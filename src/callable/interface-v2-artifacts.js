import {randomUUID} from 'node:crypto';
import {textValue} from '../value/index.js';
import {
  CALLABLE_INTERFACE_V1,
  assertCallableValueType,
  assertImages,
  parseCallableInterfaceArtifact,
} from './interface-artifacts.js';
import {isCompositeType, normalizeTypeDeclarations, normalizeTypeExpression} from './type-grammar.js';
import {packCompositeValue, unpackCompositeValue} from './composite-codec.js';

// callable-interface/v2 adds the composite type grammar. v1 is frozen: its validator accepts
// exactly seven types and rejects everything else, so admitting composites under the /v1
// identity would let two runtimes read one durable representation differently.
//
// The version boundary tracks a semantic distinction rather than a schema change:
//   v1  every type maps directly to one canonical Value
//   v2  a type may need an interface-composite/v0 carrier
const CALLABLE_INTERFACE_V2 = 'callable-interface/v2';

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

function normalizeCallableInterfaceV2Descriptor(input) {
  exactKeys(input, ['abi', 'function', 'parameters', 'result', 'types'], 'callable interface v2 descriptor');
  if (input.abi !== CALLABLE_INTERFACE_V2) {
    throw new TypeError(`unsupported callable interface ABI: ${input.abi}`);
  }
  if (!Array.isArray(input.parameters)) throw new TypeError('callable interface parameters must be an array');
  const types = normalizeTypeDeclarations(input.types);
  const declaredNames = new Set(Object.keys(types));
  return Object.freeze({
    abi: CALLABLE_INTERFACE_V2,
    function: requiredText(input.function, 'callable interface function'),
    types,
    parameters: Object.freeze(input.parameters.map((type, index) => normalizeTypeExpression(
      type, declaredNames, `callable interface parameter ${index}`,
    ))),
    result: normalizeTypeExpression(input.result, declaredNames, 'callable interface result'),
  });
}

function createCallableInterfaceV2Content({functionName, parameters = [], result, types = {}} = {}) {
  return textValue(JSON.stringify(normalizeCallableInterfaceV2Descriptor({
    abi: CALLABLE_INTERFACE_V2,
    function: functionName,
    types,
    parameters,
    result,
  })));
}

function parseCallableInterfaceV2Artifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== CALLABLE_INTERFACE_V2) {
    throw new TypeError(`artifact must be ${CALLABLE_INTERFACE_V2}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('callable interface content must be a text Value');
  if ((artifact.dependencies ?? []).length !== 0) {
    throw new TypeError('callable interface must not declare dependencies; implementations bind to it, not the reverse');
  }
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('callable interface content must be valid JSON', {cause: error});
  }
  return normalizeCallableInterfaceV2Descriptor(decoded);
}

// Bindings accept either interface version. v1 descriptors gain an empty `types` map so a
// binding never has to branch on version to read a signature.
function parseAnyCallableInterfaceArtifact(artifact) {
  const representation = artifact?.representation;
  if (representation === CALLABLE_INTERFACE_V2) return parseCallableInterfaceV2Artifact(artifact);
  if (representation === CALLABLE_INTERFACE_V1) {
    return Object.freeze({...parseCallableInterfaceArtifact(artifact), types: Object.freeze({})});
  }
  throw new TypeError(`artifact must be ${CALLABLE_INTERFACE_V1} or ${CALLABLE_INTERFACE_V2}`);
}

// The Block edge is Values-only, so a composite arrives packed. Scalars keep their direct
// canonical mapping and are merely validated.
function assertCallableInterfaceValue(value, type, types, label) {
  if (!isCompositeType(type)) return assertCallableValueType(value, type, label);
  // Validating a composite means checking the envelope decodes against this exact type;
  // the packed Value itself is what continues to the lane or the caller.
  unpackCompositeValue(value, type, types, label);
  return value;
}

function assertCallableInterfaceArguments(descriptor, args, label = 'callable') {
  if (!Array.isArray(args)) throw new TypeError(`${label} arguments must be an array`);
  if (args.length !== descriptor.parameters.length) {
    throw new TypeError(`${label} expected ${descriptor.parameters.length} arguments, got ${args.length}`);
  }
  return descriptor.parameters.map((type, index) => assertCallableInterfaceValue(
    args[index], type, descriptor.types ?? {}, `${label} argument ${index}`,
  ));
}

async function installCallableInterfaceV2({
  images,
  imageId,
  functionName,
  parameters = [],
  result,
  types = {},
  interfaceId = randomUUID(),
  metadata = {},
} = {}) {
  const imageService = assertImages(images);
  requiredText(imageId, 'callable interface imageId');
  return await imageService.putCodeArtifact(imageId, {
    id: interfaceId,
    representation: CALLABLE_INTERFACE_V2,
    content: createCallableInterfaceV2Content({functionName, parameters, result, types}),
    dependencies: [],
    metadata,
  });
}

export {
  CALLABLE_INTERFACE_V2,
  assertCallableInterfaceArguments,
  assertCallableInterfaceValue,
  createCallableInterfaceV2Content,
  installCallableInterfaceV2,
  normalizeCallableInterfaceV2Descriptor,
  packCompositeValue,
  parseAnyCallableInterfaceArtifact,
  parseCallableInterfaceV2Artifact,
  unpackCompositeValue,
};
