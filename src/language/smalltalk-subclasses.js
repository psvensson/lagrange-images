import {isObjectRef, objectRef, textValue} from '../value/index.js';
import {ensureObject, ensureShape} from '../graph/ensure-records.js';
import {SHAPE_INDEXED} from '../object/model.js';
import {SMALLTALK_PRIMITIVE} from './smalltalk-primitive-support.js';
import {findSmalltalkKernel, readBehavior} from './smalltalk-kernel.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {ensureBlock, ensureCodeArtifact} from './smalltalk-class-builder.js';
import {SMALLTALK_KERNEL_PRIMITIVE_V1} from './smalltalk-primitives.js';
import {primitiveCodeContent} from './smalltalk-primitives.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// Class-hierarchy introspection: the durable subclass registry and the
// `subclasses`/`allSubclasses` protocol.
//
// A class's direct subclasses are ordinary durable image state, never hidden JS
// state and never a new field on the fixed Behavior shape (which would be a
// durable-schema migration touching every class). Each class has a registry
// object at a deterministic id whose indexed part holds direct-subclass refs.
// `defineClass` maintains it (see `maintainSubclassRegistries`); the
// `subclasses-of` primitive reads it into an image Array; the Smalltalk
// `subclasses`/`allSubclasses` methods compose over it with OrderedCollection.
//
// Owner: the Symmetric Smalltalk personality. No Value/generic-Object/backend
// change; the registry rides the ordinary object model.

const SUBCLASS_REGISTRY_SHAPE_ID = 'smalltalk/subclass-registry-shape/v1';
const SUBCLASSES_OF_BLOCK_ID = 'smalltalk/primitive/subclasses-of';
const SUBCLASSES_OF_CAPTURE = Object.freeze({id: SUBCLASSES_OF_BLOCK_ID, name: 'primitiveSubclassesOf'});

class SmalltalkSubclassRegistryConflictError extends TypeError {
  constructor(registryRef, subclassRef = null) {
    super(
      `subclass registry ${registryRef.imageId}/${registryRef.objectId} changed or is malformed; `
      + 'refusing to overwrite it',
    );
    this.name = 'SmalltalkSubclassRegistryConflictError';
    this.imageId = registryRef.imageId;
    this.objectId = registryRef.objectId;
    this.subclassRef = subclassRef;
  }
}

function subclassRegistryId(className) {
  return `smalltalk/subclasses/${className}`;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

async function ensureRegistryShape(images, imageId) {
  const desired = {
    id: SUBCLASS_REGISTRY_SHAPE_ID, slots: [], indexed: SHAPE_INDEXED.VALUES,
  };
  const shape = await ensureShape(images, imageId, desired);
  return objectRef(imageId, shape.id);
}

// The registry's shape is well-known and lazily ensured, but the registry record
// for a class is created on first append (or first explicit ensure), so a class
// nobody ever subclassed has no record at all — and absence reads as empty.
async function ensureSubclassRegistry({images, imageId, className}) {
  const shapeRef = await ensureRegistryShape(images, imageId);
  const id = subclassRegistryId(className);
  const ref = objectRef(imageId, id);
  const conflict = () => new SmalltalkSubclassRegistryConflictError(ref);
  // The empty registry is only a SEED: the record is appended to afterwards under its own CAS, so
  // a present (or concurrently created) registry is adopted as it is — never overwritten by a
  // late creator, and never compared for identity (ensure owner, seed mode).
  const record = await ensureObject(images, imageId, {
    id, shape: shapeRef, behavior: null, slots: {}, indexed: [], metadata: {smalltalk: 'subclass-registry'},
  }, {seed: true, conflict});
  const members = subclassRegistryMembers(record, ref);
  return {ref, record, members};
}

// The indexed member set is the only mutable part of a registry. Seed admission deliberately
// adopts an already-present record, so this owner must validate every immutable field and the set
// invariant before it interprets that record as subclass state.
function subclassRegistryMembers(record, registryRef) {
  const conflict = () => new SmalltalkSubclassRegistryConflictError(registryRef);
  if (
    !record
    || record.kind !== 'object'
    || record.imageId !== registryRef.imageId
    || record.id !== registryRef.objectId
    || !isObjectRef(record.shape)
    || record.shape.imageId !== registryRef.imageId
    || record.shape.objectId !== SUBCLASS_REGISTRY_SHAPE_ID
    || record.behavior !== null
    || !record.slots
    || typeof record.slots !== 'object'
    || Array.isArray(record.slots)
    || Object.keys(record.slots).length !== 0
    || !record.metadata
    || record.metadata.smalltalk !== 'subclass-registry'
    || Object.keys(record.metadata).length !== 1
    || !Array.isArray(record.indexed)
  ) {
    throw conflict();
  }

  const seen = new Set();
  for (const member of record.indexed) {
    if (!isObjectRef(member) || member.imageId !== registryRef.imageId) throw conflict();
    const key = member.objectId;
    if (seen.has(key)) throw conflict();
    seen.add(key);
  }
  return record.indexed;
}

// Membership-guarded append: replaying `defineClass` never duplicates an entry.
async function appendSubclass({images, imageId, superclassName, subclassRef}) {
  const {ref: registryRef, record, members: current} = await ensureSubclassRegistry({
    images, imageId, className: superclassName,
  });
  const present = current.some(
    (ref) => isObjectRef(ref) && ref.imageId === subclassRef.imageId && ref.objectId === subclassRef.objectId,
  );
  if (present) return;
  try {
    await images.putObject(imageId, {
      id: record.id,
      shape: record.shape,
      behavior: null,
      slots: record.slots,
      indexed: [...current, subclassRef],
      metadata: record.metadata,
    }, {expectedVersion: record._version});
  } catch (error) {
    if (error?.name !== 'VersionConflictError') throw error;

    // The CAS remains authoritative. Classify its winner once, by this owner's set semantics:
    // another contender adding the same ref completed our request, while every other winner is a
    // domain conflict. There is no second write and therefore no unbounded retry or overwrite.
    const winner = await images.getObject(registryRef.imageId, registryRef.objectId);
    let winnerMembers;
    try {
      winnerMembers = subclassRegistryMembers(winner, registryRef);
    } catch {
      throw new SmalltalkSubclassRegistryConflictError(registryRef, subclassRef);
    }
    if (winnerMembers.some(
      (ref) => ref.imageId === subclassRef.imageId && ref.objectId === subclassRef.objectId,
    )) return;
    throw new SmalltalkSubclassRegistryConflictError(registryRef, subclassRef);
  }
}

// `defineClass` calls this for every class it defines. It registers the CLASS
// object's superclass edge (never the metaclass's derived one) in the
// superclass's registry, and ensures this class's own empty registry. Lazy and
// tolerant: bootstrap classes are defined before the registry Shape exists, and
// absence reads as empty, so this converges on retry rather than failing the
// definition. The superclass edge is the one `defineClass` was given — `Object`
// for a default superclass, so ordinary classes register under `Object`.
async function maintainSubclassRegistries({images, imageId, className, classRef, superclassRef, nilRef}) {
  requiredText(className, 'class name');
  // Ensure this class's own (empty) registry first so every class is introspectable.
  await ensureSubclassRegistry({images, imageId, className});
  if (!isObjectRef(superclassRef) || (nilRef && superclassRef.objectId === nilRef.objectId)) return;
  // The root Object class has no superclass to register under; its superclass
  // edge is the kernel nil, handled above.
  const superclassName = (await readBehavior(images, superclassRef)).name;
  if (superclassName?.kind !== 'text' || superclassName.value.length === 0) return;
  await appendSubclass({images, imageId, superclassName: superclassName.value, subclassRef: classRef});
}

// The protocol methods, written in Smalltalk over OrderedCollection and the
// `subclasses-of` primitive. `subclasses` answers the direct set;
// `allSubclasses` walks it transitively (depth-first, order-insensitive by
// contract — membership is what callers may rely on).
const SUBCLASS_PROTOCOL_METHODS = Object.freeze([
  {
    selector: 'subclasses',
    source: `[ | arr coll |
      arr := primitiveSubclassesOf value: self.
      coll := OrderedCollection new.
      1 to: arr size do: [:i | coll add: (arr at: i)].
      ^ coll ]`,
  },
  {
    selector: 'allSubclasses',
    source: `[ | result work |
      result := OrderedCollection new.
      work := OrderedCollection new.
      self subclasses do: [:s | work add: s].
      [ work isEmpty ] whileFalse: [
        | current |
        current := work removeLast.
        result add: current.
        current subclasses do: [:s | work add: s].
      ].
      ^ result ]`,
  },
]);

async function installSmalltalkSubclassProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  // The primitive Block, published on the same `smalltalk-kernel-primitive/v1`
  // seam as the other kernel primitives.
  const code = await ensureCodeArtifact(images, imageId, {
    id: `${SUBCLASSES_OF_BLOCK_ID}:code`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SMALLTALK_KERNEL_PRIMITIVE_V1,
    content: textValue(primitiveCodeContent(SMALLTALK_PRIMITIVE.SUBCLASSES_OF)),
    metadata: {smalltalk: 'kernel-primitive', primitive: SMALLTALK_PRIMITIVE.SUBCLASSES_OF},
  });
  const primitiveBlock = await ensureBlock(images, imageId, {
    id: SUBCLASSES_OF_BLOCK_ID,
    code: objectRef(imageId, code.id),
    environment: null,
    metadata: {smalltalk: 'kernel-primitive', primitive: SMALLTALK_PRIMITIVE.SUBCLASSES_OF},
  });

  // The methods live on Class so every class understands them; an instance does
  // not (defence-in-depth behind the primitive's own receiver guard).
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: kernel.classClass,
    methods: SUBCLASS_PROTOCOL_METHODS.map(({selector, source}) => ({
      selector,
      source,
      captures: [{...SUBCLASSES_OF_CAPTURE, value: objectRef(imageId, primitiveBlock.id)}],
    })),
  });

  return Object.freeze({
    protocol: 'smalltalk-subclass-protocol/v1',
    subclassesOfPrimitive: objectRef(imageId, primitiveBlock.id),
    classClass: kernel.classClass,
  });
}

export {
  SUBCLASS_REGISTRY_SHAPE_ID,
  SmalltalkSubclassRegistryConflictError,
  installSmalltalkSubclassProtocol,
  maintainSubclassRegistries,
  subclassRegistryId,
};
