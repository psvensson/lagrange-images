import {normalizeForeignRuntimeProviderId} from './provider-registry.js';

class ForeignRuntimeDefinitionBindingRegistrationError extends Error {
  constructor(representation) {
    super(`foreign runtime definition binding already registered: ${representation}`);
    this.name = 'ForeignRuntimeDefinitionBindingRegistrationError';
    this.representation = representation;
  }
}

class ForeignRuntimeDefinitionBindingNotFoundError extends Error {
  constructor(representation) {
    super(`foreign runtime definition binding not registered: ${representation}`);
    this.name = 'ForeignRuntimeDefinitionBindingNotFoundError';
    this.representation = representation;
  }
}

function normalizeDefinitionRepresentation(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('foreign runtime definition representation must be a non-empty string');
  }
  return value;
}

class ForeignRuntimeDefinitionBindingRegistry {
  constructor(entries = []) {
    this.bindings = new Map();
    for (const [representation, providerId] of entries) this.register(representation, providerId);
  }

  register(representation, providerId) {
    const normalizedRepresentation = normalizeDefinitionRepresentation(representation);
    const normalizedProviderId = normalizeForeignRuntimeProviderId(providerId);
    if (this.bindings.has(normalizedRepresentation)) {
      throw new ForeignRuntimeDefinitionBindingRegistrationError(normalizedRepresentation);
    }
    this.bindings.set(normalizedRepresentation, normalizedProviderId);
    return normalizedProviderId;
  }

  get(representation) {
    const normalizedRepresentation = normalizeDefinitionRepresentation(representation);
    const providerId = this.bindings.get(normalizedRepresentation);
    if (!providerId) throw new ForeignRuntimeDefinitionBindingNotFoundError(normalizedRepresentation);
    return providerId;
  }

  has(representation) {
    return this.bindings.has(normalizeDefinitionRepresentation(representation));
  }

  resolve({artifact} = {}) {
    if (!artifact || artifact.kind !== 'code-artifact') {
      throw new TypeError('foreign runtime binding resolver requires a code-artifact definition');
    }
    return this.get(artifact.representation);
  }

  list() {
    return [...this.bindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([representation, providerId]) => Object.freeze({representation, providerId}));
  }
}

export {
  ForeignRuntimeDefinitionBindingNotFoundError,
  ForeignRuntimeDefinitionBindingRegistrationError,
  ForeignRuntimeDefinitionBindingRegistry,
  normalizeDefinitionRepresentation,
};
