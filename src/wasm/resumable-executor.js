import {assertWasmFunctionArtifactAnyVersion, functionModuleRef, resolveFunctionContract} from './function-contract.js';
import {canonicalizeValue, isReference} from '../value/index.js';
import {
  WASM_IMPORT_MODULE,
  ValueHandleArena,
} from './abi.js';
import {
  WASM_INSTANCE_REUSE_STATELESS_V0,
  WasmInstancePool,
} from './instance-pool.js';
import {WasmModuleCache} from './module-cache.js';
import {readModuleDescriptor, readModuleImplementationBytes} from './module-contract.js';
import {WASM_RESUMABLE_VALUE_HANDLE_ABI_V1} from './resumable-abi.js';

const MAX_WASM_RESUMPTIONS = 256;

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(', ')}`);
  }
  return value;
}

function normalizeCaptures(value, label = 'WASM function metadata.captures') {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(value.map((id, index) => {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError(`${label} ${index} must be a non-empty binding id`);
    return id;
  }));
}

function normalizeIndexList(value, limit, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const seen = new Set();
  return Object.freeze(value.map((entry, index) => {
    const normalized = requireNonNegativeInteger(entry, `${label} ${index}`);
    if (normalized >= limit) throw new TypeError(`${label} ${index} is out of range`);
    if (seen.has(normalized)) throw new TypeError(`${label} contains duplicate index ${normalized}`);
    seen.add(normalized);
    return normalized;
  }));
}

function normalizeLiterals(value) {
  if (!Array.isArray(value)) throw new TypeError('WASM module contract literals must be an array');
  return Object.freeze(value.map((entry) => canonicalizeValue(entry)));
}

function normalizeSendSites(value) {
  if (!Array.isArray(value)) throw new TypeError('WASM module contract sendSites must be an array');
  return Object.freeze(value.map((site, index) => {
    exactKeys(site, ['languageId', 'message', 'arity'], `WASM send site ${index}`);
    if (typeof site.languageId !== 'string' || site.languageId.length === 0) {
      throw new TypeError(`WASM send site ${index} languageId must be a non-empty string`);
    }
    const message = canonicalizeValue(site.message);
    if (isReference(message)) throw new TypeError(`WASM send site ${index} message must not hide a graph reference`);
    return Object.freeze({
      languageId: site.languageId,
      message,
      arity: requireNonNegativeInteger(site.arity, `WASM send site ${index} arity`),
    });
  }));
}

function normalizeClosureSites(value) {
  if (!Array.isArray(value)) throw new TypeError('WASM module contract closureSites must be an array');
  return Object.freeze(value.map((site, siteIndex) => {
    exactKeys(site, ['blockId', 'captures'], `WASM closure site ${siteIndex}`);
    if (typeof site.blockId !== 'string' || site.blockId.length === 0) {
      throw new TypeError(`WASM closure site ${siteIndex} blockId must be non-empty text`);
    }
    if (!Array.isArray(site.captures)) throw new TypeError(`WASM closure site ${siteIndex} captures must be an array`);
    const captures = Object.freeze(site.captures.map((capture, captureIndex) => {
      exactKeys(capture, ['id', 'name'], `WASM closure site ${siteIndex} capture ${captureIndex}`);
      if (typeof capture.id !== 'string' || capture.id.length === 0) throw new TypeError(`WASM closure capture ${captureIndex} id must be non-empty text`);
      if (typeof capture.name !== 'string' || capture.name.length === 0) throw new TypeError(`WASM closure capture ${captureIndex} name must be non-empty text`);
      return Object.freeze({id: capture.id, name: capture.name});
    }));
    return Object.freeze({blockId: site.blockId, captures});
  }));
}

function normalizeEffectSites(value, sendSites, closureSites) {
  if (!Array.isArray(value)) throw new TypeError('resumable WASM module contract effectSites must be an array');
  const seen = new Set();
  return Object.freeze(value.map((effect, effectIndex) => {
    exactKeys(
      effect,
      ['kind', 'siteIndex', 'requestArity', 'savedCount', 'resumeEntry'],
      `resumable WASM effect site ${effectIndex}`,
    );
    if (!['send', 'closure'].includes(effect.kind)) {
      throw new TypeError(`resumable WASM effect site ${effectIndex} kind must be send or closure`);
    }
    const siteIndex = requireNonNegativeInteger(effect.siteIndex, `resumable WASM effect site ${effectIndex} siteIndex`);
    const key = `${effect.kind}:${siteIndex}`;
    if (seen.has(key)) throw new TypeError(`duplicate resumable WASM effect site: ${key}`);
    seen.add(key);

    const site = effect.kind === 'send' ? sendSites[siteIndex] : closureSites[siteIndex];
    if (!site) throw new TypeError(`resumable WASM effect site ${effectIndex} references a missing ${effect.kind} site`);
    const expectedRequestArity = effect.kind === 'send' ? 1 + site.arity : site.captures.length;
    const requestArity = requireNonNegativeInteger(effect.requestArity, `resumable WASM effect site ${effectIndex} requestArity`);
    if (requestArity !== expectedRequestArity) {
      throw new TypeError(`resumable WASM effect site ${effectIndex} request arity does not match its ${effect.kind} site`);
    }
    const savedCount = requireNonNegativeInteger(effect.savedCount, `resumable WASM effect site ${effectIndex} savedCount`);
    const resumeEntry = effect.resumeEntry;
    if (resumeEntry !== null && (typeof resumeEntry !== 'string' || resumeEntry.length === 0)) {
      throw new TypeError(`resumable WASM effect site ${effectIndex} resumeEntry must be non-empty text or null`);
    }
    if (resumeEntry === null && savedCount !== 0) {
      throw new TypeError(`tail resumable WASM effect site ${effectIndex} must not save continuation handles`);
    }
    return Object.freeze({
      kind: effect.kind,
      siteIndex,
      requestArity,
      savedCount,
      resumeEntry,
    });
  }));
}

function normalizeModuleFunctions(value, sendSites, closureSites) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('resumable WASM module contract functions must be a non-empty array');
  }
  const entries = new Set();
  const memberIndices = new Set();
  return Object.freeze(value.map((descriptor, index) => {
    exactKeys(
      descriptor,
      ['entry', 'memberIndex', 'parameters', 'captures', 'sendSiteIndices', 'closureSiteIndices'],
      `WASM module function ${index}`,
    );
    if (typeof descriptor.entry !== 'string' || descriptor.entry.length === 0) throw new TypeError(`WASM module function ${index} entry must be non-empty text`);
    if (entries.has(descriptor.entry)) throw new TypeError(`duplicate WASM module function entry: ${descriptor.entry}`);
    entries.add(descriptor.entry);
    const memberIndex = requireNonNegativeInteger(descriptor.memberIndex, `WASM module function ${index} memberIndex`);
    if (memberIndices.has(memberIndex)) throw new TypeError(`duplicate WASM module function memberIndex: ${memberIndex}`);
    memberIndices.add(memberIndex);
    return Object.freeze({
      entry: descriptor.entry,
      memberIndex,
      parameters: requireNonNegativeInteger(descriptor.parameters, `WASM module function ${index} parameters`),
      captures: normalizeCaptures(descriptor.captures, `WASM module function ${index} captures`),
      sendSiteIndices: normalizeIndexList(descriptor.sendSiteIndices, sendSites.length, `WASM module function ${index} sendSiteIndices`),
      closureSiteIndices: normalizeIndexList(descriptor.closureSiteIndices, closureSites.length, `WASM module function ${index} closureSiteIndices`),
    });
  }));
}




function recordPending(pending, effect) {
  if (pending.effect !== null) throw new TypeError('WASM activation attempted more than one pending host effect');
  pending.effect = Object.freeze(effect);
  return 0;
}

function effectMaps(effectSites) {
  const sends = new Map();
  const closures = new Map();
  effectSites.forEach((effect, effectIndex) => {
    const target = effect.kind === 'send' ? sends : closures;
    target.set(effect.siteIndex, Object.freeze({...effect, effectIndex}));
  });
  return {sends, closures};
}

function createRebindableHostEnvironment(literals, sendSites, closureSites, effectSites) {
  const holder = {current: null};
  const maps = effectMaps(effectSites);
  const current = () => {
    if (!holder.current) throw new TypeError('WASM instance host environment is not bound to an activation');
    return holder.current;
  };
  const lagrange = {
    literal(index) {
      const state = current();
      if (!Number.isInteger(index) || index < 0 || index >= literals.length) throw new TypeError(`WASM literal index out of range: ${index}`);
      return state.arena.put(literals[index]);
    },
    integer_add(left, right) {
      return current().arena.integerAdd(left, right);
    },
    equals(left, right) {
      return current().arena.equals(left, right);
    },
    is_true(handle) {
      return current().arena.isTrue(handle);
    },
  };

  sendSites.forEach((site, siteIndex) => {
    const effect = maps.sends.get(siteIndex);
    if (!effect) throw new TypeError(`resumable WASM send site ${siteIndex} has no effect descriptor`);
    lagrange[`send_site_${siteIndex}`] = (...handles) => {
      const state = current();
      if (!state.activeSendSites.has(siteIndex)) throw new TypeError(`inactive WASM send site invoked: ${siteIndex}`);
      const expected = effect.requestArity + effect.savedCount;
      if (handles.length !== expected) {
        throw new TypeError(`resumable WASM send site ${siteIndex} expected ${expected} handles, received ${handles.length}`);
      }
      const requestHandles = handles.slice(0, effect.requestArity);
      const savedHandles = Object.freeze(handles.slice(effect.requestArity));
      return recordPending(state.pending, {
        kind: 'send',
        request: Object.freeze({
          languageId: site.languageId,
          receiver: state.arena.get(requestHandles[0], `WASM send site ${siteIndex} receiver handle`),
          message: site.message,
          arguments: Object.freeze(requestHandles.slice(1).map((handle, argumentIndex) =>
            state.arena.get(handle, `WASM send site ${siteIndex} argument ${argumentIndex} handle`))),
        }),
        resume: effect.resumeEntry === null
          ? null
          : Object.freeze({entry: effect.resumeEntry, handles: savedHandles}),
      });
    };
  });

  closureSites.forEach((site, siteIndex) => {
    const effect = maps.closures.get(siteIndex);
    if (!effect) throw new TypeError(`resumable WASM closure site ${siteIndex} has no effect descriptor`);
    lagrange[`make_block_site_${siteIndex}`] = (...handles) => {
      const state = current();
      if (!state.activeClosureSites.has(siteIndex)) throw new TypeError(`inactive WASM closure site invoked: ${siteIndex}`);
      const expected = effect.requestArity + effect.savedCount;
      if (handles.length !== expected) {
        throw new TypeError(`resumable WASM closure site ${siteIndex} expected ${expected} handles, received ${handles.length}`);
      }
      const requestHandles = handles.slice(0, effect.requestArity);
      const savedHandles = Object.freeze(handles.slice(effect.requestArity));
      const prototype = state.closurePrototypes.get(siteIndex);
      if (!prototype) throw new TypeError(`WASM closure prototype missing at execution: ${site.blockId}`);
      return recordPending(state.pending, {
        kind: 'closure',
        request: Object.freeze({
          prototype,
          captures: Object.freeze(site.captures.map((capture, captureIndex) => Object.freeze({
            id: capture.id,
            name: capture.name,
            value: state.arena.get(requestHandles[captureIndex], `WASM closure site ${siteIndex} capture ${captureIndex} handle`),
          }))),
        }),
        resume: effect.resumeEntry === null
          ? null
          : Object.freeze({entry: effect.resumeEntry, handles: savedHandles}),
      });
    };
  });

  return Object.freeze({
    imports: {[WASM_IMPORT_MODULE]: lagrange},
    bind({arena, descriptor, closurePrototypes, pending}) {
      if (holder.current) throw new TypeError('WASM instance host environment is already bound');
      holder.current = {
        arena,
        closurePrototypes,
        pending,
        activeSendSites: new Set(descriptor.sendSiteIndices),
        activeClosureSites: new Set(descriptor.closureSiteIndices),
      };
    },
    unbind() {
      if (!holder.current) throw new TypeError('WASM instance host environment is not bound');
      holder.current = null;
    },
  });
}

function instanceReuseMode(moduleArtifact) {
  const mode = moduleArtifact.metadata?.instanceReuse;
  if (mode === undefined) return null;
  if (mode !== WASM_INSTANCE_REUSE_STATELESS_V0) throw new TypeError(`unsupported WASM instance reuse contract: ${mode}`);
  return mode;
}

async function createInstanceSlot(compiledModule, literals, sendSites, closureSites, effectSites) {
  const host = createRebindableHostEnvironment(literals, sendSites, closureSites, effectSites);
  const instance = await WebAssembly.instantiate(compiledModule, host.imports);
  return Object.freeze({instance, host});
}

async function acquireInstance({
  moduleArtifact,
  compiledModule,
  instancePool,
  literals,
  sendSites,
  closureSites,
  effectSites,
}) {
  if (instanceReuseMode(moduleArtifact) === WASM_INSTANCE_REUSE_STATELESS_V0) {
    return await instancePool.acquire(
      moduleArtifact,
      async () => await createInstanceSlot(compiledModule, literals, sendSites, closureSites, effectSites),
    );
  }
  const slot = await createInstanceSlot(compiledModule, literals, sendSites, closureSites, effectSites);
  let released = false;
  return Object.freeze({
    slot,
    release() {
      if (released) throw new TypeError('WASM one-shot instance lease already released');
      released = true;
    },
  });
}

async function performHostEffect(effect, context) {
  if (effect.kind === 'send') {
    if (typeof context.sendMessage !== 'function') throw new TypeError('WASM message send requires a message runtime');
    return canonicalizeValue(await context.sendMessage(effect.request));
  }
  if (effect.kind === 'closure') {
    if (typeof context.createClosure !== 'function') throw new TypeError('WASM closure creation requires a closure runtime');
    return canonicalizeValue(await context.createClosure(effect.request));
  }
  throw new TypeError(`unknown WASM host effect kind: ${effect.kind}`);
}

function createResumableWasmFunctionV1Executor({
  moduleCache = new WasmModuleCache(),
  instancePool = new WasmInstancePool(),
} = {}) {
  if (!moduleCache || typeof moduleCache.get !== 'function' || typeof moduleCache.stats !== 'function') {
    throw new TypeError('moduleCache must be a WasmModuleCache-compatible object');
  }
  if (!instancePool || typeof instancePool.acquire !== 'function' || typeof instancePool.stats !== 'function') {
    throw new TypeError('instancePool must be a WasmInstancePool-compatible object');
  }

  return Object.freeze({
    moduleCache,
    instancePool,
    async execute({activation, code}, context, resolved = null) {
      if (!resolved) assertWasmFunctionArtifactAnyVersion(code);
      const moduleRef = functionModuleRef(code);
      const moduleArtifact = resolved?.moduleArtifact ?? await context.images.getCodeArtifact(moduleRef.imageId, moduleRef.objectId);
      if (!moduleArtifact) throw new TypeError(`WASM module not found: ${moduleRef.imageId}/${moduleRef.objectId}`);
      const contract = readModuleDescriptor(moduleArtifact);
      const resolveImplementation = (ref) => context.images.getCodeArtifact(ref.imageId, ref.objectId);
      if (contract.abi !== WASM_RESUMABLE_VALUE_HANDLE_ABI_V1) {
        throw new TypeError(`WASM module ABI does not match ${WASM_RESUMABLE_VALUE_HANDLE_ABI_V1}`);
      }
      const literals = normalizeLiterals(contract.literals);
      const sendSites = normalizeSendSites(contract.sendSites);
      const closureSites = normalizeClosureSites(contract.closureSites);
      const effectSites = normalizeEffectSites(contract.effectSites, sendSites, closureSites);
      const fn = resolveFunctionContract(
        code,
        Object.freeze({...contract, functions: normalizeModuleFunctions(contract.functions, sendSites, closureSites), closureSites}),
        resolved?.selection ? {selection: resolved.selection} : {},
      );
      const {descriptor, closurePrototypes} = fn;
      const parameterCount = descriptor.parameters;
      const captureIds = descriptor.captures;
      if (activation.arguments.length !== parameterCount) {
        throw new TypeError(`WASM activation expected ${parameterCount} arguments, received ${activation.arguments.length}`);
      }
      const compiledModule = await moduleCache.get(moduleArtifact, () => readModuleImplementationBytes(moduleArtifact, {resolveImplementation}));

      const arena = new ValueHandleArena({receiverAbsent: activation.receiver === null});
      const receiverHandle = activation.receiver === null ? 0 : arena.put(activation.receiver);
      const argumentHandles = activation.arguments.map((value) => arena.put(value));
      const captureHandles = [];
      for (const bindingId of captureIds) captureHandles.push(arena.put(await context.lookupBinding(bindingId)));
      const pending = {effect: null};

      const lease = await acquireInstance({
        moduleArtifact,
        compiledModule,
        instancePool,
        literals,
        sendSites,
        closureSites,
        effectSites,
      });
      let bound = false;
      let released = false;
      let result = null;
      let tailEffect = null;
      let currentEntry = fn.entry;
      let currentHandles = [receiverHandle, ...argumentHandles, ...captureHandles];
      let resumptions = 0;

      try {
        while (true) {
          pending.effect = null;
          lease.slot.host.bind({arena, descriptor, closurePrototypes, pending});
          bound = true;
          const entry = lease.slot.instance.exports[currentEntry];
          if (typeof entry !== 'function') throw new TypeError(`WASM function/resume entry not found: ${currentEntry}`);
          const resultHandle = entry(...currentHandles);

          const effect = pending.effect;
          lease.slot.host.unbind();
          bound = false;

          if (effect === null) {
            result = arena.get(resultHandle, 'WASM result handle');
            break;
          }
          if (resultHandle !== 0) throw new TypeError('WASM host effect suspension must return reserved handle 0');

          if (effect.resume === null) {
            tailEffect = effect;
            break;
          }
          resumptions += 1;
          if (resumptions > MAX_WASM_RESUMPTIONS) throw new TypeError('WASM resumable effect limit exceeded');

          const resumedValue = await performHostEffect(effect, context);
          const resultValueHandle = arena.put(resumedValue);
          currentEntry = effect.resume.entry;
          currentHandles = [...effect.resume.handles, resultValueHandle];
        }

        lease.release();
        released = true;
      } catch (error) {
        if (bound) {
          try { lease.slot.host.unbind(); } catch {}
          bound = false;
        }
        if (!released) {
          try { lease.release({retire: true}); } catch {}
          released = true;
        }
        throw error;
      }

      if (tailEffect !== null) return await performHostEffect(tailEffect, context);
      return canonicalizeValue(result);
    },
  });
}

export {
  MAX_WASM_RESUMPTIONS,
  createResumableWasmFunctionV1Executor,
};
