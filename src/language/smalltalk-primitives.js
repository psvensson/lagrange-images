import {randomUUID} from 'node:crypto';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {SHAPE_INDEXED, shapeIndexedKind} from '../object/model.js';
import {
  builtInEquals,
  builtInHash,
  normalizeBooleanSingleton,
} from './smalltalk-equality.js';
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
  VALUE_KIND,
  booleanValue,
  canonicalizeValue,
  integerValue,
  isObjectRef,
  objectRef,
  textValue,
} from '../value/index.js';
import {TupleSet} from '../support/tuple-map.js';
import {findSmalltalkKernel, readBehavior} from './smalltalk-kernel.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';
import {
  SmalltalkDanglingEdgeError,
  SmalltalkMalformedBehaviorError,
  behaviorRefFor,
  sameRef,
  visibleInstanceShape,
} from './smalltalk-lookup.js';

// ADR 0046 introduced the representation for the image operations the shared IR cannot express;
// ADR 0047 extends the *same* language-owned primitive family rather than inventing a second ABI.
// They are ordinary Blocks for invocation, and both execution lanes reach them through ordinary
// sends, so neither lagrange-code nor the dispatcher learns collection semantics.
const SMALLTALK_KERNEL_PRIMITIVE_V1 = 'smalltalk-kernel-primitive/v1';

const SMALLTALK_PRIMITIVE = Object.freeze({
  CLASS_OF: 'class-of',
  BASIC_NEW: 'basic-new',
  BASIC_NEW_SIZED: 'basic-new-sized',
  INDEXED_SIZE: 'indexed-size',
  INDEXED_AT: 'indexed-at',
  INDEXED_AT_PUT: 'indexed-at-put',
  BUILT_IN_EQUALS: 'built-in-equals',
  BUILT_IN_HASH: 'built-in-hash',
  DICTIONARY_INITIALIZE: 'dictionary-initialize',
  DICTIONARY_SIZE: 'dictionary-size',
  DICTIONARY_INCLUDES_KEY: 'dictionary-includes-key',
  DICTIONARY_AT: 'dictionary-at',
  DICTIONARY_AT_PUT: 'dictionary-at-put',
  INSTANCE_SLOT_READ: 'instance-slot-read',
  INSTANCE_SLOT_WRITE: 'instance-slot-write',
  // ADR 0051. These two are unlike every primitive above: they are not applied as
  // `aPrimitive value: x`, but dispatched with the condition Block as the receiver.
  BLOCK_WHILE_TRUE: 'block-while-true',
  BLOCK_WHILE_FALSE: 'block-while-false',
  // ADR 0053. One comparison, because four would be four chances for the set to disagree.
  INTEGER_LESS_THAN: 'integer-less-than',
  INTEGER_SUBTRACT: 'integer-subtract',
  INTEGER_MULTIPLY: 'integer-multiply',
  // Named for what it does, not for the operator it backs: the name becomes durable CodeArtifact
  // content, and `integer-divide` would imply the host truncation ADR 0053 decision 4 rejects.
  INTEGER_FLOOR_DIVIDE: 'integer-floor-divide',
  INTEGER_MODULO: 'integer-modulo',
});

// The loop primitives, kept as a set because their invocation shape and therefore their guard
// differ from every other primitive's.
const LOOP_PRIMITIVES = Object.freeze({
  [SMALLTALK_PRIMITIVE.BLOCK_WHILE_TRUE]: true,
  [SMALLTALK_PRIMITIVE.BLOCK_WHILE_FALSE]: false,
});

const SMALLTALK_PRIMITIVE_NAMES = Object.freeze(Object.values(SMALLTALK_PRIMITIVE));
const SMALLTALK_PRIMITIVE_ARITY = Object.freeze({
  [SMALLTALK_PRIMITIVE.CLASS_OF]: 1,
  [SMALLTALK_PRIMITIVE.BASIC_NEW]: 1,
  [SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED]: 2,
  [SMALLTALK_PRIMITIVE.INDEXED_SIZE]: 1,
  [SMALLTALK_PRIMITIVE.INDEXED_AT]: 2,
  [SMALLTALK_PRIMITIVE.INDEXED_AT_PUT]: 3,
  [SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS]: 2,
  [SMALLTALK_PRIMITIVE.BUILT_IN_HASH]: 1,
  [SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE]: 1,
  [SMALLTALK_PRIMITIVE.DICTIONARY_SIZE]: 1,
  [SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY]: 2,
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT]: 2,
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT]: 3,
  [SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ]: 2,
  [SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE]: 3,
  // One argument, the body Block; the condition Block arrives as the receiver.
  [SMALLTALK_PRIMITIVE.BLOCK_WHILE_TRUE]: 1,
  [SMALLTALK_PRIMITIVE.BLOCK_WHILE_FALSE]: 1,
  [SMALLTALK_PRIMITIVE.INTEGER_LESS_THAN]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_MODULO]: 2,
});

// One locality rule for every primitive. A foreign primitive Block must fail rather than answer a
// foreign kernel's class, allocate into somebody else's image, or mutate a foreign indexed object.
class SmalltalkPrimitiveLocalityError extends TypeError {
  constructor(primitive, primitiveImage, ref) {
    super(
      `Symmetric Smalltalk ${primitive} primitive in ${primitiveImage} cannot act on `
      + `${ref.imageId}/${ref.objectId}; a primitive is local to its own image`,
    );
    this.name = 'SmalltalkPrimitiveLocalityError';
    this.primitive = primitive;
    this.primitiveImage = primitiveImage;
  }
}

// ADR 0046: `instanceShape == nil` means "not instantiable", never "empty instance". Kept distinct
// from a malformed Behavior and from a dangling Shape edge.
class SmalltalkNotInstantiableError extends TypeError {
  constructor(classRef) {
    super(
      `${classRef.imageId}/${classRef.objectId} has no instance shape, so it cannot be instantiated; `
      + 'an instantiable class points at a Shape, and an empty Shape is not nil',
    );
    this.name = 'SmalltalkNotInstantiableError';
    this.classRef = classRef;
  }
}

class SmalltalkNotIndexedError extends TypeError {
  constructor(primitive, ref) {
    super(
      `Symmetric Smalltalk ${primitive} requires an indexed object layout; `
      + `${ref.imageId}/${ref.objectId} does not declare indexed values`,
    );
    this.name = 'SmalltalkNotIndexedError';
    this.primitive = primitive;
    this.ref = ref;
  }
}

class SmalltalkIndexedBoundsError extends RangeError {
  constructor(primitive, zeroBasedIndex, size) {
    super(
      `Symmetric Smalltalk ${primitive} index ${zeroBasedIndex.toString()} is outside `
      + `the 0-based indexed part of size ${size}`,
    );
    this.name = 'SmalltalkIndexedBoundsError';
    this.primitive = primitive;
    this.index = zeroBasedIndex.toString();
    this.size = size;
  }
}

class SmalltalkPrimitiveReceiverError extends TypeError {
  constructor(primitive, description) {
    super(`Symmetric Smalltalk ${primitive} primitive cannot act on ${description}`);
    this.name = 'SmalltalkPrimitiveReceiverError';
    this.primitive = primitive;
  }
}

function parsePrimitiveCode(code) {
  if (code.content?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(`${SMALLTALK_KERNEL_PRIMITIVE_V1} content must be a text Value`);
  }
  let declaration;
  try {
    declaration = JSON.parse(code.content.value);
  } catch (error) {
    throw new TypeError(`${SMALLTALK_KERNEL_PRIMITIVE_V1} content must contain valid JSON`, {cause: error});
  }
  const keys = Object.keys(declaration ?? {});
  if (keys.length !== 1 || keys[0] !== 'primitive') {
    throw new TypeError(`${SMALLTALK_KERNEL_PRIMITIVE_V1} content must contain exactly primitive`);
  }
  if (!SMALLTALK_PRIMITIVE_NAMES.includes(declaration.primitive)) {
    throw new TypeError(`unknown ${SMALLTALK_KERNEL_PRIMITIVE_V1} primitive: ${declaration.primitive}`);
  }
  return declaration.primitive;
}

function primitiveCodeContent(primitive) {
  if (!SMALLTALK_PRIMITIVE_NAMES.includes(primitive)) {
    throw new TypeError(`unknown ${SMALLTALK_KERNEL_PRIMITIVE_V1} primitive: ${primitive}`);
  }
  return JSON.stringify({primitive});
}

function assertLocalRef(value, primitiveImage, primitive, description) {
  if (!isObjectRef(value)) {
    throw new SmalltalkPrimitiveReceiverError(
      primitive,
      value?.kind ? `a ${value.kind} Value; ${description}` : `a non-ref; ${description}`,
    );
  }
  if (value.imageId !== primitiveImage) {
    throw new SmalltalkPrimitiveLocalityError(primitive, primitiveImage, value);
  }
  return value;
}

// ADR 0046 decision 9. Deliberately routed through the same `behaviorRefFor` the dispatcher uses, so
// `class` cannot drift from what a send would actually dispatch through.
async function classOf({images, primitiveImage, value}) {
  if (isObjectRef(value) && value.imageId !== primitiveImage) {
    throw new SmalltalkPrimitiveLocalityError(SMALLTALK_PRIMITIVE.CLASS_OF, primitiveImage, value);
  }
  const {behavior} = await behaviorRefFor({images, receiver: value, dispatchImage: primitiveImage});
  if (!isObjectRef(behavior)) {
    throw new SmalltalkPrimitiveReceiverError(
      SMALLTALK_PRIMITIVE.CLASS_OF,
      isObjectRef(value)
        ? `${value.imageId}/${value.objectId}, which has no behavior`
        : `a ${value.kind} Value`,
    );
  }
  return behavior;
}

async function loadAllocationClass({images, primitiveImage, classValue, primitive}) {
  assertLocalRef(classValue, primitiveImage, primitive, 'only an unpinned class ref allocates');

  const kernel = await findSmalltalkKernel({images, imageId: primitiveImage});
  if (!kernel) throw new TypeError(`image ${primitiveImage} has no Smalltalk kernel to allocate against`);

  const record = await images.getObject(classValue.imageId, classValue.objectId);
  if (!record) throw new SmalltalkDanglingEdgeError('class', classValue, classValue);
  let behavior;
  try {
    behavior = await readBehavior(images, classValue);
  } catch (error) {
    throw new SmalltalkMalformedBehaviorError(classValue, error);
  }

  if (sameRef(behavior.instanceShape, kernel.nil)) throw new SmalltalkNotInstantiableError(classValue);

  const shapeRef = behavior.instanceShape;
  const shape = await images.getShape(shapeRef.imageId, shapeRef.objectId);
  if (!shape) throw new SmalltalkDanglingEdgeError('instanceShape', behavior.record, shapeRef);
  return {kernel, behavior, shapeRef, shape};
}

function nonNegativeSize(value, primitive) {
  const normalized = canonicalizeValue(value);
  if (normalized.kind !== VALUE_KIND.INTEGER) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a ${normalized.kind} size; size must be an Integer Value`);
  }
  const size = BigInt(normalized.value);
  if (size < 0n) throw new RangeError(`Symmetric Smalltalk ${primitive} size must be non-negative`);
  // Durable indices are unbounded integer Values, but this JavaScript representation is an Array.
  // Fail explicitly rather than letting an implementation RangeError or allocation overflow define
  // language behavior by accident.
  if (size > 0xffff_ffffn) {
    throw new RangeError(`Symmetric Smalltalk ${primitive} size exceeds the current indexed-object implementation limit`);
  }
  return Number(size);
}

async function allocate({
  images,
  primitiveImage,
  classValue,
  primitive,
  indexedSize = null,
  newObjectId,
  maxIdentityAttempts,
}) {
  const {kernel, shapeRef, shape} = await loadAllocationClass({
    images, primitiveImage, classValue, primitive,
  });
  const indexedKind = shapeIndexedKind(shape);
  if (indexedSize !== null && indexedKind !== SHAPE_INDEXED.VALUES) {
    throw new SmalltalkNotIndexedError(primitive, classValue);
  }

  const slots = Object.fromEntries(shape.slots.map(({id}) => [id, kernel.nil]));
  // `basicNew` on an indexed class means its zero-length form. `basicNew:` supplies the fixed size.
  // A non-indexed shape omits the property entirely, preserving the old record form.
  const indexed = indexedKind === SHAPE_INDEXED.VALUES
    ? Array.from({length: indexedSize ?? 0}, () => kernel.nil)
    : null;

  // ADR 0046 identity rule: a known collision chooses another candidate; every other failure
  // surfaces, and a new Smalltalk send always begins with a fresh candidate.
  for (let attempt = 0; attempt < maxIdentityAttempts; attempt += 1) {
    const candidate = newObjectId();
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new TypeError('Smalltalk object identity generator must answer non-empty text');
    }
    try {
      const stored = await images.putObject(primitiveImage, {
        id: candidate,
        shape: shapeRef,
        behavior: classValue,
        slots,
        ...(indexed === null ? {} : {indexed}),
        metadata: {},
      }, {expectedVersion: 0});
      return objectRef(primitiveImage, stored.id);
    } catch (error) {
      if (error?.name !== 'VersionConflictError') throw error;
    }
  }
  throw new TypeError(
    `Symmetric Smalltalk ${primitive} could not find a free object identity in ${primitiveImage} `
    + `after ${maxIdentityAttempts} attempts`,
  );
}

async function basicNew({images, primitiveImage, classValue, newObjectId, maxIdentityAttempts}) {
  return await allocate({
    images,
    primitiveImage,
    classValue,
    primitive: SMALLTALK_PRIMITIVE.BASIC_NEW,
    newObjectId,
    maxIdentityAttempts,
  });
}

async function basicNewSized({images, primitiveImage, classValue, sizeValue, newObjectId, maxIdentityAttempts}) {
  const size = nonNegativeSize(sizeValue, SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED);
  return await allocate({
    images,
    primitiveImage,
    classValue,
    primitive: SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED,
    indexedSize: size,
    newObjectId,
    maxIdentityAttempts,
  });
}

async function loadIndexedObject({images, primitiveImage, value, primitive}) {
  const ref = assertLocalRef(value, primitiveImage, primitive, 'only an unpinned object ref has indexed state');
  const record = await images.getObject(ref.imageId, ref.objectId);
  if (!record) throw new SmalltalkDanglingEdgeError('indexed receiver', ref, ref);
  const shape = await images.getShape(record.shape.imageId, record.shape.objectId);
  if (!shape) throw new SmalltalkDanglingEdgeError('shape', record, record.shape);
  if (shapeIndexedKind(shape) !== SHAPE_INDEXED.VALUES || !Object.hasOwn(record, 'indexed')) {
    throw new SmalltalkNotIndexedError(primitive, ref);
  }
  return record;
}

function zeroBasedIndex(value, length, primitive) {
  const normalized = canonicalizeValue(value);
  if (normalized.kind !== VALUE_KIND.INTEGER) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a ${normalized.kind} index; index must be an Integer Value`);
  }
  const index = BigInt(normalized.value);
  if (index < 0n || index >= BigInt(length)) throw new SmalltalkIndexedBoundsError(primitive, index, length);
  return Number(index);
}

async function indexedSize({images, primitiveImage, value}) {
  const record = await loadIndexedObject({
    images, primitiveImage, value, primitive: SMALLTALK_PRIMITIVE.INDEXED_SIZE,
  });
  return integerValue(record.indexed.length);
}

async function indexedAt({images, primitiveImage, value, indexValue}) {
  const record = await loadIndexedObject({
    images, primitiveImage, value, primitive: SMALLTALK_PRIMITIVE.INDEXED_AT,
  });
  const index = zeroBasedIndex(indexValue, record.indexed.length, SMALLTALK_PRIMITIVE.INDEXED_AT);
  return record.indexed[index];
}

async function indexedAtPut({images, primitiveImage, value, indexValue, newValue, context}) {
  const record = await loadIndexedObject({
    images, primitiveImage, value, primitive: SMALLTALK_PRIMITIVE.INDEXED_AT_PUT,
  });
  const index = zeroBasedIndex(indexValue, record.indexed.length, SMALLTALK_PRIMITIVE.INDEXED_AT_PUT);
  const storedValue = canonicalizeValue(await promoted(context, newValue));
  const indexed = [...record.indexed];
  indexed[index] = storedValue;
  await images.putObject(primitiveImage, {
    id: record.id,
    shape: record.shape,
    behavior: record.behavior,
    slots: record.slots,
    indexed,
    metadata: record.metadata,
  }, {expectedVersion: record._version});
  return storedValue;
}

// ADR 0048 decisions 2 and 3, at the primitive boundary. The helpers themselves are pure; what the
// primitive adds is the ADR 0045 bridge normalization, so `true = true` does not depend on whether
// each operand arrived as the singleton ref or as the canonical boolean.
// General Dictionary lookup is defined to *send* hash and =, so an execution context without a
// message runtime cannot serve these primitives — failing here is clearer than a lookup that
// silently used the built-in helper and ignored a user override.
// ADR 0052 decision 6: writing into a slot, an indexed part or a Dictionary makes a value durably
// reachable, so it is an escape. Each of these boundaries rewrites the value through the one central
// promoter and then performs its existing write unchanged — the promotion is the boundary's job, not
// the graph guard's.
//
// A context without `promote` is an execution that predates this seam rather than an error: the
// value passes through, and the graph guard still refuses a transient ref, so a missed boundary
// fails loudly instead of silently persisting a dangling reference.
async function promoted(context, value) {
  return typeof context?.promote === 'function' ? await context.promote(value) : value;
}

function requireSendMessage(context, primitive) {
  if (typeof context?.sendMessage !== 'function') {
    throw new TypeError(`Symmetric Smalltalk ${primitive} primitive requires a message runtime to send hash and =`);
  }
  return context.sendMessage;
}

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

async function dictionaryAt({images, primitiveImage, value, keyValue, sendMessage}) {
  const {found, table} = await dictionaryLookup({
    images, primitiveImage, value, keyValue, sendMessage,
    primitive: SMALLTALK_PRIMITIVE.DICTIONARY_AT,
  });
  if (found === null) throw new SmalltalkDictionaryKeyNotFoundError(value);
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

// ADR 0050 decisions 5, 5a and 6. Two checks that answer different questions, kept apart because
// collapsing them is exactly how the Parent/Child hole opens:
//
//   may this method name this slot?   the slot is declared by the defining Behavior's visible layout
//   does this object have it?         the slot is in the target's *current* Shape
//
// Plus the one that makes both meaningful: the target must be this activation's `self`, proved from
// the transient frame rather than trusted from the argument.
class SmalltalkSlotAccessError extends TypeError {
  constructor(primitive, reason) {
    super(`Symmetric Smalltalk ${primitive} refused: ${reason}`);
    this.name = 'SmalltalkSlotAccessError';
    this.primitive = primitive;
  }
}

class SmalltalkSlotFrameMissingError extends TypeError {
  constructor(primitive) {
    super(
      `Symmetric Smalltalk ${primitive} has no method frame; instance state is reachable only from a `
      + 'method of the declaring class, and a closure that outlived its execution no longer has one',
    );
    this.name = 'SmalltalkSlotFrameMissingError';
    this.primitive = primitive;
  }
}

function sameValueRef(left, right) {
  if (isObjectRef(left) && isObjectRef(right)) {
    return left.imageId === right.imageId && left.objectId === right.objectId;
  }
  return JSON.stringify(canonicalizeValue(left)) === JSON.stringify(canonicalizeValue(right));
}

async function resolveSlotAccess({images, primitiveImage, primitive, target, slotIdValue, context}) {
  const frame = context?.invocationFrame ?? null;
  if (!frame) throw new SmalltalkSlotFrameMissingError(primitive);
  if (slotIdValue?.kind !== VALUE_KIND.TEXT || slotIdValue.value.length === 0) {
    throw new SmalltalkSlotAccessError(primitive, 'a slot id must be non-empty text');
  }
  // Proved, not arranged by the compiler: a method is ordinary durable data, so a forged artifact
  // could otherwise pass any object at all.
  if (!sameValueRef(target, frame.self)) {
    throw new SmalltalkSlotAccessError(primitive, 'instance state is reachable only on the method own self');
  }
  assertLocalRef(target, primitiveImage, primitive, 'an instance');

  const kernel = await findSmalltalkKernel({images, imageId: primitiveImage});
  if (!kernel) throw new TypeError(`image ${primitiveImage} has no Smalltalk kernel`);

  // Shared with the binder, and strict: a cycle or a dangling instance Shape raises here rather
  // than presenting as "this method may not name that slot".
  const layout = await visibleInstanceShape({images, behaviorRef: frame.definingBehavior, nilRef: kernel.nil});
  if (!layout?.slots.some(({id}) => id === slotIdValue.value)) {
    throw new SmalltalkSlotAccessError(
      primitive,
      `${slotIdValue.value} is not declared by ${frame.definingBehavior.imageId}/${frame.definingBehavior.objectId}`,
    );
  }

  const record = await images.getObject(target.imageId, target.objectId);
  if (!record) throw new SmalltalkDanglingEdgeError('instance', target, target);
  const shape = await images.getShape(record.shape.imageId, record.shape.objectId);
  if (!shape) throw new SmalltalkDanglingEdgeError('instance shape', record, record.shape);
  // A separate structural question from permission: stale or migrated layout is corruption, never
  // nil and never an opportunity to add a slot.
  if (!shape.slots.some(({id}) => id === slotIdValue.value)) {
    throw new SmalltalkSlotAccessError(
      primitive,
      `${slotIdValue.value} is absent from the current shape of ${target.imageId}/${target.objectId}`,
    );
  }
  return {record, slotId: slotIdValue.value};
}

async function instanceSlotRead({images, primitiveImage, target, slotIdValue, context}) {
  const {record, slotId} = await resolveSlotAccess({
    images, primitiveImage, primitive: SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ, target, slotIdValue, context,
  });
  return record.slots[slotId];
}

async function instanceSlotWrite({images, primitiveImage, target, slotIdValue, newValue, context}) {
  const {record, slotId} = await resolveSlotAccess({
    images, primitiveImage, primitive: SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE, target, slotIdValue, context,
  });
  const stored = canonicalizeValue(await promoted(context, newValue));
  await images.putObject(primitiveImage, {
    id: record.id,
    shape: record.shape,
    behavior: record.behavior,
    slots: {...record.slots, [slotId]: stored},
    // Everything else survives. ADR 0047's review found the mutation binding erasing an indexed part
    // it did not carry forward; a named-slot write rebuilds a whole record for the same reason.
    ...(Object.hasOwn(record, 'indexed') ? {indexed: record.indexed} : {}),
    metadata: record.metadata,
  }, {expectedVersion: record._version});
  return stored;
}

// ADR 0053. Two Integers, and nothing else: mixed Integer/Float *ordering and arithmetic* need
// coercion rules this ADR deliberately defers. Mixed *equality* is untouched — ADR 0048 already
// decided that an Integer equals a finite integral Float of the same mathematical value.
class SmalltalkIntegerOperandError extends TypeError {
  constructor(primitive, kind, position) {
    super(`Symmetric Smalltalk ${primitive} primitive requires two Integers; the ${position} is a ${kind} Value`);
    this.name = 'SmalltalkIntegerOperandError';
    this.primitive = primitive;
  }
}

class SmalltalkDivideByZeroError extends TypeError {
  constructor(primitive) {
    super(`Symmetric Smalltalk ${primitive} primitive cannot divide by zero`);
    this.name = 'SmalltalkDivideByZeroError';
    this.primitive = primitive;
  }
}

const SMALLTALK_INTEGER_ARITY = Object.freeze({
  [SMALLTALK_PRIMITIVE.INTEGER_LESS_THAN]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_MODULO]: 2,
});

function integerOperands(primitive, left, right) {
  const a = canonicalizeValue(left);
  const b = canonicalizeValue(right);
  if (a.kind !== VALUE_KIND.INTEGER) throw new SmalltalkIntegerOperandError(primitive, a.kind, 'receiver');
  if (b.kind !== VALUE_KIND.INTEGER) throw new SmalltalkIntegerOperandError(primitive, b.kind, 'argument');
  // BigInt throughout: an Integer Value is arbitrary precision, and a host number round-trip would
  // silently round anything past 2^53.
  return [BigInt(a.value), BigInt(b.value)];
}

// q = floor(a / b). Host BigInt division truncates toward zero, so the correction below is the whole
// point of this primitive existing rather than the operator being wired straight through.
function floorDivide(a, b) {
  const quotient = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? quotient - 1n : quotient;
}

function integerOperation(primitive, left, right) {
  const [a, b] = integerOperands(primitive, left, right);
  switch (primitive) {
    case SMALLTALK_PRIMITIVE.INTEGER_LESS_THAN:
      return booleanValue(a < b);
    case SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT:
      return integerValue(a - b);
    case SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY:
      return integerValue(a * b);
    case SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE:
      if (b === 0n) throw new SmalltalkDivideByZeroError(primitive);
      return integerValue(floorDivide(a, b));
    default:
      // r = a - q*b, so the remainder takes the divisor's sign: 0 <= r < b for b > 0, and
      // b < r <= 0 for b < 0. That range — not the reconstruction identity, which a truncating
      // implementation also satisfies — is what makes `\\` usable for hashing and indexing.
      if (b === 0n) throw new SmalltalkDivideByZeroError(primitive);
      return integerValue(a - floorDivide(a, b) * b);
  }
}

// ADR 0051 decision 4. Every other primitive is applied as `aPrimitive value: x`, so
// `assertBlockApplicationReceiver` can demand that the activation's receiver *is* the Block. A loop
// primitive is dispatched instead, with the condition Block as receiver, so that guard cannot apply
// and something must replace it — otherwise `aLoopPrimitive value: aBlock` would arrive with the
// primitive itself as the condition, which is precisely the bypass the structural rule below closes.
//
// "Kernel-primitive Block" is the existing structural test and nothing else: the Block's CodeArtifact
// has representation `smalltalk-kernel-primitive/v1`. That is already how the dispatcher decides
// frame inheritance for a Block send, so this reuses a definition the system depends on rather than
// adding a second, weaker notion of "is a primitive" that the two could drift apart on.
async function assertLoopBlock({images, value, primitive, role}) {
  // A direct `invokeBlock` leaves the receiver null, which `assertBlockApplicationReceiver` treats as
  // the legitimate direct-application case. For a loop primitive it is not legitimate at all: there
  // is no condition Block, so say that rather than failing later on an untagged value.
  if (value === null || value === undefined) {
    throw new SmalltalkPrimitiveReceiverError(
      primitive,
      `no ${role}; a loop primitive is reachable only by dispatching whileTrue: or whileFalse:`,
    );
  }
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a ${ref.kind} Value as the ${role}`);
  }
  const block = await images.getBlock(ref.imageId, ref.objectId);
  if (!block) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `${ref.imageId}/${ref.objectId} as the ${role}, which is not a Block`);
  }
  const code = block.code && await images.getCodeArtifact(block.code.imageId, block.code.objectId);
  if (code?.representation === SMALLTALK_KERNEL_PRIMITIVE_V1) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a kernel-primitive Block as the ${role}`);
  }
  return ref;
}

// The loop itself. Every evaluation is an ordinary nested `value` send through the execution
// context, never a direct execution of the Block's code, so lexical frame restoration, authority
// attenuation, the dispatch image and cell arenas are inherited rather than reimplemented here.
//
// Constant activation depth falls out of the shape rather than from any bookkeeping: each `await`
// returns before the next send begins, so the sends are siblings from this one activation rather
// than a nesting chain, and depth does not grow with iteration count.
async function blockWhile({images, activation, context, primitive, wanted}) {
  const condition = await assertLoopBlock({
    images, value: activation.receiver, primitive, role: 'condition',
  });
  const body = await assertLoopBlock({
    images, value: activation.arguments[0], primitive, role: 'body',
  });
  const sendMessage = requireSendMessage(context, primitive);

  // ADR 0051 decision 12: the loop answers the condition image's nil, rediscovered from that image's
  // current kernel rather than captured at install time — a captured nil would keep answering after
  // the image's kernel changed underneath it. Resolved before the first iteration so a broken kernel
  // fails as a kernel failure rather than after the body has already had effects.
  const conditionImage = condition.imageId;
  const kernel = await findSmalltalkKernel({images, imageId: conditionImage});
  if (!kernel) {
    throw new TypeError(
      `Symmetric Smalltalk ${primitive} primitive requires a Smalltalk kernel in ${conditionImage} to answer nil`,
    );
  }

  for (;;) {
    const verdict = canonicalizeValue(await sendMessage({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: condition,
      message: textValue('value'),
      arguments: [],
    }));
    // ADR 0051 decision 7: a canonical boolean, and nothing else. Accepting more would introduce a
    // second, looser notion of truth beside the polymorphism ADR 0045 established.
    if (verdict.kind !== VALUE_KIND.BOOLEAN) {
      throw new TypeError(
        `Symmetric Smalltalk ${primitive} condition answered a ${verdict.kind} Value; a Boolean is required`,
      );
    }
    if (verdict.value !== wanted) return kernel.nil;
    await sendMessage({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: body,
      message: textValue('value'),
      arguments: [],
    });
  }
}

// `newObjectId` is runtime machinery, not durable class semantics, so it is injectable.
function createSmalltalkKernelPrimitiveV1Executor({
  newObjectId = randomUUID,
  maxIdentityAttempts = 8,
} = {}) {
  if (typeof newObjectId !== 'function') throw new TypeError('newObjectId must be a function');
  if (!Number.isInteger(maxIdentityAttempts) || maxIdentityAttempts < 1) {
    throw new TypeError('maxIdentityAttempts must be a positive integer');
  }
  return Object.freeze({
    async execute({activation, code}, context) {
      const primitive = parsePrimitiveCode(code);
      // Primitive Blocks may only be called directly; making one a method must not smuggle `self`
      // past the primitive's own argument contract. The loop primitives are the one exception, and
      // not a weakening: they are dispatched rather than applied, so they carry their own stricter
      // structural guard on both the receiver and the argument (see `assertLoopBlock`).
      const isLoop = Object.hasOwn(LOOP_PRIMITIVES, primitive);
      if (!isLoop) {
        assertBlockApplicationReceiver(activation, `${SMALLTALK_KERNEL_PRIMITIVE_V1} ${primitive}`);
      }
      const expectedArity = SMALLTALK_PRIMITIVE_ARITY[primitive];
      if (activation.arguments.length !== expectedArity) {
        throw new TypeError(
          `Symmetric Smalltalk ${primitive} primitive expects exactly ${expectedArity} arguments, `
          + `received ${activation.arguments.length}`,
        );
      }
      const primitiveImage = activation.block.imageId;
      const images = context?.images;
      if (!images || typeof images.getObject !== 'function') {
        throw new TypeError('Symmetric Smalltalk primitives require an images service');
      }
      const [value, second, third] = activation.arguments;
      if (Object.hasOwn(SMALLTALK_INTEGER_ARITY, primitive)) {
        return integerOperation(primitive, value, second);
      }
      if (isLoop) {
        return await blockWhile({
          images, activation, context, primitive, wanted: LOOP_PRIMITIVES[primitive],
        });
      }

      switch (primitive) {
        case SMALLTALK_PRIMITIVE.CLASS_OF:
          return await classOf({images, primitiveImage, value});
        case SMALLTALK_PRIMITIVE.BASIC_NEW:
          return await basicNew({images, primitiveImage, classValue: value, newObjectId, maxIdentityAttempts});
        case SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED:
          return await basicNewSized({
            images,
            primitiveImage,
            classValue: value,
            sizeValue: second,
            newObjectId,
            maxIdentityAttempts,
          });
        case SMALLTALK_PRIMITIVE.INDEXED_SIZE:
          return await indexedSize({images, primitiveImage, value});
        case SMALLTALK_PRIMITIVE.INDEXED_AT:
          return await indexedAt({images, primitiveImage, value, indexValue: second});
        case SMALLTALK_PRIMITIVE.INDEXED_AT_PUT:
          return await indexedAtPut({images, primitiveImage, value, indexValue: second, newValue: third, context});
        case SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS:
          return await builtInEqualsPrimitive({images, primitiveImage, left: value, right: second});
        case SMALLTALK_PRIMITIVE.BUILT_IN_HASH:
          return await builtInHashPrimitive({images, primitiveImage, value});
        case SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ:
          return await instanceSlotRead({
            images, primitiveImage, target: value, slotIdValue: second, context,
          });
        case SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE:
          return await instanceSlotWrite({
            images, primitiveImage, target: value, slotIdValue: second, newValue: third, context,
          });
        case SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE:
          return await dictionaryInitialize({
            images, primitiveImage, value, newObjectId, maxIdentityAttempts,
          });
        case SMALLTALK_PRIMITIVE.DICTIONARY_SIZE:
          return await dictionarySize({images, primitiveImage, value});
        case SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY:
          return await dictionaryIncludesKey({
            images, primitiveImage, value, keyValue: second, sendMessage: requireSendMessage(context, primitive),
          });
        case SMALLTALK_PRIMITIVE.DICTIONARY_AT:
          return await dictionaryAt({
            images, primitiveImage, value, keyValue: second, sendMessage: requireSendMessage(context, primitive),
          });
        case SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT:
          return await dictionaryAtPut({
            images,
            primitiveImage,
            value,
            keyValue: second,
            newValue: third,
            sendMessage: requireSendMessage(context, primitive),
            newObjectId,
            maxIdentityAttempts,
            context,
          });
        default:
          throw new TypeError(`unknown ${SMALLTALK_KERNEL_PRIMITIVE_V1} primitive: ${primitive}`);
      }
    },
  });
}

export {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  SMALLTALK_PRIMITIVE_NAMES,
  SmalltalkDictionaryConflictError,
  SmalltalkDictionaryKeyNotFoundError,
  SmalltalkDictionaryProtocolError,
  SmalltalkDivideByZeroError,
  SmalltalkIntegerOperandError,
  SmalltalkIndexedBoundsError,
  SmalltalkNotIndexedError,
  SmalltalkNotInstantiableError,
  SmalltalkPrimitiveLocalityError,
  SmalltalkPrimitiveReceiverError,
  SmalltalkSlotAccessError,
  SmalltalkSlotFrameMissingError,
  createSmalltalkKernelPrimitiveV1Executor,
  parsePrimitiveCode,
  primitiveCodeContent,
};
