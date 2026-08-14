class ExecutorRegistrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecutorRegistrationError';
  }
}

class ExecutorNotFoundError extends Error {
  constructor(representation) {
    super(`no executor registered for representation: ${representation}`);
    this.name = 'ExecutorNotFoundError';
    this.representation = representation;
  }
}

function normalizeRepresentation(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('code representation must be a non-empty string');
  }
  return value;
}

function assertExecutor(executor) {
  if (!executor || typeof executor !== 'object' || typeof executor.execute !== 'function') {
    throw new TypeError('code executor must implement execute(input, context)');
  }
  return executor;
}

class CodeExecutorRegistry {
  constructor() {
    this.executors = new Map();
  }

  register(representation, executor) {
    const key = normalizeRepresentation(representation);
    if (this.executors.has(key)) {
      throw new ExecutorRegistrationError(`executor already registered: ${key}`);
    }
    this.executors.set(key, assertExecutor(executor));
    return executor;
  }

  get(representation) {
    const key = normalizeRepresentation(representation);
    const executor = this.executors.get(key);
    if (!executor) throw new ExecutorNotFoundError(key);
    return executor;
  }

  has(representation) {
    return this.executors.has(normalizeRepresentation(representation));
  }

  list() {
    return [...this.executors.keys()].sort();
  }
}

export {
  CodeExecutorRegistry,
  ExecutorNotFoundError,
  ExecutorRegistrationError,
  normalizeRepresentation,
};
