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

import {AuthorityError} from '../authority/authority-service.js';

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

class UndeclaredAsyncHostEffectError extends TypeError {
  constructor(specifier, member = null) {
    super(
      member
        ? `host import ${specifier}.${member} returned an async effect without an explicit asyncEffects contract`
        : `host import ${specifier} returned an async effect without an explicit asyncEffects contract`,
    );
    this.name = 'UndeclaredAsyncHostEffectError';
    this.specifier = specifier;
    this.member = member;
  }
}

function normalizeHostImportSpecifier(value, label = 'host import specifier') {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeStringSet(values, label) {
  if (values === null || values === undefined) return null;
  if (!Array.isArray(values) && !(values instanceof Set)) {
    throw new TypeError(`${label} must be an array or Set of non-empty strings`);
  }
  const set = new Set();
  for (const item of values) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new TypeError(`${label} entries must be non-empty strings`);
    }
    set.add(item);
  }
  return set;
}

function normalizePolicy(options = {}, label = 'host import policy') {
  if (options === null || options === undefined) return {
    allowedOperations: null,
    allowedResources: null,
    attenuateDemand: null,
    asyncEffects: null,
  };
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`${label} must be an options object`);
  }
  const allowedOperations = normalizeStringSet(options.allowedOperations, `${label} allowedOperations`);
  const allowedResources = normalizeStringSet(options.allowedResources, `${label} allowedResources`);
  const attenuateDemand = options.attenuateDemand ?? null;
  if (attenuateDemand !== null && typeof attenuateDemand !== 'function') {
    throw new TypeError(`${label} attenuateDemand must be a function or null`);
  }
  const asyncEffects = options.asyncEffects ?? null;
  if (asyncEffects !== null && typeof asyncEffects !== 'boolean') {
    throw new TypeError(`${label} asyncEffects must be a boolean or null`);
  }
  return {
    allowedOperations,
    allowedResources,
    attenuateDemand,
    asyncEffects,
  };
}

function buildAttenuatedRequire(specifier, baseRequire, policies) {
  const activePolicies = policies.filter(
    (p) => p && (p.allowedOperations !== null || p.allowedResources !== null || p.attenuateDemand !== null),
  );
  if (activePolicies.length === 0) return baseRequire;

  return (demand) => {
    if (!demand || typeof demand !== 'object' || Array.isArray(demand)
      || typeof demand.operation !== 'string' || demand.operation.length === 0
      || typeof demand.resource !== 'string' || demand.resource.length === 0) {
      return baseRequire(demand);
    }
    for (const policy of activePolicies) {
      if (policy.allowedOperations !== null && !policy.allowedOperations.has(demand.operation)) {
        throw new AuthorityError(
          `host import ${specifier} is not delegated operation: ${demand.operation} on ${demand.resource}`,
          {operation: demand.operation, resource: demand.resource},
        );
      }
      if (policy.allowedResources !== null && !policy.allowedResources.has(demand.resource)) {
        throw new AuthorityError(
          `host import ${specifier} is not delegated resource: ${demand.operation} on ${demand.resource}`,
          {operation: demand.operation, resource: demand.resource},
        );
      }
      if (policy.attenuateDemand !== null && policy.attenuateDemand(demand) !== true) {
        throw new AuthorityError(
          `host import ${specifier} attenuated authority demand: ${demand.operation} on ${demand.resource}`,
          {operation: demand.operation, resource: demand.resource},
        );
      }
    }
    return baseRequire(demand);
  };
}

function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

function enforceAsyncEffectContract(specifier, implementation, asyncEffects) {
  if (asyncEffects !== false) return implementation;
  const wrapped = {};
  for (const [key, member] of Object.entries(implementation)) {
    if (typeof member === 'function' && !/^class\s/.test(Function.prototype.toString.call(member))) {
      wrapped[key] = (...args) => {
        const result = member(...args);
        if (isThenable(result)) {
          Promise.resolve(result).catch(() => {});
          throw new UndeclaredAsyncHostEffectError(specifier, key);
        }
        return result;
      };
    } else {
      wrapped[key] = member;
    }
  }
  return wrapped;
}

class ComponentHostImportRegistry {
  constructor(entries = []) {
    this.providers = new Map();
    for (const [specifier, provider, options] of entries) this.register(specifier, provider, options);
  }

  register(specifier, provider, options = {}) {
    const id = normalizeHostImportSpecifier(specifier);
    if (typeof provider !== 'function') {
      throw new TypeError(`host import provider for ${id} must be a function of {require}`);
    }
    if (this.providers.has(id)) throw new TypeError(`host import provider already registered: ${id}`);
    const policy = normalizePolicy(options, `host import policy for ${id}`);
    this.providers.set(id, {provider, policy});
    return this;
  }

  has(specifier) {
    return this.providers.has(normalizeHostImportSpecifier(specifier));
  }

  // Builds the import implementation for one interface. `require` is the only authority-facing
  // thing that crosses, and it is handed in per execution rather than held by the registry,
  // so an implementation cannot outlive or cache the authority of the call that created it.
  async create(specifier, {require, ...callOptions} = {}) {
    const id = normalizeHostImportSpecifier(specifier);
    const entry = this.providers.get(id);
    if (!entry) throw new HostImportUnavailableError(id);
    const provider = typeof entry === 'function' ? entry : entry.provider;
    const registeredPolicy = typeof entry === 'function' ? normalizePolicy() : entry.policy;
    const callPolicy = normalizePolicy(callOptions, `host import call policy for ${id}`);
    if (typeof require !== 'function') throw new TypeError('host import providers require a require(demand) function');
    const scopedRequire = buildAttenuatedRequire(id, require, [registeredPolicy, callPolicy]);
    // Awaited so a provider may resolve its own configuration; `require` is still the only
    // authority-facing thing that crosses.
    const implementation = await provider({require: scopedRequire});
    if (!implementation || typeof implementation !== 'object') {
      throw new TypeError(`host import provider for ${id} must return an object of functions`);
    }
    const effectiveAsync = callPolicy.asyncEffects !== null ? callPolicy.asyncEffects : registeredPolicy.asyncEffects;
    return enforceAsyncEffectContract(id, implementation, effectiveAsync);
  }
}

export {
  ComponentHostImportRegistry,
  HostImportUnavailableError,
  UndeclaredAsyncHostEffectError,
  UndeclaredHostImportError,
  normalizeHostImportSpecifier,
};
