import {objectRef, textValue} from '../value/index.js';
import {defineMethods, ensureBlock, ensureCodeArtifact} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0046 decision 12: the allocation and class-introspection protocol, installed explicitly after
// kernel identity exists — never by `installSmalltalkKernel`, which stays identity-only.
//
// Two layers land here. The primitive Blocks are lane-independent host implementations; the methods
// that reach them are ordinary semantic `lagrange-code/v0` programs derived per lane, so `basicNew`,
// `new`, `class` and `initialize` are found by the same Behavior walk as `+` and `ifTrue:`. Neither
// the compiler nor the dispatcher learns any of these selectors.
//
// Note what installation does *not* do: registering the executor for
// `smalltalk-kernel-primitive/v1` is runtime composition (decision 2a), so an image may hold this
// protocol in a process that never registered it. That fails as an unregistered representation,
// which is the ordinary outcome rather than a special case.
const PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.CLASS_OF]: 'smalltalk/primitive/class-of',
  [SMALLTALK_PRIMITIVE.BASIC_NEW]: 'smalltalk/primitive/basic-new',
});

// The capture names are what the method bodies read as, so they are part of the installed program
// and are kept beside the ids they bind.
const CLASS_OF_CAPTURE = Object.freeze({
  id: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.CLASS_OF],
  name: 'primitiveClassOf',
});
const BASIC_NEW_CAPTURE = Object.freeze({
  id: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.BASIC_NEW],
  name: 'primitiveBasicNew',
});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

// `aPrimitive value: self` — an ordinary Block send, which ADR 0044 decision 11 answers without a
// class, so the host effect rides the existing send/resumption machinery in both lanes.
const sendPrimitive = (capture) => ({
  op: 'send',
  languageId: SYMMETRIC_SMALLTALK_ID,
  receiver: {op: 'binding', id: capture.id},
  message: textValue('value:'),
  arguments: [{op: 'receiver'}],
});

// The installed protocol, as it reads in Smalltalk:
//
//   Object >> class        primitiveClassOf value: self
//   Object >> initialize   ^self
//   Class  >> basicNew     primitiveBasicNew value: self
//   Class  >> new          ^self basicNew initialize
//
// `new` is deliberately not a second allocation primitive: it is composition, and in the WASM lane
// the `basicNew` result feeding `initialize` is a non-tail send that the resumable ABI carries.
function protocolFor(kernel) {
  return [
    {
      classRef: kernel.objectClass,
      methods: [
        {
          selector: 'class',
          program: {parameters: [], captures: [{...CLASS_OF_CAPTURE}], body: sendPrimitive(CLASS_OF_CAPTURE)},
          captures: [{...CLASS_OF_CAPTURE, value: objectRef(kernel.ref.imageId, CLASS_OF_CAPTURE.id)}],
        },
        {
          selector: 'initialize',
          program: {parameters: [], captures: [], body: {op: 'receiver'}},
        },
      ],
    },
    {
      classRef: kernel.classClass,
      methods: [
        {
          selector: 'basicNew',
          program: {parameters: [], captures: [{...BASIC_NEW_CAPTURE}], body: sendPrimitive(BASIC_NEW_CAPTURE)},
          captures: [{...BASIC_NEW_CAPTURE, value: objectRef(kernel.ref.imageId, BASIC_NEW_CAPTURE.id)}],
        },
        {
          selector: 'new',
          program: {
            parameters: [],
            captures: [],
            body: {
              op: 'send',
              languageId: SYMMETRIC_SMALLTALK_ID,
              receiver: {
                op: 'send',
                languageId: SYMMETRIC_SMALLTALK_ID,
                receiver: {op: 'receiver'},
                message: textValue('basicNew'),
                arguments: [],
              },
              message: textValue('initialize'),
              arguments: [],
            },
          },
        },
      ],
    },
  ];
}

// Both writes are ensure-exact-or-create, like every other deterministic-id record in this
// substrate: an identical artifact left by a partial run is reused, and a differing one is refused
// rather than overwritten.
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

async function installSmalltalkAllocationProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  // Validated here rather than only inside `defineMethods`, which runs after both primitive Blocks
  // and their code artifacts are already committed. Validate everything before publishing anything.
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  // Primitives first: the methods capture their refs, and a method's environment may not point at a
  // Block that does not yet exist.
  const primitives = {};
  for (const primitive of [SMALLTALK_PRIMITIVE.CLASS_OF, SMALLTALK_PRIMITIVE.BASIC_NEW]) {
    primitives[primitive] = await installPrimitiveBlock({images, imageId, primitive});
  }

  for (const {classRef, methods} of protocolFor(kernel)) {
    await defineMethods({images, compilation, imageId, classRef, methods, lane});
  }

  // Workstream 3 (MessagePack pressure). Ordinary-source root-class protocol, installed here because
  // this installer already owns the base `Object` protocol (`class`/`initialize` above). These are
  // pure Smalltalk — no primitive, no compiler knowledge — reached for by real upstream source:
  // `MpEncoder class>>on:` ends in `yourself`, and `MpEncoder>>writeStream` guards with `isNil`.
  //
  // `isNil` needs both halves: `nil` is the kernel `UndefinedObject` singleton, so `nil isNil` must
  // find `^true` on `UndefinedObject` while every other receiver inherits `^false` from `Object`.
  // Installing only the `Object` half would leave `nil isNil` answering `false` by inheritance.
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: kernel.objectClass,
    methods: [
      {selector: 'yourself', source: '[ ^self ]'},
      {selector: 'isNil', source: '[ ^false ]'},
    ],
  });
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/class/UndefinedObject'),
    methods: [
      {selector: 'isNil', source: '[ ^true ]'},
    ],
  });

  return Object.freeze({
    classOfPrimitive: primitives[SMALLTALK_PRIMITIVE.CLASS_OF],
    basicNewPrimitive: primitives[SMALLTALK_PRIMITIVE.BASIC_NEW],
    objectClass: kernel.objectClass,
    classClass: kernel.classClass,
  });
}

export {
  BASIC_NEW_CAPTURE as SMALLTALK_BASIC_NEW_CAPTURE,
  CLASS_OF_CAPTURE as SMALLTALK_CLASS_OF_CAPTURE,
  PRIMITIVE_BLOCK_ID as SMALLTALK_PRIMITIVE_BLOCK_ID,
  installSmalltalkAllocationProtocol,
};
