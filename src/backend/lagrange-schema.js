const LAGRANGE_IMAGE_TABLES = Object.freeze({
  images: 'lagrange_images_images',
  records: 'lagrange_images_records',
  snapshots: 'lagrange_images_snapshots',
  streamHeads: 'lagrange_images_stream_heads',
  events: 'lagrange_images_events',
});

const LAGRANGE_IMAGE_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${LAGRANGE_IMAGE_TABLES.images} (
    id TEXT PRIMARY KEY,
    record_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAGRANGE_IMAGE_TABLES.records} (
    id TEXT PRIMARY KEY,
    record_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAGRANGE_IMAGE_TABLES.snapshots} (
    id TEXT PRIMARY KEY,
    record_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAGRANGE_IMAGE_TABLES.streamHeads} (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAGRANGE_IMAGE_TABLES.events} (
    id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
]);

const IMAGE_COLLECTION = 'images';
const IMAGE_COLLECTION_PREFIX = 'image:';
const OBJECT_COLLECTION_SUFFIX = ':objects';
const SNAPSHOT_COLLECTION_SUFFIX = ':snapshots';
const HISTORY_STREAM_SUFFIX = ':history';
const RANGE_TERMINATOR = 'g';
const REVISION_WIDTH = 16;

function assertStorageName(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function encodePart(value, label) {
  return Buffer.from(assertStorageName(value, label), 'utf8').toString('hex');
}

function imageIdFrom(name, suffix) {
  if (!name.startsWith(IMAGE_COLLECTION_PREFIX) || !name.endsWith(suffix)) return null;
  return name.slice(IMAGE_COLLECTION_PREFIX.length, -suffix.length);
}

function encodedRange(prefix) {
  return Object.freeze({lower: prefix, upper: `${prefix}${RANGE_TERMINATOR}`});
}

function collectionRoute(collection) {
  assertStorageName(collection, 'collection');
  if (collection === IMAGE_COLLECTION) {
    return Object.freeze({
      table: LAGRANGE_IMAGE_TABLES.images,
      base: 'i/',
    });
  }

  const imageId = imageIdFrom(collection, OBJECT_COLLECTION_SUFFIX);
  if (imageId !== null) {
    return Object.freeze({
      table: LAGRANGE_IMAGE_TABLES.records,
      base: `i/${encodePart(imageId, 'image id')}/`,
    });
  }

  const snapshotImageId = imageIdFrom(collection, SNAPSHOT_COLLECTION_SUFFIX);
  if (snapshotImageId !== null) {
    return Object.freeze({
      table: LAGRANGE_IMAGE_TABLES.snapshots,
      base: `i/${encodePart(snapshotImageId, 'image id')}/`,
    });
  }

  return Object.freeze({
    table: LAGRANGE_IMAGE_TABLES.records,
    base: `c/${encodePart(collection, 'collection')}/`,
  });
}

function collectionRecord(collection, key) {
  const route = collectionRoute(collection);
  const recordKey = assertStorageName(key, 'key');
  return Object.freeze({
    ...route,
    id: `${route.base}${encodePart(recordKey, 'key')}`,
    recordKey,
  });
}

function collectionScanRange(collection, prefix = '') {
  const route = collectionRoute(collection);
  const keyPrefix = assertStorageName(prefix, 'scan prefix');
  return Object.freeze({...route, ...encodedRange(`${route.base}${encodePart(keyPrefix, 'scan prefix')}`)});
}

function streamRoute(stream) {
  assertStorageName(stream, 'stream');
  const imageId = imageIdFrom(stream, HISTORY_STREAM_SUFFIX);
  const id = imageId === null ?
    `s/${encodePart(stream, 'stream')}` :
    `i/${encodePart(imageId, 'image id')}`;
  return Object.freeze({id, ...encodedRange(`${id}/`)});
}

function eventId(streamId, revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError('stream revision must be a positive safe integer');
  }
  return `${streamId}/${String(revision).padStart(REVISION_WIDTH, '0')}`;
}

export {
  LAGRANGE_IMAGE_SCHEMA,
  LAGRANGE_IMAGE_TABLES,
  collectionRecord,
  collectionScanRange,
  eventId,
  streamRoute,
};
