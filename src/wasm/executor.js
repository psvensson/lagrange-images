import {
  WASM_FUNCTION_V1,
  assertWasmFunctionArtifact,
  assertWasmModuleArtifact,
} from '../code/wasm-artifacts.js';
import {bytesFromBase64, canonicalizeValue} from '../value/index.js';
import {
  WASM_IMPORT_MODULE,
  WASM_VALUE_HANDLE_ABI_V0,
  ValueHandleArena,
} from './abi.js';

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
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

function createHostImports(arena, literals) {
  return {
    [WASM_IMPORT_MODULE]: {
      literal(index) {
        if (!Number.isInteger(index) || index < 0 || index >= literals.length) {
          throw new TypeError(`WASM literal index out of range: ${index}`);
        }
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
    },
  };
}

const wasmFunctionV1Executor = Object.freeze({
  async execute({activation, code}, context) {
    assertWasmFunctionArtifact(code);
    if (code.metadata.abi !== WASM_VALUE_HANDLE_ABI_V0) {
      throw new TypeError(`unsupported WASM ABI: ${code.metadata.abi}`);
    }
    const parameterCount = requireNonNegativeInteger(code.metadata.parameters, 'WASM function parameter count');
    const captureIds = normalizeCaptures(code.metadata.captures ?? []);
    if (activation.arguments.length !== parameterCount) {
      throw new TypeError(`WASM activation expected ${parameterCount} arguments, received ${activation.arguments.length}`);
    }

    const moduleRef = canonicalizeValue(code.content);
    const moduleArtifact = await context.images.getCodeArtifact(moduleRef.imageId, moduleRef.objectId);
    assertWasmModuleArtifact(moduleArtifact);
    if (moduleArtifact.metadata?.abi !== WASM_VALUE_HANDLE_ABI_V0) {
      throw new TypeError(`WASM module ABI does not match ${WASM_VALUE_HANDLE_ABI_V0}`);
    }
    const literals = normalizeLiterals(moduleArtifact.metadata?.literals ?? []);
    const bytesValue = bytesFromBase64(moduleArtifact.content.base64);
    const bytes = Buffer.from(bytesValue.base64, 'base64');
    if (!WebAssembly.validate(bytes)) throw new TypeError('WASM module bytes failed validation');

    const arena = new ValueHandleArena();
    const receiverHandle = activation.receiver === null ? 0 : arena.put(activation.receiver);
    const argumentHandles = activation.arguments.map((value) => arena.put(value));
    const captureHandles = [];
    for (const bindingId of captureIds) {
      captureHandles.push(arena.put(await context.lookupBinding(bindingId)));
    }

    const {instance} = await WebAssembly.instantiate(bytes, createHostImports(arena, literals));
    const entry = instance.exports[code.metadata.entry];
    if (typeof entry !== 'function') throw new TypeError(`WASM function entry not found: ${code.metadata.entry}`);
    const resultHandle = entry(receiverHandle, ...argumentHandles, ...captureHandles);
    return arena.get(resultHandle, 'WASM result handle');
  },
});

export {wasmFunctionV1Executor};
