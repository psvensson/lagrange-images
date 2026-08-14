import {canonicalizeValue, isObjectRef} from '../value/index.js';

function sameObjectRef(left, right) {
  return left.imageId === right.imageId && left.objectId === right.objectId;
}

function assertBlockApplicationReceiver(activation, label = 'callable Block') {
  if (!activation || typeof activation !== 'object' || Array.isArray(activation)) {
    throw new TypeError(`${label} activation must be an object`);
  }
  if (activation.receiver === null) return activation;

  const block = canonicalizeValue(activation.block);
  const receiver = canonicalizeValue(activation.receiver);
  if (!isObjectRef(block) || !isObjectRef(receiver) || !sameObjectRef(block, receiver)) {
    throw new TypeError(`${label} accepts only direct Block invocation or the Block itself as receiver`);
  }
  return activation;
}

export {assertBlockApplicationReceiver};
