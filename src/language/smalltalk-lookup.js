import {VALUE_KIND, isObjectRef, textValue} from '../value/index.js';
import {TupleMap, TupleSet} from '../support/tuple-map.js';
import {
  isMethodDictionary,
  lookupSelectorInTable,
  validateMethodDictionary,
} from './smalltalk-method-dictionary.js';
import {
  assertUniqueSelectorShape,
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

// Callers hold records in some places and refs in others; a record has `id` where a ref has
// `objectId`, so normalize before formatting or the message reads `app/undefined`.
function asRef(value) {
  if (!value) return {imageId: 'unknown', objectId: 'unknown'};
  return {imageId: value.imageId, objectId: value.objectId ?? value.id};
}

class SmalltalkDanglingEdgeError extends TypeError {
  constructor(edge, fromValue, refValue) {
    const from = asRef(fromValue);
    const ref = asRef(refValue);
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
//
// `boolean` is deliberately absent. ADR 0045 supersedes its row: a boolean Value bridges to the
// dispatch image's `true`/`false` singleton and then resolves that object's behavior edge like any
// other object receiver. `Boolean` is still reached — `True` and `False` inherit from it — but not
// by dispatching a classless immediate through it.
const KERNEL_CLASS_FOR_KIND = Object.freeze({
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

// ADR 0049 decision 5a. Whole-table validation is `O(n)`; doing it per send would reinstate exactly
// the cost this representation removes. It is therefore done once per *record version*.
//
// This caches a structural fact about one immutable record version, never a lookup answer, so it
// cannot mask a method addition or a migration: whatever would change the answer also changes the
// `_version` in the key. That version component is the invalidation contract ADR 0044 decision 8
// requires before any durable-graph read may be memoized — without one, this would be forbidden.
class MethodDictionaryValidationCache {
  constructor() {
    this.validated = new TupleMap(3);
  }

  read(record, ref, nilRef) {
    const key = [record.imageId, record.id, String(record._version)];
    const hit = this.validated.get(key);
    if (hit) return hit;
    const table = validateMethodDictionary(record, ref, nilRef);
    this.validated.set(key, table);
    return table;
  }
}

async function methodAt(images, behavior, selector, nilRef, validationCache = null) {
  const dictionaryRef = behavior.methods;
  const dictionary = await images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
  if (!dictionary) {
    throw new SmalltalkDanglingEdgeError('methods', behavior.record, dictionaryRef);
  }

  // ADR 0049 decision 2: a record is read as what its own Shape says it is, so a hashed and a
  // legacy dictionary can sit in one superclass chain and resolve identically. Installing the new
  // format reinterprets nothing.
  if (isMethodDictionary(dictionary)) {
    const table = validationCache
      ? validationCache.read(dictionary, dictionaryRef, nilRef)
      : validateMethodDictionary(dictionary, dictionaryRef, nilRef);
    // One record read, and no Shape fetch: the selector set is the record's own indexed part.
    return lookupSelectorInTable(table, textValue(selector));
  }

  const shape = await images.getShape(dictionary.shape.imageId, dictionary.shape.objectId);
  if (!shape) {
    throw new SmalltalkDanglingEdgeError('method dictionary shape', dictionary, dictionary.shape);
  }
  // The invariant is that selector names are globally unique in a dictionary, so the whole shape is
  // validated rather than only the selector being sent. Checking one name would leave a corrupt
  // dictionary usable for every other selector.
  try {
    assertUniqueSelectorShape(shape, `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  } catch (error) {
    throw new SmalltalkMalformedBehaviorError(dictionaryRef, error);
  }
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
async function lookupSelector({images, behaviorRef, selector, nilRef, receiverDescription, validationCache = null}) {
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
    const method = await methodAt(images, behavior, selector, nilRef, validationCache);
    // ADR 0050 decision 5: *which* Behavior's dictionary supplied the method is a permission fact,
    // and this walk is the only place it is known. Reconstructing it later by asking which
    // dictionary holds a Block would be neither unique — a Block may legitimately sit in two — nor
    // trustworthy, since that answer comes from graph data a forged artifact can arrange.
    if (method) return {method, definingBehavior: currentRef};

    from = behavior.record;
    edge = 'superclass';
    currentRef = behavior.superclass;
  }

  throw new SmalltalkMessageNotUnderstoodError(selector, receiverDescription);
}

// ADR 0050 decision 5, as corrected: the layout a method of this Behavior may name. One
// implementation, shared by the binder and by the runtime permission check, because two would be two
// chances to disagree about what is visible and two different answers for corrupt graph state.
//
// Strict on purpose. Returning "no layout" for a cycle or a dangling Shape would convert corruption
// into an ordinary denial at runtime and into `unbound Symmetric Smalltalk name` at compile time —
// the same laundering of structural failure into a language-level outcome that ADR 0044's three-way
// split exists to prevent.
//
// `null` means exactly one thing: the walk reached the kernel `nil` terminator having found no
// declared layout.
async function visibleInstanceShape({images, behaviorRef, nilRef}) {
  const visited = new TupleSet(2);
  let currentRef = behaviorRef;

  while (!sameRef(currentRef, nilRef)) {
    if (!isObjectRef(currentRef)) {
      throw new TypeError('instance layout walk reached a non-ref superclass edge');
    }
    // Tuple-keyed, never a joined string: object ids are arbitrary non-empty text, so no separator
    // can make `imageId/objectId` injective.
    const key = [currentRef.imageId, currentRef.objectId];
    if (visited.has(key)) {
      throw new TypeError(
        `instance layout walk hit a superclass cycle at ${currentRef.imageId}/${currentRef.objectId}; `
        + 'the visible layout cannot be determined',
      );
    }
    visited.add(key);

    const behavior = await loadBehavior(images, currentRef, {edge: 'superclass', from: currentRef});
    if (!sameRef(behavior.instanceShape, nilRef)) {
      const shape = await images.getShape(behavior.instanceShape.imageId, behavior.instanceShape.objectId);
      if (!shape) throw new SmalltalkDanglingEdgeError('instanceShape', behavior.record, behavior.instanceShape);
      return shape;
    }
    currentRef = behavior.superclass;
  }
  return null;
}

// The class a receiver dispatches through, and the image that answers "which Integer?".
//
// `effectiveReceiver` is non-null only where the language nominates a different receiver from the
// one the message was sent to. That is the ADR 0045 boolean bridge and, today, nothing else.
async function behaviorRefFor({images, receiver, dispatchImage}) {
  if (isObjectRef(receiver)) {
    const record = await images.getObject(receiver.imageId, receiver.objectId);
    if (!record) {
      throw new TypeError(`Symmetric Smalltalk receiver not found: ${receiver.imageId}/${receiver.objectId}`);
    }
    return {record, behavior: record.behavior, effectiveReceiver: null};
  }
  // ADR 0045 decisions 2 and 3. A boolean Value is not boxed and gains nothing; for the duration of
  // this one send the dispatch image's `true` or `false` object *is* the receiver, so the method's
  // `self` is genuinely the singleton and lookup starts at `True` or `False` rather than at a class
  // chosen from a kind.
  if (receiver.kind === VALUE_KIND.BOOLEAN) {
    const kernel = await findSmalltalkKernel({images, imageId: dispatchImage});
    if (!kernel) throw new SmalltalkKernelMissingError(dispatchImage, receiver.kind);
    const singleton = receiver.value ? kernel.true : kernel.false;
    const record = await images.getObject(singleton.imageId, singleton.objectId);
    if (!record) {
      throw new TypeError(
        `Symmetric Smalltalk kernel singleton ${singleton.imageId}/${singleton.objectId} not found; `
        + 'the object graph is incomplete',
      );
    }
    return {record, behavior: record.behavior, effectiveReceiver: singleton, kernel};
  }
  // Decision 5a: an immediate Value carries no image, so the sender's dispatch image supplies one.
  const slotName = KERNEL_CLASS_FOR_KIND[receiver.kind];
  if (!slotName) return {record: null, behavior: null, effectiveReceiver: null};
  const kernel = await findSmalltalkKernel({images, imageId: dispatchImage});
  if (!kernel) throw new SmalltalkKernelMissingError(dispatchImage, receiver.kind);
  return {record: null, behavior: kernel[slotName], effectiveReceiver: null, kernel};
}

export {
  KERNEL_CLASS_FOR_KIND,
  MethodDictionaryValidationCache,
  SmalltalkDanglingEdgeError,
  SmalltalkKernelMissingError,
  SmalltalkMalformedBehaviorError,
  SmalltalkMessageNotUnderstoodError,
  behaviorRefFor,
  isBehaviorObject,
  visibleInstanceShape,
  lookupSelector,
  sameRef,
};
