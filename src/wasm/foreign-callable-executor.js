import {TupleMap} from '../support/tuple-map.js';
import {
  VALUE_KIND,
  booleanValue,
  canonicalizeValue,
  float64ToNumber,
  float64Value,
  integerValue,
} from '../value/index.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {
  WASM_CALLABLE_INTERFACE_V1,
  assertWasmBinaryArtifact,
  parseWasmCallableInterfaceArtifact,
} from './foreign-artifacts.js';

const I32_MIN = -(1n << 31n);
const I32_MAX = (1n << 31n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

// A tuple key, not a joined string: image and object ids are arbitrary non-empty text, so
// no separator is safe to join on. See src/support/tuple-map.js.
function foreignModuleCacheKey(artifact) {
  assertWasmBinaryArtifact(artifact);
  return [artifact.imageId, artifact.id];
}

class ForeignWasmModuleCache {
  constructor({compile = (bytes) => WebAssembly.compile(bytes)} = {}) {
    if (typeof compile !== 'function') throw new TypeError('foreign WASM module cache compile must be a function');
    this.compile = compile;
    this.entries = new TupleMap(2);
  }

  async get(artifact) {
    const key = foreignModuleCacheKey(artifact);
    const existing = this.entries.get(key);
    if (existing) return await existing;
    const bytes = Buffer.from(artifact.content.base64, 'base64');
    let pending;
    pending = Promise.resolve()
      .then(() => this.compile(bytes))
      .then((module) => {
        if (!(module instanceof WebAssembly.Module)) {
          throw new TypeError('foreign WASM compiler must return a WebAssembly.Module');
        }
        return module;
      })
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

function integerInRange(value, min, max, label) {
  if (value.kind !== VALUE_KIND.INTEGER) throw new TypeError(`${label} must be an integer Value`);
  const integer = BigInt(value.value);
  if (integer < min || integer > max) throw new RangeError(`${label} is outside the declared WASM scalar range`);
  return integer;
}

function encodeScalar(value, type, label) {
  const normalized = canonicalizeValue(value);
  switch (type) {
    case 'boolean':
      if (normalized.kind !== VALUE_KIND.BOOLEAN) throw new TypeError(`${label} must be a boolean Value`);
      return normalized.value ? 1 : 0;
    case 'i32':
      return Number(integerInRange(normalized, I32_MIN, I32_MAX, label));
    case 'i64':
      return integerInRange(normalized, I64_MIN, I64_MAX, label);
    case 'f32':
      if (normalized.kind !== VALUE_KIND.FLOAT64) throw new TypeError(`${label} must be a float64 Value`);
      return Math.fround(float64ToNumber(normalized));
    case 'f64':
      if (normalized.kind !== VALUE_KIND.FLOAT64) throw new TypeError(`${label} must be a float64 Value`);
      return float64ToNumber(normalized);
    default:
      throw new TypeError(`unsupported WASM scalar type: ${type}`);
  }
}

function decodeScalar(value, type) {
  switch (type) {
    case 'boolean':
      if (value !== 0 && value !== 1) throw new TypeError('foreign WASM boolean result must be i32 0 or 1');
      return booleanValue(value === 1);
    case 'i32':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError('foreign WASM i32 result must be an integer number');
      return integerValue(value);
    case 'i64':
      if (typeof value !== 'bigint') throw new TypeError('foreign WASM i64 result must be a bigint');
      return integerValue(value);
    case 'f32':
    case 'f64':
      if (typeof value !== 'number') throw new TypeError(`foreign WASM ${type} result must be a number`);
      return float64Value(value);
    default:
      throw new TypeError(`unsupported WASM scalar type: ${type}`);
  }
}

function assertNoImports(module) {
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    throw new TypeError('wasm-scalar-call/v0 requires a WebAssembly module with no imports');
  }
}

function createWasmCallableInterfaceV1Executor({moduleCache = new ForeignWasmModuleCache()} = {}) {
  if (!moduleCache || typeof moduleCache.get !== 'function') {
    throw new TypeError('foreign WASM executor moduleCache must implement get(artifact)');
  }
  return Object.freeze({
    moduleCache,
    async execute({activation, code}, {images}) {
      if (!code || code.representation !== WASM_CALLABLE_INTERFACE_V1) {
        throw new TypeError(`foreign WASM executor requires ${WASM_CALLABLE_INTERFACE_V1}`);
      }
      assertBlockApplicationReceiver(activation, 'wasm-scalar-call/v0');
      if (activation.environment !== null) throw new TypeError('wasm-scalar-call/v0 does not accept a lexical environment');

      const {descriptor, implementation} = parseWasmCallableInterfaceArtifact(code);
      if (activation.arguments.length !== descriptor.parameters.length) {
        throw new TypeError(`foreign WASM callable expected ${descriptor.parameters.length} arguments, got ${activation.arguments.length}`);
      }
      const implementationArtifact = await images.getCodeArtifact(implementation.imageId, implementation.objectId);
      if (!implementationArtifact) {
        throw new TypeError(`foreign WASM implementation not found: ${implementation.imageId}/${implementation.objectId}`);
      }
      assertWasmBinaryArtifact(implementationArtifact);
      const module = await moduleCache.get(implementationArtifact);
      assertNoImports(module);

      const instance = new WebAssembly.Instance(module, {});
      const fn = instance.exports[descriptor.export];
      if (typeof fn !== 'function') {
        throw new TypeError(`foreign WASM callable export not found or not a function: ${descriptor.export}`);
      }
      const args = descriptor.parameters.map((type, index) => encodeScalar(
        activation.arguments[index],
        type,
        `foreign WASM argument ${index}`,
      ));
      const result = fn(...args);
      return decodeScalar(result, descriptor.result);
    },
  });
}

export {
  ForeignWasmModuleCache,
  createWasmCallableInterfaceV1Executor,
  decodeScalar as decodeForeignWasmScalar,
  encodeScalar as encodeForeignWasmScalar,
  foreignModuleCacheKey,
};
