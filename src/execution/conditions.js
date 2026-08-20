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

class SmalltalkUnhandledConditionError extends TypeError {
  constructor(description) {
    super(`unhandled Smalltalk condition: ${description}`);
    this.name = 'SmalltalkUnhandledConditionError';
  }
}

class SmalltalkNoActiveOccurrenceError extends TypeError {
  constructor(operation) {
    super(`${operation} requires a condition that is currently being handled`);
    this.name = 'SmalltalkNoActiveOccurrenceError';
  }
}

class ConditionRuntime {
  #scopes = [];
  #occurrences = [];
  #nextId = 0;

  // `invoke` is supplied by the executor and closes over the authority in force *here*, at
  // establishment. Primitives never see an authority context — they hand back a callable and the
  // executor keeps the capability side private (ADR 0037).
  enterHandler({conditionClass, block, invoke}) {
    const scopeId = (this.#nextId += 1);
    this.#scopes.push({scopeId, kind: 'handler', conditionClass, block, invoke, active: true});
    return scopeId;
  }

  enterProtection({kind, block, invoke}) {
    const scopeId = (this.#nextId += 1);
    this.#scopes.push({scopeId, kind, block, invoke, active: true});
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

export {
  ConditionRuntime,
  ConditionTransfer,
  SmalltalkNoActiveOccurrenceError,
  SmalltalkUnhandledConditionError,
};
