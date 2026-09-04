import {randomUUID} from 'node:crypto';
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/index.js';
import {WASM_BINARY_V1, WASM_IMPLEMENTATION_DEPENDENCY_ROLE, assertWasmBinaryArtifact} from '../code/wasm-artifacts.js';

const WASM_CALLABLE_INTERFACE_V1 = 'wasm-callable-interface/v1';
const WASM_SCALAR_CALL_V0 = 'wasm-scalar-call/v0';
const WASM_SCALAR_TYPES = Object.freeze(['boolean', 'i32', 'i64', 'f32', 'f64']);

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

function normalizeScalarType(value, label) {
  const type = requiredText(value, label);
  if (!WASM_SCALAR_TYPES.includes(type)) {
    throw new TypeError(`${label} must be one of ${WASM_SCALAR_TYPES.join(', ')}`);
  }
  return type;
}

function normalizeScalarInterface(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('WASM callable interface must be an object');
  }
  const allowed = ['abi', 'export', 'parameters', 'result'];
  const actual = Object.keys(input).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`WASM callable interface must contain exactly ${expected.join(', ')}`);
  }
  if (input.abi !== WASM_SCALAR_CALL_V0) {
    throw new TypeError(`unsupported foreign WASM callable ABI: ${input.abi}`);
  }
  if (!Array.isArray(input.parameters)) throw new TypeError('WASM callable interface parameters must be an array');
  return Object.freeze({
    abi: WASM_SCALAR_CALL_V0,
    export: requiredText(input.export, 'WASM callable export'),
    parameters: Object.freeze(input.parameters.map((type, index) => normalizeScalarType(type, `WASM callable parameter ${index}`))),
    result: normalizeScalarType(input.result, 'WASM callable result'),
  });
}

function createWasmScalarInterfaceContent({exportName, parameters = [], result} = {}) {
  const normalized = normalizeScalarInterface({
    abi: WASM_SCALAR_CALL_V0,
    export: exportName,
    parameters,
    result,
  });
  return textValue(JSON.stringify(normalized));
}

function parseWasmCallableInterfaceArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_CALLABLE_INTERFACE_V1) {
    throw new TypeError(`artifact must be ${WASM_CALLABLE_INTERFACE_V1}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('WASM callable interface content must be a text Value');
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('WASM callable interface content must be valid JSON', {cause: error});
  }
  const descriptor = normalizeScalarInterface(decoded);
  const dependencies = artifact.dependencies ?? [];
  if (dependencies.length !== 1 || dependencies[0].role !== WASM_IMPLEMENTATION_DEPENDENCY_ROLE) {
    throw new TypeError(`WASM callable interface must have exactly one ${WASM_IMPLEMENTATION_DEPENDENCY_ROLE} dependency`);
  }
  return Object.freeze({
    descriptor,
    implementation: normalizeObjectRef(dependencies[0].artifact, 'WASM callable implementation'),
  });
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getCodeArtifact', 'putCodeArtifact', 'putBlock']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

async function installWasmScalarCallable({
  images,
  wasm,
  imageId = null,
  exportName,
  parameters = [],
  result,
  interfaceId = randomUUID(),
  blockId = randomUUID(),
  interfaceMetadata = {},
  blockMetadata = {},
} = {}) {
  const imageService = assertImages(images);
  const implementationRef = normalizeObjectRef(wasm, 'WASM implementation');
  const implementation = await imageService.getCodeArtifact(implementationRef.imageId, implementationRef.objectId);
  if (!implementation) {
    throw new TypeError(`WASM implementation not found: ${implementationRef.imageId}/${implementationRef.objectId}`);
  }
  assertWasmBinaryArtifact(implementation);
  const targetImageId = imageId ?? implementationRef.imageId;
  requiredText(targetImageId, 'WASM callable imageId');

  const interfaceArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: interfaceId,
    representation: WASM_CALLABLE_INTERFACE_V1,
    content: createWasmScalarInterfaceContent({exportName, parameters, result}),
    dependencies: [{role: WASM_IMPLEMENTATION_DEPENDENCY_ROLE, artifact: implementationRef}],
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
  WASM_BINARY_V1,
  WASM_CALLABLE_INTERFACE_V1,
  WASM_IMPLEMENTATION_DEPENDENCY_ROLE,
  WASM_SCALAR_CALL_V0,
  WASM_SCALAR_TYPES,
  assertWasmBinaryArtifact,
  createWasmScalarInterfaceContent,
  installWasmScalarCallable,
  normalizeScalarInterface,
  parseWasmCallableInterfaceArtifact,
};
