import {HOST_CONDITION_CLASS} from './smalltalk-condition-ids.js';
import {
  DICTIONARY_TABLE_SHAPE_ID,
  DICTIONARY_TABLE_SLOT,
  DICTIONARY_MINIMUM_CAPACITY,
  emptyBuckets,
  grownCapacity,
  needsGrowth,
  probeSequence,
  readTableRecord,
  reinsert,
  sameCanonicalValue,
  sameStoredHash,
  tableRecordFields,
} from './smalltalk-dictionary-table.js';
import {
  builtInEquals,
  builtInHash,
  normalizeBooleanSingleton,
} from './smalltalk-equality.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {SmalltalkDanglingEdgeError} from './smalltalk-lookup.js';
import {
  SMALLTALK_PRIMITIVE,
  SmalltalkPrimitiveLocalityError,
  assertLocalRef,
  assertLoopBlock,
  promoted,
  signalHostCondition,
} from './smalltalk-primitive-support.js';
import {
  VALUE_KIND,
  booleanValue,
  canonicalizeValue,
  integerValue,
  isObjectRef,
  objectRef,
  textValue,
} from '../value/index.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0048 decisions 2 and 3, at the primitive boundary. The helpers themselves are pure; what the
// primitive adds is the ADR 0045 bridge normalization, so `true = true` does not depend on whether
// each operand arrived as the singleton ref or as the canonical boolean.
// General Dictionary lookup is defined to *send* hash and =, so an execution context without a
// message runtime cannot serve these primitives — failing here is clearer than a lookup that
// silently used the built-in helper and ignored a user override.
async function builtInEqualsPrimitive({images, primitiveImage, left, right}) {
  const kernel = await findSmalltalkKernel({images, imageId: primitiveImage});
  return booleanValue(builtInEquals(
    normalizeBooleanSingleton(left, kernel),
    normalizeBooleanSingleton(right, kernel),
  ));
}

async function builtInHashPrimitive({images, primitiveImage, value}) {
  const kernel = await findSmalltalkKernel({images, imageId: primitiveImage});
  return builtInHash(normalizeBooleanSingleton(value, kernel));
}

// ADR 0048 decisions 7 and 8.
//
// A Dictionary operation is the first primitive that runs *arbitrary Smalltalk* in the middle of a
// durable mutation: it sends `hash` to the query key and `=` to stored keys, and those methods may
// send further messages or mutate state — including this very Dictionary. Everything below is shaped
// by that: read first, run user code, build a complete next snapshot, then compare-and-set exactly
// one ref.
class SmalltalkDictionaryKeyNotFoundError extends TypeError {
  constructor(dictionaryRef) {
    super(`Symmetric Smalltalk Dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId} has no such key`);
    this.name = 'SmalltalkDictionaryKeyNotFoundError';
  }
}

// A failed swap is never retried: retrying would re-execute user `hash`/`=` methods and could
// duplicate whatever effects they had.
class SmalltalkDictionaryConflictError extends TypeError {
  constructor(dictionaryRef) {
    super(
      `Symmetric Smalltalk Dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId} changed while `
      + 'its hash/= methods were running; the mutation is refused rather than retried, because a retry '
      + 'would re-execute that user code',
    );
    this.name = 'SmalltalkDictionaryConflictError';
  }
}

class SmalltalkDictionaryProtocolError extends TypeError {
  constructor(message) {
    super(`Symmetric Smalltalk Dictionary protocol violation: ${message}`);
    this.name = 'SmalltalkDictionaryProtocolError';
  }
}

async function loadDictionary({images, primitiveImage, value, primitive}) {
  assertLocalRef(value, primitiveImage, primitive, 'a Dictionary');
  const record = await images.getObject(value.imageId, value.objectId);
  if (!record) throw new SmalltalkDanglingEdgeError('dictionary', value, value);
  const tableRef = record.slots?.[DICTIONARY_TABLE_SLOT];
  if (!isObjectRef(tableRef)) {
    throw new SmalltalkDictionaryProtocolError(
      `${value.imageId}/${value.objectId} has no table; a Dictionary must be initialized before use`,
    );
  }
  if (tableRef.imageId !== primitiveImage) {
    throw new SmalltalkPrimitiveLocalityError(primitive, primitiveImage, tableRef);
  }
  const tableRecord = await images.getObject(tableRef.imageId, tableRef.objectId);
  if (!tableRecord) throw new SmalltalkDanglingEdgeError('dictionary table', value, tableRef);
  return {record, tableRef, table: readTableRecord(tableRecord)};
}

// The two places user code enters a primitive. Both results are checked before anything is written:
// a broken `hash` or `=` must fail the operation, not corrupt a table.
async function sendHash({sendMessage, key, kernel}) {
  const result = await sendMessage({
    languageId: SYMMETRIC_SMALLTALK_ID,
    receiver: key,
    message: textValue('hash'),
    arguments: [],
  });
  const normalized = canonicalizeValue(result);
  if (normalized.kind !== VALUE_KIND.INTEGER) {
    throw new SmalltalkDictionaryProtocolError(`hash answered a ${normalized.kind} Value; hash must answer an Integer`);
  }
  return normalized;
}

async function sendEquals({sendMessage, storedKey, queryKey}) {
  const result = await sendMessage({
    languageId: SYMMETRIC_SMALLTALK_ID,
    receiver: storedKey,
    message: textValue('='),
    arguments: [queryKey],
  });
  const normalized = canonicalizeValue(result);
  if (normalized.kind !== VALUE_KIND.BOOLEAN) {
    throw new SmalltalkDictionaryProtocolError(`= answered a ${normalized.kind} Value; = must answer a Boolean`);
  }
  return normalized.value;
}

// One probe, shared by every read and by the write path, so lookup and insertion can never disagree
// about where a key lives. Answers the matching bucket index, or the first free one.
async function locate({buckets, capacity, hash, key, sendMessage}) {
  let firstFree = null;
  for (const index of probeSequence(hash, capacity)) {
    const bucket = buckets[index];
    if (bucket.hash === null) {
      if (firstFree === null) firstFree = index;
      // Open addressing with no deletion: the first empty bucket ends the run, so a key that is not
      // here cannot be further along.
      return {found: null, free: firstFree};
    }
    if (sameStoredHash(bucket.hash, hash) && await sendEquals({sendMessage, storedKey: bucket.key, queryKey: key})) {
      return {found: index, free: firstFree};
    }
  }
  return {found: null, free: firstFree};
}

async function dictionaryInitialize({images, primitiveImage, value, newObjectId, maxIdentityAttempts}) {
  const primitive = SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE;
  assertLocalRef(value, primitiveImage, primitive, 'a Dictionary');
  const record = await images.getObject(value.imageId, value.objectId);
  if (!record) throw new SmalltalkDanglingEdgeError('dictionary', value, value);
  const kernel = await findSmalltalkKernel({images, imageId: primitiveImage});
  if (!kernel) throw new TypeError(`image ${primitiveImage} has no Smalltalk kernel`);

  const tableRef = await publishTable({
    images,
    primitiveImage,
    buckets: emptyBuckets(DICTIONARY_MINIMUM_CAPACITY),
    kernel,
    newObjectId,
    maxIdentityAttempts,
  });
  await images.putObject(primitiveImage, {
    id: record.id,
    shape: record.shape,
    behavior: record.behavior,
    slots: {...record.slots, [DICTIONARY_TABLE_SLOT]: tableRef},
    metadata: record.metadata,
  }, {expectedVersion: record._version});
  return value;
}

// A published table is never rewritten, so every snapshot gets a fresh identity under the same
// create-once rule ADR 0046 gave ordinary allocation.
async function publishTable({images, primitiveImage, buckets, kernel, newObjectId, maxIdentityAttempts}) {
  const fields = tableRecordFields({
    buckets,
    shapeRef: objectRef(primitiveImage, DICTIONARY_TABLE_SHAPE_ID),
    nilRef: kernel.nil,
  });
  for (let attempt = 0; attempt < maxIdentityAttempts; attempt += 1) {
    const candidate = newObjectId();
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new TypeError('Smalltalk object identity generator must answer non-empty text');
    }
    try {
      const stored = await images.putObject(primitiveImage, {id: candidate, ...fields}, {expectedVersion: 0});
      return objectRef(primitiveImage, stored.id);
    } catch (error) {
      if (error?.name !== 'VersionConflictError') throw error;
    }
  }
  throw new TypeError(`Symmetric Smalltalk Dictionary could not find a free table identity in ${primitiveImage}`);
}

async function dictionarySize({images, primitiveImage, value}) {
  const {table} = await loadDictionary({
    images, primitiveImage, value, primitive: SMALLTALK_PRIMITIVE.DICTIONARY_SIZE,
  });
  return integerValue(table.tally);
}

async function dictionaryLookup({images, primitiveImage, value, keyValue, primitive, sendMessage}) {
  const kernel = await findSmalltalkKernel({images, imageId: primitiveImage});
  if (!kernel) throw new TypeError(`image ${primitiveImage} has no Smalltalk kernel`);
  const {table} = await loadDictionary({images, primitiveImage, value, primitive});
  const hash = await sendHash({sendMessage, key: keyValue, kernel});
  const {found} = await locate({
    buckets: table.buckets, capacity: table.capacity, hash, key: keyValue, sendMessage,
  });
  return {found, table};
}

async function dictionaryIncludesKey({images, primitiveImage, value, keyValue, sendMessage}) {
  const {found} = await dictionaryLookup({
    images, primitiveImage, value, keyValue, sendMessage,
    primitive: SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY,
  });
  return booleanValue(found !== null);
}

async function dictionaryAt({
  images, primitiveImage, value, keyValue, sendMessage, context, newObjectId, maxIdentityAttempts,
}) {
  const {found, table} = await dictionaryLookup({
    images, primitiveImage, value, keyValue, sendMessage,
    primitive: SMALLTALK_PRIMITIVE.DICTIONARY_AT,
  });
  // ADR 0054 decision 8: a missing key is a catchable `KeyNotFound`, so `at:ifAbsent:` over a
  // Dictionary is writable in Smalltalk for the same reason it is over an OrderedCollection.
  if (found === null) {
    return await signalHostCondition({
      images,
      primitiveImage,
      context,
      classId: HOST_CONDITION_CLASS.keyNotFound,
      hostError: new SmalltalkDictionaryKeyNotFoundError(value),
      newObjectId,
      maxIdentityAttempts,
    });
  }
  return table.buckets[found].value;
}

async function dictionaryAtPut({
  images, primitiveImage, value, keyValue, newValue, sendMessage, newObjectId, maxIdentityAttempts, context,
}) {
  const primitive = SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT;
  // Both, because a Dictionary makes its keys durably reachable exactly as it does its values.
  keyValue = await promoted(context, keyValue);
  newValue = await promoted(context, newValue);
  const kernel = await findSmalltalkKernel({images, imageId: primitiveImage});
  if (!kernel) throw new TypeError(`image ${primitiveImage} has no Smalltalk kernel`);

  // Step 1: the version observed here is what the final swap is conditioned on.
  const {record, table} = await loadDictionary({images, primitiveImage, value, primitive});
  const observedVersion = record._version;

  // Steps 2 and 3: user code runs here, and may do anything at all.
  const hash = await sendHash({sendMessage, key: keyValue, kernel});
  const {found, free} = await locate({
    buckets: table.buckets, capacity: table.capacity, hash, key: keyValue, sendMessage,
  });

  const stored = canonicalizeValue(newValue);
  // The one recognized no-op: an equal key already holding the exact same canonical Value. This is
  // canonical-Value identity of the *stored value*, not a second dynamic `=` send, and it is what
  // makes an exact caller retry after a lost acknowledgement idempotent in durable state.
  //
  // It is still a claim about durable state made *after* arbitrary user code ran, so it is
  // conditioned on exactly the version the write path CASes against. Returning from the stale
  // snapshot alone would let a re-entrant `hash`/`=` mutate this Dictionary while the outer
  // operation reported success — a false success, which is worse than the conflict it hides.
  if (found !== null && sameCanonicalValue(table.buckets[found].value, stored)) {
    const current = await images.getObject(value.imageId, value.objectId);
    if (!current || current._version !== observedVersion) throw new SmalltalkDictionaryConflictError(value);
    return stored;
  }

  // Step 4: a complete next snapshot, in memory.
  let buckets = table.buckets.map((bucket) => ({...bucket}));
  if (found !== null) {
    buckets[found] = {...buckets[found], value: stored};
  } else {
    let capacity = table.capacity;
    if (needsGrowth(table.tally + 1, capacity)) {
      capacity = grownCapacity(capacity);
      buckets = reinsert(buckets, capacity);
    }
    let placed = false;
    for (const index of probeSequence(hash, capacity)) {
      if (buckets[index].hash === null) {
        buckets[index] = {hash, key: canonicalizeValue(keyValue), value: stored};
        placed = true;
        break;
      }
    }
    if (!placed) throw new SmalltalkDictionaryProtocolError('no free bucket below the load factor, which cannot happen');
    void free;
  }

  // Step 5: publish the new table under fresh identity. Still invisible: nothing points at it.
  const tableRef = await publishTable({
    images, primitiveImage, buckets, kernel, newObjectId, maxIdentityAttempts,
  });

  // Step 6: one compare-and-set. A reader sees the old complete mapping or the new one.
  try {
    await images.putObject(primitiveImage, {
      id: record.id,
      shape: record.shape,
      behavior: record.behavior,
      slots: {...record.slots, [DICTIONARY_TABLE_SLOT]: tableRef},
      metadata: record.metadata,
    }, {expectedVersion: observedVersion});
  } catch (error) {
    // The freshly written table is now unreachable garbage. That is strictly better than installing
    // a snapshot built from state some other mutation has already superseded.
    if (error?.name === 'VersionConflictError') throw new SmalltalkDictionaryConflictError(value);
    throw error;
  }
  return stored;
}

// Workstream 3 (MessagePack pressure: `writeMap:` walks every pair). The one enumeration
// operation, Dictionary-owned: the bucket triples live below ordinary message sends, so no
// Smalltalk composition of the existing protocol can visit the pairs — `at:` needs a key it does
// not have yet. This is categorically different from `between:and:`, which is expressible over
// `<` and stays source-only. It is deliberately NOT a generic "iterate object internals"
// operation: it acts only on an initialized Dictionary, through the same `loadDictionary` that
// validates the representation for every other Dictionary primitive.
//
// What it promises, and does not:
//   snapshot     the pairs are fixed before the first Block runs. The loaded table record is an
//                immutable published snapshot (ADR 0048 decision 5), so a Block that mutates this
//                Dictionary swaps the `table` ref to a *new* snapshot while this traversal keeps
//                visiting the complete mapping it started from — mutation during enumeration never
//                invalidates the traversal, and never makes a pair appear twice or half-updated.
//   no rehash    neither `hash` nor `=` is sent. Enumeration visits stored pairs; it looks nothing
//                up, so user equality code runs zero times here.
//   no order     bucket order is a representation accident (it moves on growth), so no iteration
//                order is promised. Code that needs one must sort what it collects.
async function dictionaryKeysAndValuesDo({images, primitiveImage, value, blockValue, sendMessage}) {
  const primitive = SMALLTALK_PRIMITIVE.DICTIONARY_KEYS_AND_VALUES_DO;
  const {table} = await loadDictionary({images, primitiveImage, value, primitive});
  // The same structural Block guard the loop primitives use, for the same reason: the pair Block is
  // about to be applied on this primitive's behalf, and a kernel-primitive Block handed in here
  // would run a primitive with Dictionary-chosen arguments.
  const block = await assertLoopBlock({images, value: blockValue, primitive, role: 'pair block'});
  const pairs = table.buckets
    .filter((bucket) => bucket.hash !== null)
    .map((bucket) => ({key: bucket.key, value: bucket.value}));
  for (const pair of pairs) {
    // An ordinary `value:value:` send, exactly like a loop body (ADR 0051): lexical frame
    // restoration, authority attenuation and the dispatch image are inherited, not reimplemented.
    // Each `await` returns before the next send begins, so the sends are siblings and activation
    // depth does not grow with the number of pairs.
    await sendMessage({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: block,
      message: textValue('value:value:'),
      arguments: [pair.key, pair.value],
    });
  }
  // Answers the receiver, as Smalltalk enumeration protocol does.
  return value;
}

export {
  SmalltalkDictionaryConflictError,
  SmalltalkDictionaryKeyNotFoundError,
  SmalltalkDictionaryProtocolError,
  builtInEqualsPrimitive,
  builtInHashPrimitive,
  dictionaryAt,
  dictionaryAtPut,
  dictionaryIncludesKey,
  dictionaryInitialize,
  dictionaryKeysAndValuesDo,
  dictionarySize,
};
