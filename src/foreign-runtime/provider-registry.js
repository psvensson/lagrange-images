class ForeignRuntimeProviderRegistrationError extends Error {
  constructor(providerId) {
    super(`foreign runtime provider already registered: ${providerId}`);
    this.name = 'ForeignRuntimeProviderRegistrationError';
    this.providerId = providerId;
  }
}

class ForeignRuntimeProviderNotFoundError extends Error {
  constructor(providerId) {
    super(`foreign runtime provider not registered: ${providerId}`);
    this.name = 'ForeignRuntimeProviderNotFoundError';
    this.providerId = providerId;
  }
}

function normalizeForeignRuntimeProviderId(value, label = 'foreign runtime provider id') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertForeignRuntimeProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError('foreign runtime provider must be an object');
  }
  if (typeof provider.identity !== 'string' || provider.identity.length === 0) {
    throw new TypeError('foreign runtime provider identity must be a non-empty string');
  }
  for (const method of ['start', 'call', 'stop']) {
    if (typeof provider[method] !== 'function') {
      throw new TypeError(`foreign runtime provider must implement ${method}()`);
    }
  }
  return provider;
}

class ForeignRuntimeProviderRegistry {
  constructor(entries = []) {
    this.providers = new Map();
    for (const [providerId, provider] of entries) this.register(providerId, provider);
  }

  register(providerId, provider) {
    const id = normalizeForeignRuntimeProviderId(providerId);
    assertForeignRuntimeProvider(provider);
    if (this.providers.has(id)) throw new ForeignRuntimeProviderRegistrationError(id);
    this.providers.set(id, provider);
    return provider;
  }

  get(providerId) {
    const id = normalizeForeignRuntimeProviderId(providerId);
    const provider = this.providers.get(id);
    if (!provider) throw new ForeignRuntimeProviderNotFoundError(id);
    return provider;
  }

  has(providerId) {
    return this.providers.has(normalizeForeignRuntimeProviderId(providerId));
  }

  list() {
    return [...this.providers.keys()].sort();
  }
}

export {
  ForeignRuntimeProviderNotFoundError,
  ForeignRuntimeProviderRegistrationError,
  ForeignRuntimeProviderRegistry,
  assertForeignRuntimeProvider,
  normalizeForeignRuntimeProviderId,
};
