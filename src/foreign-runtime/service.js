import {randomUUID} from 'node:crypto';
import {canonicalizeValue} from '../value/index.js';
import {
  ForeignRuntimeProviderRegistry,
  normalizeForeignRuntimeProviderId,
} from './provider-registry.js';

const FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0 = 'lagrange-foreign-runtime-provider/v0';

class ForeignRuntimeInstanceNotFoundError extends Error {
  constructor(runtimeId) {
    super(`foreign runtime instance not found: ${runtimeId}`);
    this.name = 'ForeignRuntimeInstanceNotFoundError';
    this.runtimeId = runtimeId;
  }
}

class ForeignRuntimeInstanceNotActiveError extends Error {
  constructor(runtimeId, status) {
    super(`foreign runtime instance is not active: ${runtimeId} (${status})`);
    this.name = 'ForeignRuntimeInstanceNotActiveError';
    this.runtimeId = runtimeId;
    this.status = status;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function validatePlainData(value, path = 'foreign runtime data', seen = new WeakSet()) {
  if (value === null) return;
  switch (typeof value) {
    case 'boolean':
    case 'string':
    case 'bigint':
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path} numbers must be finite`);
      return;
    case 'object': {
      if (seen.has(value)) throw new TypeError(`${path} must not contain cycles`);
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((entry, index) => validatePlainData(entry, `${path}[${index}]`, seen));
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError(`${path} objects must be plain records`);
        }
        for (const [key, entry] of Object.entries(value)) {
          validatePlainData(entry, `${path}.${key}`, seen);
        }
      }
      seen.delete(value);
      return;
    }
    default:
      throw new TypeError(`${path} contains unsupported ${typeof value}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function normalizePlainData(value, label) {
  validatePlainData(value, label);
  return deepFreeze(structuredClone(value));
}

function normalizeStartResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('foreign runtime provider start() must return an object');
  }
  const allowed = new Set(['handle', 'metadata']);
  const extra = Object.keys(result).filter((key) => !allowed.has(key));
  if (extra.length > 0) throw new TypeError(`unknown foreign runtime start result fields: ${extra.join(', ')}`);
  if (!Object.hasOwn(result, 'handle') || result.handle === undefined) {
    throw new TypeError('foreign runtime provider start() result must contain handle');
  }
  return Object.freeze({
    handle: result.handle,
    metadata: normalizePlainData(result.metadata ?? {}, 'foreign runtime start metadata'),
  });
}

function normalizeArguments(values) {
  if (!Array.isArray(values)) throw new TypeError('foreign runtime arguments must be an array');
  return Object.freeze(values.map((value) => canonicalizeValue(value)));
}

function instanceDescriptor(state) {
  return Object.freeze({
    kind: 'foreign-runtime-instance',
    runtimeId: state.runtimeId,
    providerId: state.providerId,
    providerIdentity: state.provider.identity,
    status: state.status,
    metadata: state.metadata,
  });
}

function providerContext() {
  return Object.freeze({protocol: FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0});
}

function stopRequest({providerId, providerIdentity, runtimeId}) {
  return Object.freeze({
    protocol: FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0,
    providerId,
    providerIdentity,
    runtimeId,
  });
}

async function cleanRejectedStart(provider, rawResult, request, error) {
  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)
    || !Object.hasOwn(rawResult, 'handle') || rawResult.handle === undefined) {
    throw error;
  }
  try {
    await provider.stop(
      rawResult.handle,
      stopRequest({
        providerId: request.providerId,
        providerIdentity: request.providerIdentity,
        runtimeId: request.runtimeId,
      }),
      providerContext(),
    );
  } catch (stopError) {
    throw new AggregateError(
      [error, stopError],
      'foreign runtime start result was invalid and cleanup failed',
    );
  }
  throw error;
}

class ForeignRuntimeService {
  constructor({providers = new ForeignRuntimeProviderRegistry()} = {}) {
    if (!providers || typeof providers.get !== 'function') {
      throw new TypeError('providers must be a ForeignRuntimeProviderRegistry-compatible object');
    }
    this.providers = providers;
    this.instances = new Map();
  }

  async start({providerId, spec = {}} = {}) {
    const id = normalizeForeignRuntimeProviderId(providerId);
    const provider = this.providers.get(id);
    const runtimeId = randomUUID();
    const normalizedSpec = normalizePlainData(spec, 'foreign runtime spec');
    const request = Object.freeze({
      protocol: FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0,
      providerId: id,
      providerIdentity: provider.identity,
      runtimeId,
      spec: normalizedSpec,
    });
    const rawResult = await provider.start(request, providerContext());
    let result;
    try {
      result = normalizeStartResult(rawResult);
    } catch (error) {
      return await cleanRejectedStart(provider, rawResult, request, error);
    }
    const state = {
      runtimeId,
      providerId: id,
      provider,
      handle: result.handle,
      metadata: result.metadata,
      status: 'active',
      calls: new Set(),
    };
    this.instances.set(runtimeId, state);
    return instanceDescriptor(state);
  }

  get(runtimeId) {
    const id = requiredText(runtimeId, 'foreign runtime id');
    const state = this.instances.get(id);
    if (!state) throw new ForeignRuntimeInstanceNotFoundError(id);
    return instanceDescriptor(state);
  }

  list() {
    return [...this.instances.values()]
      .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId))
      .map(instanceDescriptor);
  }

  async call({runtimeId, interface: callableInterface, arguments: args = []} = {}) {
    const id = requiredText(runtimeId, 'foreign runtime id');
    const state = this.instances.get(id);
    if (!state) throw new ForeignRuntimeInstanceNotFoundError(id);
    if (state.status !== 'active') throw new ForeignRuntimeInstanceNotActiveError(id, state.status);
    const normalizedInterface = normalizePlainData(callableInterface, 'foreign runtime interface');
    const normalizedArguments = normalizeArguments(args);
    const request = Object.freeze({
      protocol: FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0,
      providerId: state.providerId,
      providerIdentity: state.provider.identity,
      runtimeId: id,
      interface: normalizedInterface,
      arguments: normalizedArguments,
    });

    let pending;
    pending = Promise.resolve()
      .then(() => state.provider.call(state.handle, request, providerContext()))
      .then((value) => canonicalizeValue(value));
    state.calls.add(pending);
    try {
      return await pending;
    } finally {
      state.calls.delete(pending);
    }
  }

  async stop(runtimeId) {
    const id = requiredText(runtimeId, 'foreign runtime id');
    const state = this.instances.get(id);
    if (!state) throw new ForeignRuntimeInstanceNotFoundError(id);
    if (state.status !== 'active') throw new ForeignRuntimeInstanceNotActiveError(id, state.status);
    state.status = 'stopping';

    await Promise.allSettled([...state.calls]);
    try {
      await state.provider.stop(
        state.handle,
        stopRequest({
          providerId: state.providerId,
          providerIdentity: state.provider.identity,
          runtimeId: id,
        }),
        providerContext(),
      );
    } catch (error) {
      state.status = 'active';
      throw error;
    }
    this.instances.delete(id);
  }

  async close() {
    const failures = [];
    for (const runtimeId of [...this.instances.keys()].sort()) {
      try {
        await this.stop(runtimeId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to stop one or more foreign runtime instances');
    }
  }
}

export {
  FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0,
  ForeignRuntimeInstanceNotActiveError,
  ForeignRuntimeInstanceNotFoundError,
  ForeignRuntimeService,
  normalizePlainData as normalizeForeignRuntimeData,
};
