import {SHAPE_INDEXED} from '../object/model.js';
import {integerValue, objectRef, textValue} from '../value/index.js';
import {
  defineClass,
  defineMethods,
  ensureBlock,
  ensureCodeArtifact,
} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {
  SmalltalkKernelConflictError,
  canonicalJson,
  findSmalltalkKernel,
  readBehavior,
} from './smalltalk-kernel.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {sameRef} from './smalltalk-lookup.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0047 is intentionally post-bootstrap, like allocation and control flow. The kernel remains
// identity-only; Array is the first ordinary class whose instance Shape has an indexed part.
const ARRAY_INSTANCE_SHAPE_ID = 'smalltalk/array-instance-shape/v1';
const ARRAY_CLASS_ID = 'smalltalk/class/Array';
const ARRAY_METACLASS_ID = 'smalltalk/metaclass/Array';

const INDEXED_PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED]: 'smalltalk/primitive/basic-new-sized',
  [SMALLTALK_PRIMITIVE.INDEXED_SIZE]: 'smalltalk/primitive/indexed-size',
  [SMALLTALK_PRIMITIVE.INDEXED_AT]: 'smalltalk/primitive/indexed-at',
  [SMALLTALK_PRIMITIVE.INDEXED_AT_PUT]: 'smalltalk/primitive/indexed-at-put',
});

const CAPTURE = Object.freeze({
  [SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED]: Object.freeze({
    id: INDEXED_PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED],
    name: 'primitiveBasicNewSized',
  }),
  [SMALLTALK_PRIMITIVE.INDEXED_SIZE]: Object.freeze({
    id: INDEXED_PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.INDEXED_SIZE],
    name: 'primitiveIndexedSize',
  }),
  [SMALLTALK_PRIMITIVE.INDEXED_AT]: Object.freeze({
    id: INDEXED_PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.INDEXED_AT],
    name: 'primitiveIndexedAt',
  }),
  [SMALLTALK_PRIMITIVE.INDEXED_AT_PUT]: Object.freeze({
    id: INDEXED_PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.INDEXED_AT_PUT],
    name: 'primitiveIndexedAtPut',
  }),
});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

const parameter = (id, name = id) => ({id, name});
const argument = (index) => ({op: 'argument', index});
const receiver = () => ({op: 'receiver'});

const oneBasedToZeroBased = (expression) => ({
  op: 'integer-add',
  left: expression,
  right: {op: 'literal', value: integerValue(-1)},
});

function primitiveSend(capture, args) {
  return {
    op: 'send',
    languageId: SYMMETRIC_SMALLTALK_ID,
    receiver: {op: 'binding', id: capture.id},
    message: textValue('value:'.repeat(args.length)),
    arguments: args,
  };
}

function methodProgram(parameters, capture, body) {
  return {
    parameters,
    captures: capture ? [{...capture}] : [],
    body,
  };
}

function capturedMethod(selector, parameters, capture, args) {
  return {
    selector,
    program: methodProgram(parameters, capture, primitiveSend(capture, args)),
    captures: [{...capture, value: null}],
  };
}

async function ensureArrayShape(images, imageId) {
  const desired = {id: ARRAY_INSTANCE_SHAPE_ID, slots: [], indexed: SHAPE_INDEXED.VALUES};
  const existing = await images.getShape(imageId, desired.id);
  if (!existing) return await images.putShape(imageId, desired);
  const layout = (shape) => canonicalJson({
    slots: shape.slots,
    indexed: Object.hasOwn(shape, 'indexed') ? shape.indexed : SHAPE_INDEXED.NONE,
  });
  if (layout(existing) !== layout(desired)) {
    throw new SmalltalkKernelConflictError('shape', imageId, desired.id);
  }
  return existing;
}

function requireSameRef(actual, expected, imageId) {
  if (!sameRef(actual, expected)) throw new SmalltalkKernelConflictError('class', imageId, ARRAY_CLASS_ID);
}

async function ensureArrayClass({images, imageId, kernel, shapeRef}) {
  const classRef = objectRef(imageId, ARRAY_CLASS_ID);
  const metaclassRef = objectRef(imageId, ARRAY_METACLASS_ID);
  const existing = await images.getObject(imageId, ARRAY_CLASS_ID);
  if (!existing) {
    return await defineClass({
      images,
      imageId,
      name: 'Array',
      superclassRef: kernel.objectClass,
      instanceShapeRef: shapeRef,
    });
  }

  // Once the class record exists, defineClass completed all four class-graph writes. Calling it
  // again after methods have begun to publish would wrongly demand that the method dictionaries be
  // empty again. Rediscovery therefore validates only the immutable class definition and leaves
  // method dictionaries to defineMethods, which has its own retry-safe exactness contract.
  let behavior;
  let metaclass;
  try {
    behavior = await readBehavior(images, classRef);
    metaclass = await readBehavior(images, metaclassRef);
  } catch (error) {
    throw new SmalltalkKernelConflictError('class', imageId, ARRAY_CLASS_ID, {cause: error});
  }
  if (behavior.name.value !== 'Array' || metaclass.name.value !== 'Array class') {
    throw new SmalltalkKernelConflictError('class', imageId, ARRAY_CLASS_ID);
  }
  requireSameRef(behavior.record.behavior, metaclassRef, imageId);
  requireSameRef(behavior.superclass, kernel.objectClass, imageId);
  requireSameRef(behavior.instanceShape, shapeRef, imageId);

  const objectBehavior = await readBehavior(images, kernel.objectClass);
  requireSameRef(metaclass.record.behavior, kernel.metaclassClass, imageId);
  requireSameRef(metaclass.superclass, objectBehavior.record.behavior, imageId);
  requireSameRef(metaclass.instanceShape, kernel.nil, imageId);
  return Object.freeze({classRef, metaclassRef});
}

async function installPrimitiveBlock({images, imageId, primitive}) {
  const id = INDEXED_PRIMITIVE_BLOCK_ID[primitive];
  const code = await ensureCodeArtifact(images, imageId, {
    id: `${id}:code`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SMALLTALK_KERNEL_PRIMITIVE_V1,
    content: textValue(primitiveCodeContent(primitive)),
    metadata: {smalltalk: 'kernel-primitive', primitive},
  });
  const block = await ensureBlock(images, imageId, {
    id,
    code: objectRef(imageId, code.id),
    environment: null,
    metadata: {smalltalk: 'kernel-primitive', primitive},
  });
  return objectRef(imageId, block.id);
}

function bindCapture(method, imageId) {
  if (!method.captures) return method;
  return {
    ...method,
    captures: method.captures.map((entry) => ({
      ...entry,
      value: objectRef(imageId, entry.id),
    })),
  };
}

function protocolFor({kernel, arrayClass, imageId}) {
  const basicNewSized = CAPTURE[SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED];
  const indexedSize = CAPTURE[SMALLTALK_PRIMITIVE.INDEXED_SIZE];
  const indexedAt = CAPTURE[SMALLTALK_PRIMITIVE.INDEXED_AT];
  const indexedAtPut = CAPTURE[SMALLTALK_PRIMITIVE.INDEXED_AT_PUT];
  const index = oneBasedToZeroBased(argument(0));

  return [
    {
      classRef: kernel.classClass,
      methods: [bindCapture(capturedMethod(
        'basicNew:',
        [parameter('size')],
        basicNewSized,
        [receiver(), argument(0)],
      ), imageId)],
    },
    {
      classRef: arrayClass.metaclassRef,
      methods: [{
        selector: 'new:',
        program: methodProgram(
          [parameter('size')],
          null,
          {
            op: 'send',
            languageId: SYMMETRIC_SMALLTALK_ID,
            receiver: receiver(),
            message: textValue('basicNew:'),
            arguments: [argument(0)],
          },
        ),
      }],
    },
    {
      classRef: arrayClass.classRef,
      methods: [
        bindCapture(capturedMethod('size', [], indexedSize, [receiver()]), imageId),
        bindCapture(capturedMethod('at:', [parameter('index')], indexedAt, [receiver(), index]), imageId),
        bindCapture(capturedMethod(
          'at:put:',
          [parameter('index'), parameter('value')],
          indexedAtPut,
          [receiver(), index, argument(1)],
        ), imageId),
      ],
    },
  ];
}

async function installSmalltalkIndexedProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  // Deterministic publication order makes a partial run recoverable by replaying the installer:
  // layout -> class graph -> primitive Blocks -> ordinary methods.
  const shape = await ensureArrayShape(images, imageId);
  const arrayClass = await ensureArrayClass({
    images,
    imageId,
    kernel,
    shapeRef: objectRef(imageId, shape.id),
  });

  const primitives = {};
  for (const primitive of [
    SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED,
    SMALLTALK_PRIMITIVE.INDEXED_SIZE,
    SMALLTALK_PRIMITIVE.INDEXED_AT,
    SMALLTALK_PRIMITIVE.INDEXED_AT_PUT,
  ]) {
    primitives[primitive] = await installPrimitiveBlock({images, imageId, primitive});
  }

  for (const {classRef, methods} of protocolFor({kernel, arrayClass, imageId})) {
    await defineMethods({images, compilation, imageId, classRef, methods, lane});
  }

  return Object.freeze({
    arrayClass: arrayClass.classRef,
    arrayMetaclass: arrayClass.metaclassRef,
    arrayInstanceShape: objectRef(imageId, shape.id),
    basicNewSizedPrimitive: primitives[SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED],
    indexedSizePrimitive: primitives[SMALLTALK_PRIMITIVE.INDEXED_SIZE],
    indexedAtPrimitive: primitives[SMALLTALK_PRIMITIVE.INDEXED_AT],
    indexedAtPutPrimitive: primitives[SMALLTALK_PRIMITIVE.INDEXED_AT_PUT],
  });
}

// `do:` for Array, installed as a separate post-Block/Integer step because it
// composes the indexed primitives with the Block enumeration loop (which is not
// yet installed when `installSmalltalkIndexedProtocol` runs). A general
// collection protocol the upstream MessagePack encoder needs (`writeArray:`
// sends `array do:`); Array is a kernel class outside the `Collection`
// hierarchy, so it does not inherit the library's `Collection do:`.
const ARRAY_ENUMERATION_METHODS = Object.freeze([
  {
    selector: 'do:',
    source: `[ :aBlock | | index |
      index := 1.
      [ index <= self size ] whileTrue: [
        aBlock value: (self at: index).
        index := index + 1 ] ]`,
  },
]);

async function installSmalltalkArrayEnumerationProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  await defineMethodsFromSource({
    images, compilation, imageId, lane,
    classRef: objectRef(imageId, ARRAY_CLASS_ID),
    methods: ARRAY_ENUMERATION_METHODS,
  });
  return Object.freeze({protocol: 'smalltalk-array-enumeration/v1'});
}

export {
  ARRAY_INSTANCE_SHAPE_ID,
  CAPTURE as SMALLTALK_INDEXED_CAPTURE,
  INDEXED_PRIMITIVE_BLOCK_ID as SMALLTALK_INDEXED_PRIMITIVE_BLOCK_ID,
  installSmalltalkArrayEnumerationProtocol,
  installSmalltalkIndexedProtocol,
};
