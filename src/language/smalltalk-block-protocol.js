import {objectRef, textValue} from '../value/index.js';
import {ensureBlock, ensureCodeArtifact} from './smalltalk-class-builder.js';
import {ensureObject, ensureShape, findSmalltalkKernel, isLocalRef} from './smalltalk-kernel.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  parsePrimitiveCode,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0051: the discoverable Block protocol, which is how `whileTrue:`/`whileFalse:` reach their
// loop primitives without the dispatcher ever knowing an object id (ADR 0044 decision 9).
//
// Discovery deliberately mirrors `findSmalltalkKernel` rather than inventing a second bootstrap
// style: one well-known id, a fixed local Shape, a protocol tag, and absent kept distinct from
// corrupt. An image with no protocol object is coherent — its Blocks simply do not loop — while a
// damaged one is an explicit failure, because degrading it to "absent" would turn a broken image
// into a quietly less capable one.
const SMALLTALK_BLOCK_PROTOCOL_V1 = 'smalltalk-block-protocol/v1';
const BLOCK_PROTOCOL_OBJECT_ID = 'smalltalk-block-protocol/v1';
const BLOCK_PROTOCOL_SHAPE_ID = 'smalltalk/block-protocol-shape/v1';

// Each slot names the primitive its target must actually be, so validation is an equality against a
// known name rather than "some primitive is there".
const BLOCK_PROTOCOL_SLOTS = Object.freeze([
  Object.freeze({
    id: 'block-protocol-while-true',
    name: 'whileTrue',
    primitive: SMALLTALK_PRIMITIVE.BLOCK_WHILE_TRUE,
    blockId: 'smalltalk/primitive/block-while-true',
  }),
  Object.freeze({
    id: 'block-protocol-while-false',
    name: 'whileFalse',
    primitive: SMALLTALK_PRIMITIVE.BLOCK_WHILE_FALSE,
    blockId: 'smalltalk/primitive/block-while-false',
  }),
]);

class SmalltalkBlockProtocolError extends TypeError {
  constructor(imageId, detail) {
    super(`Symmetric Smalltalk Block protocol in ${imageId} is corrupt: ${detail}`);
    this.name = 'SmalltalkBlockProtocolError';
    this.imageId = imageId;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

// Ensure-exact-or-create at both deterministic ids, like every other derived record here: an
// identical artifact left by a partial run is reused and a differing one refused, so a retry after a
// lost acknowledgement converges instead of conflicting.
async function installLoopPrimitive({images, imageId, slot}) {
  const code = await ensureCodeArtifact(images, imageId, {
    id: `${slot.blockId}:code`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SMALLTALK_KERNEL_PRIMITIVE_V1,
    content: textValue(primitiveCodeContent(slot.primitive)),
    metadata: {smalltalk: 'kernel-primitive', primitive: slot.primitive},
  });
  const block = await ensureBlock(images, imageId, {
    id: slot.blockId,
    code: objectRef(imageId, code.id),
    environment: null,
    metadata: {smalltalk: 'kernel-primitive', primitive: slot.primitive},
  });
  return objectRef(imageId, block.id);
}

async function installSmalltalkBlockProtocol({images, imageId} = {}) {
  requiredText(imageId, 'image id');
  // ADR 0051 decision 12: the loop answers this image's nil, so it cannot work without a kernel
  // here. Refusing up front beats installing a protocol that is guaranteed to fail at the first
  // send, and it is checked before anything is written.
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel; install the kernel first`);

  // Primitives before the protocol object, so the object never points at a Block that does not yet
  // exist — a partially-written protocol must never be discoverable.
  const slots = {};
  const refs = {};
  for (const slot of BLOCK_PROTOCOL_SLOTS) {
    const ref = await installLoopPrimitive({images, imageId, slot});
    slots[slot.id] = ref;
    refs[slot.name] = ref;
  }

  const shapeRecord = await ensureShape(images, imageId, {
    id: BLOCK_PROTOCOL_SHAPE_ID,
    slots: BLOCK_PROTOCOL_SLOTS.map(({id, name}) => ({id, name})),
  });
  await ensureObject(images, imageId, {
    id: BLOCK_PROTOCOL_OBJECT_ID,
    shape: objectRef(imageId, shapeRecord.id),
    behavior: null,
    slots,
    metadata: {protocol: SMALLTALK_BLOCK_PROTOCOL_V1},
  });

  return Object.freeze({
    protocol: SMALLTALK_BLOCK_PROTOCOL_V1,
    ref: objectRef(imageId, BLOCK_PROTOCOL_OBJECT_ID),
    ...refs,
  });
}

// Validating the object is not validating the loop. A structurally perfect protocol whose slots have
// been repointed passes every check above — the slots are still local, still unpinned, still refs —
// so each ref is followed and the target proven to be the primitive that slot claims.
//
// The cost is justified by what this object is: a routing authority the dispatcher hands control of
// a `whileTrue:` send, and one whose target inherits the caller's frame (ADR 0051 decision 9).
// Accepting a local ref as sufficient would let any Block in the image run with borrowed identity.
async function validateLoopTarget({images, imageId, slot, ref}) {
  const block = await images.getBlock(ref.imageId, ref.objectId);
  if (!block) {
    throw new SmalltalkBlockProtocolError(imageId, `slot ${slot.name} does not reference a Block`);
  }
  const code = block.code && await images.getCodeArtifact(block.code.imageId, block.code.objectId);
  if (!code) {
    throw new SmalltalkBlockProtocolError(imageId, `slot ${slot.name} references a Block with no code artifact`);
  }
  if (code.representation !== SMALLTALK_KERNEL_PRIMITIVE_V1) {
    throw new SmalltalkBlockProtocolError(
      imageId,
      `slot ${slot.name} references a ${code.representation} Block, not a ${SMALLTALK_KERNEL_PRIMITIVE_V1} primitive`,
    );
  }
  let primitive;
  try {
    primitive = parsePrimitiveCode(code);
  } catch (error) {
    throw new SmalltalkBlockProtocolError(imageId, `slot ${slot.name} references an unreadable primitive`, {cause: error});
  }
  // Equality against the expected name, so while-true and while-false cannot be swapped for each
  // other any more than either can be swapped for an unrelated primitive.
  if (primitive !== slot.primitive) {
    throw new SmalltalkBlockProtocolError(
      imageId,
      `slot ${slot.name} references the ${primitive} primitive, not ${slot.primitive}`,
    );
  }
  return ref;
}

async function findSmalltalkBlockProtocol({images, imageId} = {}) {
  requiredText(imageId, 'block protocol image id');
  const record = await images.getObject(imageId, BLOCK_PROTOCOL_OBJECT_ID);
  // Absent: this image's Blocks do not loop. Every other outcome below is corrupt.
  if (!record) return null;
  if (record.metadata?.protocol !== SMALLTALK_BLOCK_PROTOCOL_V1) {
    throw new SmalltalkBlockProtocolError(imageId, `object does not declare ${SMALLTALK_BLOCK_PROTOCOL_V1}`);
  }
  if (!isLocalRef(record.shape, imageId, BLOCK_PROTOCOL_SHAPE_ID)) {
    throw new SmalltalkBlockProtocolError(imageId, `object does not have shape ${BLOCK_PROTOCOL_SHAPE_ID}`);
  }
  const refs = {};
  for (const slot of BLOCK_PROTOCOL_SLOTS) {
    const value = record.slots?.[slot.id];
    if (!isLocalRef(value, imageId)) {
      throw new SmalltalkBlockProtocolError(imageId, `slot ${slot.name} must be an unpinned local ref`);
    }
    refs[slot.name] = await validateLoopTarget({images, imageId, slot, ref: value});
  }
  return Object.freeze({protocol: SMALLTALK_BLOCK_PROTOCOL_V1, ref: objectRef(imageId, record.id), record, ...refs});
}

export {
  BLOCK_PROTOCOL_OBJECT_ID,
  BLOCK_PROTOCOL_SHAPE_ID,
  BLOCK_PROTOCOL_SLOTS,
  SMALLTALK_BLOCK_PROTOCOL_V1,
  SmalltalkBlockProtocolError,
  findSmalltalkBlockProtocol,
  installSmalltalkBlockProtocol,
};
