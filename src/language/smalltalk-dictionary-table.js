import {SHAPE_INDEXED} from '../object/model.js';
import {VALUE_KIND, canonicalizeValue, integerValue} from '../value/index.js';

// ADR 0048 decisions 5 and 6: the durable Dictionary representation, as pure functions.
//
// Kept free of installers, executors and image services on purpose. A test can then prove the
// representation directly rather than only through surface sends, and a later MethodDictionary fast
// path can read the same layout without dragging in the Dictionary protocol.
const DICTIONARY_SHAPE_ID = 'smalltalk/dictionary-shape/v1';
const DICTIONARY_TABLE_SHAPE_ID = 'smalltalk/dictionary-table-shape/v1';
const DICTIONARY_TABLE_SLOT = 'dictionary-table';
const DICTIONARY_TALLY_SLOT = 'dictionary-table-tally';

const DICTIONARY_SHAPE_SLOTS = Object.freeze([{id: DICTIONARY_TABLE_SLOT, name: 'table'}]);
const DICTIONARY_TABLE_SHAPE_SLOTS = Object.freeze([{id: DICTIONARY_TALLY_SLOT, name: 'tally'}]);

// Power of two so the probe start is a mask-equivalent modulo, and at least 8 so a small dictionary
// still has slack before its first growth.
const DICTIONARY_MINIMUM_CAPACITY = 8;
const DICTIONARY_LOAD_NUMERATOR = 3;
const DICTIONARY_LOAD_DENOMINATOR = 4;

// Three Values per bucket. Occupancy is the *hash* cell rather than the key cell, which is what
// leaves `nil` usable as an ordinary key instead of being stolen as an empty sentinel.
const BUCKET_WIDTH = 3;

class SmalltalkDictionaryTableError extends TypeError {
  constructor(message) {
    super(`malformed Dictionary table: ${message}`);
    this.name = 'SmalltalkDictionaryTableError';
  }
}

function isIntegerValue(value) {
  return Boolean(value) && value.kind === VALUE_KIND.INTEGER;
}

function capacityOf(indexedLength) {
  if (indexedLength % BUCKET_WIDTH !== 0) {
    throw new SmalltalkDictionaryTableError(`indexed length ${indexedLength} is not a multiple of ${BUCKET_WIDTH}`);
  }
  const capacity = indexedLength / BUCKET_WIDTH;
  if (capacity < DICTIONARY_MINIMUM_CAPACITY || (capacity & (capacity - 1)) !== 0) {
    throw new SmalltalkDictionaryTableError(`capacity ${capacity} is not a power of two of at least ${DICTIONARY_MINIMUM_CAPACITY}`);
  }
  return capacity;
}

function emptyBuckets(capacity) {
  return Array.from({length: capacity}, () => ({hash: null, key: null, value: null}));
}

// Buckets -> the flat indexed part. `nil` fills all three cells of an empty bucket, so an empty
// bucket is indistinguishable from one that never held anything — there are no tombstones in v1
// because there is no removal.
function indexedFromBuckets(buckets, nilRef) {
  const indexed = [];
  for (const bucket of buckets) {
    if (bucket.hash === null) {
      indexed.push(nilRef, nilRef, nilRef);
      continue;
    }
    indexed.push(bucket.hash, bucket.key, bucket.value);
  }
  return indexed;
}

function bucketsFromIndexed(indexed) {
  const capacity = capacityOf(indexed.length);
  const buckets = [];
  for (let index = 0; index < capacity; index += 1) {
    const base = index * BUCKET_WIDTH;
    const hash = indexed[base];
    if (!isIntegerValue(hash)) {
      buckets.push({hash: null, key: null, value: null});
      continue;
    }
    buckets.push({hash, key: indexed[base + 1], value: indexed[base + 2]});
  }
  return buckets;
}

// Linear probing from the floor-modulo of the hash. Floor rather than truncating remainder because
// a user-defined `hash` may answer a negative Integer, and a negative start index would otherwise
// probe outside the table.
function probeStart(hashValue, capacity) {
  if (!isIntegerValue(hashValue)) {
    throw new SmalltalkDictionaryTableError('a stored or query hash must be an Integer Value');
  }
  const capacityBig = BigInt(capacity);
  const raw = BigInt(hashValue.value) % capacityBig;
  return Number(((raw % capacityBig) + capacityBig) % capacityBig);
}

function* probeSequence(hashValue, capacity) {
  const start = probeStart(hashValue, capacity);
  for (let step = 0; step < capacity; step += 1) {
    yield (start + step) % capacity;
  }
}

function sameStoredHash(left, right) {
  return isIntegerValue(left) && isIntegerValue(right) && BigInt(left.value) === BigInt(right.value);
}

// Growth is decided from the count the table would have *after* the insert, so a table never
// publishes at a load above the limit and then grows on the following write.
function needsGrowth(tallyAfterInsert, capacity) {
  return tallyAfterInsert * DICTIONARY_LOAD_DENOMINATOR > capacity * DICTIONARY_LOAD_NUMERATOR;
}

function grownCapacity(capacity) {
  return capacity * 2;
}

// Reinsertion after growth places entries by their **stored** hashes. A key is never sent `hash`
// again merely because the table grew: that would re-run user code during an internal resize, and
// a key whose hash had since changed would silently relocate.
function reinsert(buckets, capacity) {
  const grown = emptyBuckets(capacity);
  for (const bucket of buckets) {
    if (bucket.hash === null) continue;
    let placed = false;
    for (const index of probeSequence(bucket.hash, capacity)) {
      if (grown[index].hash === null) {
        grown[index] = {...bucket};
        placed = true;
        break;
      }
    }
    if (!placed) throw new SmalltalkDictionaryTableError('grown table has no free bucket, which cannot happen below the load factor');
  }
  return grown;
}

function tallyOf(buckets) {
  return buckets.reduce((count, bucket) => count + (bucket.hash === null ? 0 : 1), 0);
}

// The durable form of a table snapshot, ready for `putObject`. `behavior` is deliberately absent:
// DictionaryTable is a language-owned internal graph object, not a public Smalltalk class.
function tableRecordFields({buckets, shapeRef, nilRef}) {
  return {
    shape: shapeRef,
    slots: {[DICTIONARY_TALLY_SLOT]: integerValue(tallyOf(buckets))},
    indexed: indexedFromBuckets(buckets, nilRef),
    metadata: {smalltalk: 'dictionary-table'},
  };
}

// Read a stored table, validating what the representation promises rather than trusting it. A
// dictionary whose tally disagrees with its buckets would make `size` lie, and a mis-sized indexed
// part would make probing read the wrong cells.
function readTableRecord(record) {
  if (!record || record.kind !== 'object') throw new SmalltalkDictionaryTableError('table record is not an object');
  if (!Object.hasOwn(record, 'indexed')) throw new SmalltalkDictionaryTableError('table record has no indexed part');
  const buckets = bucketsFromIndexed(record.indexed);
  const tally = record.slots?.[DICTIONARY_TALLY_SLOT];
  if (!isIntegerValue(tally)) throw new SmalltalkDictionaryTableError('table tally must be an Integer Value');
  const counted = tallyOf(buckets);
  if (BigInt(tally.value) !== BigInt(counted)) {
    throw new SmalltalkDictionaryTableError(`table tally ${tally.value} disagrees with ${counted} occupied buckets`);
  }
  return {buckets, capacity: buckets.length, tally: counted};
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(canonicalizeValue(left)) === JSON.stringify(canonicalizeValue(right));
}

export {
  BUCKET_WIDTH,
  DICTIONARY_LOAD_DENOMINATOR,
  DICTIONARY_LOAD_NUMERATOR,
  DICTIONARY_MINIMUM_CAPACITY,
  DICTIONARY_SHAPE_ID,
  DICTIONARY_SHAPE_SLOTS,
  DICTIONARY_TABLE_SHAPE_ID,
  DICTIONARY_TABLE_SHAPE_SLOTS,
  DICTIONARY_TABLE_SLOT,
  DICTIONARY_TALLY_SLOT,
  SHAPE_INDEXED,
  SmalltalkDictionaryTableError,
  bucketsFromIndexed,
  capacityOf,
  emptyBuckets,
  grownCapacity,
  indexedFromBuckets,
  needsGrowth,
  probeSequence,
  probeStart,
  readTableRecord,
  reinsert,
  sameCanonicalValue,
  sameStoredHash,
  tableRecordFields,
  tallyOf,
};
