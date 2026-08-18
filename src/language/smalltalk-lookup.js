import {VALUE_KIND, isObjectRef} from '../value/index.js';
import {TupleSet} from '../support/tuple-map.js';
import {
  findSmalltalkKernel,
  isBehaviorObject,
  readBehavior,
} from './smalltalk-kernel.js';

// ADR 0044 method lookup: walk the receiver's Behavior and its superclasses until the selector is
// found. Three failures are kept apart on purpose, because they mean different things and a caller
// that cannot tell them apart cannot respond correctly to any of them.
//
//   malformed Behavior     a record claiming the fixed shape whose slots do not hold what that
//                          shape promises. A structural defect in one record.
//   dangling edge          a well-formed Behavior whose superclass or method dictionary does not
//                          resolve. Corrupt or incomplete graph state, not a message miss.
//   not understood         the walk completed and no class implements the selector. An ordinary
//                          language-level outcome.
class SmalltalkMalformedBehaviorError extends TypeError {
  constructor(ref, cause) {
    super(`malformed Behavior ${ref.imageId}/${ref.objectId}: ${cause.message}`, {cause});
    this.name = 'SmalltalkMalformedBehaviorError';
    this.behavior = ref;
  }
}

class SmalltalkDanglingEdgeError extends TypeError {
  constructor(edge, from, ref) {
    super(
      `Behavior ${from.imageId}/${from.objectId} has a dangling ${edge} edge to `
      + `${ref.imageId}/${ref.objectId}; the object graph is incomplete`,
    );
    this.name = 'SmalltalkDanglingEdgeError';
    this.edge = edge;
    this.from = from;
    this.target = ref;
  }
}

class SmalltalkMessageNotUnderstoodError extends TypeError {
  constructor(selector, receiverDescription) {
    super(`Symmetric Smalltalk message not understood: ${selector} sent to ${receiverDescription}`);
    this.name = 'SmalltalkMessageNotUnderstoodError';
    this.selector = selector;
  }
}

class SmalltalkKernelMissingError extends TypeError {
  constructor(imageId, kind) {
    super(
      `image ${imageId} has no Smalltalk kernel, so a ${kind} Value has no class to dispatch through`,
    );
    this.name = 'SmalltalkKernelMissingError';
    this.imageId = imageId;
  }
}

// Decision 5: an immediate Value has no `behavior` field, so its class comes from its kind. Which
// image's class is a question the dispatch image answers.
const KERNEL_CLASS_FOR_KIND = Object.freeze({
  [VALUE_KIND.BOOLEAN]: 'booleanClass',
  [VALUE_KIND.INTEGER]: 'integerClass',
  [VALUE_KIND.FLOAT64]: 'floatClass',
  [VALUE_KIND.TEXT]: 'textClass',
  [VALUE_KIND.BYTES]: 'byteArrayClass',
});

function sameRef(left, right) {
  return Boolean(left) && Boolean(right)
    && left.kind === right.kind
    && left.imageId === right.imageId
    && left.objectId === right.objectId;
}

async function loadBehavior(images, ref, {edge = null, from = null} = {}) {
  const record = await images.getObject(ref.imageId, ref.objectId);
  // An absent target is a dangling edge when we arrived along one, and a malformed receiver
  // otherwise. Both are graph problems; neither is a selector miss.
  if (!record) {
    if (edge) throw new SmalltalkDanglingEdgeError(edge, from, ref);
    throw new SmalltalkDanglingEdgeError('behavior', from ?? ref, ref);
  }
  try {
    return await readBehavior(images, ref);
  } catch (error) {
    throw new SmalltalkMalformedBehaviorError(ref, error);
  }
}

async function methodAt(images, behavior, selector) {
  const dictionaryRef = behavior.methods;
  const dictionary = await images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
  if (!dictionary) {
    throw new SmalltalkDanglingEdgeError('methods', behavior.record, dictionaryRef);
  }
  const shape = await images.getShape(dictionary.shape.imageId, dictionary.shape.objectId);
  if (!shape) {
    throw new SmalltalkDanglingEdgeError('method dictionary shape', dictionary, dictionary.shape);
  }
  // Selector names are unique in a MethodDictionary by construction, so this cannot resolve by
  // position — see ADR 0044 decision 2.
  const slot = shape.slots.find(({name}) => name === selector);
  if (!slot) return null;
  const method = dictionary.slots[slot.id];
  if (!isObjectRef(method)) {
    throw new SmalltalkMalformedBehaviorError(
      dictionaryRef,
      new TypeError(`method slot for ${selector} must contain an unpinned Block ref`),
    );
  }
  return method;
}

// The walk. Terminates when a Behavior's superclass is the kernel's `nil`, compared as a full ref
// rather than by object id.
//
// That comparison is defence in depth today rather than an active discriminator: `readBehavior`
// requires a superclass to be a local ref, so a foreign `smalltalk/nil` is rejected as a malformed
// Behavior before the chain could reach here, and within one image the two comparisons coincide. It
// is written this way so that relaxing the locality rule for cross-image inheritance would not
// silently turn every image's `smalltalk/nil` into a chain terminator.
async function lookupSelector({images, behaviorRef, selector, nilRef, receiverDescription}) {
  const visited = new TupleSet(2);
  let currentRef = behaviorRef;
  let edge = null;
  let from = null;

  while (!sameRef(currentRef, nilRef)) {
    const key = [currentRef.imageId, currentRef.objectId];
    if (visited.has(key)) {
      throw new TypeError(
        `Symmetric Smalltalk superclass cycle at ${currentRef.imageId}/${currentRef.objectId}`,
      );
    }
    visited.add(key);

    const behavior = await loadBehavior(images, currentRef, {edge, from});
    const method = await methodAt(images, behavior, selector);
    if (method) return method;

    from = behavior.record;
    edge = 'superclass';
    currentRef = behavior.superclass;
  }

  throw new SmalltalkMessageNotUnderstoodError(selector, receiverDescription);
}

// The class a receiver dispatches through, and the image that answers "which Integer?".
async function behaviorRefFor({images, receiver, dispatchImage}) {
  if (isObjectRef(receiver)) {
    const record = await images.getObject(receiver.imageId, receiver.objectId);
    if (!record) {
      throw new TypeError(`Symmetric Smalltalk receiver not found: ${receiver.imageId}/${receiver.objectId}`);
    }
    return {record, behavior: record.behavior};
  }
  // Decision 5a: an immediate Value carries no image, so the sender's dispatch image supplies one.
  const slotName = KERNEL_CLASS_FOR_KIND[receiver.kind];
  if (!slotName) return {record: null, behavior: null};
  const kernel = await findSmalltalkKernel({images, imageId: dispatchImage});
  if (!kernel) throw new SmalltalkKernelMissingError(dispatchImage, receiver.kind);
  return {record: null, behavior: kernel[slotName], kernel};
}

export {
  KERNEL_CLASS_FOR_KIND,
  SmalltalkDanglingEdgeError,
  SmalltalkKernelMissingError,
  SmalltalkMalformedBehaviorError,
  SmalltalkMessageNotUnderstoodError,
  behaviorRefFor,
  isBehaviorObject,
  lookupSelector,
  sameRef,
};
