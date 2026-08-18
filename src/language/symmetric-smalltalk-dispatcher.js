import {VALUE_KIND, isObjectRef} from '../value/index.js';
import {findSmalltalkKernel, isBehaviorObject} from './smalltalk-kernel.js';
import {
  SmalltalkMessageNotUnderstoodError,
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
  const methodSlot = shape.slots.find(({name}) => name === selector);
  if (!methodSlot) throw new SmalltalkMessageNotUnderstoodError(selector, `${behavior.imageId}/${behavior.id}`);
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

      const {record: receiver, behavior} = await behaviorRefFor({
        images,
        receiver: request.receiver,
        dispatchImage,
      });
      if (!behavior) {
        throw new TypeError(
          isObjectRef(request.receiver)
            ? `Symmetric Smalltalk receiver has no behavior: ${request.receiver.imageId}/${request.receiver.objectId}`
            : `Symmetric Smalltalk cannot dispatch a ${request.receiver.kind} Value`,
        );
      }

      const behaviorRecord = await images.getObject(behavior.imageId, behavior.objectId);
      if (!behaviorRecord) {
        throw new TypeError(`Symmetric Smalltalk behavior not found: ${behavior.imageId}/${behavior.objectId}`);
      }

      // ADR 0044 decision 10. A behavior record means what its own shape says it means, so
      // installing a kernel reinterprets nothing that already exists.
      if (!isBehaviorObject(behaviorRecord)) {
        return Object.freeze({block: await legacyLookup(images, behaviorRecord, selector)});
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
        receiverDescription: receiver
          ? `${request.receiver.imageId}/${request.receiver.objectId}`
          : `a ${request.receiver.kind} Value`,
      });
      const method = await images.getBlock(blockRef.imageId, blockRef.objectId);
      if (!method) {
        throw new TypeError(`Symmetric Smalltalk method Block not found: ${blockRef.imageId}/${blockRef.objectId}`);
      }
      return Object.freeze({block: blockRef});
    },
  });
}

export {blockValueSelector, createSymmetricSmalltalkDispatcher};
