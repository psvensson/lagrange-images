import {
  ConditionTransfer,
  NonLocalReturnHomeError,
  NonLocalReturnTransfer,
  SmalltalkNoActiveOccurrenceError,
  SmalltalkUnhandledConditionError,
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

// ADR 0055. `^ expr` lowers to `$nonLocalReturn value: expr`, so this primitive runs with the home
// method's frame already in hand: a kernel-primitive send INHERITS the caller's frame (ADR 0050 rule
// 2), and a closure activation RESTORES the frame it was created in (rule 3). Chained, those two
// rules hand it the home frame with no new propagation.
//
// It never catches its own transfer, because it only *borrows* that frame — decision 3a makes
// stopping the transfer the owner's job.
function nonLocalReturn({activation, context, primitive}) {
  const frame = context?.invocationFrame ?? null;
  if (!frame) {
    // No frame at all: the Block outlived the execution that created it, so its home is
    // unreachable — the same fail-closed shape ADR 0050 decision 10a gives an escaped
    // ivar-dependent closure, and for the same reason.
    throw new NonLocalReturnHomeError(
      'the Block has no home frame; it outlived the execution that created it',
    );
  }
  if (typeof context.conditions?.homeActivationState !== 'function') {
    throw new TypeError(`Symmetric Smalltalk ${primitive} primitive requires a condition runtime`);
  }
  const state = context.conditions.homeActivationState(frame);
  if (state === 'dead') {
    // The frame is still reachable, so its identity is known — and it is known to be finished.
    // Saying so beats the vaguer "no home", which is why the registry retains dead entries.
    const selector = context.conditions.homeActivationSelector?.(frame) ?? null;
    const behavior = frame.definingBehavior?.objectId ?? 'unknown';
    throw new NonLocalReturnHomeError(
      `the home method activation has already returned: ${behavior}${selector ? ` >> ${selector}` : ''}`,
    );
  }
  if (state !== 'live') {
    // A frame this executor never ran as a home: distinct from one that ran and returned, and the
    // reason the registry has three states rather than two.
    throw new NonLocalReturnHomeError('the frame in force is not a home method activation');
  }
  throw new NonLocalReturnTransfer(frame, canonicalizeValue(activation.arguments[0]));
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
  const authorityToken = facade.captureAuthority();

  const scopeId = facade.runtime.enterHandler({
    conditionClass: canonicalizeValue(conditionClass), block: handler, authorityToken,
  });
  try {
    return await facade.invoke(authorityToken, protectedBlock, []);
  } catch (error) {
    // `return:` — including a handler's ordinary value, which means `return:` implicitly — lands
    // here, and only for *this* scope. Anything aimed at an outer scope keeps travelling.
    if (error instanceof ConditionTransfer && error.kind === 'return' && error.scopeId === scopeId) {
      return canonicalizeValue(error.value);
    }
    throw error;
  } finally {
    facade.runtime.leave(scopeId);
  }
}

async function blockEnsure({images, activation, context, primitive, onlyWhenCurtailed}) {
  const protectedBlock = await assertLoopBlock({
    images, value: activation.receiver, primitive, role: 'protected block',
  });
  const cleanupBlock = await assertLoopBlock({
    images, value: activation.arguments[0], primitive, role: 'cleanup block',
  });
  const facade = requireConditions(context, primitive);
  const authorityToken = facade.captureAuthority();
  const scopeId = facade.runtime.enterProtection({kind: primitive, block: cleanupBlock, authorityToken});

  let result = null;
  let primary = null;
  try {
    result = await facade.invoke(authorityToken, protectedBlock, []);
  } catch (error) {
    primary = error;
  } finally {
    facade.runtime.leave(scopeId);
  }

  // Every non-normal exit, not only a catchable condition: a host trap crossing this scope travels
  // as an ordinary throw and must run the cleanup too. Protection that only fired for catchable
  // failures would stop working exactly when something unexpected happened.
  if (primary !== null || !onlyWhenCurtailed) {
    try {
      // The cleanup Block's own value is discarded — cleanup runs for its effect, and letting it
      // replace the answer would make adding a logging line change what the expression evaluates to.
      await facade.invoke(authorityToken, cleanupBlock, []);
    } catch (secondary) {
      // A cleanup failure is a real failure and stays catchable. It becomes the failure travelling
      // outward, retaining the one that was already unwinding so neither is lost.
      if (primary !== null && secondary && typeof secondary === 'object' && !secondary.duringUnwind) {
        secondary.duringUnwind = primary;
      }
      throw secondary;
    }
  }
  if (primary !== null) throw primary;
  return result;
}

async function conditionSignal({images, primitiveImage, activation, context, primitive}) {
  const condition = canonicalizeValue(activation.arguments[0]);
  if (!isObjectRef(condition)) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a ${condition.kind} Value as the condition`);
  }
  const facade = requireConditions(context, primitive);
  const conditionClass = await classOfCondition({images, primitiveImage, condition});

  // A handler for class H catches a condition of class C when C is H or a subclass of it.
  const scope = await facade.runtime.findHandler(async (handled) =>
    await conditionIsKindOf({images, conditionClass: handled, candidateClass: conditionClass}));
  if (!scope) {
    throw new SmalltalkUnhandledConditionError(`${condition.imageId}/${condition.objectId}`);
  }

  const occurrence = facade.runtime.beginOccurrence(condition, scope.scopeId);
  try {
    // Disabled while it runs, so a re-signal from inside the handler delegates to an *outer*
    // handler rather than recursing into itself.
    const answer = await facade.runtime.withDisabled(
      scope,
      async () => await facade.invoke(scope.authorityToken, scope.block, [condition]),
    );
    // A handler's ordinary value means `return:`.
    throw new ConditionTransfer('return', scope.scopeId, canonicalizeValue(answer));
  } catch (error) {
    if (error instanceof ConditionTransfer && error.kind === 'resume' && error.occurrenceId === occurrence) {
      // The signalling send answers, and computation continues — which in the WASM lane is the
      // guest resuming at its effect site, with no ABI involvement at all.
      return canonicalizeValue(error.value);
    }
    throw error;
  } finally {
    facade.runtime.endOccurrence(occurrence);
  }
}

function conditionTransferOut({facade, condition, value, kind, primitive}) {
  const occurrence = facade.runtime.activeOccurrenceFor(
    (candidate) => sameRefIdentity(candidate, condition),
  );
  if (!occurrence) throw new SmalltalkNoActiveOccurrenceError(primitive);
  if (kind === 'resume') {
    throw new ConditionTransfer('resume', null, value, occurrence.occurrenceId);
  }
  throw new ConditionTransfer('return', occurrence.handlerScopeId, value);
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
  const body = await assertLoopBlock({
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
    await sendMessage({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: body,
      message: textValue('value'),
      arguments: [],
    });
  }
}

export {
  blockEnsure,
  blockOnDo,
  blockWhile,
  conditionSignal,
  conditionTransferOut,
  nonLocalReturn,
  requireConditions,
};
