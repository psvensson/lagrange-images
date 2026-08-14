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

function normalizeCaptures(value) {
  if (!Array.isArray(value)) throw new TypeError('WASM function metadata.captures must be an array');
  return Object.freeze(value.map((id, index) => {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError(`WASM capture ${index} must be a non-empty binding id`);
    return id;
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

function normalizeClosurePrototypes(code, closureSites) {
  const entries = code.metadata?.closurePrototypes ?? [];
  if (!Array.isArray(entries)) throw new TypeError('WASM function metadata.closurePrototypes must be an array');
  if (entries.length !== closureSites.length) throw new TypeError('WASM closure prototype count does not match module closure sites');
  const result = new Map();
  entries.forEach((entry, index) => {
    exactKeys(entry, ['blockId', 'derivedFromIndex'], `WASM closure prototype ${index}`);
    const site = closureSites[index];
    if (entry.blockId !== site.blockId) throw new TypeError(`WASM closure prototype ${index} does not match closure site ${site.blockId}`);
    const derivedFromIndex = requireNonNegativeInteger(entry.derivedFromIndex, `WASM closure prototype ${index} derivedFromIndex`);
    if (derivedFromIndex < 2 || derivedFromIndex >= code.derivedFrom.length) {
      throw new TypeError(`WASM closure prototype ${index} derivedFromIndex is out of range`);
    }
    const ref = canonicalizeValue(code.derivedFrom[derivedFromIndex]);
    if (!isObjectRef(ref)) throw new TypeError(`WASM closure prototype ${index} must resolve to an unpinned Block ref`);
    result.set(site.blockId, ref);
  });
  return result;
}

function recordPending(pending, effect) {
  if (pending.effect !== null) throw new TypeError('WASM activation attempted more than one pending host effect');
  pending.effect = Object.freeze(effect);
  return 0;
}

function createHostImports(arena, literals, sendSites, closureSites, closurePrototypes, pending) {
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
      if (handles.length !== site.captures.length) {
        throw new TypeError(`WASM closure site ${siteIndex} expected ${site.captures.length} handles, received ${handles.length}`);
      }
      const prototype = closurePrototypes.get(site.blockId);
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
    const closurePrototypes = normalizeClosurePrototypes(code, closureSites);
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
      createHostImports(arena, literals, sendSites, closureSites, closurePrototypes, pending),
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
