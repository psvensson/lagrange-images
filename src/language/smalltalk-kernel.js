import {objectRef, textValue} from '../value/index.js';

// The Symmetric Smalltalk kernel: the durable object graph ADR 0044 dispatches against.
//
// This module installs and rediscovers it. It deliberately performs no dispatch: execution starts
// depending on the kernel in a later change, once dispatch-image context exists. What lands here is
// identity — the shapes, the singleton and class graph, and a way to find all of it again from
// nothing but an image id.
//
// Discoverability is the point. Returning refs from an installer is not enough: the refs die with
// the process while the image survives, so the kernel is reachable at one well-known object id and
// everything else is found through it. The dispatcher will know this protocol, never an `Integer`
// object id.
const SMALLTALK_KERNEL_PROTOCOL_V1 = 'smalltalk-kernel/v1';
const SMALLTALK_KERNEL_OBJECT_ID = 'smalltalk-kernel/v1';

// Fixed shapes, per ADR 0044 decision 1. A Behavior's shape never changes, which is what keeps
// adding a method from restructuring the class.
const BEHAVIOR_SHAPE_ID = 'smalltalk/behavior-shape/v1';
const KERNEL_SHAPE_ID = 'smalltalk/kernel-shape/v1';
const EMPTY_SHAPE_ID = 'smalltalk/empty-shape/v1';

const BEHAVIOR_SLOTS = Object.freeze([
  {id: 'behavior-name', name: 'name'},
  {id: 'behavior-superclass', name: 'superclass'},
  {id: 'behavior-methods', name: 'methods'},
  {id: 'behavior-instance-shape', name: 'instanceShape'},
]);

// The kernel carries the immediate-value classes decision 5 dispatches through, the singletons of
// decision 7, and the three classes the metaclass knot is tied from.
const KERNEL_SLOTS = Object.freeze([
  {id: 'kernel-nil', name: 'nil'},
  {id: 'kernel-true', name: 'true'},
  {id: 'kernel-false', name: 'false'},
  {id: 'kernel-object-class', name: 'objectClass'},
  {id: 'kernel-class-class', name: 'classClass'},
  {id: 'kernel-metaclass-class', name: 'metaclassClass'},
  {id: 'kernel-boolean-class', name: 'booleanClass'},
  {id: 'kernel-integer-class', name: 'integerClass'},
  {id: 'kernel-float-class', name: 'floatClass'},
  {id: 'kernel-text-class', name: 'textClass'},
  {id: 'kernel-byte-array-class', name: 'byteArrayClass'},
]);

const KERNEL_SLOT_BY_NAME = Object.freeze(Object.fromEntries(
  KERNEL_SLOTS.map(({id, name}) => [name, id]),
));

// ADR 0044 decision 2. Generic Shapes reject a duplicate slot *id* and say nothing about names, so
// two slots may both be named `+` and a find-based lookup would resolve by position. That is a
// MethodDictionary invariant, checked here, and deliberately not imposed on generic Shape — which
// has other legitimate users whose slot names are not selectors.
function methodDictionarySlots(selectors) {
  if (!Array.isArray(selectors)) throw new TypeError('method dictionary selectors must be an array');
  const seen = new Set();
  return selectors.map((selector, index) => {
    if (typeof selector !== 'string' || selector.length === 0) {
      throw new TypeError(`method dictionary selector ${index} must be non-empty text`);
    }
    if (seen.has(selector)) {
      throw new TypeError(`method dictionary declares duplicate selector: ${selector}`);
    }
    seen.add(selector);
    return {id: `selector:${Buffer.from(selector, 'utf8').toString('base64url')}`, name: selector};
  });
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['putShape', 'getShape', 'putObject', 'getObject']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

// The kernel classes. `super` is the instance-side superclass name; the metaclass chain is derived
// from it by decision 4 rather than written out, so the two cannot drift apart.
const KERNEL_CLASSES = Object.freeze([
  {name: 'Object', super: null},
  {name: 'Class', super: 'Object'},
  {name: 'Metaclass', super: 'Object'},
  {name: 'UndefinedObject', super: 'Object'},
  {name: 'Boolean', super: 'Object'},
  {name: 'True', super: 'Boolean'},
  {name: 'False', super: 'Boolean'},
  {name: 'Integer', super: 'Object'},
  {name: 'Float', super: 'Object'},
  {name: 'Text', super: 'Object'},
  {name: 'ByteArray', super: 'Object'},
]);

const classId = (name) => `smalltalk/class/${name}`;
const metaclassId = (name) => `smalltalk/metaclass/${name}`;
const methodsId = (ownerId) => `${ownerId}/methods`;

async function installSmalltalkKernel({images, imageId} = {}) {
  const service = assertImages(images);
  requiredText(imageId, 'kernel image id');
  const ref = (objectId) => objectRef(imageId, objectId);

  const shapes = {
    behavior: await service.putShape(imageId, {id: BEHAVIOR_SHAPE_ID, slots: [...BEHAVIOR_SLOTS]}),
    kernel: await service.putShape(imageId, {id: KERNEL_SHAPE_ID, slots: [...KERNEL_SLOTS]}),
    empty: await service.putShape(imageId, {id: EMPTY_SHAPE_ID, slots: []}),
  };
  // Every kernel method dictionary starts empty; methods arrive with the classes that need them.
  const emptyMethodsShapeId = `${EMPTY_SHAPE_ID}`;

  // A Behavior object. `behavior` and `superclass` are passed as refs rather than derived, because
  // the metaclass knot needs edges pointing at objects that do not exist yet — which `putObject`
  // permits, since it validates the shape but neither `behavior` nor ref-valued slots.
  const putBehavior = async ({id, name, superclassRef, behaviorRef, instanceShapeRef}) => {
    await service.putObject(imageId, {
      id: methodsId(id),
      shape: ref(emptyMethodsShapeId),
      slots: {},
      metadata: {smalltalk: 'method-dictionary', owner: id},
    });
    return await service.putObject(imageId, {
      id,
      shape: ref(BEHAVIOR_SHAPE_ID),
      behavior: behaviorRef,
      slots: {
        'behavior-name': textValue(name),
        'behavior-superclass': superclassRef,
        'behavior-methods': ref(methodsId(id)),
        'behavior-instance-shape': instanceShapeRef,
      },
      metadata: {smalltalk: 'behavior', name},
    });
  };

  // The singletons first, so `nil` exists to stand in every absent slot. They are ordinary objects
  // with no slots; what makes them singular is that the kernel names them.
  const singletons = {};
  for (const [slotName, className, objectId] of [
    ['nil', 'UndefinedObject', 'smalltalk/nil'],
    ['true', 'True', 'smalltalk/true'],
    ['false', 'False', 'smalltalk/false'],
  ]) {
    singletons[slotName] = await service.putObject(imageId, {
      id: objectId,
      shape: ref(EMPTY_SHAPE_ID),
      behavior: ref(classId(className)),
      slots: {},
      metadata: {smalltalk: 'singleton', name: slotName},
    });
  }
  const nilRef = ref('smalltalk/nil');

  // Metaclasses. `behavior(aMetaclass) == Metaclass` for every one of them, including Metaclass's
  // own metaclass — which is the knot: `behavior(Metaclass class) == Metaclass`.
  //
  // Decision 4's chain rule is applied here rather than written out per class, so the class and
  // metaclass hierarchies cannot drift apart: `C class superclass == S class`, with `Object class
  // superclass == Class` as the root case.
  for (const {name, super: superName} of KERNEL_CLASSES) {
    await putBehavior({
      id: metaclassId(name),
      name: `${name} class`,
      superclassRef: superName === null ? ref(classId('Class')) : ref(metaclassId(superName)),
      behaviorRef: ref(classId('Metaclass')),
      instanceShapeRef: nilRef,
    });
  }

  // Classes. `behavior(aClass) == that class's metaclass`, and `nil` stands for "no superclass".
  for (const {name, super: superName} of KERNEL_CLASSES) {
    await putBehavior({
      id: classId(name),
      name,
      superclassRef: superName === null ? nilRef : ref(classId(superName)),
      behaviorRef: ref(metaclassId(name)),
      instanceShapeRef: nilRef,
    });
  }

  const kernel = await service.putObject(imageId, {
    id: SMALLTALK_KERNEL_OBJECT_ID,
    shape: ref(KERNEL_SHAPE_ID),
    behavior: ref(classId('Object')),
    slots: {
      'kernel-nil': ref('smalltalk/nil'),
      'kernel-true': ref('smalltalk/true'),
      'kernel-false': ref('smalltalk/false'),
      'kernel-object-class': ref(classId('Object')),
      'kernel-class-class': ref(classId('Class')),
      'kernel-metaclass-class': ref(classId('Metaclass')),
      'kernel-boolean-class': ref(classId('Boolean')),
      'kernel-integer-class': ref(classId('Integer')),
      'kernel-float-class': ref(classId('Float')),
      'kernel-text-class': ref(classId('Text')),
      'kernel-byte-array-class': ref(classId('ByteArray')),
    },
    metadata: {protocol: SMALLTALK_KERNEL_PROTOCOL_V1},
  });

  return Object.freeze({
    protocol: SMALLTALK_KERNEL_PROTOCOL_V1,
    ref: ref(SMALLTALK_KERNEL_OBJECT_ID),
    kernel,
    shapes: Object.freeze(shapes),
    singletons: Object.freeze(singletons),
  });
}

// Rediscovery: one image id in, the whole kernel out. Nothing here depends on having run the
// installer in this process.
async function findSmalltalkKernel({images, imageId} = {}) {
  const service = assertImages(images);
  requiredText(imageId, 'kernel image id');
  const record = await service.getObject(imageId, SMALLTALK_KERNEL_OBJECT_ID);
  if (!record) return null;
  if (record.metadata?.protocol !== SMALLTALK_KERNEL_PROTOCOL_V1) {
    throw new TypeError(
      `object ${imageId}/${SMALLTALK_KERNEL_OBJECT_ID} does not declare ${SMALLTALK_KERNEL_PROTOCOL_V1}`,
    );
  }
  const slots = {};
  for (const {id, name} of KERNEL_SLOTS) {
    const value = record.slots[id];
    if (!value) throw new TypeError(`Smalltalk kernel is missing ${name}`);
    slots[name] = value;
  }
  return Object.freeze({protocol: SMALLTALK_KERNEL_PROTOCOL_V1, ref: objectRef(imageId, record.id), record, ...slots});
}

// ADR 0044 decision 10: a behavior record means what its own shape says it means. A fixed-shape
// Behavior gets ADR 0044 lookup; anything else is a legacy behavior and keeps legacy lookup.
// Installing the kernel therefore reinterprets nothing that already exists.
function isBehaviorObject(record) {
  return Boolean(record) && record.kind === 'object' && record.shape?.objectId === BEHAVIOR_SHAPE_ID;
}

async function readBehavior(images, ref) {
  const record = await assertImages(images).getObject(ref.imageId, ref.objectId);
  if (!record) throw new TypeError(`behavior not found: ${ref.imageId}/${ref.objectId}`);
  if (!isBehaviorObject(record)) throw new TypeError(`not a ${BEHAVIOR_SHAPE_ID} behavior: ${ref.objectId}`);
  return Object.freeze({
    record,
    name: record.slots['behavior-name'],
    superclass: record.slots['behavior-superclass'],
    methods: record.slots['behavior-methods'],
    instanceShape: record.slots['behavior-instance-shape'],
  });
}

export {
  BEHAVIOR_SHAPE_ID,
  BEHAVIOR_SLOTS,
  EMPTY_SHAPE_ID,
  KERNEL_SHAPE_ID,
  KERNEL_SLOTS,
  KERNEL_SLOT_BY_NAME,
  SMALLTALK_KERNEL_OBJECT_ID,
  SMALLTALK_KERNEL_PROTOCOL_V1,
  findSmalltalkKernel,
  installSmalltalkKernel,
  isBehaviorObject,
  methodDictionarySlots,
  readBehavior,
};
