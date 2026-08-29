import {SHAPE_INDEXED, shapeIndexedKind} from '../object/model.js';
import {HOST_CONDITION_CLASS} from './smalltalk-condition-ids.js';
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
  visibleInstanceShape,
} from './smalltalk-lookup.js';
import {
  SMALLTALK_PRIMITIVE,
  SmalltalkPrimitiveLocalityError,
  SmalltalkPrimitiveReceiverError,
  assertLocalRef,
  promoted,
  signalHostCondition,
} from './smalltalk-primitive-support.js';

// The object-shaped primitives: class identity, allocation, the indexed part, and instance-slot
// access. Everything here acts on one object's durable record and runs no user code beyond the
// conditions a failure may signal.

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
  context = null,
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

  // ADR 0060 decision 3. Inside an execution the object begins in the arena: the executor's
  // `mintObject` supplies a transient identity and holds the record, so allocation costs no durable
  // write unless the object escapes. The layout is identical to the durable form below, so
  // promotion is a copy, not a translation.
  if (typeof context?.mintObject === 'function') {
    return context.mintObject({
      imageId: primitiveImage,
      shape: shapeRef,
      behavior: classValue,
      slots,
      indexed,
      metadata: {},
    });
  }

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

async function basicNew({images, primitiveImage, classValue, newObjectId, maxIdentityAttempts, context = null}) {
  return await allocate({
    images,
    primitiveImage,
    classValue,
    primitive: SMALLTALK_PRIMITIVE.BASIC_NEW,
    newObjectId,
    maxIdentityAttempts,
    context,
  });
}

async function basicNewSized({images, primitiveImage, classValue, sizeValue, newObjectId, maxIdentityAttempts, context = null}) {
  const size = nonNegativeSize(sizeValue, SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED);
  return await allocate({
    images,
    primitiveImage,
    classValue,
    primitive: SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED,
    indexedSize: size,
    newObjectId,
    maxIdentityAttempts,
    context,
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

// ADR 0054 decision 8. `zeroBasedIndex` stays synchronous and keeps throwing — it is used where
// there is no execution context — so the signalling wrapper lives at the two sites that have one.
async function boundedIndex({
  images, primitiveImage, context, newObjectId, maxIdentityAttempts, indexValue, length, primitive,
}) {
  try {
    return {index: zeroBasedIndex(indexValue, length, primitive)};
  } catch (error) {
    if (!(error instanceof SmalltalkIndexedBoundsError)) throw error;
    return {
      resumed: await signalHostCondition({
        images,
        primitiveImage,
        context,
        classId: HOST_CONDITION_CLASS.indexBounds,
        hostError: error,
        newObjectId,
        maxIdentityAttempts,
      }),
    };
  }
}

async function indexedAt({images, primitiveImage, value, indexValue, context, newObjectId, maxIdentityAttempts}) {
  const record = await loadIndexedObject({
    images, primitiveImage, value, primitive: SMALLTALK_PRIMITIVE.INDEXED_AT,
  });
  const bounded = await boundedIndex({
    images, primitiveImage, context, newObjectId, maxIdentityAttempts, indexValue,
    length: record.indexed.length, primitive: SMALLTALK_PRIMITIVE.INDEXED_AT,
  });
  // A handler that resumed answers the access itself.
  if (Object.hasOwn(bounded, 'resumed')) return bounded.resumed;
  return record.indexed[bounded.index];
}

async function indexedAtPut({
  images, primitiveImage, value, indexValue, newValue, context, newObjectId, maxIdentityAttempts,
}) {
  const record = await loadIndexedObject({
    images, primitiveImage, value, primitive: SMALLTALK_PRIMITIVE.INDEXED_AT_PUT,
  });
  const bounded = await boundedIndex({
    images, primitiveImage, context, newObjectId, maxIdentityAttempts, indexValue,
    length: record.indexed.length, primitive: SMALLTALK_PRIMITIVE.INDEXED_AT_PUT,
  });
  if (Object.hasOwn(bounded, 'resumed')) return bounded.resumed;
  const index = bounded.index;
  // `value` is the receiver: writing into a transient indexed object keeps the value in the arena.
  const storedValue = canonicalizeValue(await promoted(context, newValue, value));
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
  // `target` is the receiver: writing into a transient object keeps the value in the arena.
  const stored = canonicalizeValue(await promoted(context, newValue, target));
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

export {
  SmalltalkIndexedBoundsError,
  SmalltalkNotIndexedError,
  SmalltalkNotInstantiableError,
  SmalltalkSlotAccessError,
  SmalltalkSlotFrameMissingError,
  basicNew,
  basicNewSized,
  classOf,
  indexedAt,
  indexedAtPut,
  indexedSize,
  instanceSlotRead,
  instanceSlotWrite,
};
