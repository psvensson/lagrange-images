class ToolchainProviderRegistrationError extends Error {
  constructor(providerId) {
    super(`toolchain provider already registered: ${providerId}`);
    this.name = 'ToolchainProviderRegistrationError';
    this.providerId = providerId;
  }
}

class ToolchainProviderNotFoundError extends Error {
  constructor(providerId) {
    super(`toolchain provider not registered: ${providerId}`);
    this.name = 'ToolchainProviderNotFoundError';
    this.providerId = providerId;
  }
}

function normalizeProviderId(value, label = 'toolchain provider id') {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function assertToolchainProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError('toolchain provider must be an object');
  }
  if (typeof provider.identity !== 'string' || provider.identity.length === 0) {
    throw new TypeError('toolchain provider identity must be a non-empty string');
  }
  if (typeof provider.run !== 'function') {
    throw new TypeError('toolchain provider must implement run(request, context)');
  }
  return provider;
}

class ToolchainProviderRegistry {
  constructor(entries = []) {
    this.providers = new Map();
    for (const [providerId, provider] of entries) this.register(providerId, provider);
  }

  register(providerId, provider) {
    const id = normalizeProviderId(providerId);
    assertToolchainProvider(provider);
    if (this.providers.has(id)) throw new ToolchainProviderRegistrationError(id);
    this.providers.set(id, provider);
    return provider;
  }

  get(providerId) {
    const id = normalizeProviderId(providerId);
    const provider = this.providers.get(id);
    if (!provider) throw new ToolchainProviderNotFoundError(id);
    return provider;
  }

  has(providerId) {
    return this.providers.has(normalizeProviderId(providerId));
  }

  list() {
    return [...this.providers.keys()].sort();
  }
}

export {
  ToolchainProviderNotFoundError,
  ToolchainProviderRegistrationError,
  ToolchainProviderRegistry,
  assertToolchainProvider,
  normalizeProviderId,
};
