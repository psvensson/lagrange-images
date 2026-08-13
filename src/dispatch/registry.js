class DispatchRegistrationError extends Error {
  constructor(languageId) {
    super(`dispatcher already registered: ${languageId}`);
    this.name = 'DispatchRegistrationError';
    this.languageId = languageId;
  }
}

class DispatchNotFoundError extends Error {
  constructor(languageId) {
    super(`dispatcher not registered: ${languageId}`);
    this.name = 'DispatchNotFoundError';
    this.languageId = languageId;
  }
}

function normalizeLanguageId(languageId) {
  if (typeof languageId !== 'string' || languageId.length === 0) {
    throw new TypeError('languageId must be a non-empty string');
  }
  return languageId;
}

function assertDispatcher(dispatcher) {
  if (!dispatcher || typeof dispatcher !== 'object') {
    throw new TypeError('dispatcher must be an object');
  }
  if (typeof dispatcher.resolveMessage !== 'function') {
    throw new TypeError('dispatcher must implement resolveMessage(request, context)');
  }
  return dispatcher;
}

class DispatchRegistry {
  constructor(entries = []) {
    this.dispatchers = new Map();
    for (const [languageId, dispatcher] of entries) {
      this.register(languageId, dispatcher);
    }
  }

  register(languageId, dispatcher) {
    const id = normalizeLanguageId(languageId);
    assertDispatcher(dispatcher);
    if (this.dispatchers.has(id)) throw new DispatchRegistrationError(id);
    this.dispatchers.set(id, dispatcher);
    return dispatcher;
  }

  get(languageId) {
    const id = normalizeLanguageId(languageId);
    const dispatcher = this.dispatchers.get(id);
    if (!dispatcher) throw new DispatchNotFoundError(id);
    return dispatcher;
  }

  has(languageId) {
    return this.dispatchers.has(normalizeLanguageId(languageId));
  }

  list() {
    return [...this.dispatchers.keys()].sort();
  }
}

export {
  DispatchNotFoundError,
  DispatchRegistrationError,
  DispatchRegistry,
  assertDispatcher,
  normalizeLanguageId,
};
