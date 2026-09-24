import {VersionConflictError} from './backend-contract.js';

// Stored state is JSON text, exactly as the durable Lagrange adapter keeps it (`encodePayload` /
// `storedRecord` in lagrange-backend.js): a record is `{version, text}` and an event is
// `{revision, text}`, where `text` is the JSON of the value without its `_version` / `revision`.
// Three things follow. A read is a fresh `JSON.parse`, so a caller can never reach stored state to
// mutate it — the detachment the backend contract promises — at well under half the cost of the
// `structuredClone` per read this replaced (measured on the 1684 standard-image records: 3.1 ms
// against 7.3 ms per pass), which dominated every mock-backed exhaustive recovery sweep (bead kq98).
// The mock now accepts exactly what the durable adapter accepts: a record, JSON-encodable, with
// `undefined` properties dropped. And stored entries are immutable strings, so a transaction draft
// or a fork can share them and copy only the Map and array structure.
function encodeRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('backend values and events must be records');
  }
  const {[field]: _ignored, ...rest} = value;
  const text = JSON.stringify(rest);
  if (text === undefined) throw new TypeError('backend value is not JSON encodable');
  return text;
}

function decodeRecord(entry) {
  return entry === undefined ? undefined : {...JSON.parse(entry.text), _version: entry.version};
}

function decodeEvent(entry) {
  return {...JSON.parse(entry.text), revision: entry.revision};
}

// A transaction draft and a fork copy the Map and array STRUCTURE and share the immutable stored
// entries. Before bead c87v every transaction deep-cloned the whole state, so one durable write cost
// O(records) and a standard-image install was quadratic in its own size.
function copyCollections(collections) {
  return new Map([...collections].map(([name, bucket]) => [name, new Map(bucket)]));
}

function copyStreams(streams) {
  return new Map([...streams].map(([name, events]) => [name, events.slice()]));
}

function getFrom(state, collection, key) {
  return decodeRecord(state.collections.get(collection)?.get(key));
}

function putInto(state, collection, key, value, {expectedVersion} = {}) {
  const text = encodeRecord(value, '_version');
  let bucket = state.collections.get(collection);
  if (!bucket) {
    bucket = new Map();
    state.collections.set(collection, bucket);
  }

  const current = bucket.get(key);
  const actualVersion = current?.version ?? 0;

  if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
    throw new VersionConflictError({
      collection,
      key,
      expectedVersion,
      actualVersion,
    });
  }

  const stored = Object.freeze({version: actualVersion + 1, text});
  bucket.set(key, stored);
  return decodeRecord(stored);
}

function scanFrom(state, collection, {prefix = ''} = {}) {
  const bucket = state.collections.get(collection);
  if (!bucket) return [];

  return [...bucket.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => ({key, value: decodeRecord(entry)}));
}

function appendTo(state, stream, event) {
  const text = encodeRecord(event, 'revision');
  let events = state.streams.get(stream);
  if (!events) {
    events = [];
    state.streams.set(stream, events);
  }

  const stored = Object.freeze({revision: events.length + 1, text});
  events.push(stored);
  return decodeEvent(stored);
}

function readStreamFrom(state, stream, {afterRevision = 0} = {}) {
  const events = state.streams.get(stream) ?? [];
  return events.filter((entry) => entry.revision > afterRevision).map(decodeEvent);
}

// The current committed head revision of a stream: the last appended event's
// revision, or 0 for a stream with no events. Read-only; a direct head read from
// the stream's own state, never a scan.
function streamHeadFrom(state, stream) {
  const events = state.streams.get(stream) ?? [];
  return events.length === 0 ? 0 : events[events.length - 1].revision;
}

function transactionView(state, isActive) {
  const active = () => {
    if (!isActive()) throw new TypeError('backend transaction is no longer active');
  };

  return Object.freeze({
    async get(collection, key) {
      active();
      return getFrom(state, collection, key);
    },
    async put(collection, key, value, options = {}) {
      active();
      return putInto(state, collection, key, value, options);
    },
    async scan(collection, options = {}) {
      active();
      return scanFrom(state, collection, options);
    },
    async append(stream, event) {
      active();
      return appendTo(state, stream, event);
    },
    async readStream(stream, options = {}) {
      active();
      return readStreamFrom(state, stream, options);
    },
    async streamHead(stream) {
      active();
      return streamHeadFrom(state, stream);
    },
  });
}

class MockBackend {
  constructor({integration = {}} = {}) {
    this.kind = 'mock';
    this.durable = false;
    this.integration = Object.freeze({...integration});
    this.collections = new Map();
    this.streams = new Map();
    this.started = false;
    this.writeTail = Promise.resolve();
  }

  async exclusive(operation) {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return await result;
  }

  async start() {
    this.started = true;
    return this;
  }

  async stop() {
    await this.writeTail;
    this.started = false;
  }

  async get(collection, key) {
    return getFrom(this, collection, key);
  }

  async put(collection, key, value, options = {}) {
    return await this.exclusive(() => putInto(this, collection, key, value, options));
  }

  async scan(collection, options = {}) {
    return scanFrom(this, collection, options);
  }

  async append(stream, event) {
    return await this.exclusive(() => appendTo(this, stream, event));
  }

  async readStream(stream, options = {}) {
    return readStreamFrom(this, stream, options);
  }

  async streamHead(stream) {
    return streamHeadFrom(this, stream);
  }

  // An independent MockBackend holding a copy of this one's current state — versions, streams and
  // all — through the same structure-copy helpers a transaction draft uses, sharing the immutable
  // stored values. Writes to either side are invisible to the other. Mock-only on purpose: a durable backend cannot promise a
  // cheap whole-state copy, so this is a testing seam (the exhaustive recovery sweeps fork one
  // prepared base image per iteration instead of rebuilding it), not part of the backend contract.
  fork() {
    const forked = new MockBackend({integration: this.integration});
    forked.collections = copyCollections(this.collections);
    forked.streams = copyStreams(this.streams);
    return forked;
  }

  async transaction(work) {
    if (typeof work !== 'function') throw new TypeError('backend transaction work must be a function');

    return await this.exclusive(async () => {
      const draft = {
        collections: copyCollections(this.collections),
        streams: copyStreams(this.streams),
      };
      let active = true;
      const transaction = transactionView(draft, () => active);

      try {
        const result = await work(transaction);
        this.collections = draft.collections;
        this.streams = draft.streams;
        return result;
      } finally {
        active = false;
      }
    });
  }
}

export {MockBackend};
