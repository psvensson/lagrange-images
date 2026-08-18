import {randomUUID} from 'node:crypto';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {SHAPE_INDEXED, shapeIndexedKind} from '../object/model.js';
import {
  VALUE_KIND,
  canonicalizeValue,
  integerValue,
  isObjectRef,
  objectRef,
} from '../value/index.js';
import {findSmalltalkKernel, readBehavior} from './smalltalk-kernel.js';
import {
  SmalltalkDanglingEdgeError,
  SmalltalkMalformedBehaviorError,
  behaviorRefFor,
  sameRef,
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
});

const SMALLTALK_PRIMITIVE_NAMES = Object.freeze(Object.values(SMALLTALK_PRIMITIVE));
const SMALLTALK_PRIMITIVE_ARITY = Object.freeze({
  [SMALLTALK_PRIMITIVE.CLASS_OF]: 1,
  [SMALLTALK_PRIMITIVE.BASIC_NEW]: 1,
  [SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED]: 2,
  [SMALLTALK_PRIMITIVE.INDEXED_SIZE]: 1,
  [SMALLTALK_PRIMITIVE.INDEXED_AT]: 2,
  [SMALLTALK_PRIMITIVE.INDEXED_AT_PUT]: 3,
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

async function indexedAtPut({images, primitiveImage, value, indexValue, newValue}) {
  const record = await loadIndexedObject({
    images, primitiveImage, value, primitive: SMALLTALK_PRIMITIVE.INDEXED_AT_PUT,
  });
  const index = zeroBasedIndex(indexValue, record.indexed.length, SMALLTALK_PRIMITIVE.INDEXED_AT_PUT);
  const storedValue = canonicalizeValue(newValue);
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
      // past the primitive's own argument contract.
      assertBlockApplicationReceiver(activation, `${SMALLTALK_KERNEL_PRIMITIVE_V1} ${primitive}`);
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
          return await indexedAtPut({images, primitiveImage, value, indexValue: second, newValue: third});
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
  SmalltalkIndexedBoundsError,
  SmalltalkNotIndexedError,
  SmalltalkNotInstantiableError,
  SmalltalkPrimitiveLocalityError,
  SmalltalkPrimitiveReceiverError,
  createSmalltalkKernelPrimitiveV1Executor,
  parsePrimitiveCode,
  primitiveCodeContent,
};
