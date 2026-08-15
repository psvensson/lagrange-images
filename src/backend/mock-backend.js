import {VersionConflictError} from './backend-contract.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function cloneCollections(collections) {
  return new Map([...collections].map(([name, bucket]) => [
    name,
    new Map([...bucket].map(([key, value]) => [key, clone(value)])),
  ]));
}

function cloneStreams(streams) {
  return new Map([...streams].map(([name, events]) => [name, clone(events)]));
}

function getFrom(state, collection, key) {
  return clone(state.collections.get(collection)?.get(key));
}

function putInto(state, collection, key, value, {expectedVersion} = {}) {
  let bucket = state.collections.get(collection);
  if (!bucket) {
    bucket = new Map();
    state.collections.set(collection, bucket);
  }

  const current = bucket.get(key);
  const actualVersion = current?._version ?? 0;

  if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
    throw new VersionConflictError({
      collection,
      key,
      expectedVersion,
      actualVersion,
    });
  }

  const stored = {
    ...clone(value),
    _version: actualVersion + 1,
  };
  bucket.set(key, stored);
  return clone(stored);
}

function scanFrom(state, collection, {prefix = ''} = {}) {
  const bucket = state.collections.get(collection);
  if (!bucket) return [];

  return [...bucket.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({key, value: clone(value)}));
}

function appendTo(state, stream, event) {
  let events = state.streams.get(stream);
  if (!events) {
    events = [];
    state.streams.set(stream, events);
  }

  const stored = {
    ...clone(event),
    revision: events.length + 1,
  };
  events.push(stored);
  return clone(stored);
}

function readStreamFrom(state, stream, {afterRevision = 0} = {}) {
  const events = state.streams.get(stream) ?? [];
  return clone(events.filter((event) => event.revision > afterRevision));
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

  async transaction(work) {
    if (typeof work !== 'function') throw new TypeError('backend transaction work must be a function');

    return await this.exclusive(async () => {
      const draft = {
        collections: cloneCollections(this.collections),
        streams: cloneStreams(this.streams),
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
