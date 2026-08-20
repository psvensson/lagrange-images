import {VALUE_KIND, isObjectRef} from '../value/index.js';
import {findSmalltalkKernel, isBehaviorObject} from './smalltalk-kernel.js';
import {
  MethodDictionaryValidationCache,
  SmalltalkDanglingEdgeError,
  behaviorRefFor,
  lookupSelector,
} from './smalltalk-lookup.js';
import {findSmalltalkBlockProtocol} from './smalltalk-block-protocol.js';
import {findSmalltalkBlockUnwindProtocol} from './smalltalk-conditions.js';
import {SMALLTALK_KERNEL_PRIMITIVE_V1} from './smalltalk-primitives.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getObject', 'getShape', 'getBlock', 'getCodeArtifact']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

// The only two selectors the dispatcher recognizes for a Block beyond `value`. Mapping selector to
// protocol slot name keeps the dispatcher's knowledge to "which slot", never "which object".
const LOOP_SELECTOR = Object.freeze({
  'whileTrue:': 'whileTrue',
  'whileFalse:': 'whileFalse',
});

// ADR 0054. A separate protocol object from the loop one, so the dispatcher still knows only slot
// names and never an object id, and an image with loops but no unwind protocol stays coherent.
const UNWIND_SELECTOR = Object.freeze({
  'on:do:': {slot: 'onDo', arity: 2},
  'ensure:': {slot: 'ensure', arity: 1},
  'ifCurtailed:': {slot: 'ifCurtailed', arity: 1},
});

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
function resolution(block, effectiveReceiver, frame = null) {
  return Object.freeze({
    ...(effectiveReceiver ? {effectiveReceiver} : {}),
    ...(frame ? {frame} : {}),
    block,
  });
}

function createSymmetricSmalltalkDispatcher() {
  // Per dispatcher, so it lives and dies with the runtime that owns it rather than leaking between
  // images or across tests. Transient runtime state: never durable, never a Value, and correct to
  // drop at any moment (ADR 0049 decision 5a).
  const validationCache = new MethodDictionaryValidationCache();
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
          // ADR 0051: two more operations on the classless Block personality. The protocol is
          // looked up in the *condition* Block's image — which is the receiver, and therefore
          // already the dispatch image a nested send would compute — so the image that owns the
          // send owns the loop, and the answered nil is that image's.
          //
          // The dispatcher learns a protocol tag and two slot meanings, never an object id
          // (ADR 0044 decision 9). An image with no protocol falls through to the ordinary
          // does-not-understand below, which is the coherent answer for an image whose Blocks
          // simply do not loop; a corrupt one throws out of `findSmalltalkBlockProtocol` rather
          // than being degraded to that.
          const loopSlot = LOOP_SELECTOR[selector];
          if (loopSlot && request.arguments.length === 1) {
            const protocol = await findSmalltalkBlockProtocol({images, imageId: request.receiver.imageId});
            // Decision 9: the loop primitive is the language's own host operation, so it inherits
            // the caller's frame. The condition and body do not — they are reached by ordinary
            // `value` sends, which inherit nothing.
            if (protocol) return Object.freeze({block: protocol[loopSlot], inheritsFrame: true});
          }
          const unwind = UNWIND_SELECTOR[selector];
          if (unwind && request.arguments.length === unwind.arity) {
            const protocol = await findSmalltalkBlockUnwindProtocol({images, imageId: request.receiver.imageId});
            // Same rule as the loop primitives: the unwind primitive is the language's own host
            // operation and inherits the caller's frame, while the protected, handler and cleanup
            // Blocks are invoked in their own right and inherit nothing.
            if (protocol) return Object.freeze({block: protocol[unwind.slot], inheritsFrame: true});
          }
          const expected = blockValueSelector(request.arguments.length);
          if (selector !== expected) throw new TypeError(`Symmetric Smalltalk Block does not understand: ${selector}`);
          // ADR 0050 decision 5a. A kernel-primitive Block is how a method reaches a host operation,
          // so it inherits the invoking method's frame — that is the only way the slot primitives
          // can see whose `self` they are acting on. Every *other* Block send inherits nothing: a
          // method must not lend its identity to a Block it merely happens to invoke.
          const code = await images.getCodeArtifact(blockReceiver.code.imageId, blockReceiver.code.objectId);
          return code?.representation === SMALLTALK_KERNEL_PRIMITIVE_V1
            ? Object.freeze({block: request.receiver, inheritsFrame: true})
            : Object.freeze({block: request.receiver});
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
      const {method: blockRef, definingBehavior} = await lookupSelector({
        images,
        behaviorRef: behavior,
        selector,
        nilRef: kernel.nil,
        receiverDescription,
        validationCache,
      });
      // A selector that resolved to a Block ref which does not load is incomplete graph state, not
      // a message the receiver failed to understand.
      const method = await images.getBlock(blockRef.imageId, blockRef.objectId);
      if (!method) throw new SmalltalkDanglingEdgeError('method', behavior, blockRef);
      // ADR 0050 decision 5b: the trusted facts of this dispatch travel in the resolution, and the
      // invocation layer turns them into a transient envelope. They never reach the activation.
      return resolution(blockRef, effectiveReceiver, {definingBehavior, self: activeReceiver});
    },
  });
}

export {blockValueSelector, createSymmetricSmalltalkDispatcher};
