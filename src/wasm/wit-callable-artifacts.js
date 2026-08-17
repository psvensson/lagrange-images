import {randomUUID} from 'node:crypto';
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/index.js';

const WASM_WIT_CALLABLE_INTERFACE_V1 = 'wasm-wit-callable-interface/v1';
const WASM_COMPONENT_V1 = 'wasm-component/v1';
const WASM_WIT_IMPLEMENTATION_DEPENDENCY_ROLE = 'implementation';

const WIT_TYPES = Object.freeze(['bool', 's32', 's64', 'f32', 'f64', 'string', 'list<u8>']);

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

function normalizeWitType(value, label) {
  const type = requiredText(value, label);
  if (!WIT_TYPES.includes(type)) {
    throw new TypeError(`${label} must be one of ${WIT_TYPES.join(', ')}`);
  }
  return type;
}

function normalizeWitInterface(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('WIT callable interface must be an object');
  }
  const allowed = ['abi', 'function', 'parameters', 'result'];
  const actual = Object.keys(input).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`WIT callable interface must contain exactly ${expected.join(', ')}`);
  }
  if (input.abi !== 'wit-canonical-call/v0') {
    throw new TypeError(`unsupported WIT callable ABI: ${input.abi}`);
  }
  if (!Array.isArray(input.parameters)) throw new TypeError('WIT callable interface parameters must be an array');
  return Object.freeze({
    abi: 'wit-canonical-call/v0',
    function: requiredText(input.function, 'WIT callable function'),
    parameters: Object.freeze(input.parameters.map((type, index) => normalizeWitType(type, `WIT callable parameter ${index}`))),
    result: normalizeWitType(input.result, 'WIT callable result'),
  });
}

function createWitCallableInterfaceContent({functionName, parameters = [], result} = {}) {
  const normalized = normalizeWitInterface({
    abi: 'wit-canonical-call/v0',
    function: functionName,
    parameters,
    result,
  });
  return textValue(JSON.stringify(normalized));
}

function parseWitCallableInterfaceArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_WIT_CALLABLE_INTERFACE_V1) {
    throw new TypeError(`artifact must be ${WASM_WIT_CALLABLE_INTERFACE_V1}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('WIT callable interface content must be a text Value');
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('WIT callable interface content must be valid JSON', {cause: error});
  }
  const descriptor = normalizeWitInterface(decoded);
  const dependencies = artifact.dependencies ?? [];
  if (dependencies.length !== 1 || dependencies[0].role !== WASM_WIT_IMPLEMENTATION_DEPENDENCY_ROLE) {
    throw new TypeError(`WIT callable interface must have exactly one ${WASM_WIT_IMPLEMENTATION_DEPENDENCY_ROLE} dependency`);
  }
  return Object.freeze({
    descriptor,
    implementation: normalizeObjectRef(dependencies[0].artifact, 'WIT callable implementation'),
  });
}

function assertWasmComponentArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_COMPONENT_V1) {
    throw new TypeError(`artifact must be ${WASM_COMPONENT_V1}`);
  }
  if (artifact.content?.kind !== 'bytes') throw new TypeError('WASM Component content must be a bytes Value');
  return artifact;
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getCodeArtifact', 'putCodeArtifact', 'putBlock']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

async function installWasmWitCallable({
  images,
  component,
  imageId = null,
  functionName,
  parameters = [],
  result,
  interfaceId = randomUUID(),
  blockId = randomUUID(),
  interfaceMetadata = {},
  blockMetadata = {},
} = {}) {
  const imageService = assertImages(images);
  const implementationRef = normalizeObjectRef(component, 'WIT callable implementation');
  const implementation = await imageService.getCodeArtifact(implementationRef.imageId, implementationRef.objectId);
  if (!implementation) {
    throw new TypeError(`WIT callable implementation not found: ${implementationRef.imageId}/${implementationRef.objectId}`);
  }
  assertWasmComponentArtifact(implementation);
  const targetImageId = imageId ?? implementationRef.imageId;
  requiredText(targetImageId, 'WIT callable imageId');

  const interfaceArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: interfaceId,
    representation: WASM_WIT_CALLABLE_INTERFACE_V1,
    content: createWitCallableInterfaceContent({functionName, parameters, result}),
    dependencies: [{role: WASM_WIT_IMPLEMENTATION_DEPENDENCY_ROLE, artifact: implementationRef}],
    metadata: interfaceMetadata,
  });
  const block = await imageService.putBlock(targetImageId, {
    id: blockId,
    code: objectRef(targetImageId, interfaceArtifact.id),
    environment: null,
    metadata: blockMetadata,
  });
  return Object.freeze({interfaceArtifact, block});
}

export {
  WASM_COMPONENT_V1,
  WASM_WIT_CALLABLE_INTERFACE_V1,
  WASM_WIT_IMPLEMENTATION_DEPENDENCY_ROLE,
  WIT_TYPES,
  assertWasmComponentArtifact,
  createWitCallableInterfaceContent,
  installWasmWitCallable,
  normalizeWitInterface,
  parseWitCallableInterfaceArtifact,
};
