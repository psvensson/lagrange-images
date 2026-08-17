import {randomUUID} from 'node:crypto';
import {VALUE_KIND, canonicalizeValue, float64ToNumber, float64Value, textValue} from '../value/index.js';

// A callable interface describes a callable shape and nothing else. It deliberately
// carries no reference to a WASM module, a foreign runtime, a provider or a capability:
// those belong to an implementation binding, which depends on this artifact. One
// interface artifact is meant to be shared by every lane that implements it.
const CALLABLE_INTERFACE_V1 = 'callable-interface/v1';

// The type language is WIT's, spelled the way WIT spells it, so the descriptor can be
// projected to a real WIT interface without a translation table. It is kept tiny on
// purpose: no lists (beyond list<u8> for bytes), records, tuples, options, results,
// refs or multiple results. Those need a separate decision about how structured
// interface values relate to the canonical Value model.
const CALLABLE_TYPES = Object.freeze(['bool', 's32', 's64', 'f32', 'f64', 'string', 'list<u8>']);

const S32_MIN = -(2n ** 31n);
const S32_MAX = 2n ** 31n - 1n;
const S64_MIN = -(2n ** 63n);
const S64_MAX = 2n ** 63n - 1n;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
  return value;
}

function normalizeCallableType(value, label) {
  const type = requiredText(value, label);
  if (!CALLABLE_TYPES.includes(type)) throw new TypeError(`${label} must be one of ${CALLABLE_TYPES.join(', ')}`);
  return type;
}

function normalizeCallableInterfaceDescriptor(input) {
  exactKeys(input, ['abi', 'function', 'parameters', 'result'], 'callable interface descriptor');
  if (input.abi !== CALLABLE_INTERFACE_V1) {
    throw new TypeError(`unsupported callable interface ABI: ${input.abi}`);
  }
  if (!Array.isArray(input.parameters)) throw new TypeError('callable interface parameters must be an array');
  return Object.freeze({
    abi: CALLABLE_INTERFACE_V1,
    function: requiredText(input.function, 'callable interface function'),
    parameters: Object.freeze(input.parameters.map((type, index) => normalizeCallableType(type, `callable interface parameter ${index}`))),
    result: normalizeCallableType(input.result, 'callable interface result'),
  });
}

function createCallableInterfaceContent({functionName, parameters = [], result} = {}) {
  return textValue(JSON.stringify(normalizeCallableInterfaceDescriptor({
    abi: CALLABLE_INTERFACE_V1,
    function: functionName,
    parameters,
    result,
  })));
}

function parseCallableInterfaceArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== CALLABLE_INTERFACE_V1) {
    throw new TypeError(`artifact must be ${CALLABLE_INTERFACE_V1}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('callable interface content must be a text Value');
  // An interface that depended on anything would no longer be implementation-independent.
  if ((artifact.dependencies ?? []).length !== 0) {
    throw new TypeError('callable interface must not declare dependencies; implementations bind to it, not the reverse');
  }
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('callable interface content must be valid JSON', {cause: error});
  }
  return normalizeCallableInterfaceDescriptor(decoded);
}

// Type checking against the shared interface, used by every lane. Lowering a Value into
// a lane's own representation is the binding's job; agreeing on what is legal is not.
function assertCallableValueType(value, type, label) {
  const normalized = canonicalizeValue(value);
  switch (type) {
    case 'bool':
      if (normalized.kind !== VALUE_KIND.BOOLEAN) throw new TypeError(`${label} must be a boolean Value for bool`);
      return normalized;
    case 's32':
    case 's64': {
      if (normalized.kind !== VALUE_KIND.INTEGER) throw new TypeError(`${label} must be an integer Value for ${type}`);
      const n = BigInt(normalized.value);
      const [min, max] = type === 's32' ? [S32_MIN, S32_MAX] : [S64_MIN, S64_MAX];
      if (n < min || n > max) throw new RangeError(`${label} is outside ${type} range`);
      return normalized;
    }
    case 'f64':
      if (normalized.kind !== VALUE_KIND.FLOAT64) throw new TypeError(`${label} must be a float64 Value for f64`);
      return normalized;
    case 'f32': {
      if (normalized.kind !== VALUE_KIND.FLOAT64) throw new TypeError(`${label} must be a float64 Value for f32`);
      // f32 at this boundary means "a float64 restricted to f32 precision". Rounding here,
      // in the shared interface, is what makes the lanes agree by construction instead of
      // by each lane happening to round the same way. A lane that rounds again is a no-op.
      return float64Value(Math.fround(float64ToNumber(normalized)));
    }
    case 'string':
      if (normalized.kind !== VALUE_KIND.TEXT) throw new TypeError(`${label} must be a text Value for string`);
      return normalized;
    case 'list<u8>':
      if (normalized.kind !== VALUE_KIND.BYTES) throw new TypeError(`${label} must be a bytes Value for list<u8>`);
      return normalized;
    default:
      throw new TypeError(`unsupported callable type: ${type}`);
  }
}

// Canonical Value -> the host representation the composite codec and lane adapters expect.
// Shared so every lane converts leaves identically; a second copy is a place for them to drift.
function canonicalToHostLeaf(value, type, label) {
  const normalized = assertCallableValueType(value, type, label);
  switch (type) {
    case 'bool': return normalized.value;
    case 's32': return Number(BigInt(normalized.value));
    case 's64': return BigInt(normalized.value);
    case 'f32': return Math.fround(float64ToNumber(normalized));
    case 'f64': return float64ToNumber(normalized);
    case 'string': return normalized.value;
    case 'list<u8>': return new Uint8Array(Buffer.from(normalized.base64, 'base64'));
    default: throw new TypeError(`${label} has unsupported leaf type ${type}`);
  }
}

function assertCallableArguments(descriptor, args, label = 'callable') {
  if (!Array.isArray(args)) throw new TypeError(`${label} arguments must be an array`);
  if (args.length !== descriptor.parameters.length) {
    throw new TypeError(`${label} expected ${descriptor.parameters.length} arguments, got ${args.length}`);
  }
  return descriptor.parameters.map((type, index) => assertCallableValueType(args[index], type, `${label} argument ${index}`));
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getCodeArtifact', 'putCodeArtifact', 'putBlock']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

async function installCallableInterface({
  images,
  imageId,
  functionName,
  parameters = [],
  result,
  interfaceId = randomUUID(),
  metadata = {},
} = {}) {
  const imageService = assertImages(images);
  requiredText(imageId, 'callable interface imageId');
  return await imageService.putCodeArtifact(imageId, {
    id: interfaceId,
    representation: CALLABLE_INTERFACE_V1,
    content: createCallableInterfaceContent({functionName, parameters, result}),
    dependencies: [],
    metadata,
  });
}

export {
  CALLABLE_INTERFACE_V1,
  CALLABLE_TYPES,
  assertCallableArguments,
  assertCallableValueType,
  canonicalToHostLeaf,
  assertImages,
  createCallableInterfaceContent,
  installCallableInterface,
  normalizeCallableInterfaceDescriptor,
  parseCallableInterfaceArtifact,
};
