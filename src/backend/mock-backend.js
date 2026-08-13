class VersionConflictError extends Error {
  constructor({collection, key, expectedVersion, actualVersion}) {
    super(
      `version conflict for ${collection}/${key}: expected ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = 'VersionConflictError';
    this.collection = collection;
    this.key = key;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MockBackend {
  constructor({integration = {}} = {}) {
    this.kind = 'mock';
    this.durable = false;
    this.integration = Object.freeze({...integration});
    this.collections = new Map();
    this.streams = new Map();
    this.started = false;
  }

  async start() {
    this.started = true;
    return this;
  }

  async stop() {
    this.started = false;
  }

  async get(collection, key) {
    const bucket = this.collections.get(collection);
    return clone(bucket?.get(key));
  }

  async put(collection, key, value, {expectedVersion} = {}) {
    let bucket = this.collections.get(collection);
    if (!bucket) {
      bucket = new Map();
      this.collections.set(collection, bucket);
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

  async scan(collection, {prefix = ''} = {}) {
    const bucket = this.collections.get(collection);
    if (!bucket) return [];

    return [...bucket.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({key, value: clone(value)}));
  }

  async append(stream, event) {
    let events = this.streams.get(stream);
    if (!events) {
      events = [];
      this.streams.set(stream, events);
    }

    const stored = {
      ...clone(event),
      revision: events.length + 1,
    };
    events.push(stored);
    return clone(stored);
  }

  async readStream(stream, {afterRevision = 0} = {}) {
    const events = this.streams.get(stream) ?? [];
    return clone(events.filter((event) => event.revision > afterRevision));
  }
}

export {MockBackend, VersionConflictError};
