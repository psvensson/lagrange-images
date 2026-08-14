import {
  WASM_FUNCTION_V1,
  assertWasmFunctionArtifact,
  assertWasmModuleArtifact,
} from '../code/wasm-artifacts.js';
import {bytesFromBase64, canonicalizeValue, isObjectRef, isReference} from '../value/index.js';
import {
  WASM_IMPORT_MODULE,
  WASM_VALUE_HANDLE_ABI_V0,
  ValueHandleArena,
} from './abi.js';

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
  if (!Array.isArray(value)) throw new TypeError('WASM module metadata.literals must be an array');
  return Object.freeze(value.map((entry) => canonicalizeValue(entry)));
}

function normalizeSendSites(value) {
  if (!Array.isArray(value)) throw new TypeError('WASM module metadata.sendSites must be an array');
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
  if (!Array.isArray(value)) throw new TypeError('WASM module metadata.closureSites must be an array');
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

function normalizeModuleFunctions(value, sendSites, closureSites) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('WASM module metadata.functions must be a non-empty array');
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

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function activeFunctionDescriptor(code, moduleArtifact, sendSites, closureSites) {
  const functions = normalizeModuleFunctions(moduleArtifact.metadata?.functions, sendSites, closureSites);
  if (functions) {
    const descriptor = functions.find(({entry}) => entry === code.metadata.entry);
    if (!descriptor) throw new TypeError(`WASM function entry not described by module: ${code.metadata.entry}`);
    if (descriptor.parameters !== code.metadata.parameters) throw new TypeError('WASM function parameter metadata does not match module entry');
    const codeCaptures = normalizeCaptures(code.metadata.captures ?? []);
    if (!sameStrings(descriptor.captures, codeCaptures)) throw new TypeError('WASM function capture metadata does not match module entry');
    return descriptor;
  }
  return Object.freeze({
    entry: code.metadata.entry,
    memberIndex: 0,
    parameters: code.metadata.parameters,
    captures: normalizeCaptures(code.metadata.captures ?? []),
    sendSiteIndices: Object.freeze(sendSites.map((_, index) => index)),
    closureSiteIndices: Object.freeze(closureSites.map((_, index) => index)),
  });
}

function normalizeClosurePrototypes(code, descriptor, closureSites) {
  const entries = code.metadata?.closurePrototypes ?? [];
  if (!Array.isArray(entries)) throw new TypeError('WASM function metadata.closurePrototypes must be an array');
  if (entries.length !== descriptor.closureSiteIndices.length) throw new TypeError('WASM closure prototype count does not match module function closure sites');
  const result = new Map();
  entries.forEach((entry, localIndex) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`WASM closure prototype ${localIndex} must be an object`);
    const keys = Object.keys(entry).sort();
    const legacyKeys = ['blockId', 'derivedFromIndex'].sort();
    const currentKeys = ['blockId', 'derivedFromIndex', 'siteIndex'].sort();
    const isLegacy = keys.length === legacyKeys.length && keys.every((key, index) => key === legacyKeys[index]);
    const isCurrent = keys.length === currentKeys.length && keys.every((key, index) => key === currentKeys[index]);
    if (!isLegacy && !isCurrent) throw new TypeError(`WASM closure prototype ${localIndex} has unsupported fields`);
    const siteIndex = isCurrent
      ? requireNonNegativeInteger(entry.siteIndex, `WASM closure prototype ${localIndex} siteIndex`)
      : descriptor.closureSiteIndices[localIndex];
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

function createHostImports(arena, literals, sendSites, closureSites, descriptor, closurePrototypes, pending) {
  const activeSendSites = new Set(descriptor.sendSiteIndices);
  const activeClosureSites = new Set(descriptor.closureSiteIndices);
  const lagrange = {
    literal(index) {
      if (!Number.isInteger(index) || index < 0 || index >= literals.length) throw new TypeError(`WASM literal index out of range: ${index}`);
      return arena.put(literals[index]);
    },
    integer_add(left, right) {
      return arena.integerAdd(left, right);
    },
    equals(left, right) {
      return arena.equals(left, right);
    },
    is_true(handle) {
      return arena.isTrue(handle);
    },
  };

  sendSites.forEach((site, siteIndex) => {
    lagrange[`send_site_${siteIndex}`] = (...handles) => {
      if (!activeSendSites.has(siteIndex)) throw new TypeError(`inactive WASM send site invoked: ${siteIndex}`);
      if (handles.length !== 1 + site.arity) {
        throw new TypeError(`WASM send site ${siteIndex} expected ${1 + site.arity} handles, received ${handles.length}`);
      }
      return recordPending(pending, {
        kind: 'send',
        request: Object.freeze({
          languageId: site.languageId,
          receiver: arena.get(handles[0], `WASM send site ${siteIndex} receiver handle`),
          message: site.message,
          arguments: Object.freeze(handles.slice(1).map((handle, argumentIndex) =>
            arena.get(handle, `WASM send site ${siteIndex} argument ${argumentIndex} handle`))),
        }),
      });
    };
  });

  closureSites.forEach((site, siteIndex) => {
    lagrange[`make_block_site_${siteIndex}`] = (...handles) => {
      if (!activeClosureSites.has(siteIndex)) throw new TypeError(`inactive WASM closure site invoked: ${siteIndex}`);
      if (handles.length !== site.captures.length) {
        throw new TypeError(`WASM closure site ${siteIndex} expected ${site.captures.length} handles, received ${handles.length}`);
      }
      const prototype = closurePrototypes.get(siteIndex);
      if (!prototype) throw new TypeError(`WASM closure prototype missing at execution: ${site.blockId}`);
      return recordPending(pending, {
        kind: 'closure',
        request: Object.freeze({
          prototype,
          captures: Object.freeze(site.captures.map((capture, captureIndex) => Object.freeze({
            id: capture.id,
            name: capture.name,
            value: arena.get(handles[captureIndex], `WASM closure site ${siteIndex} capture ${captureIndex} handle`),
          }))),
        }),
      });
    };
  });

  return {[WASM_IMPORT_MODULE]: lagrange};
}

const wasmFunctionV1Executor = Object.freeze({
  async execute({activation, code}, context) {
    assertWasmFunctionArtifact(code);
    if (code.metadata.abi !== WASM_VALUE_HANDLE_ABI_V0) throw new TypeError(`unsupported WASM ABI: ${code.metadata.abi}`);
    const parameterCount = requireNonNegativeInteger(code.metadata.parameters, 'WASM function parameter count');
    const captureIds = normalizeCaptures(code.metadata.captures ?? []);
    if (activation.arguments.length !== parameterCount) {
      throw new TypeError(`WASM activation expected ${parameterCount} arguments, received ${activation.arguments.length}`);
    }

    const moduleRef = canonicalizeValue(code.content);
    const moduleArtifact = await context.images.getCodeArtifact(moduleRef.imageId, moduleRef.objectId);
    assertWasmModuleArtifact(moduleArtifact);
    if (moduleArtifact.metadata?.abi !== WASM_VALUE_HANDLE_ABI_V0) throw new TypeError(`WASM module ABI does not match ${WASM_VALUE_HANDLE_ABI_V0}`);
    const literals = normalizeLiterals(moduleArtifact.metadata?.literals ?? []);
    const sendSites = normalizeSendSites(moduleArtifact.metadata?.sendSites ?? []);
    const closureSites = normalizeClosureSites(moduleArtifact.metadata?.closureSites ?? []);
    const descriptor = activeFunctionDescriptor(code, moduleArtifact, sendSites, closureSites);
    const closurePrototypes = normalizeClosurePrototypes(code, descriptor, closureSites);
    const bytesValue = bytesFromBase64(moduleArtifact.content.base64);
    const bytes = Buffer.from(bytesValue.base64, 'base64');
    if (!WebAssembly.validate(bytes)) throw new TypeError('WASM module bytes failed validation');

    const arena = new ValueHandleArena();
    const receiverHandle = activation.receiver === null ? 0 : arena.put(activation.receiver);
    const argumentHandles = activation.arguments.map((value) => arena.put(value));
    const captureHandles = [];
    for (const bindingId of captureIds) captureHandles.push(arena.put(await context.lookupBinding(bindingId)));

    const pending = {effect: null};
    const {instance} = await WebAssembly.instantiate(
      bytes,
      createHostImports(arena, literals, sendSites, closureSites, descriptor, closurePrototypes, pending),
    );
    const entry = instance.exports[code.metadata.entry];
    if (typeof entry !== 'function') throw new TypeError(`WASM function entry not found: ${code.metadata.entry}`);
    const resultHandle = entry(receiverHandle, ...argumentHandles, ...captureHandles);

    if (pending.effect !== null) {
      if (resultHandle !== 0) throw new TypeError('WASM tail host effect must return reserved handle 0');
      if (pending.effect.kind === 'send') {
        if (typeof context.sendMessage !== 'function') throw new TypeError('WASM message send requires a message runtime');
        return canonicalizeValue(await context.sendMessage(pending.effect.request));
      }
      if (pending.effect.kind === 'closure') {
        if (typeof context.createClosure !== 'function') throw new TypeError('WASM closure creation requires a closure runtime');
        return canonicalizeValue(await context.createClosure(pending.effect.request));
      }
      throw new TypeError(`unknown WASM host effect kind: ${pending.effect.kind}`);
    }

    return arena.get(resultHandle, 'WASM result handle');
  },
});

export {wasmFunctionV1Executor};
