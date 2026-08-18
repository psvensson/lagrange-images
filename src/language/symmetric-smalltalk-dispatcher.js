import {VALUE_KIND, isObjectRef} from '../value/index.js';
import {findSmalltalkKernel, isBehaviorObject} from './smalltalk-kernel.js';
import {
  SmalltalkDanglingEdgeError,
  behaviorRefFor,
  lookupSelector,
} from './smalltalk-lookup.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getObject', 'getShape', 'getBlock']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

function blockValueSelector(argumentCount) {
  if (!Number.isInteger(argumentCount) || argumentCount < 0) throw new TypeError('argument count must be a non-negative integer');
  return argumentCount === 0 ? 'value' : Array.from({length: argumentCount}, () => 'value:').join('');
}

// The pre-ADR-0044 convention, unchanged: a behavior object whose *shape slot names* are selectors.
// Lifted here rather than reimplemented, so an already-stored object keeps answering exactly as it
// did before any kernel existed.
async function legacyLookup(images, behavior, selector) {
  const shape = await images.getShape(behavior.shape.imageId, behavior.shape.objectId);
  if (!shape) {
    throw new TypeError(`Symmetric Smalltalk behavior shape not found: ${behavior.shape.imageId}/${behavior.shape.objectId}`);
  }
  // Deliberately the pre-0044 TypeError and wording. Decision 10 preserves what an already-stored
  // object *means*, and a failure is part of that meaning: a legacy receiver that did not
  // understand a selector must still fail exactly as it did before any kernel existed.
  const methodSlot = shape.slots.find(({name}) => name === selector);
  if (!methodSlot) throw new TypeError(`Symmetric Smalltalk message not understood: ${selector}`);
  const blockRef = behavior.slots[methodSlot.id];
  if (!isObjectRef(blockRef)) {
    throw new TypeError(`Symmetric Smalltalk method slot ${methodSlot.id} must contain a Block ref`);
  }
  const block = await images.getBlock(blockRef.imageId, blockRef.objectId);
  if (!block) {
    throw new TypeError(`Symmetric Smalltalk method Block not found: ${blockRef.imageId}/${blockRef.objectId}`);
  }
  return blockRef;
}

// ADR 0045 decision 7: the key is present only when the language actually nominates a different
// receiver, so an ordinary send produces exactly the `{block}` resolution it always has.
function resolution(block, effectiveReceiver) {
  return effectiveReceiver
    ? Object.freeze({block, effectiveReceiver})
    : Object.freeze({block});
}

function createSymmetricSmalltalkDispatcher() {
  return Object.freeze({
    languageId: SYMMETRIC_SMALLTALK_ID,

    async resolveMessage(request, context) {
      const images = assertImages(context?.images);
      if (request.languageId !== SYMMETRIC_SMALLTALK_ID) {
        throw new TypeError(`unexpected language id for Symmetric Smalltalk dispatcher: ${request.languageId}`);
      }
      if (request.message?.kind !== VALUE_KIND.TEXT) {
        throw new TypeError('Symmetric Smalltalk v0 messages must be text Values');
      }
      const selector = request.message.value;

      // ADR 0044 decision 11: a Block answers value/value: without a class. Checked first, as it
      // always has been.
      if (isObjectRef(request.receiver)) {
        const blockReceiver = await images.getBlock(request.receiver.imageId, request.receiver.objectId);
        if (blockReceiver) {
          const expected = blockValueSelector(request.arguments.length);
          if (selector !== expected) throw new TypeError(`Symmetric Smalltalk Block does not understand: ${selector}`);
          return Object.freeze({block: request.receiver});
        }
      }

      // Decision 5a: an immediate Value has no image of its own, so the dispatch image says which
      // kernel's Integer, Text and so on apply.
      const dispatchImage = context?.dispatchImage
        ?? (isObjectRef(request.receiver) ? request.receiver.imageId : null);
      if (!isObjectRef(request.receiver) && dispatchImage === null) {
        throw new TypeError(
          'Symmetric Smalltalk needs a dispatch image to send to an immediate Value; '
          + 'a top-level send must supply one',
        );
      }

      // ADR 0045 decision 2: for a boolean receiver this answers the dispatch image's `true`/`false`
      // singleton, which then behaves exactly like an ordinary object receiver.
      const {behavior, effectiveReceiver} = await behaviorRefFor({
        images,
        receiver: request.receiver,
        dispatchImage,
      });
      // What the method actually runs against, and therefore what every failure below should name.
      // Describing the original boolean here would report `undefined/undefined` for a bridged send
      // and, worse, would hide which singleton failed to understand the selector.
      const activeReceiver = effectiveReceiver ?? request.receiver;
      const receiverDescription = isObjectRef(activeReceiver)
        ? `${activeReceiver.imageId}/${activeReceiver.objectId}`
        : `a ${activeReceiver.kind} Value`;
      if (!behavior) {
        throw new TypeError(
          isObjectRef(activeReceiver)
            ? `Symmetric Smalltalk receiver has no behavior: ${receiverDescription}`
            : `Symmetric Smalltalk cannot dispatch a ${activeReceiver.kind} Value`,
        );
      }

      const behaviorRecord = await images.getObject(behavior.imageId, behavior.objectId);
      if (!behaviorRecord) {
        throw new TypeError(`Symmetric Smalltalk behavior not found: ${behavior.imageId}/${behavior.objectId}`);
      }

      // ADR 0044 decision 10. A behavior record means what its own shape says it means, so
      // installing a kernel reinterprets nothing that already exists.
      if (!isBehaviorObject(behaviorRecord)) {
        return resolution(await legacyLookup(images, behaviorRecord, selector), effectiveReceiver);
      }

      const kernel = await findSmalltalkKernel({images, imageId: behavior.imageId});
      if (!kernel) {
        throw new TypeError(
          `image ${behavior.imageId} holds a fixed-shape Behavior but no Smalltalk kernel to terminate lookup`,
        );
      }
      const blockRef = await lookupSelector({
        images,
        behaviorRef: behavior,
        selector,
        nilRef: kernel.nil,
        receiverDescription,
      });
      // A selector that resolved to a Block ref which does not load is incomplete graph state, not
      // a message the receiver failed to understand.
      const method = await images.getBlock(blockRef.imageId, blockRef.objectId);
      if (!method) throw new SmalltalkDanglingEdgeError('method', behavior, blockRef);
      return resolution(blockRef, effectiveReceiver);
    },
  });
}

export {blockValueSelector, createSymmetricSmalltalkDispatcher};
