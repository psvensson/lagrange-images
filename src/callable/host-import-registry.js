// Runtime-local registry of host implementations for declared Component imports, per ADR 0038.
//
// The durable binding says which host interfaces a program was designed to use. This says
// which implementation satisfies each of them here, in this deployment. Those are different
// questions, so the registry is transient and never part of artifact identity.
//
// A provider receives only `{require}` — the same check-only function an executor gets. It
// never sees an AuthorityService, an authority context, a principal or a grant, so the
// containment rule between ActivationExecutor and executors extends unchanged to host
// implementations.

class UndeclaredHostImportError extends TypeError {
  constructor(specifier) {
    super(`WASM Component requires host import ${specifier}, which its binding does not declare`);
    this.name = 'UndeclaredHostImportError';
    this.specifier = specifier;
  }
}

class HostImportUnavailableError extends TypeError {
  constructor(specifier) {
    super(`host import ${specifier} is declared but no provider is registered in this runtime`);
    this.name = 'HostImportUnavailableError';
    this.specifier = specifier;
  }
}

function normalizeHostImportSpecifier(value, label = 'host import specifier') {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

class ComponentHostImportRegistry {
  constructor(entries = []) {
    this.providers = new Map();
    for (const [specifier, provider] of entries) this.register(specifier, provider);
  }

  register(specifier, provider) {
    const id = normalizeHostImportSpecifier(specifier);
    if (typeof provider !== 'function') {
      throw new TypeError(`host import provider for ${id} must be a function of {require}`);
    }
    if (this.providers.has(id)) throw new TypeError(`host import provider already registered: ${id}`);
    this.providers.set(id, provider);
    return this;
  }

  has(specifier) {
    return this.providers.has(normalizeHostImportSpecifier(specifier));
  }

  // Builds the import implementation for one interface. `require` is the only authority-facing
  // thing that crosses, and it is handed in per execution rather than held by the registry,
  // so an implementation cannot outlive or cache the authority of the call that created it.
  async create(specifier, {require}) {
    const id = normalizeHostImportSpecifier(specifier);
    const provider = this.providers.get(id);
    if (!provider) throw new HostImportUnavailableError(id);
    if (typeof require !== 'function') throw new TypeError('host import providers require a require(demand) function');
    // Awaited so a provider may resolve its own configuration; `require` is still the only
    // authority-facing thing that crosses.
    const implementation = await provider({require});
    if (!implementation || typeof implementation !== 'object') {
      throw new TypeError(`host import provider for ${id} must return an object of functions`);
    }
    return implementation;
  }
}

export {
  ComponentHostImportRegistry,
  HostImportUnavailableError,
  UndeclaredHostImportError,
  normalizeHostImportSpecifier,
};
