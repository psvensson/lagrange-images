const REQUIRED_TRANSACTION_METHODS = Object.freeze([
  'get',
  'put',
  'scan',
  'append',
  'readStream',
  // Read-only stream-head read: the current committed high-water revision of a
  // stream. The backend owns stream persistence/head mechanics; this is a direct
  // head read, never a scan/reconstruction. Kept about STREAM HEADS only — the
  // backend has no notion of an Image frontier or a Project.
  'streamHead',
]);

const REQUIRED_BACKEND_METHODS = Object.freeze([
  'start',
  'stop',
  ...REQUIRED_TRANSACTION_METHODS,
  'transaction',
]);

class BackendContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackendContractError';
  }
}

class VersionConflictError extends Error {
  constructor({collection, key, expectedVersion, actualVersion}) {
    super(
      `version conflict for ${collection}/${key}: expected ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = 'VersionConflictError';
    this.collection = collection;
    this.key = key;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

function assertMethods(value, methods, label) {
  if (!value || typeof value !== 'object') {
    throw new BackendContractError(`${label} must be an object`);
  }

  const missing = methods.filter(
    (method) => typeof value[method] !== 'function',
  );

  if (missing.length > 0) {
    throw new BackendContractError(
      `${label} is missing required methods: ${missing.join(', ')}`,
    );
  }

  return value;
}

function assertBackendTransaction(transaction) {
  return assertMethods(transaction, REQUIRED_TRANSACTION_METHODS, 'backend transaction');
}

function assertBackend(backend) {
  return assertMethods(backend, REQUIRED_BACKEND_METHODS, 'backend');
}

export {
  BackendContractError,
  REQUIRED_BACKEND_METHODS,
  REQUIRED_TRANSACTION_METHODS,
  VersionConflictError,
  assertBackend,
  assertBackendTransaction,
};
