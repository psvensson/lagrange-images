import {canonicalizeValue, isObjectRef} from '../value/index.js';
import {
  FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1,
  parseForeignRuntimeCallableArtifact,
} from './callable-artifacts.js';
import {normalizeForeignRuntimeProviderId} from './provider-registry.js';

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

function assertDefinitions(definitions) {
  if (!definitions || typeof definitions.start !== 'function') {
    throw new TypeError('foreign runtime callable executor requires definitions.start');
  }
  return definitions;
}

function assertRuntimes(runtimes) {
  if (!runtimes || typeof runtimes.call !== 'function') {
    throw new TypeError('foreign runtime callable executor requires runtimes.call');
  }
  return runtimes;
}

function assertBindings(bindings) {
  if (!bindings || typeof bindings.resolve !== 'function') {
    throw new TypeError('foreign runtime callable executor requires bindings.resolve');
  }
  return bindings;
}

function definitionInstanceKey(providerId, definition) {
  const id = normalizeForeignRuntimeProviderId(providerId);
  const ref = normalizeObjectRef(definition, 'foreign runtime definition');
  return `${id}\u0000${ref.imageId}\u0000${ref.objectId}`;
}

class ForeignRuntimeDefinitionInstanceCache {
  constructor({definitions, bindings} = {}) {
    this.definitions = assertDefinitions(definitions);
    this.bindings = assertBindings(bindings);
    this.entries = new Map();
  }

  async get({definition, artifact} = {}) {
    const definitionRef = normalizeObjectRef(definition, 'foreign runtime definition');
    if (!artifact || artifact.kind !== 'code-artifact') {
      throw new TypeError('foreign runtime definition cache requires a code-artifact definition');
    }
    if (artifact.imageId !== definitionRef.imageId || artifact.id !== definitionRef.objectId) {
      throw new TypeError('foreign runtime definition artifact identity must match its ref');
    }
    const providerId = normalizeForeignRuntimeProviderId(
      this.bindings.resolve({definition: definitionRef, artifact}),
    );
    const key = definitionInstanceKey(providerId, definitionRef);
    const existing = this.entries.get(key);
    if (existing) return await existing;

    let pending;
    pending = Promise.resolve()
      .then(() => this.definitions.start({providerId, definition: definitionRef}))
      .catch((error) => {
        if (this.entries.get(key) === pending) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, pending);
    return await pending;
  }

  clear() {
    this.entries.clear();
  }
}

function createForeignRuntimeCallableInterfaceV1Executor({
  definitions,
  runtimes,
  bindings,
  instanceCache = null,
} = {}) {
  const runtimeService = assertRuntimes(runtimes);
  const cache = instanceCache ?? new ForeignRuntimeDefinitionInstanceCache({definitions, bindings});
  if (!cache || typeof cache.get !== 'function') {
    throw new TypeError('foreign runtime callable executor instanceCache must implement get');
  }

  return Object.freeze({
    instanceCache: cache,
    async execute({activation, code}, {images}) {
      if (!code || code.representation !== FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1) {
        throw new TypeError(`foreign runtime callable executor requires ${FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1}`);
      }
      if (activation.receiver !== null) {
        throw new TypeError('foreign-runtime-value-call/v0 does not accept a receiver');
      }
      if (activation.environment !== null) {
        throw new TypeError('foreign-runtime-value-call/v0 does not accept a lexical environment');
      }

      const {descriptor, runtimeDefinition} = parseForeignRuntimeCallableArtifact(code);
      if (activation.arguments.length !== descriptor.argumentCount) {
        throw new TypeError(
          `foreign runtime callable expected ${descriptor.argumentCount} arguments, got ${activation.arguments.length}`,
        );
      }
      const definitionArtifact = await images.getCodeArtifact(
        runtimeDefinition.imageId,
        runtimeDefinition.objectId,
      );
      if (!definitionArtifact) {
        throw new TypeError(
          `foreign runtime definition not found: ${runtimeDefinition.imageId}/${runtimeDefinition.objectId}`,
        );
      }

      const instance = await cache.get({definition: runtimeDefinition, artifact: definitionArtifact});
      return await runtimeService.call({
        runtimeId: instance.runtimeId,
        interface: descriptor.interface,
        arguments: activation.arguments,
      });
    },
  });
}

export {
  ForeignRuntimeDefinitionInstanceCache,
  createForeignRuntimeCallableInterfaceV1Executor,
  definitionInstanceKey as foreignRuntimeDefinitionInstanceKey,
};
