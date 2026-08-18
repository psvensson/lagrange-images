import {SHAPE_INDEXED} from '../object/model.js';
import {objectRef, textValue} from '../value/index.js';
import {
  defineClass,
  defineMethods,
  ensureBlock,
  ensureCodeArtifact,
} from './smalltalk-class-builder.js';
import {
  DICTIONARY_SHAPE_ID,
  DICTIONARY_SHAPE_SLOTS,
  DICTIONARY_TABLE_SHAPE_ID,
  DICTIONARY_TABLE_SHAPE_SLOTS,
} from './smalltalk-dictionary-table.js';
import {
  SmalltalkKernelConflictError,
  canonicalJson,
  findSmalltalkKernel,
  readBehavior,
} from './smalltalk-kernel.js';
import {sameRef} from './smalltalk-lookup.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0048 decisions 1 and 9: the `Object >> =` / `Object >> hash` protocol and the first public
// `Dictionary` protocol, installed after kernel identity exists exactly as ADRs 0045-0047 install
// theirs. The compiler and dispatcher learn none of these selectors.
//
// Two installers rather than one, because they are separately useful: equality and hashing are
// ordinary Object protocol that a program may want without any collection at all, and a later
// MethodDictionary fast path needs the built-in helpers rather than the Dictionary class.
const DICTIONARY_CLASS_ID = 'smalltalk/class/Dictionary';
const DICTIONARY_METACLASS_ID = 'smalltalk/metaclass/Dictionary';

const PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS]: 'smalltalk/primitive/built-in-equals',
  [SMALLTALK_PRIMITIVE.BUILT_IN_HASH]: 'smalltalk/primitive/built-in-hash',
  [SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE]: 'smalltalk/primitive/dictionary-initialize',
  [SMALLTALK_PRIMITIVE.DICTIONARY_SIZE]: 'smalltalk/primitive/dictionary-size',
  [SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY]: 'smalltalk/primitive/dictionary-includes-key',
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT]: 'smalltalk/primitive/dictionary-at',
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT]: 'smalltalk/primitive/dictionary-at-put',
});

const CAPTURE_NAME = Object.freeze({
  [SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS]: 'primitiveEquals',
  [SMALLTALK_PRIMITIVE.BUILT_IN_HASH]: 'primitiveHash',
  [SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE]: 'primitiveDictionaryInitialize',
  [SMALLTALK_PRIMITIVE.DICTIONARY_SIZE]: 'primitiveDictionarySize',
  [SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY]: 'primitiveDictionaryIncludesKey',
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT]: 'primitiveDictionaryAt',
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT]: 'primitiveDictionaryAtPut',
});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

const captureFor = (primitive) => ({id: PRIMITIVE_BLOCK_ID[primitive], name: CAPTURE_NAME[primitive]});
const argument = (index) => ({op: 'argument', index});
const receiver = () => ({op: 'receiver'});

function primitiveSend(capture, args) {
  return {
    op: 'send',
    languageId: SYMMETRIC_SMALLTALK_ID,
    receiver: {op: 'binding', id: capture.id},
    message: textValue('value:'.repeat(args.length)),
    arguments: args,
  };
}

// One method reaching one primitive, with the primitive Block bound as an ordinary captured ref in
// the method's own lexical environment.
function capturedMethod({selector, primitive, parameters = [], args, imageId}) {
  const capture = captureFor(primitive);
  return {
    selector,
    program: {
      parameters: parameters.map((name, index) => ({id: `${selector}:parameter:${index}`, name})),
      captures: [{...capture}],
      body: primitiveSend(capture, args),
    },
    captures: [{...capture, value: objectRef(imageId, capture.id)}],
  };
}

async function installPrimitiveBlock({images, imageId, primitive}) {
  const id = PRIMITIVE_BLOCK_ID[primitive];
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

const shapeLayout = (shape) => canonicalJson({
  slots: shape.slots,
  indexed: Object.hasOwn(shape, 'indexed') ? shape.indexed : SHAPE_INDEXED.NONE,
});

async function ensureShapeExactly(images, imageId, desired) {
  const existing = await images.getShape(imageId, desired.id);
  if (!existing) return await images.putShape(imageId, desired);
  if (shapeLayout(existing) !== shapeLayout(desired)) {
    throw new SmalltalkKernelConflictError('shape', imageId, desired.id);
  }
  return existing;
}

// `Object >> =` and `Object >> hash`. Every receiver in the image inherits them, which is what makes
// the default relation of decision 2 the language's default rather than a Dictionary-private helper.
async function installSmalltalkEqualityProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  for (const primitive of [SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS, SMALLTALK_PRIMITIVE.BUILT_IN_HASH]) {
    await installPrimitiveBlock({images, imageId, primitive});
  }

  await defineMethods({
    images,
    compilation,
    imageId,
    lane,
    classRef: kernel.objectClass,
    methods: [
      capturedMethod({
        selector: '=',
        primitive: SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS,
        parameters: ['anObject'],
        args: [receiver(), argument(0)],
        imageId,
      }),
      capturedMethod({
        selector: 'hash',
        primitive: SMALLTALK_PRIMITIVE.BUILT_IN_HASH,
        args: [receiver()],
        imageId,
      }),
    ],
  });
  return Object.freeze({objectClass: kernel.objectClass});
}

function requireSameRef(actual, expected, imageId) {
  if (!sameRef(actual, expected)) throw new SmalltalkKernelConflictError('class', imageId, DICTIONARY_CLASS_ID);
}

// The Dictionary class is created directly rather than through `defineClass`, because its class and
// metaclass records must be rediscovered on a retry: once method publication has begun, a replayed
// `defineClass` would wrongly demand that the method dictionaries be empty again.
//
// Rediscovery validates the whole *immutable* class definition, not just the instance Shape. A
// record carrying the right Shape but the wrong name, superclass or metaclass edge is a different
// class that happens to occupy this deterministic id, and adopting it would then publish Dictionary
// methods onto it. Method dictionaries are deliberately excluded: they are the mutable part, and
// `defineMethods` has its own retry-safe exactness contract. Same pattern as ADR 0047's Array
// installer, for the same reason.
async function ensureDictionaryClass({images, imageId, kernel, instanceShapeRef}) {
  const classRef = objectRef(imageId, DICTIONARY_CLASS_ID);
  const metaclassRef = objectRef(imageId, DICTIONARY_METACLASS_ID);
  const existing = await images.getObject(imageId, DICTIONARY_CLASS_ID);
  if (!existing) {
    const defined = await defineClass({
      images,
      imageId,
      name: 'Dictionary',
      superclassRef: kernel.objectClass,
      instanceShapeRef,
    });
    return Object.freeze({classRef: defined.classRef, metaclassRef: defined.metaclassRef});
  }

  let behavior;
  let metaclass;
  try {
    behavior = await readBehavior(images, classRef);
    metaclass = await readBehavior(images, metaclassRef);
  } catch (error) {
    throw new SmalltalkKernelConflictError('class', imageId, DICTIONARY_CLASS_ID, {cause: error});
  }
  if (behavior.name.value !== 'Dictionary' || metaclass.name.value !== 'Dictionary class') {
    throw new SmalltalkKernelConflictError('class', imageId, DICTIONARY_CLASS_ID);
  }
  requireSameRef(behavior.record.behavior, metaclassRef, imageId);
  requireSameRef(behavior.superclass, kernel.objectClass, imageId);
  requireSameRef(behavior.instanceShape, instanceShapeRef, imageId);

  const objectBehavior = await readBehavior(images, kernel.objectClass);
  requireSameRef(metaclass.record.behavior, kernel.metaclassClass, imageId);
  requireSameRef(metaclass.superclass, objectBehavior.record.behavior, imageId);
  requireSameRef(metaclass.instanceShape, kernel.nil, imageId);
  return Object.freeze({classRef, metaclassRef});
}

async function installSmalltalkDictionaryProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  // The table Shape carries the indexed declaration ADR 0047 introduced; the Dictionary Shape is an
  // ordinary one-slot layout, so a Dictionary's own identity never moves when its contents change.
  await ensureShapeExactly(images, imageId, {
    id: DICTIONARY_SHAPE_ID,
    slots: [...DICTIONARY_SHAPE_SLOTS],
  });
  await ensureShapeExactly(images, imageId, {
    id: DICTIONARY_TABLE_SHAPE_ID,
    slots: [...DICTIONARY_TABLE_SHAPE_SLOTS],
    indexed: SHAPE_INDEXED.VALUES,
  });

  for (const primitive of [
    SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE,
    SMALLTALK_PRIMITIVE.DICTIONARY_SIZE,
    SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY,
    SMALLTALK_PRIMITIVE.DICTIONARY_AT,
    SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT,
  ]) {
    await installPrimitiveBlock({images, imageId, primitive});
  }

  const {classRef} = await ensureDictionaryClass({
    images,
    imageId,
    kernel,
    instanceShapeRef: objectRef(imageId, DICTIONARY_SHAPE_ID),
  });

  await defineMethods({
    images,
    compilation,
    imageId,
    lane,
    classRef,
    methods: [
      // Overrides `Object >> initialize`, which ADR 0046 installs as `^self`. `new` therefore stays
      // ordinary composition: basicNew leaves `table` nil, and this fills it in.
      capturedMethod({
        selector: 'initialize',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE,
        args: [receiver()],
        imageId,
      }),
      capturedMethod({
        selector: 'size',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_SIZE,
        args: [receiver()],
        imageId,
      }),
      capturedMethod({
        selector: 'includesKey:',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY,
        parameters: ['aKey'],
        args: [receiver(), argument(0)],
        imageId,
      }),
      capturedMethod({
        selector: 'at:',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_AT,
        parameters: ['aKey'],
        args: [receiver(), argument(0)],
        imageId,
      }),
      capturedMethod({
        selector: 'at:put:',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT,
        parameters: ['aKey', 'aValue'],
        args: [receiver(), argument(0), argument(1)],
        imageId,
      }),
    ],
  });

  return Object.freeze({classRef, dictionaryShape: objectRef(imageId, DICTIONARY_SHAPE_ID)});
}

export {
  DICTIONARY_CLASS_ID,
  PRIMITIVE_BLOCK_ID as SMALLTALK_DICTIONARY_PRIMITIVE_BLOCK_ID,
  installSmalltalkDictionaryProtocol,
  installSmalltalkEqualityProtocol,
};
