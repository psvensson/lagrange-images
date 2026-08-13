const REQUIRED_BACKEND_METHODS = Object.freeze([
  'start',
  'stop',
  'get',
  'put',
  'scan',
  'append',
  'readStream',
]);

class BackendContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackendContractError';
  }
}

function assertBackend(backend) {
  if (!backend || typeof backend !== 'object') {
    throw new BackendContractError('backend must be an object');
  }

  const missing = REQUIRED_BACKEND_METHODS.filter(
    (method) => typeof backend[method] !== 'function',
  );

  if (missing.length > 0) {
    throw new BackendContractError(
      `backend is missing required methods: ${missing.join(', ')}`,
    );
  }

  return backend;
}

export {BackendContractError, REQUIRED_BACKEND_METHODS, assertBackend};
