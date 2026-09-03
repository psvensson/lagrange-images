import {
  assertWasmFunctionArtifact,
  assertWasmModuleArtifact,
} from '../code/wasm-artifacts.js';
import {canonicalizeValue, isObjectRef, isReference} from '../value/index.js';
import {ValueHandleArena, WASM_IMPORT_MODULE, WASM_VALUE_HANDLE_ABI_V1} from './abi.js';
import {readCellThrough, writeCellThrough} from './cell-access.js';
import {WasmModuleCache} from './module-cache.js';
import {readModuleContract} from './module-contract.js';
import {WASM_INSTANCE_REUSE_STATELESS_V0, WasmInstancePool} from './instance-pool.js';

// The lagrange-value-handle/v1 executor. Separate from the v0 one on purpose: every metadata
// normalizer here branches on the v1 ABI, and the v0 normalizers never learn to accept the v1
// shape. An artifact means exactly what its declared ABI says it means.
function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
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

function normalizeLiterals(value) {
  if (!Array.isArray(value)) throw new TypeError('WASM module metadata.literals must be an array');
  return Object.freeze(value.map((literal) => canonicalizeValue(literal)));
}

function normalizeIndexList(value, limit, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const seen = new Set();
  return Object.freeze(value.map((entry, index) => {
    const site = requireNonNegativeInteger(entry, `${label} ${index}`);
    if (site >= limit) throw new TypeError(`${label} ${index} is out of range`);
    if (seen.has(site)) throw new TypeError(`${label} contains duplicate index ${site}`);
    seen.add(site);
    return site;
  }));
}

// Defence in depth: general metadata normalization already rejects object references, but this is
// an invariant of the ABI reader and the new one should not be laxer than the frozen one.
function assertNonReferenceMessage(message, index) {
  if (isReference(message)) throw new TypeError(`WASM send site ${index} message must not hide a graph reference`);
  return message;
}

function normalizeSendSites(value) {
  if (!Array.isArray(value)) throw new TypeError('WASM module metadata.sendSites must be an array');
  return Object.freeze(value.map((site, index) => {
    exactKeys(site, ['languageId', 'message', 'arity'], `WASM send site ${index}`);
    return Object.freeze({
      languageId: requiredText(site.languageId, `WASM send site ${index} languageId`),
      message: assertNonReferenceMessage(canonicalizeValue(site.message), index),
      arity: requireNonNegativeInteger(site.arity, `WASM send site ${index} arity`),
    });
  }));
}

// v1 closure sites carry a per-capture mode. This normalizer requires it: a v0-shaped site reaching
// a v1 module is a mismatch, not something to interpret generously.
function normalizeClosureSites(value) {
  if (!Array.isArray(value)) throw new TypeError('WASM module metadata.closureSites must be an array');
  return Object.freeze(value.map((site, siteIndex) => {
    exactKeys(site, ['blockId', 'captures'], `WASM closure site ${siteIndex}`);
    requiredText(site.blockId, `WASM closure site ${siteIndex} blockId`);
    if (!Array.isArray(site.captures)) throw new TypeError(`WASM closure site ${siteIndex} captures must be an array`);
    const captures = Object.freeze(site.captures.map((capture, captureIndex) => {
      const label = `WASM closure site ${siteIndex} capture ${captureIndex}`;
      exactKeys(capture, ['id', 'mode', 'name'], label);
      const mode = requiredText(capture.mode, `${label} mode`);
      if (mode !== 'snapshot' && mode !== 'cell') throw new TypeError(`${label} mode must be snapshot or cell`);
      return Object.freeze({
        id: requiredText(capture.id, `${label} id`),
        name: requiredText(capture.name, `${label} name`),
        mode,
      });
    }));
    return Object.freeze({blockId: site.blockId, captures});
  }));
}

function normalizeCellBindings(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const seen = new Set();
  return Object.freeze(value.map((binding, index) => {
    exactKeys(binding, ['id', 'name', 'source'], `${label} ${index}`);
    const id = requiredText(binding.id, `${label} ${index} id`);
    if (seen.has(id)) throw new TypeError(`${label} declares duplicate cell binding ${id}`);
    seen.add(id);
    const source = requiredText(binding.source, `${label} ${index} source`);
    if (source !== 'temporary' && source !== 'capture') {
      throw new TypeError(`${label} ${index} source must be temporary or capture`);
    }
    return Object.freeze({id, name: requiredText(binding.name, `${label} ${index} name`), source});
  }));
}

function normalizeCaptureIds(value, label = 'WASM function metadata.captures') {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(value.map((id, index) => requiredText(id, `${label} ${index}`)));
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCellBindings(left, right) {
  return left.length === right.length && left.every((binding, index) => (
    binding.id === right[index].id
    && binding.name === right[index].name
    && binding.source === right[index].source
  ));
}

function normalizeModuleFunctions(value, sendSites, closureSites) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('WASM module metadata.functions must be a non-empty array');
  }
  const entries = new Set();
  const memberIndices = new Set();
  return Object.freeze(value.map((descriptor, index) => {
    exactKeys(
      descriptor,
      ['entry', 'memberIndex', 'parameters', 'captures', 'cellBindings', 'sendSiteIndices', 'closureSiteIndices'],
      `WASM module function ${index}`,
    );
    const entry = requiredText(descriptor.entry, `WASM module function ${index} entry`);
    const memberIndex = requireNonNegativeInteger(descriptor.memberIndex, `WASM module function ${index} memberIndex`);
    if (entries.has(entry)) throw new TypeError(`duplicate WASM module function entry: ${entry}`);
    if (memberIndices.has(memberIndex)) throw new TypeError(`duplicate WASM module function memberIndex: ${memberIndex}`);
    entries.add(entry);
    memberIndices.add(memberIndex);
    return Object.freeze({
      entry,
      memberIndex,
      parameters: requireNonNegativeInteger(descriptor.parameters, `WASM module function ${index} parameters`),
      captures: normalizeCaptureIds(descriptor.captures, `WASM module function ${index} captures`),
      cellBindings: normalizeCellBindings(descriptor.cellBindings, `WASM module function ${index} cellBindings`),
      sendSiteIndices: normalizeIndexList(descriptor.sendSiteIndices, sendSites.length, `WASM module function ${index} sendSiteIndices`),
      closureSiteIndices: normalizeIndexList(descriptor.closureSiteIndices, closureSites.length, `WASM module function ${index} closureSiteIndices`),
    });
  }));
}

function activeFunctionDescriptor(code, moduleFunctions, sendSites, closureSites) {
  const functions = normalizeModuleFunctions(moduleFunctions, sendSites, closureSites);
  if (functions) {
    const descriptor = functions.find(({entry}) => entry === code.metadata.entry);
    if (!descriptor) throw new TypeError(`WASM function entry not described by module: ${code.metadata.entry}`);
    if (descriptor.parameters !== code.metadata.parameters) throw new TypeError('WASM function parameter metadata does not match module entry');
    if (!sameStrings(descriptor.captures, normalizeCaptureIds(code.metadata.captures ?? []))) {
      throw new TypeError('WASM function capture metadata does not match module entry');
    }
    // Full equality, not just ids. The module descriptor is what drives execution, so an id-only
    // check would let two durable artifacts disagree about whether a cell is a temporary or a
    // capture — the difference between declaring a fresh cell and using the declaring frame's —
    // and still validate. Versioned metadata should reject that contradiction, not tolerate it.
    const codeCells = normalizeCellBindings(code.metadata.cellBindings ?? [], 'WASM function metadata.cellBindings');
    if (!sameCellBindings(descriptor.cellBindings, codeCells)) {
      throw new TypeError('WASM function cell binding metadata does not match module entry');
    }
    return descriptor;
  }
  return Object.freeze({
    entry: code.metadata.entry,
    memberIndex: 0,
    parameters: code.metadata.parameters,
    captures: normalizeCaptureIds(code.metadata.captures ?? []),
    cellBindings: normalizeCellBindings(code.metadata.cellBindings ?? [], 'WASM function metadata.cellBindings'),
    sendSiteIndices: Object.freeze(sendSites.map((_, index) => index)),
    closureSiteIndices: Object.freeze(closureSites.map((_, index) => index)),
  });
}

function normalizeClosurePrototypes(code, descriptor, closureSites) {
  const entries = code.metadata?.closurePrototypes ?? [];
  if (!Array.isArray(entries)) throw new TypeError('WASM function metadata.closurePrototypes must be an array');
  if (entries.length !== descriptor.closureSiteIndices.length) {
    throw new TypeError('WASM closure prototype count does not match module function closure sites');
  }
  const result = new Map();
  entries.forEach((entry, localIndex) => {
    exactKeys(entry, ['blockId', 'derivedFromIndex', 'siteIndex'], `WASM closure prototype ${localIndex}`);
    const siteIndex = requireNonNegativeInteger(entry.siteIndex, `WASM closure prototype ${localIndex} siteIndex`);
    if (siteIndex !== descriptor.closureSiteIndices[localIndex]) {
      throw new TypeError(`WASM closure prototype ${localIndex} does not match module function closure site index`);
    }
    const site = closureSites[siteIndex];
    if (entry.blockId !== site.blockId) throw new TypeError(`WASM closure prototype ${localIndex} does not match closure site ${site.blockId}`);
    const derivedFromIndex = requireNonNegativeInteger(entry.derivedFromIndex, `WASM closure prototype ${localIndex} derivedFromIndex`);
    if (derivedFromIndex < 2 || derivedFromIndex >= code.derivedFrom.length) {
      throw new TypeError(`WASM closure prototype ${localIndex} derivedFromIndex is out of range`);
    }
    const ref = canonicalizeValue(code.derivedFrom[derivedFromIndex]);
    if (!isObjectRef(ref)) throw new TypeError(`WASM closure prototype ${localIndex} must resolve to an unpinned Block ref`);
    result.set(siteIndex, ref);
  });
  return result;
}

function recordPending(pending, effect) {
  if (pending.effect !== null) throw new TypeError('WASM activation attempted more than one pending host effect');
  pending.effect = Object.freeze(effect);
  return 0;
}

function createRebindableHostEnvironment(literals, sendSites, closureSites) {
  const holder = {current: null};
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
    // Synchronous, and resolved through *this activation's* descriptor. A slot index means nothing
    // on its own: a shared module holds several semantic Blocks whose static binding ids all start
    // at `root:`, so a module-global table would confuse unrelated slots that share a name.
    cell_get(slot) {
      const state = current();
      return state.arena.put(readCellThrough(state.readCell, state.cellBinding(slot)));
    },
    // Assignment is an expression, so this returns the handle of the value written.
    cell_set(slot, handle) {
      const state = current();
      const binding = state.cellBinding(slot);
      const value = state.arena.get(handle, `WASM cell_set value handle for slot ${slot}`);
      return state.arena.put(writeCellThrough(state.writeCell, binding, value));
    },
  };

  sendSites.forEach((site, siteIndex) => {
    lagrange[`send_site_${siteIndex}`] = (...handles) => {
      const state = current();
      if (!state.activeSendSites.has(siteIndex)) throw new TypeError(`inactive WASM send site invoked: ${siteIndex}`);
      if (handles.length !== 1 + site.arity) {
        throw new TypeError(`WASM send site ${siteIndex} expected ${1 + site.arity} handles, received ${handles.length}`);
      }
      return recordPending(state.pending, {
        kind: 'send',
        request: Object.freeze({
          languageId: site.languageId,
          receiver: state.arena.get(handles[0], `WASM send site ${siteIndex} receiver handle`),
          message: site.message,
          arguments: Object.freeze(handles.slice(1).map((handle, argumentIndex) =>
            state.arena.get(handle, `WASM send site ${siteIndex} argument ${argumentIndex} handle`))),
        }),
      });
    };
  });

  closureSites.forEach((site, siteIndex) => {
    // Arity counts snapshot captures only. A cell capture occupies no handle position, so there is
    // no channel through which a snapshot of a mutable cell could enter the closure — the host
    // reconstructs the full capture list, marking cell captures for createClosure to resolve
    // against the declaring frame.
    const snapshotCaptures = site.captures.filter(({mode}) => mode === 'snapshot');
    lagrange[`make_block_site_${siteIndex}`] = (...handles) => {
      const state = current();
      if (!state.activeClosureSites.has(siteIndex)) throw new TypeError(`inactive WASM closure site invoked: ${siteIndex}`);
      if (handles.length !== snapshotCaptures.length) {
        throw new TypeError(`WASM closure site ${siteIndex} expected ${snapshotCaptures.length} handles, received ${handles.length}`);
      }
      const prototype = state.closurePrototypes.get(siteIndex);
      if (!prototype) throw new TypeError(`WASM closure prototype missing at execution: ${site.blockId}`);
      let handleIndex = 0;
      const captures = Object.freeze(site.captures.map((capture) => {
        if (capture.mode === 'cell') {
          return Object.freeze({id: capture.id, name: capture.name, mode: 'cell'});
        }
        const handle = handles[handleIndex];
        handleIndex += 1;
        return Object.freeze({
          id: capture.id,
          name: capture.name,
          mode: 'snapshot',
          value: state.arena.get(handle, `WASM closure site ${siteIndex} capture ${capture.id} handle`),
        });
      }));
      return recordPending(state.pending, {kind: 'closure', request: Object.freeze({prototype, captures})});
    };
  });

  return Object.freeze({
    imports: {[WASM_IMPORT_MODULE]: lagrange},
    // Lexical cell access is per-activation state, exactly like the value arena and the active
    // effect sites, so a pooled instance rebinds all of it on every checkout.
    bind({arena, descriptor, closurePrototypes, pending, readCell, writeCell}) {
      if (holder.current) throw new TypeError('WASM instance host environment is already bound');
      const cellBindings = descriptor.cellBindings;
      holder.current = {
        arena,
        closurePrototypes,
        pending,
        readCell,
        writeCell,
        cellBinding(slot) {
          if (!Number.isInteger(slot) || slot < 0 || slot >= cellBindings.length) {
            throw new TypeError(`WASM cell slot out of range for ${descriptor.entry}: ${slot}`);
          }
          return cellBindings[slot];
        },
        activeSendSites: new Set(descriptor.sendSiteIndices),
        activeClosureSites: new Set(descriptor.closureSiteIndices),
      };
    },
    // Clears everything, so nothing from one activation is reachable from the next checkout of a
    // pooled instance.
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

async function createInstanceSlot(compiledModule, literals, sendSites, closureSites) {
  const host = createRebindableHostEnvironment(literals, sendSites, closureSites);
  const instance = await WebAssembly.instantiate(compiledModule, host.imports);
  return Object.freeze({instance, host});
}

async function acquireInstance({moduleArtifact, compiledModule, instancePool, literals, sendSites, closureSites}) {
  if (instanceReuseMode(moduleArtifact) === WASM_INSTANCE_REUSE_STATELESS_V0) {
    return await instancePool.acquire(
      moduleArtifact,
      async () => await createInstanceSlot(compiledModule, literals, sendSites, closureSites),
    );
  }
  const slot = await createInstanceSlot(compiledModule, literals, sendSites, closureSites);
  let released = false;
  return Object.freeze({
    slot,
    release() {
      if (released) throw new TypeError('WASM one-shot instance lease already released');
      released = true;
    },
  });
}

function requireCellOperations(context) {
  for (const operation of ['readCell', 'writeCell', 'declareTemporaries']) {
    if (typeof context[operation] !== 'function') {
      throw new TypeError(`the lagrange-value-handle/v1 ABI requires the ${operation} execution operation`);
    }
  }
}

function createWasmFunctionV1CellExecutor({
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
    async execute({activation, code}, context) {
      assertWasmFunctionArtifact(code);
      if (code.metadata.abi !== WASM_VALUE_HANDLE_ABI_V1) throw new TypeError(`unsupported WASM ABI: ${code.metadata.abi}`);
      requireCellOperations(context);
      const parameterCount = requireNonNegativeInteger(code.metadata.parameters, 'WASM function parameter count');
      const captureIds = normalizeCaptureIds(code.metadata.captures ?? []);
      if (activation.arguments.length !== parameterCount) {
        throw new TypeError(`WASM activation expected ${parameterCount} arguments, received ${activation.arguments.length}`);
      }

      const moduleRef = canonicalizeValue(code.content);
      const moduleArtifact = await context.images.getCodeArtifact(moduleRef.imageId, moduleRef.objectId);
      const contract = await readModuleContract(moduleArtifact, {
        resolveImplementation: (ref) => context.images.getCodeArtifact(ref.imageId, ref.objectId),
      });
      if (contract.abi !== WASM_VALUE_HANDLE_ABI_V1) {
        throw new TypeError(`WASM module ABI does not match ${WASM_VALUE_HANDLE_ABI_V1}`);
      }
      const literals = normalizeLiterals(contract.literals);
      const sendSites = normalizeSendSites(contract.sendSites);
      const closureSites = normalizeClosureSites(contract.closureSites);
      const descriptor = activeFunctionDescriptor(code, contract.functions, sendSites, closureSites);
      const closurePrototypes = normalizeClosurePrototypes(code, descriptor, closureSites);
      const compiledModule = await moduleCache.get(moduleArtifact, contract.bytes);

      // Only temporaries: this activation declares the cells it owns. A cell capture already
      // exists in the frame that declared it, and declaring one here would shadow it with a fresh
      // empty cell. Declaring host-side rather than in the guest is what keeps frame machinery out
      // of the ABI — the module knows slot indices, the host owns which cell each one is.
      context.declareTemporaries(descriptor.cellBindings.filter(({source}) => source === 'temporary'));

      const arena = new ValueHandleArena({receiverAbsent: activation.receiver === null});
      const receiverHandle = activation.receiver === null ? 0 : arena.put(activation.receiver);
      const argumentHandles = activation.arguments.map((value) => arena.put(value));
      // Snapshot captures are still resolved before entry and passed as handles, exactly as in v0.
      // Cell captures are not resolved here at all; they are reached through cell_get/cell_set.
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
      });
      let bound = false;
      let released = false;
      let result;
      let tailEffect = null;
      try {
        lease.slot.host.bind({
          arena,
          descriptor,
          closurePrototypes,
          pending,
          readCell: context.readCell,
          writeCell: context.writeCell,
        });
        bound = true;
        const entry = lease.slot.instance.exports[code.metadata.entry];
        if (typeof entry !== 'function') throw new TypeError(`WASM function entry not found: ${code.metadata.entry}`);
        const resultHandle = entry(receiverHandle, ...argumentHandles, ...captureHandles);

        if (pending.effect !== null) {
          if (resultHandle !== 0) throw new TypeError('WASM tail host effect must return reserved handle 0');
          tailEffect = pending.effect;
        } else {
          result = arena.get(resultHandle, 'WASM result handle');
        }

        lease.slot.host.unbind();
        bound = false;
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

      if (tailEffect !== null) {
        if (tailEffect.kind === 'send') {
          if (typeof context.sendMessage !== 'function') throw new TypeError('WASM message send requires a message runtime');
          return canonicalizeValue(await context.sendMessage(tailEffect.request));
        }
        if (tailEffect.kind === 'closure') {
          if (typeof context.createClosure !== 'function') throw new TypeError('WASM closure creation requires a closure runtime');
          return canonicalizeValue(await context.createClosure(tailEffect.request));
        }
        throw new TypeError(`unknown WASM host effect kind: ${tailEffect.kind}`);
      }

      return canonicalizeValue(result);
    },
  });
}

export {createWasmFunctionV1CellExecutor};
