import {SHAPE_INDEXED} from '../object/model.js';
import {VALUE_KIND, integerValue, isObjectRef} from '../value/index.js';
import {builtInEquals, builtInHash} from './smalltalk-equality.js';
import {
  DICTIONARY_MINIMUM_CAPACITY,
  bucketsFromIndexed,
  capacityOf,
  emptyBuckets,
  grownCapacity,
  indexedFromBuckets,
  needsGrowth,
  probeSequence,
  reinsert,
  tallyOf,
} from './smalltalk-dictionary-table.js';

// ADR 0049. The selector-to-Block mapping that dispatch reads, as a fixed-Shape kernel
// representation rather than a Smalltalk class.
//
// The whole file is pure with respect to Smalltalk: nothing here sends a message, so lookup cannot
// re-enter the dispatcher while it is trying to find the method a send would run. That is the
// property ADR 0048 decision 12 promised and the reason this is not an ordinary Dictionary — a
// Dictionary must honour an overridden `hash`/`=`, and a dispatcher must not.
const METHOD_DICTIONARY_SHAPE_ID = 'smalltalk/method-dictionary-shape/v1';
const METHOD_DICTIONARY_TALLY_SLOT = 'method-dictionary-tally';
const METHOD_DICTIONARY_SHAPE_SLOTS = Object.freeze([
  {id: METHOD_DICTIONARY_TALLY_SLOT, name: 'tally'},
]);

// ADR 0049 decision 7. Migration is one-shot per Behavior, so its output is a named durable thing
// and gets a deterministic id — the opposite of ADR 0048's per-snapshot fresh identity, and for the
// opposite reason: a retry must find its own previous output instead of leaving another orphan.
const migratedDictionaryId = (behaviorObjectId) => `${behaviorObjectId}/methods/hashed/v1`;

class SmalltalkMalformedMethodDictionaryError extends TypeError {
  constructor(ref, reason) {
    super(`malformed method dictionary ${ref.imageId}/${ref.objectId}: ${reason}`);
    this.name = 'SmalltalkMalformedMethodDictionaryError';
    this.dictionary = ref;
  }
}

// ADR 0049 decision 2: recognition is by the *local* fixed Shape. Another image may hold its own
// Shape at this id, so identity is the (imageId, objectId) pair — the same rule `isBehaviorObject`
// applies to the Behavior shape.
function isMethodDictionary(record) {
  return Boolean(record)
    && record.kind === 'object'
    && isObjectRef(record.shape)
    && record.shape.imageId === record.imageId
    && record.shape.objectId === METHOD_DICTIONARY_SHAPE_ID;
}

const isIntegerValue = (value) => Boolean(value) && value.kind === VALUE_KIND.INTEGER;
const isTextValue = (value) => Boolean(value) && value.kind === VALUE_KIND.TEXT;

// The full structural validation of decision 5, run once per record version behind the cache of
// decision 5a. Everything it checks is a way a record could physically hide a method while looking
// like an ordinary selector miss, which is the failure the malformed/not-understood split exists to
// prevent.
function sameRefValue(left, right) {
  return isObjectRef(left) && isObjectRef(right)
    && left.imageId === right.imageId && left.objectId === right.objectId;
}

function validateMethodDictionary(record, ref, nilRef) {
  const fail = (reason) => {
    throw new SmalltalkMalformedMethodDictionaryError(ref ?? {imageId: record?.imageId, objectId: record?.id}, reason);
  };
  if (!isObjectRef(nilRef)) fail('validation needs this image kernel nil to recognize an empty bucket');

  // Decision 3: a behavior edge would make this dispatchable, which is exactly the dynamic protocol
  // decision 2 denies it. Structural, not conventional.
  if (record.behavior !== null && record.behavior !== undefined) fail('a method dictionary must have no behavior edge');
  if (!Object.hasOwn(record, 'indexed')) fail('a method dictionary must carry an indexed part');

  let capacity;
  try {
    capacity = capacityOf(record.indexed.length);
  } catch (error) {
    fail(error.message);
  }

  // The raw triples, *before* the shared parser sees them. `bucketsFromIndexed` reads any non-Integer
  // hash cell as an empty bucket, which is right for a table this code built and wrong as a
  // validation input: a corrupted hash cell would become an "empty" bucket, the evidence would be
  // gone before this function could reject it, and - because an empty bucket ends a probe - the
  // selector would vanish and report as an ordinary message-not-understood.
  //
  // So occupancy is decided here, from the cell's actual kind, and anything that is neither a
  // well-formed occupied triple nor a well-formed empty one is corruption.
  for (let index = 0; index < record.indexed.length; index += 3) {
    const [hash, key, method] = record.indexed.slice(index, index + 3);
    const bucket = index / 3;
    if (isIntegerValue(hash)) {
      if (!isTextValue(key)) fail(`bucket ${bucket} selector must be a Text Value`);
      if (key.value.length === 0) fail(`bucket ${bucket} selector must not be empty`);
      if (!isObjectRef(method)) fail(`bucket ${bucket} method must be an unpinned ref`);
      if (method.imageId !== record.imageId) fail(`bucket ${bucket} method must be local to ${record.imageId}`);
      continue;
    }
    // An empty bucket is all three cells holding this image's nil, and nothing else. Comparing the
    // full ref rather than an object id keeps a foreign `smalltalk/nil` from passing as empty.
    if (!sameRefValue(hash, nilRef) || !sameRefValue(key, nilRef) || !sameRefValue(method, nilRef)) {
      fail(`bucket ${bucket} is neither an occupied triple nor an empty one`);
    }
  }

  const buckets = bucketsFromIndexed(record.indexed);
  const tally = record.slots?.[METHOD_DICTIONARY_TALLY_SLOT];
  if (!isIntegerValue(tally)) fail('tally must be an Integer Value');
  if (BigInt(tally.value) !== BigInt(tallyOf(buckets))) {
    fail(`tally ${tally.value} disagrees with ${tallyOf(buckets)} occupied buckets`);
  }

  const seen = new Set();
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.hash === null) continue;
    // The stored hash must be the built-in hash of the stored selector, or a probe would look in
    // the wrong place for a selector that is physically present.
    const expected = builtInHash(bucket.key);
    if (BigInt(bucket.hash.value) !== BigInt(expected.value)) {
      fail(`bucket ${index} stores hash ${bucket.hash.value} for selector ${bucket.key.value}`);
    }
    // Two buckets holding one selector make one method unreachable — the ADR 0044 decision 2 defect
    // in the new format, where it would resolve by probe order instead of by slot order.
    if (seen.has(bucket.key.value)) fail(`selector ${bucket.key.value} appears in more than one bucket`);
    seen.add(bucket.key.value);
  }

  // Probe reachability. An occupied bucket separated from its home by an empty bucket is invisible
  // to lookup, which would read as an ordinary miss rather than as the corruption it is.
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.hash === null) continue;
    let reachable = false;
    for (const probe of probeSequence(bucket.hash, capacity)) {
      if (probe === index) {
        reachable = true;
        break;
      }
      if (buckets[probe].hash === null) break;
    }
    if (!reachable) fail(`bucket ${index} is unreachable from its own probe sequence`);
  }

  return {buckets, capacity, tally: tallyOf(buckets)};
}

// Decision 5: pure hash, pure probe, pure comparison. No send anywhere on this path.
function lookupSelectorInTable({buckets, capacity}, selectorValue) {
  const hash = builtInHash(selectorValue);
  for (const index of probeSequence(hash, capacity)) {
    const bucket = buckets[index];
    if (bucket.hash === null) return null;
    if (BigInt(bucket.hash.value) === BigInt(hash.value) && builtInEquals(bucket.key, selectorValue)) {
      return bucket.value;
    }
  }
  return null;
}

function capacityForEntries(count) {
  let capacity = DICTIONARY_MINIMUM_CAPACITY;
  while (needsGrowth(count, capacity)) capacity = grownCapacity(capacity);
  return capacity;
}

// Build a complete set of buckets from `[selectorTextValue, methodRef]` pairs. Used by creation,
// by every method addition, and by migration, so all three produce byte-identical layouts for the
// same selector set — which is what makes the deterministic migration target reusable on retry.
function buildMethodBuckets(entries) {
  const capacity = capacityForEntries(entries.length);
  let buckets = emptyBuckets(capacity);
  const placed = new Set();
  // Sorted, so the layout is a function of the selector set rather than of insertion order.
  const sorted = [...entries].sort(([left], [right]) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0));
  for (const [selector, method] of sorted) {
    if (placed.has(selector.value)) throw new TypeError(`method dictionary declares duplicate selector: ${selector.value}`);
    placed.add(selector.value);
    const hash = builtInHash(selector);
    let done = false;
    for (const index of probeSequence(hash, capacity)) {
      if (buckets[index].hash === null) {
        buckets[index] = {hash, key: selector, value: method};
        done = true;
        break;
      }
    }
    if (!done) throw new TypeError('no free bucket below the load factor, which cannot happen');
  }
  void reinsert;
  return {buckets, capacity};
}

function methodDictionaryRecordFields({buckets, shapeRef, nilRef, metadata = {}}) {
  return {
    shape: shapeRef,
    // No behavior: decision 3 makes its absence structural.
    slots: {[METHOD_DICTIONARY_TALLY_SLOT]: integerValue(tallyOf(buckets))},
    indexed: indexedFromBuckets(buckets, nilRef),
    metadata: {smalltalk: 'method-dictionary', ...metadata},
  };
}

function entriesFromBuckets(buckets) {
  return buckets.filter(({hash}) => hash !== null).map(({key, value}) => [key, value]);
}

// ADR 0049 decision 7. A seal is a durable marker saying "this record is being migrated and no
// longer accepts additions". It hides no ref, dispatch ignores it entirely, and only the method
// installer consults it.
const SEAL_METADATA_KEY = 'sealedForMigration';
const isSealed = (record) => record?.metadata?.[SEAL_METADATA_KEY] === true;

export {
  METHOD_DICTIONARY_SHAPE_ID,
  METHOD_DICTIONARY_SHAPE_SLOTS,
  METHOD_DICTIONARY_TALLY_SLOT,
  SEAL_METADATA_KEY,
  SHAPE_INDEXED,
  SmalltalkMalformedMethodDictionaryError,
  buildMethodBuckets,
  capacityForEntries,
  entriesFromBuckets,
  isMethodDictionary,
  isSealed,
  lookupSelectorInTable,
  methodDictionaryRecordFields,
  migratedDictionaryId,
  validateMethodDictionary,
};
