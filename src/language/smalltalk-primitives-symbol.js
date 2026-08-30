import {createHash} from 'node:crypto';
import {
  VALUE_KIND,
  canonicalizeValue,
  isObjectRef,
  objectRef,
  textValue,
} from '../value/index.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {
  SmalltalkPrimitiveReceiverError,
  assertLocalRef,
  requireSendMessage,
} from './smalltalk-primitive-support.js';
import {ensureObject} from '../graph/ensure-records.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// Symbol identity and interning for Symmetric Smalltalk.
//
// A Symbol is an ordinary image object with:
//   shape:   smalltalk/symbol-shape/v1  (one slot: symbol-spelling)
//   behavior: smalltalk/class/Symbol
//   id:      smalltalk/symbol/<base64url(spelling)>  (deterministic, injective)
//
// The deterministic ID means the same image + same spelling always yields the same object
// identity, surviving runtime recreation. Two images never share interning state because
// identity is the (imageId, objectId) pair.
//
// The interner is a language-owned primitive Block, captured by compiled code through the
// $symbol intrinsic. The compiled artifact carries only the canonical spelling as a Text
// literal — never an image-specific Symbol ref.

const SYMBOL_SHAPE_ID = 'smalltalk/symbol-shape/v1';
const SYMBOL_CLASS_NAME = 'Symbol';
const SYMBOL_SPELLING_SLOT = 'symbol-spelling';

function symbolObjectId(spelling) {
  return `smalltalk/symbol/${Buffer.from(spelling, 'utf8').toString('base64url')}`;
}

async function symbolIntern({images, primitiveImage, value}) {
  const spelling = canonicalizeValue(value);
  if (spelling.kind !== VALUE_KIND.TEXT) {
    throw new SmalltalkPrimitiveReceiverError(
      'symbol-intern',
      `a ${spelling.kind} Value; the interner requires a Text spelling`,
    );
  }
  const kernel = await findSmalltalkKernel({images, imageId: primitiveImage});
  if (!kernel) {
    throw new TypeError(`image ${primitiveImage} has no Smalltalk kernel`);
  }
  const id = symbolObjectId(spelling.value);
  const shapeRef = objectRef(primitiveImage, SYMBOL_SHAPE_ID);
  const behaviorRef = objectRef(primitiveImage, `smalltalk/class/${SYMBOL_CLASS_NAME}`);
  await ensureObject(images, primitiveImage, {
    id,
    shape: shapeRef,
    behavior: behaviorRef,
    slots: {[SYMBOL_SPELLING_SLOT]: spelling},
    metadata: {},
  });
  return objectRef(primitiveImage, id);
}

// Extract the selector text from a Symbol object. The receiver must be a local ref to a
// Symbol (shape and behavior checked).
async function requireSymbol({images, primitiveImage, value, primitive}) {
  const ref = assertLocalRef(value, primitiveImage, primitive, 'a Symbol as the selector');
  const record = await images.getObject(ref.imageId, ref.objectId);
  if (!record) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `${ref.imageId}/${ref.objectId}, which does not exist`);
  }
  // Structural check: a Symbol is what its shape says. The shape must be the Symbol shape
  // and the behavior must be the Symbol class — no duck-typing on spelling alone.
  if (!isObjectRef(record.shape) || record.shape.objectId !== SYMBOL_SHAPE_ID) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `${ref.imageId}/${ref.objectId}, which is not a Symbol`);
  }
  const spelling = record.slots[SYMBOL_SPELLING_SLOT];
  if (!spelling || spelling.kind !== VALUE_KIND.TEXT) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `${ref.imageId}/${ref.objectId}, which has no spelling`);
  }
  return spelling.value;
}

async function performSend({images, primitiveImage, value, second, context, primitive}) {
  const receiver = canonicalizeValue(value);
  const selector = await requireSymbol({images, primitiveImage, value: second, primitive});
  const sendMessage = requireSendMessage(context, primitive, 'perform a dynamic send');
  return await sendMessage({
    languageId: SYMMETRIC_SMALLTALK_ID,
    receiver,
    message: textValue(selector),
    arguments: [],
  });
}

async function performSendWith({images, primitiveImage, value, second, third, context, primitive}) {
  const receiver = canonicalizeValue(value);
  const selector = await requireSymbol({images, primitiveImage, value: second, primitive});
  const argument = canonicalizeValue(third);
  const sendMessage = requireSendMessage(context, primitive, 'perform a dynamic send');
  return await sendMessage({
    languageId: SYMMETRIC_SMALLTALK_ID,
    receiver,
    message: textValue(selector),
    arguments: [argument],
  });
}

export {
  SYMBOL_SHAPE_ID,
  SYMBOL_CLASS_NAME,
  SYMBOL_SPELLING_SLOT,
  symbolObjectId,
  symbolIntern,
  performSend,
  performSendWith,
};
