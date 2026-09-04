import {objectRef, isObjectRef} from '../value/index.js';
import {ensureObject} from '../graph/ensure-records.js';
import {findSmalltalkKernel, readBehavior, isBehaviorObject} from './smalltalk-kernel.js';

// Class-instance state: the per-class companion that holds the *values* for a
// class's class-instance variables.
//
// The representation has two halves (PR #147): a metaclass instance Shape
// declares the logical class-instance layout, and a companion object holds the
// values. This module is the single language-owned locus for the companion
// half — its deterministic identity, its lifecycle, and the dynamic-self
// routing that resolves a class-side slot access to the right companion. No
// class-state semantics live in the generic Object/Value/backend layers.
//
// The semantic invariant this completes:
//
//   a class-side method names a class-instance slot according to its DEFINING
//   metaclass, but reads/writes the slot belonging to its DYNAMIC self class.
//
// So an inherited `MpTypeMapper class>>actionMap` accesses the companion of
// `MpEncodeTypeMapper` when `self` is `MpEncodeTypeMapper`, and of
// `MpDecodeTypeMapper` when `self` is `MpDecodeTypeMapper`.

function classStateObjectId(className) {
  return `smalltalk/class-state/${className}`;
}

function classStateObjectRef(imageId, className) {
  return objectRef(imageId, classStateObjectId(className));
}

// The class name of a class object, read from its durable behavior-name slot.
// The name keys the companion, so it comes from the record itself, never from
// a caller-supplied string that could drift from it.
async function classNameOfBehavior(images, behaviorRef) {
  const behavior = await readBehavior(images, behaviorRef);
  const name = behavior.name;
  if (name?.kind !== 'text' || name.value.length === 0) {
    throw new TypeError(`behavior ${behaviorRef.imageId}/${behaviorRef.objectId} has no class name for class state`);
  }
  return name.value;
}

// Ensure the per-class companion for `classRef` exists, creating it on first
// use with every visible class-instance slot initialised to nil.
//
// REPLAY CONTRACT: the companion is *mutable* class state. First creation
// initialises all visible slots to nil. Rediscovery (the companion already
// exists) validates identity and that the record's shape still offers every
// visible slot id, but MUST preserve current values — it never ensure-exacts
// against the original nil values, or a re-run would silently reset class state
// the program already wrote.
async function ensureClassStateCompanion({images, imageId, classRef, classInstanceShapeRef}) {
  if (!isObjectRef(classInstanceShapeRef)) return null;
  const shape = await images.getShape(classInstanceShapeRef.imageId, classInstanceShapeRef.objectId);
  if (!shape) {
    throw new TypeError(`class-instance shape not found: ${classInstanceShapeRef.imageId}/${classInstanceShapeRef.objectId}`);
  }
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const className = await classNameOfBehavior(images, classRef);
  const id = classStateObjectId(className);

  // The nil-filled companion is only a SEED: its values change afterwards, so a present (or
  // concurrently created) companion is adopted as it is by the ensure owner (seed mode) — never
  // overwritten by a late creator. The domain invariant that belongs HERE — the companion's shape
  // must carry every visible class-instance slot, values preserved — is checked on whatever came
  // back, created or adopted; it is compatibility, not identity, so it is not admission.
  const companion = await ensureObject(images, imageId, {
    id,
    shape: classInstanceShapeRef,
    behavior: null,
    slots: Object.fromEntries(shape.slots.map(({id: slotId}) => [slotId, kernel.nil])),
    metadata: {smalltalk: 'class-state', name: className},
  }, {seed: true});
  const companionShape = await images.getShape(companion.shape.imageId, companion.shape.objectId);
  if (!companionShape) throw new TypeError(`class-state companion ${id} has a dangling shape`);
  const companionSlotIds = new Set(companionShape.slots.map(({id: slotId}) => slotId));
  const missing = shape.slots.map(({id: slotId}) => slotId).filter((slotId) => !companionSlotIds.has(slotId));
  if (missing.length > 0) {
    throw new TypeError(
      `class-state companion ${id} shape is missing visible class-instance slot ids: ${missing.join(', ')}`,
    );
  }
  return objectRef(imageId, id);
}

// The class-state routing context for a slot access whose dynamic receiver is
// `selfRef`, or null when the access is an ordinary instance access. When
// `selfRef` is a class object, its own class (the metaclass) supplies the
// class-instance layout and its name keys the companion.
async function classStateCompanionFor({images, selfRef}) {
  const record = await images.getObject(selfRef.imageId, selfRef.objectId);
  if (!record || !isBehaviorObject(record)) return null;
  // The dynamic self class's metaclass holds the class-instance layout. A
  // metaclass with a nil instance shape declares no class-instance state, so
  // this is an ordinary (non-class-state) access.
  const metaclassRef = record.behavior;
  if (!isObjectRef(metaclassRef)) return null;
  const metaclassInstanceShapeRef = (await readBehavior(images, metaclassRef)).instanceShape;
  if (!isObjectRef(metaclassInstanceShapeRef)) return null;
  const className = await classNameOfBehavior(images, selfRef);
  return {
    className,
    record,
    metaclassInstanceShapeRef,
    companionRef: classStateObjectRef(selfRef.imageId, className),
  };
}

export {
  classStateObjectId,
  classStateObjectRef,
  classStateCompanionFor,
  ensureClassStateCompanion,
};
