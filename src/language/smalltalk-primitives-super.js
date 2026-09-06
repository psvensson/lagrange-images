import {VALUE_KIND, isObjectRef, textValue} from '../value/index.js';
import {findSmalltalkKernel, readBehavior} from './smalltalk-kernel.js';
import {SmalltalkDanglingEdgeError, lookupSelector} from './smalltalk-lookup.js';
import {
  SmalltalkPrimitiveReceiverError,
  requireInvokeResolvedMethod,
} from './smalltalk-primitive-support.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0089. The runtime half of `super`, and the only thing in the system that knows a super send
// exists at all.
//
// `super` is NOT another receiver. For `super parseDocumentFrom: aStream` the message goes to the
// invoking method's own `self`; only the STARTING POINT of selector lookup differs, and it is
// `superclass(the DEFINING Behavior of the running method)` — not the receiver's class, not the
// receiver's class's superclass, and not a class named in source. Those coincide for a receiver
// whose class is exactly the defining class and diverge for every deeper subclass, which is the
// whole reason the distinction is load-bearing.
//
// The defining Behavior is not reconstructed here. ADR 0050 decision 5 already rejected asking
// which dictionary holds a Block — a Block may legitimately sit in more than one, and the answer
// would come from graph data a forged artifact can arrange — so it is taken from the trusted
// dispatch frame the invocation owner built at the moment the running method was resolved. This
// primitive reads that frame exactly as the instance-slot primitives read it, and for the same
// reason: it is the only place the fact is known and unforgeable.
//
// Nothing here walks a superclass chain or reads a method dictionary. Lookup is delegated to
// `lookupSelector`, the Symmetric Smalltalk lookup owner, with a different starting Behavior; the
// resolved method is activated by the invocation owner through `invokeResolvedMethod`. This module
// composes the two owners and owns neither.

class SmalltalkSuperFrameMissingError extends TypeError {
  constructor(primitive) {
    super(
      `Symmetric Smalltalk ${primitive} has no method frame; a super send starts above the DEFINING `
      + 'Behavior of the running method, and a closure that outlived its execution no longer names one',
    );
    this.name = 'SmalltalkSuperFrameMissingError';
    this.primitive = primitive;
  }
}

function describeReceiver(self) {
  return isObjectRef(self) ? `${self.imageId}/${self.objectId}` : `a ${self.kind} Value`;
}

async function superSend({images, activation, context, primitive}) {
  // ADR 0050 decision 5b's envelope. A super send is meaningful only inside a method activation:
  // without a frame there is no defining Behavior to start above, so this fails closed rather than
  // guessing one from the receiver.
  const frame = context?.invocationFrame ?? null;
  if (!frame) throw new SmalltalkSuperFrameMissingError(primitive);

  // The compiler emits the selector as a Text literal and the message's own arguments after it, so
  // one primitive serves unary, binary and keyword super sends.
  const [selectorValue, ...args] = activation.arguments;
  if (selectorValue?.kind !== VALUE_KIND.TEXT || selectorValue.value.length === 0) {
    throw new SmalltalkPrimitiveReceiverError(primitive, 'a selector that is not non-empty text');
  }
  const selector = selectorValue.value;

  const {definingBehavior, self} = frame;
  const kernel = await findSmalltalkKernel({images, imageId: definingBehavior.imageId});
  if (!kernel) throw new TypeError(`image ${definingBehavior.imageId} has no Smalltalk kernel`);

  // The Behavior owner reads the record and validates its fixed shape; the superclass edge is the
  // one it already publishes. Reading the slot directly here would be a second Behavior reader.
  const behavior = await readBehavior(images, definingBehavior);
  // Deliberately no branch for "the defining Behavior is the root". A kernel-nil superclass makes
  // the shared walk terminate immediately, which is exactly the ordinary message-not-understood
  // outcome a super send off the top of the hierarchy should have. A special case here would be a
  // second place deciding when lookup ends.
  const receiverDescription = describeReceiver(self);
  const {method: blockRef, definingBehavior: resolved} = await lookupSelector({
    images,
    behaviorRef: behavior.superclass,
    selector,
    nilRef: kernel.nil,
    receiverDescription,
  });

  // Same distinction the dispatcher keeps: a selector that resolved to a Block ref which does not
  // load is incomplete graph state, not a message the receiver failed to understand.
  const method = await images.getBlock(blockRef.imageId, blockRef.objectId);
  if (!method) throw new SmalltalkDanglingEdgeError('method', behavior.superclass, blockRef);

  // `self` is unchanged, and the callee's frame carries the Behavior that ACTUALLY supplied the
  // method rather than the one this send started above. That is what makes a second `super` inside
  // the resolved method start above ITS defining Behavior, and what keeps the instance-slot
  // permission check answering for the right class.
  const invoke = requireInvokeResolvedMethod(context, primitive);
  return await invoke({
    languageId: SYMMETRIC_SMALLTALK_ID,
    block: blockRef,
    receiver: self,
    message: textValue(selector),
    arguments: args,
    frame: {self, definingBehavior: resolved},
  });
}

export {SmalltalkSuperFrameMissingError, superSend};
