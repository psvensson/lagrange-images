import {objectRef, textValue} from '../value/index.js';
import {defineMethods, ensureBlock, ensureCodeArtifact, ensureNamedClass} from './smalltalk-class-builder.js';
import {ensureObject, ensureShape, findSmalltalkKernel, isLocalRef} from './smalltalk-kernel.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  parsePrimitiveCode,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';
import {EXCEPTION_SHAPE_ID} from './smalltalk-condition-ids.js';

// ADR 0054: conditions and handlers.
//
// Two halves. The unwind operations are Block selectors, so they arrive through a discoverable
// protocol object exactly as ADR 0051's loop selectors do — but a *separate* one, because that
// protocol is an exact two-slot record existing images already hold, and widening it would turn its
// exactness check into a migration. An image holding one protocol and not the other is coherent.
//
// The transfer protocol is ordinary methods on an ordinary class: `signal`, `resume:`, `return:` are
// sends to a condition object, which is an ordinary persistent object (decision 1a). Only the signal
// *occurrence* is transient, and it lives in the execution's condition runtime.
const SMALLTALK_BLOCK_UNWIND_PROTOCOL_V1 = 'smalltalk-block-unwind-protocol/v1';
const BLOCK_UNWIND_PROTOCOL_OBJECT_ID = 'smalltalk-block-unwind-protocol/v1';
const BLOCK_UNWIND_PROTOCOL_SHAPE_ID = 'smalltalk/block-unwind-protocol-shape/v1';

const UNWIND_SLOTS = Object.freeze([
  Object.freeze({
    id: 'block-unwind-on-do',
    name: 'onDo',
    primitive: SMALLTALK_PRIMITIVE.BLOCK_ON_DO,
    blockId: 'smalltalk/primitive/block-on-do',
  }),
  Object.freeze({
    id: 'block-unwind-ensure',
    name: 'ensure',
    primitive: SMALLTALK_PRIMITIVE.BLOCK_ENSURE,
    blockId: 'smalltalk/primitive/block-ensure',
  }),
  Object.freeze({
    id: 'block-unwind-if-curtailed',
    name: 'ifCurtailed',
    primitive: SMALLTALK_PRIMITIVE.BLOCK_IF_CURTAILED,
    blockId: 'smalltalk/primitive/block-if-curtailed',
  }),
]);

const CONDITION_PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.CONDITION_SIGNAL]: 'smalltalk/primitive/condition-signal',
  [SMALLTALK_PRIMITIVE.CONDITION_RESUME]: 'smalltalk/primitive/condition-resume',
  [SMALLTALK_PRIMITIVE.CONDITION_RETURN]: 'smalltalk/primitive/condition-return',
});

const CONDITION_CAPTURE_NAME = Object.freeze({
  [SMALLTALK_PRIMITIVE.CONDITION_SIGNAL]: 'primitiveConditionSignal',
  [SMALLTALK_PRIMITIVE.CONDITION_RESUME]: 'primitiveConditionResume',
  [SMALLTALK_PRIMITIVE.CONDITION_RETURN]: 'primitiveConditionReturn',
});

// The condition hierarchy. Deliberately shallow: this ADR makes failures catchable, and a rich
// taxonomy is library work rather than a substrate decision.
const CONDITION_CLASSES = Object.freeze([
  {name: 'Exception', superclass: null},
  {name: 'Error', superclass: 'Exception'},
  {name: 'IndexOutOfRange', superclass: 'Error'},
  {name: 'EmptyCollection', superclass: 'Error'},
  // ADR 0054 decision 8's "now" set: the existing host errors that gain a Smalltalk-visible class.
  {name: 'ZeroDivide', superclass: 'Error'},
  {name: 'IndexBounds', superclass: 'Error'},
  {name: 'KeyNotFound', superclass: 'Error'},
]);




class SmalltalkConditionProtocolError extends TypeError {
  constructor(imageId, detail) {
    super(`Symmetric Smalltalk Block unwind protocol in ${imageId} is corrupt: ${detail}`);
    this.name = 'SmalltalkConditionProtocolError';
    this.imageId = imageId;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

async function installPrimitiveBlock({images, imageId, primitive, blockId}) {
  const code = await ensureCodeArtifact(images, imageId, {
    id: `${blockId}:code`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SMALLTALK_KERNEL_PRIMITIVE_V1,
    content: textValue(primitiveCodeContent(primitive)),
    metadata: {smalltalk: 'kernel-primitive', primitive},
  });
  const block = await ensureBlock(images, imageId, {
    id: blockId,
    code: objectRef(imageId, code.id),
    environment: null,
    metadata: {smalltalk: 'kernel-primitive', primitive},
  });
  return objectRef(imageId, block.id);
}

const RECEIVER = Object.freeze({op: 'receiver'});
const ARGUMENT = Object.freeze({op: 'argument', index: 0});

const applyPrimitive = (blockId, args) => ({
  op: 'send',
  languageId: SYMMETRIC_SMALLTALK_ID,
  receiver: {op: 'binding', id: blockId},
  message: textValue(args.length === 1 ? 'value:' : 'value:value:'),
  arguments: args,
});

async function installSmalltalkConditionProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  // Primitives before anything that points at them.
  const unwind = {};
  for (const slot of UNWIND_SLOTS) {
    unwind[slot.id] = await installPrimitiveBlock({
      images, imageId, primitive: slot.primitive, blockId: slot.blockId,
    });
  }
  const conditionPrimitives = {};
  for (const [primitive, blockId] of Object.entries(CONDITION_PRIMITIVE_BLOCK_ID)) {
    conditionPrimitives[primitive] = await installPrimitiveBlock({images, imageId, primitive, blockId});
  }

  const shapeRecord = await ensureShape(images, imageId, {
    id: BLOCK_UNWIND_PROTOCOL_SHAPE_ID,
    slots: UNWIND_SLOTS.map(({id, name}) => ({id, name})),
  });
  await ensureObject(images, imageId, {
    id: BLOCK_UNWIND_PROTOCOL_OBJECT_ID,
    shape: objectRef(imageId, shapeRecord.id),
    behavior: null,
    slots: unwind,
    metadata: {protocol: SMALLTALK_BLOCK_UNWIND_PROTOCOL_V1},
  });

  // The condition classes, and `messageText` so a condition can carry a description.
  const instanceShapeRef = await (async () => {
    const record = await ensureShape(images, imageId, {
      id: EXCEPTION_SHAPE_ID,
      slots: [{id: 'exception-message-text', name: 'messageText'}],
    });
    return objectRef(imageId, record.id);
  })();

  // `ensureNamedClass` rather than `defineClass`: re-installation must converge, and `defineClass`
  // also ensures an empty method dictionary, so it conflicts once `Exception` has methods. The same
  // reason the library uses it.
  const classes = {};
  for (const {name, superclass} of CONDITION_CLASSES) {
    classes[name] = (await ensureNamedClass({
      images,
      imageId,
      name,
      instanceShapeRef,
      superclassRef: superclass ? classes[superclass] : kernel.objectClass,
    })).classRef;
  }

  const capture = (primitive) => Object.freeze({
    id: CONDITION_PRIMITIVE_BLOCK_ID[primitive],
    name: CONDITION_CAPTURE_NAME[primitive],
  });
  const signalCapture = capture(SMALLTALK_PRIMITIVE.CONDITION_SIGNAL);
  const resumeCapture = capture(SMALLTALK_PRIMITIVE.CONDITION_RESUME);
  const returnCapture = capture(SMALLTALK_PRIMITIVE.CONDITION_RETURN);

  await defineMethods({
    images,
    compilation,
    imageId,
    lane,
    classRef: classes.Exception,
    methods: [
      {
        selector: 'signal',
        program: {
          parameters: [],
          captures: [{...signalCapture}],
          body: applyPrimitive(signalCapture.id, [RECEIVER]),
        },
        captures: [{...signalCapture, value: conditionPrimitives[SMALLTALK_PRIMITIVE.CONDITION_SIGNAL]}],
      },
      {
        selector: 'resume:',
        program: {
          parameters: [{id: 'resume:arg', name: 'value'}],
          captures: [{...resumeCapture}],
          body: applyPrimitive(resumeCapture.id, [RECEIVER, ARGUMENT]),
        },
        captures: [{...resumeCapture, value: conditionPrimitives[SMALLTALK_PRIMITIVE.CONDITION_RESUME]}],
      },
      {
        selector: 'return:',
        program: {
          parameters: [{id: 'return:arg', name: 'value'}],
          captures: [{...returnCapture}],
          body: applyPrimitive(returnCapture.id, [RECEIVER, ARGUMENT]),
        },
        captures: [{...returnCapture, value: conditionPrimitives[SMALLTALK_PRIMITIVE.CONDITION_RETURN]}],
      },
      {
        selector: 'messageText',
        program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('')}},
      },
    ],
  });

  return Object.freeze({
    protocol: SMALLTALK_BLOCK_UNWIND_PROTOCOL_V1,
    ref: objectRef(imageId, BLOCK_UNWIND_PROTOCOL_OBJECT_ID),
    ...classes,
  });
}

// Discovery mirrors `findSmalltalkBlockProtocol` exactly: absent stays distinct from corrupt, and
// each slot's target is proven to be the primitive that slot claims rather than merely being a
// local ref.
async function findSmalltalkBlockUnwindProtocol({images, imageId} = {}) {
  requiredText(imageId, 'block unwind protocol image id');
  const record = await images.getObject(imageId, BLOCK_UNWIND_PROTOCOL_OBJECT_ID);
  if (!record) return null;
  if (record.metadata?.protocol !== SMALLTALK_BLOCK_UNWIND_PROTOCOL_V1) {
    throw new SmalltalkConditionProtocolError(imageId, `object does not declare ${SMALLTALK_BLOCK_UNWIND_PROTOCOL_V1}`);
  }
  if (!isLocalRef(record.shape, imageId, BLOCK_UNWIND_PROTOCOL_SHAPE_ID)) {
    throw new SmalltalkConditionProtocolError(imageId, `object does not have shape ${BLOCK_UNWIND_PROTOCOL_SHAPE_ID}`);
  }
  const refs = {};
  for (const slot of UNWIND_SLOTS) {
    const value = record.slots?.[slot.id];
    if (!isLocalRef(value, imageId)) {
      throw new SmalltalkConditionProtocolError(imageId, `slot ${slot.name} must be an unpinned local ref`);
    }
    const block = await images.getBlock(value.imageId, value.objectId);
    if (!block) throw new SmalltalkConditionProtocolError(imageId, `slot ${slot.name} does not reference a Block`);
    const code = block.code && await images.getCodeArtifact(block.code.imageId, block.code.objectId);
    if (!code) {
      throw new SmalltalkConditionProtocolError(imageId, `slot ${slot.name} references a Block with no code artifact`);
    }
    if (code.representation !== SMALLTALK_KERNEL_PRIMITIVE_V1) {
      throw new SmalltalkConditionProtocolError(imageId, `slot ${slot.name} does not reference a kernel primitive`);
    }
    // The same strict contract ADR 0051 uses, not a private JSON read: this object routes dispatch,
    // so a malformed declaration must be refused by the parser that owns that format rather than
    // by whatever a local `JSON.parse` happens to tolerate.
    let declared;
    try {
      declared = parsePrimitiveCode(code);
    } catch (error) {
      throw new SmalltalkConditionProtocolError(imageId, `slot ${slot.name} references an unreadable primitive`, {cause: error});
    }
    if (declared !== slot.primitive) {
      throw new SmalltalkConditionProtocolError(
        imageId, `slot ${slot.name} references the ${declared} primitive, not ${slot.primitive}`,
      );
    }
    refs[slot.name] = value;
  }
  return Object.freeze({protocol: SMALLTALK_BLOCK_UNWIND_PROTOCOL_V1, ref: objectRef(imageId, record.id), ...refs});
}

export {
  BLOCK_UNWIND_PROTOCOL_OBJECT_ID,
  BLOCK_UNWIND_PROTOCOL_SHAPE_ID,
  CONDITION_CLASSES,
  SMALLTALK_BLOCK_UNWIND_PROTOCOL_V1,
  SmalltalkConditionProtocolError,
  UNWIND_SLOTS,
  findSmalltalkBlockUnwindProtocol,
  installSmalltalkConditionProtocol,
};
