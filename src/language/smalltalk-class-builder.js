import {LAGRANGE_CODE_V0} from '../code/lagrange-code-v0.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {objectRef, textValue} from '../value/index.js';
import {
  BEHAVIOR_SHAPE_ID,
  findSmalltalkKernel,
  methodDictionarySlots,
} from './smalltalk-kernel.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// Installing methods onto a kernel class, and defining new classes with their metaclasses.
//
// A method is defined **semantically**, as lagrange-code/v0, and its executable Block is derived —
// ADR 0044 decision 6. Defining it directly as a neutral-expression artifact would collapse
// semantic meaning into one executable representation, which is the separation this substrate keeps
// everywhere else. `+` is not special: it is a method whose body happens to use `integer-add`.
function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

const methodsId = (ownerId) => `${ownerId}/methods`;

// Adding a method rewrites the dictionary and its shape, per ADR 0044 decision 2 — visible,
// confined to one object kind, and gone when collections arrive. The Behavior itself is untouched,
// which is the whole point of giving it a fixed shape.
async function defineMethods({images, compilation, imageId, classRef, methods}) {
  requiredText(imageId, 'image id');
  if (!Array.isArray(methods) || methods.length === 0) throw new TypeError('methods must be a non-empty array');

  const behavior = await images.getObject(classRef.imageId, classRef.objectId);
  if (!behavior) throw new TypeError(`class not found: ${classRef.imageId}/${classRef.objectId}`);
  if (behavior.shape.objectId !== BEHAVIOR_SHAPE_ID) {
    throw new TypeError(`not a fixed-shape Behavior: ${classRef.objectId}`);
  }

  const dictionaryRef = behavior.slots['behavior-methods'];
  const existing = await images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
  const existingShape = await images.getShape(existing.shape.imageId, existing.shape.objectId);

  const merged = new Map(existingShape.slots.map((slot) => [slot.name, existing.slots[slot.id]]));
  for (const {selector, program} of methods) {
    requiredText(selector, 'selector');
    const methodId = `${classRef.objectId}/method/${Buffer.from(selector, 'utf8').toString('base64url')}`;
    const semantic = await images.putCodeArtifact(imageId, {
      id: `${methodId}:semantic`,
      languageId: SYMMETRIC_SMALLTALK_ID,
      representation: LAGRANGE_CODE_V0,
      content: textValue(JSON.stringify(program)),
      metadata: {smalltalk: 'method', selector},
    });
    const code = await compilation.compileArtifact(objectRef(imageId, semantic.id), {
      id: `${methodId}:code`,
      targetRepresentation: NEUTRAL_EXPRESSION_V0,
    });
    const block = await images.putBlock(imageId, {
      id: methodId,
      code: objectRef(imageId, code.id),
      metadata: {smalltalk: 'method', selector},
    });
    merged.set(selector, objectRef(imageId, block.id));
  }

  const selectors = [...merged.keys()];
  const slots = methodDictionarySlots(selectors);
  const shapeId = `${methodsId(classRef.objectId)}/shape/${selectors.length}`;
  const shape = await images.getShape(imageId, shapeId)
    ?? await images.putShape(imageId, {id: shapeId, slots});
  const bySelector = new Map(slots.map((slot) => [slot.name, slot.id]));

  return await images.putObject(imageId, {
    id: dictionaryRef.objectId,
    shape: objectRef(imageId, shape.id),
    slots: Object.fromEntries(selectors.map((selector) => [bySelector.get(selector), merged.get(selector)])),
    metadata: existing.metadata,
  }, {expectedVersion: existing._version});
}

// A new class and its metaclass, wired by decision 4's chain rule rather than by hand.
async function defineClass({images, imageId, name, superclassRef}) {
  requiredText(name, 'class name');
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const ref = (objectId) => objectRef(imageId, objectId);
  const superclass = superclassRef ?? kernel.objectClass;
  const superBehavior = await images.getObject(superclass.imageId, superclass.objectId);
  const superMetaclass = superBehavior.behavior;

  const classId = `smalltalk/class/${name}`;
  const metaclassId = `smalltalk/metaclass/${name}`;

  for (const [id, behaviorName, superRef, behaviorRef] of [
    [metaclassId, `${name} class`, superMetaclass, kernel.metaclassClass],
    [classId, name, superclass, ref(metaclassId)],
  ]) {
    await images.putObject(imageId, {
      id: methodsId(id),
      shape: ref('smalltalk/empty-shape/v1'),
      slots: {},
      metadata: {smalltalk: 'method-dictionary', owner: id},
    });
    await images.putObject(imageId, {
      id,
      shape: ref(BEHAVIOR_SHAPE_ID),
      behavior: behaviorRef,
      slots: {
        'behavior-name': textValue(behaviorName),
        'behavior-superclass': superRef,
        'behavior-methods': ref(methodsId(id)),
        'behavior-instance-shape': kernel.nil,
      },
      metadata: {smalltalk: 'behavior', name: behaviorName},
    });
  }
  return Object.freeze({classRef: ref(classId), metaclassRef: ref(metaclassId)});
}

export {defineClass, defineMethods};
