import {VersionConflictError} from './backend-contract.js';
import {
  LAGRANGE_IMAGE_SCHEMA,
  LAGRANGE_IMAGE_TABLES,
  collectionRecord,
  collectionScanRange,
  eventId,
  streamRoute,
} from './lagrange-schema.js';

function cloneWithout(value, field) {
  const cloned = structuredClone(value);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new TypeError('backend values and events must be records');
  }
  delete cloned[field];
  return cloned;
}

function encodePayload(value, field) {
  const encoded = JSON.stringify(cloneWithout(value, field));
  if (encoded === undefined) throw new TypeError('backend value is not JSON encodable');
  return encoded;
}

function decodePayload(payload) {
  const source = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  if (typeof source !== 'string') throw new TypeError('stored payload must be text');
  return JSON.parse(source);
}

function rows(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function changed(result) {
  const count = result?.affectedRows ?? result?.rowCount ?? result?.changes ?? result?.count;
  return Number.isInteger(count) ? count > 0 : rows(result).length > 0;
}

function storedRecord(row) {
  return {...decodePayload(row.payload), _version: Number(row.version)};
}

function storedEvent(row) {
  return {...decodePayload(row.payload), revision: Number(row.revision)};
}

function assertWork(work) {
  if (typeof work !== 'function') throw new TypeError('backend transaction work must be a function');
}

async function selectRecord(database, target) {
  const result = await database.query(
    `SELECT version, payload FROM ${target.table} WHERE id = ?`,
    [target.id],
  );
  return rows(result)[0] ?? null;
}

async function putRecord(database, collection, key, value, {expectedVersion} = {}) {
  const target = collectionRecord(collection, key);
  const current = await selectRecord(database, target);
  const actualVersion = current ? Number(current.version) : 0;
  if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
    throw new VersionConflictError({collection, key, expectedVersion, actualVersion});
  }

  const version = actualVersion + 1;
  const payload = encodePayload(value, '_version');
  if (!current) {
    await database.query(
      `INSERT INTO ${target.table} (id, record_key, version, payload) VALUES (?, ?, ?, ?)`,
      [target.id, target.recordKey, version, payload],
    );
  } else {
    const result = await database.query(
      `UPDATE ${target.table} SET payload = ?, version = ? WHERE id = ? AND version = ?`,
      [payload, version, target.id, actualVersion],
    );
    if (!changed(result)) {
      throw new VersionConflictError({
        collection,
        key,
        expectedVersion: actualVersion,
        actualVersion: null,
      });
    }
  }
  return {...decodePayload(payload), _version: version};
}

async function getRecord(database, collection, key) {
  const row = await selectRecord(database, collectionRecord(collection, key));
  return row ? storedRecord(row) : undefined;
}

async function scanRecords(database, collection, {prefix = ''} = {}) {
  const range = collectionScanRange(collection, prefix);
  const result = range.lower === null ?
    await database.query(
      `SELECT id, record_key, version, payload FROM ${range.table} ORDER BY id`,
    ) :
    await database.query(
      `SELECT id, record_key, version, payload FROM ${range.table} WHERE id >= ? AND id < ? ORDER BY id`,
      [range.lower, range.upper],
    );
  return rows(result)
    .map((row) => ({key: row.record_key, value: storedRecord(row)}))
    .filter(({key}) => key.startsWith(prefix))
    .sort(({key: left}, {key: right}) => left.localeCompare(right));
}

async function appendEvent(database, stream, event) {
  const route = streamRoute(stream);
  const result = await database.query(
    `SELECT revision FROM ${LAGRANGE_IMAGE_TABLES.streamHeads} WHERE id = ?`,
    [route.id],
  );
  const current = rows(result)[0] ?? null;
  const revision = current ? Number(current.revision) + 1 : 1;
  if (current) {
    const update = await database.query(
      `UPDATE ${LAGRANGE_IMAGE_TABLES.streamHeads} SET revision = ? WHERE id = ? AND revision = ?`,
      [revision, route.id, Number(current.revision)],
    );
    if (!changed(update)) throw new Error(`stream revision conflict: ${stream}`);
  } else {
    await database.query(
      `INSERT INTO ${LAGRANGE_IMAGE_TABLES.streamHeads} (id, revision) VALUES (?, ?)`,
      [route.id, revision],
    );
  }

  const payload = encodePayload(event, 'revision');
  await database.query(
    `INSERT INTO ${LAGRANGE_IMAGE_TABLES.events} (id, stream_id, revision, payload) VALUES (?, ?, ?, ?)`,
    [eventId(route.id, revision), route.id, revision, payload],
  );
  return {...decodePayload(payload), revision};
}

async function readEvents(database, stream, {afterRevision = 0} = {}) {
  if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
    throw new RangeError('afterRevision must be a non-negative safe integer');
  }
  const route = streamRoute(stream);
  const result = await database.query(
    `SELECT revision, payload FROM ${LAGRANGE_IMAGE_TABLES.events} WHERE id >= ? AND id < ? AND revision > ? ORDER BY id`,
    [route.lower, route.upper, afterRevision],
  );
  return rows(result).map(storedEvent);
}

// The current committed head revision of a stream: the dedicated stream-heads row
// this backend already maintains at append (CAS high-water mark), read directly —
// O(1), never a scan/reconstruction of the event log. 0 for a stream with no
// committed events (no row yet).
async function readStreamHead(database, stream) {
  const route = streamRoute(stream);
  const result = await database.query(
    `SELECT revision FROM ${LAGRANGE_IMAGE_TABLES.streamHeads} WHERE id = ?`,
    [route.id],
  );
  const current = rows(result)[0] ?? null;
  return current ? Number(current.revision) : 0;
}

function transactionView(database, isActive) {
  const activeDatabase = () => {
    if (!isActive()) throw new TypeError('backend transaction is no longer active');
    return database;
  };
  return Object.freeze({
    async get(collection, key) {
      return await getRecord(activeDatabase(), collection, key);
    },
    async put(collection, key, value, options = {}) {
      return await putRecord(activeDatabase(), collection, key, value, options);
    },
    async scan(collection, options = {}) {
      return await scanRecords(activeDatabase(), collection, options);
    },
    async append(stream, event) {
      return await appendEvent(activeDatabase(), stream, event);
    },
    async readStream(stream, options = {}) {
      return await readEvents(activeDatabase(), stream, options);
    },
    async streamHead(stream) {
      return await readStreamHead(activeDatabase(), stream);
    },
  });
}

class LagrangeBackend {
  constructor({createEmbeddedLagrange, configuration = {}, namespace = 'lagrange-images', runtime = null} = {}) {
    if (!runtime && typeof createEmbeddedLagrange !== 'function') {
      throw new TypeError('createEmbeddedLagrange must be a function');
    }
    if (typeof namespace !== 'string' || namespace.length === 0) {
      throw new TypeError('namespace must be a non-empty string');
    }
    this.kind = 'lagrange';
    this.durable = true;
    this.integration = Object.freeze({namespace});
    this.createEmbeddedLagrange = createEmbeddedLagrange;
    this.configuration = structuredClone(configuration);
    this.namespace = namespace;
    this.runtime = runtime;
    this.database = null;
    this.state = 'created';
  }

  assertStarted() {
    if (this.state !== 'started' || !this.database) throw new TypeError('Lagrange backend is not started');
    return this.database;
  }

  async start() {
    if (this.state === 'started') return this;
    if (this.state !== 'created') throw new TypeError('Lagrange backend cannot be restarted');
    this.runtime ??= this.createEmbeddedLagrange({configuration: this.configuration});
    this.state = 'starting';
    try {
      await this.runtime.start();
      this.database = this.runtime.openApplicationDatabase({applicationId: this.namespace});
      for (const statement of LAGRANGE_IMAGE_SCHEMA) await this.database.query(statement);
      this.state = 'started';
      return this;
    } catch (error) {
      this.state = 'failed';
      try {
        await this.runtime.stop();
      } catch {
        // Preserve the startup/schema failure as the primary failure.
      }
      throw error;
    }
  }

  async stop() {
    if (this.state === 'stopped') return;
    if (this.state === 'created') {
      this.state = 'stopped';
      return;
    }
    try {
      await this.runtime?.stop();
    } finally {
      this.database = null;
      this.state = 'stopped';
    }
  }

  async get(collection, key) {
    return await getRecord(this.assertStarted(), collection, key);
  }

  async put(collection, key, value, options = {}) {
    return await this.transaction((transaction) => transaction.put(collection, key, value, options));
  }

  async scan(collection, options = {}) {
    return await scanRecords(this.assertStarted(), collection, options);
  }

  async append(stream, event) {
    return await this.transaction((transaction) => transaction.append(stream, event));
  }

  async readStream(stream, options = {}) {
    return await readEvents(this.assertStarted(), stream, options);
  }

  async streamHead(stream) {
    return await readStreamHead(this.assertStarted(), stream);
  }

  async transaction(work) {
    assertWork(work);
    const database = this.assertStarted();
    return await database.transaction(async (sqlTransaction) => {
      let active = true;
      const transaction = transactionView(sqlTransaction, () => active);
      try {
        return await work(transaction);
      } finally {
        active = false;
      }
    });
  }
}

export {LagrangeBackend};
