import {
  NoActiveOccurrenceError,
  UnhandledConditionError,
  performNonLocalReturn,
  runConditionHandler,
  runUnwindProtection,
  signalConditionOccurrence,
  transferConditionOccurrence,
} from '../execution/conditions.js';
import {sameRefIdentity} from './smalltalk-equality.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {behaviorRefFor} from './smalltalk-lookup.js';
import {
  SMALLTALK_PRIMITIVE,
  SmalltalkPrimitiveReceiverError,
  assertLoopBlock,
  requireSendMessage,
} from './smalltalk-primitive-support.js';
import {TupleSet} from '../support/tuple-map.js';
import {
  VALUE_KIND,
  canonicalizeValue,
  isObjectRef,
  textValue,
} from '../value/index.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// The control-transfer primitives: loops (ADR 0051), unwind protection and the condition transfer
// protocol (ADR 0054), and non-local return (ADR 0055). Everything here manipulates activations and
// scopes rather than durable object state.

class SmalltalkUnhandledConditionError extends UnhandledConditionError {
  constructor(description) {
    super(description, `unhandled Smalltalk condition: ${description}`);
    this.name = 'SmalltalkUnhandledConditionError';
  }
}

class SmalltalkNoActiveOccurrenceError extends NoActiveOccurrenceError {
  constructor(operation) {
    super(operation);
    this.name = 'SmalltalkNoActiveOccurrenceError';
  }
}

// ADR 0055. `^ expr` lowers to `$nonLocalReturn value: expr`, so this primitive runs with the home
// method's frame already in hand: a kernel-primitive send INHERITS the caller's frame (ADR 0050 rule
// 2), and a closure activation RESTORES the frame it was created in (rule 3). Chained, those two
// rules hand it the home frame with no new propagation.
//
// It never catches its own transfer, because it only *borrows* that frame — decision 3a makes
// stopping the transfer the owner's job.
function nonLocalReturn({activation, context, primitive}) {
  return performNonLocalReturn({
    context,
    value: activation.arguments[0],
    requireConditionRuntimeMessage: `Symmetric Smalltalk ${primitive} primitive requires a condition runtime`,
  });
}

// ADR 0054. The unwind operations and the transfer protocol.
//
// All three Block operations share one shape: establish a scope on the execution's condition
// runtime, run the protected Block, and leave the scope on the way out however that happens.
function requireConditions(context, primitive) {
  const facade = context?.conditions;
  if (!facade || typeof facade.captureAuthority !== 'function' || typeof facade.invoke !== 'function') {
    throw new TypeError(`Symmetric Smalltalk ${primitive} primitive requires a condition runtime`);
  }
  return facade;
}

// A condition handles another when its class is the same or an ancestor. Walked through the ordinary
// Behavior chain, so a user-defined Exception subclass participates without the runtime knowing it
// exists.
async function conditionIsKindOf({images, conditionClass, candidateClass}) {
  let current = candidateClass;
  const seen = new TupleSet(2);
  while (isObjectRef(current)) {
    if (sameRefIdentity(current, conditionClass)) return true;
    if (seen.has([current.imageId, current.objectId])) return false;
    seen.add([current.imageId, current.objectId]);
    const behavior = await images.getObject(current.imageId, current.objectId);
    if (!behavior) return false;
    const superclass = behavior.slots?.['behavior-superclass'];
    current = isObjectRef(superclass) ? superclass : null;
  }
  return false;
}

async function classOfCondition({images, primitiveImage, condition}) {
  const {behavior} = await behaviorRefFor({images, receiver: condition, dispatchImage: primitiveImage});
  return behavior;
}

async function blockOnDo({images, activation, context, primitive}) {
  const protectedBlock = await assertLoopBlock({
    images, value: activation.receiver, primitive, role: 'protected block',
  });
  const [conditionClass, handlerBlock] = activation.arguments;
  if (!isObjectRef(canonicalizeValue(conditionClass))) {
    throw new SmalltalkPrimitiveReceiverError(primitive, 'a non-class as the condition class');
  }
  const handler = await assertLoopBlock({images, value: handlerBlock, primitive, role: 'handler block'});
  const facade = requireConditions(context, primitive);
  // Captured here, at establishment: the handler runs with the rights in force where `on:do:` was
  // written, never with the signaller's.
  return await runConditionHandler({
    facade,
    conditionClass,
    handlerBlock: handler,
    protectedBlock,
  });
}

async function blockEnsure({images, activation, context, primitive, onlyWhenCurtailed}) {
  const protectedBlock = await assertLoopBlock({
    images, value: activation.receiver, primitive, role: 'protected block',
  });
  const cleanupBlock = await assertLoopBlock({
    images, value: activation.arguments[0], primitive, role: 'cleanup block',
  });
  const facade = requireConditions(context, primitive);
  // Every non-normal exit, not only a catchable condition: a host trap crossing this scope travels
  // as an ordinary throw and must run the cleanup too. Protection that only fired for catchable
  // failures would stop working exactly when something unexpected happened.
  return await runUnwindProtection({
    facade,
    kind: primitive,
    protectedBlock,
    cleanupBlock,
    onlyWhenCurtailed,
  });
}

async function conditionSignal({images, primitiveImage, activation, context, primitive}) {
  const condition = canonicalizeValue(activation.arguments[0]);
  if (!isObjectRef(condition)) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a ${condition.kind} Value as the condition`);
  }
  const facade = requireConditions(context, primitive);
  const conditionClass = await classOfCondition({images, primitiveImage, condition});

  // A handler for class H catches a condition of class C when C is H or a subclass of it.
  return await signalConditionOccurrence({
    facade,
    condition,
    matches: async (handled) =>
      await conditionIsKindOf({images, conditionClass: handled, candidateClass: conditionClass}),
    describeCondition: () => {
      // Name the condition's CLASS, not only the instance. An unhandled condition is a diagnostic
      // that has to survive into a stack trace and a test assertion, and an object id alone says
      // nothing about what was signalled; the class is what a reader greps for.
      // A record may legitimately carry a null behavior, so this never assumes one; an unhandled
      // condition must not turn into a TypeError about the diagnostic itself.
      const named = conditionClass ? `${conditionClass.imageId}/${conditionClass.objectId}` : 'an unknown class';
      return `${named} (${condition.imageId}/${condition.objectId})`;
    },
    createUnhandledError: (description) => new SmalltalkUnhandledConditionError(description),
  });
}

function conditionTransferOut({facade, condition, value, kind, primitive}) {
  return transferConditionOccurrence({
    facade,
    sameCondition: (candidate) => sameRefIdentity(candidate, condition),
    value,
    kind,
    operation: primitive,
    createNoActiveOccurrenceError: (operation) => new SmalltalkNoActiveOccurrenceError(operation),
  });
}

// The loop itself. Every evaluation is an ordinary nested `value` send through the execution
// context, never a direct execution of the Block's code, so lexical frame restoration, authority
// attenuation, the dispatch image and cell arenas are inherited rather than reimplemented here.
//
// Constant activation depth falls out of the shape rather than from any bookkeeping: each `await`
// returns before the next send begins, so the sends are siblings from this one activation rather
// than a nesting chain, and depth does not grow with iteration count.
async function blockWhile({images, activation, context, primitive, wanted}) {
  const condition = await assertLoopBlock({
    images, value: activation.receiver, primitive, role: 'condition',
  });
  const body = !wanted && activation.arguments.length === 0 ? null : await assertLoopBlock({
    images, value: activation.arguments[0], primitive, role: 'body',
  });
  const sendMessage = requireSendMessage(context, primitive);

  // ADR 0051 decision 12: the loop answers the condition image's nil, rediscovered from that image's
  // current kernel rather than captured at install time — a captured nil would keep answering after
  // the image's kernel changed underneath it. Resolved before the first iteration so a broken kernel
  // fails as a kernel failure rather than after the body has already had effects.
  const conditionImage = condition.imageId;
  const kernel = await findSmalltalkKernel({images, imageId: conditionImage});
  if (!kernel) {
    throw new TypeError(
      `Symmetric Smalltalk ${primitive} primitive requires a Smalltalk kernel in ${conditionImage} to answer nil`,
    );
  }

  for (;;) {
    context?.checkCancelled?.();
    const verdict = canonicalizeValue(await sendMessage({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: condition,
      message: textValue('value'),
      arguments: [],
    }));
    // ADR 0051 decision 7: a canonical boolean, and nothing else. Accepting more would introduce a
    // second, looser notion of truth beside the polymorphism ADR 0045 established.
    if (verdict.kind !== VALUE_KIND.BOOLEAN) {
      throw new TypeError(
        `Symmetric Smalltalk ${primitive} condition answered a ${verdict.kind} Value; a Boolean is required`,
      );
    }
    if (verdict.value !== wanted) return kernel.nil;
    if (body !== null) await sendMessage({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: body,
      message: textValue('value'),
      arguments: [],
    });
  }
}

export {
  SmalltalkNoActiveOccurrenceError,
  SmalltalkUnhandledConditionError,
  blockEnsure,
  blockOnDo,
  blockWhile,
  conditionSignal,
  conditionTransferOut,
  nonLocalReturn,
  requireConditions,
};
