import {VALUE_KIND, isObjectRef} from '../value/index.js';
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
      if (!isObjectRef(request.receiver)) {
        throw new TypeError('Symmetric Smalltalk v0 message receivers must be object refs');
      }

      const selector = request.message.value;
      const blockReceiver = await images.getBlock(request.receiver.imageId, request.receiver.objectId);
      if (blockReceiver) {
        const expected = blockValueSelector(request.arguments.length);
        if (selector !== expected) throw new TypeError(`Symmetric Smalltalk Block does not understand: ${selector}`);
        return Object.freeze({block: request.receiver});
      }

      const receiver = await images.getObject(request.receiver.imageId, request.receiver.objectId);
      if (!receiver) {
        throw new TypeError(`Symmetric Smalltalk receiver not found: ${request.receiver.imageId}/${request.receiver.objectId}`);
      }
      if (!receiver.behavior) {
        throw new TypeError(`Symmetric Smalltalk receiver has no behavior: ${request.receiver.imageId}/${request.receiver.objectId}`);
      }

      const behavior = await images.getObject(receiver.behavior.imageId, receiver.behavior.objectId);
      if (!behavior) {
        throw new TypeError(`Symmetric Smalltalk behavior not found: ${receiver.behavior.imageId}/${receiver.behavior.objectId}`);
      }
      const shape = await images.getShape(behavior.shape.imageId, behavior.shape.objectId);
      if (!shape) {
        throw new TypeError(`Symmetric Smalltalk behavior shape not found: ${behavior.shape.imageId}/${behavior.shape.objectId}`);
      }

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
      return Object.freeze({block: blockRef});
    },
  });
}

export {blockValueSelector, createSymmetricSmalltalkDispatcher};
