import {canonicalizeValue} from '../value/index.js';

// ADR 0054: the condition runtime.
//
// One execution-wide stack of scopes, owned beside the arena and living exactly as long. The three
// classless-Block operations (`on:do:`, `ensure:`, `ifCurtailed:`) only enter and leave scopes on it,
// and signalling only searches it — so the neutral and WASM lanes share one handler search and one
// transfer mechanism, and WASM contributes nothing but the suspend/resume/retire behaviour it
// already had. There is deliberately no "WASM exception system".
//
// Nothing here is durable. A scope reaches no record, no Value and no activation field: it is
// execution context in the way `dispatchImage`, the authority context and ADR 0050's frame are.

// The unwind mechanism. Thrown to move control to a scope that is still on the stack, and carried by
// the host's own stack unwinding — which is what makes `ensure:` fire for host failures too, since
// they travel the same way.
class ConditionTransfer extends Error {
  constructor(kind, scopeId, value, occurrenceId = null) {
    super(`condition transfer (${kind})`);
    this.name = 'ConditionTransfer';
    this.kind = kind;
    this.scopeId = scopeId;
    this.value = value;
    this.occurrenceId = occurrenceId;
  }
}

// ADR 0055. A transfer that names a *home method activation* rather than a handler scope, which is
// why `on:do:` cannot intercept one: it is a different class and carries a frame, not a scope id.
class NonLocalReturnTransfer extends Error {
  constructor(frame, value) {
    super('non-local return');
    this.name = 'NonLocalReturnTransfer';
    this.frame = frame;
    this.value = value;
  }
}

class NonLocalReturnHomeError extends TypeError {
  constructor(detail) {
    super(`non-local return has no live home method activation: ${detail}`);
    this.name = 'NonLocalReturnHomeError';
  }
}

class UnhandledConditionError extends TypeError {
  constructor(description, message = `unhandled condition: ${description}`) {
    super(message);
    this.name = 'UnhandledConditionError';
    this.description = description;
  }
}

class NoActiveOccurrenceError extends TypeError {
  constructor(operation) {
    super(`${operation} requires a condition that is currently being handled`);
    this.name = 'NoActiveOccurrenceError';
    this.operation = operation;
  }
}

class ConditionRuntime {
  #scopes = [];
  #occurrences = [];
  #nextId = 0;

  // `authorityToken` is an opaque handle to the authority in force at establishment. The runtime
  // carries it and never reads it; only the executor can resolve it (ADR 0037). Deliberately *not*
  // a bound invoker: binding one would freeze the establishment frame's depth and dispatch image
  // too, and a handler must run at the signal point's depth and in its own Block's image.
  enterHandler({conditionClass, block, authorityToken}) {
    const scopeId = (this.#nextId += 1);
    this.#scopes.push({scopeId, kind: 'handler', conditionClass, block, authorityToken, active: true});
    return scopeId;
  }

  enterProtection({kind, block, authorityToken}) {
    const scopeId = (this.#nextId += 1);
    this.#scopes.push({scopeId, kind, block, authorityToken, active: true});
    return scopeId;
  }

  // Truncates rather than pops: an unwind may have skipped scopes established inside this one, and
  // leaving them on the stack would let a later signal find a handler whose `on:do:` has returned.
  leave(scopeId) {
    const index = this.#scopes.findIndex((scope) => scope.scopeId === scopeId);
    if (index >= 0) this.#scopes.length = index;
  }

  // Innermost first, and only scopes that are active — a handler is disabled while it runs, so a
  // re-signal from inside it delegates outward instead of recursing into itself.
  //
  // Asynchronous because matching walks the candidate's superclass chain through the image, which is
  // I/O. Sequential rather than parallel on purpose: innermost-first is the semantics, not an
  // optimisation, so the first match must be the innermost one.
  async findHandler(matches) {
    for (let index = this.#scopes.length - 1; index >= 0; index -= 1) {
      const scope = this.#scopes[index];
      if (scope.kind !== 'handler' || !scope.active) continue;
      if (await matches(scope.conditionClass)) return scope;
    }
    return null;
  }

  // The handling scope is recorded on the occurrence, so `return:` knows where to unwind to without
  // the condition object carrying any control-flow state.
  beginOccurrence(condition, handlerScopeId) {
    const occurrenceId = (this.#nextId += 1);
    this.#occurrences.push({occurrenceId, condition, handlerScopeId, active: true});
    return occurrenceId;
  }

  endOccurrence(occurrenceId) {
    const index = this.#occurrences.findIndex((entry) => entry.occurrenceId === occurrenceId);
    if (index >= 0) this.#occurrences.splice(index, 1);
  }

  // The receiver's *currently active* occurrence. One condition object signalled twice has two, and
  // neither may see the other's — so this is resolved per handling and never read off the object.
  activeOccurrenceFor(sameCondition) {
    for (let index = this.#occurrences.length - 1; index >= 0; index -= 1) {
      const entry = this.#occurrences[index];
      if (entry.active && sameCondition(entry.condition)) return entry;
    }
    return null;
  }

  withDisabled(scope, body) {
    scope.active = false;
    return Promise.resolve()
      .then(body)
      .finally(() => { scope.active = true; });
  }
}

function performNonLocalReturn({
  context,
  value,
  requireConditionRuntimeMessage = 'non-local return requires a condition runtime',
  formatDeadHome = null,
}) {
  const frame = context?.invocationFrame ?? null;
  if (!frame) {
    throw new NonLocalReturnHomeError(
      'the Block has no home frame; it outlived the execution that created it',
    );
  }
  if (typeof context.conditions?.homeActivationState !== 'function') {
    throw new TypeError(requireConditionRuntimeMessage);
  }
  const state = context.conditions.homeActivationState(frame);
  if (state === 'dead') {
    const selector = context.conditions.homeActivationSelector?.(frame) ?? null;
    const summary = typeof formatDeadHome === 'function'
      ? formatDeadHome({frame, selector})
      : `${frame.definingBehavior?.objectId ?? 'unknown'}${selector ? ` >> ${selector}` : ''}`;
    throw new NonLocalReturnHomeError(
      `the home method activation has already returned: ${summary}`,
    );
  }
  if (state !== 'live') {
    throw new NonLocalReturnHomeError('the frame in force is not a home method activation');
  }
  throw new NonLocalReturnTransfer(frame, canonicalizeValue(value));
}

async function runConditionHandler({facade, conditionClass, handlerBlock, protectedBlock}) {
  const authorityToken = facade.captureAuthority();
  const scopeId = facade.runtime.enterHandler({
    conditionClass: canonicalizeValue(conditionClass),
    block: handlerBlock,
    authorityToken,
  });
  try {
    return await facade.invoke(authorityToken, protectedBlock, []);
  } catch (error) {
    if (error instanceof ConditionTransfer && error.kind === 'return' && error.scopeId === scopeId) {
      return canonicalizeValue(error.value);
    }
    throw error;
  } finally {
    facade.runtime.leave(scopeId);
  }
}

async function runUnwindProtection({
  facade,
  kind,
  protectedBlock,
  cleanupBlock,
  onlyWhenCurtailed = false,
}) {
  const authorityToken = facade.captureAuthority();
  const scopeId = facade.runtime.enterProtection({kind, block: cleanupBlock, authorityToken});

  let result = null;
  let primary = null;
  try {
    result = await facade.invoke(authorityToken, protectedBlock, []);
  } catch (error) {
    primary = error;
  } finally {
    facade.runtime.leave(scopeId);
  }

  if (primary !== null || !onlyWhenCurtailed) {
    try {
      await facade.invoke(authorityToken, cleanupBlock, []);
    } catch (secondary) {
      if (primary !== null && secondary && typeof secondary === 'object' && !secondary.duringUnwind) {
        secondary.duringUnwind = primary;
      }
      throw secondary;
    }
  }
  if (primary !== null) throw primary;
  return result;
}

async function signalConditionOccurrence({
  facade,
  condition,
  matches,
  createUnhandledError = (description) => new UnhandledConditionError(description),
  describeCondition = () => 'condition',
}) {
  const normalizedCondition = canonicalizeValue(condition);
  const scope = await facade.runtime.findHandler(matches);
  if (!scope) {
    throw createUnhandledError(describeCondition());
  }

  const occurrence = facade.runtime.beginOccurrence(normalizedCondition, scope.scopeId);
  try {
    const answer = await facade.runtime.withDisabled(
      scope,
      async () => await facade.invoke(scope.authorityToken, scope.block, [normalizedCondition]),
    );
    throw new ConditionTransfer('return', scope.scopeId, canonicalizeValue(answer));
  } catch (error) {
    if (error instanceof ConditionTransfer && error.kind === 'resume' && error.occurrenceId === occurrence) {
      return canonicalizeValue(error.value);
    }
    throw error;
  } finally {
    facade.runtime.endOccurrence(occurrence);
  }
}

function transferConditionOccurrence({
  facade,
  sameCondition,
  value,
  kind,
  operation,
  createNoActiveOccurrenceError = (op) => new NoActiveOccurrenceError(op),
}) {
  const occurrence = facade.runtime.activeOccurrenceFor(sameCondition);
  if (!occurrence) throw createNoActiveOccurrenceError(operation);
  const normalizedValue = canonicalizeValue(value);
  if (kind === 'resume') {
    throw new ConditionTransfer('resume', null, normalizedValue, occurrence.occurrenceId);
  }
  throw new ConditionTransfer('return', occurrence.handlerScopeId, normalizedValue);
}

export {
  ConditionRuntime,
  ConditionTransfer,
  NoActiveOccurrenceError,
  NonLocalReturnHomeError,
  NonLocalReturnTransfer,
  UnhandledConditionError,
  performNonLocalReturn,
  runConditionHandler,
  runUnwindProtection,
  signalConditionOccurrence,
  transferConditionOccurrence,
};
