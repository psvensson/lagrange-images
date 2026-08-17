import {
  VALUE_KIND,
  booleanValue,
  bytesFromBase64,
  bytesValue,
  canonicalizeValue,
  float64ToNumber,
  float64Value,
  integerValue,
  textValue,
} from '../value/index.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {
  WASM_WIT_CALLABLE_INTERFACE_V1,
  assertWasmComponentArtifact,
  parseWitCallableInterfaceArtifact,
} from './wit-callable-artifacts.js';

function encodeWitValue(value, type, label) {
  const normalized = canonicalizeValue(value);
  switch (type) {
    case 'bool':
      if (normalized.kind !== VALUE_KIND.BOOLEAN) throw new TypeError(`${label} must be a boolean Value`);
      return normalized.value;
    case 's32': {
      if (normalized.kind !== VALUE_KIND.INTEGER) throw new TypeError(`${label} must be an integer Value`);
      const n = BigInt(normalized.value);
      if (n < -(1n << 31n) || n > (1n << 31n) - 1n) throw new RangeError(`${label} is outside s32 range`);
      return Number(n);
    }
    case 's64': {
      if (normalized.kind !== VALUE_KIND.INTEGER) throw new TypeError(`${label} must be an integer Value`);
      const n = BigInt(normalized.value);
      if (n < -(1n << 63n) || n > (1n << 63n) - 1n) throw new RangeError(`${label} is outside s64 range`);
      return n;
    }
    case 'f32':
      if (normalized.kind !== VALUE_KIND.FLOAT64) throw new TypeError(`${label} must be a float64 Value`);
      return Math.fround(float64ToNumber(normalized));
    case 'f64':
      if (normalized.kind !== VALUE_KIND.FLOAT64) throw new TypeError(`${label} must be a float64 Value`);
      return float64ToNumber(normalized);
    case 'string':
      if (normalized.kind !== VALUE_KIND.TEXT) throw new TypeError(`${label} must be a text Value`);
      return normalized.value;
    case 'list<u8>':
      if (normalized.kind !== VALUE_KIND.BYTES) throw new TypeError(`${label} must be a bytes Value`);
      return Buffer.from(normalized.base64, 'base64');
    default:
      throw new TypeError(`unsupported WIT type: ${type}`);
  }
}

function decodeWitValue(raw, type) {
  switch (type) {
    case 'bool':
      if (typeof raw !== 'boolean') throw new TypeError('WIT bool result must be a boolean');
      return booleanValue(raw);
    case 's32':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new TypeError('WIT s32 result must be an integer number');
      return integerValue(raw);
    case 's64':
      if (typeof raw !== 'bigint') throw new TypeError('WIT s64 result must be a bigint');
      return integerValue(raw);
    case 'f32':
    case 'f64':
      if (typeof raw !== 'number') throw new TypeError(`WIT ${type} result must be a number`);
      return float64Value(raw);
    case 'string':
      if (typeof raw !== 'string') throw new TypeError('WIT string result must be a string');
      return textValue(raw);
    case 'list<u8>': {
      if (!(raw instanceof Uint8Array) && !Array.isArray(raw)) {
        throw new TypeError('WIT list<u8> result must be a Uint8Array or array');
      }
      return bytesValue(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
    }
    default:
      throw new TypeError(`unsupported WIT type: ${type}`);
  }
}

function createWasmWitCallableInterfaceV1Executor({componentRuntime = null} = {}) {
  if (componentRuntime !== null && (typeof componentRuntime !== 'object' || typeof componentRuntime.invoke !== 'function')) {
    throw new TypeError('WIT callable executor componentRuntime must implement invoke(component, function, args)');
  }
  return Object.freeze({
    componentRuntime,
    async execute({activation, code}, {images}) {
      if (!code || code.representation !== WASM_WIT_CALLABLE_INTERFACE_V1) {
        throw new TypeError(`WIT callable executor requires ${WASM_WIT_CALLABLE_INTERFACE_V1}`);
      }
      assertBlockApplicationReceiver(activation, 'wit-canonical-call/v0');
      if (activation.environment !== null) throw new TypeError('wit-canonical-call/v0 does not accept a lexical environment');

      const {descriptor, implementation} = parseWitCallableInterfaceArtifact(code);
      if (activation.arguments.length !== descriptor.parameters.length) {
        throw new TypeError(`WIT callable expected ${descriptor.parameters.length} arguments, got ${activation.arguments.length}`);
      }
      const implementationArtifact = await images.getCodeArtifact(implementation.imageId, implementation.objectId);
      if (!implementationArtifact) {
        throw new TypeError(`WIT callable implementation not found: ${implementation.imageId}/${implementation.objectId}`);
      }
      assertWasmComponentArtifact(implementationArtifact);

      const args = descriptor.parameters.map((type, index) => encodeWitValue(
        activation.arguments[index],
        type,
        `WIT callable argument ${index}`,
      ));

      let raw;
      if (componentRuntime) {
        raw = await componentRuntime.invoke(implementationArtifact, descriptor.function, args);
      } else {
        throw new TypeError('no Component runtime registered; install a Component toolchain provider to execute WIT callables');
      }

      return decodeWitValue(raw, descriptor.result);
    },
  });
}

export {
  decodeWitValue,
  encodeWitValue,
  createWasmWitCallableInterfaceV1Executor,
};
