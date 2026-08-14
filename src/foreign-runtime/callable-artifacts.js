import {randomUUID} from 'node:crypto';
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/index.js';

const FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1 = 'foreign-runtime-callable-interface/v1';
const FOREIGN_RUNTIME_VALUE_CALL_V0 = 'foreign-runtime-value-call/v0';
const FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE = 'runtime-definition';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

function normalizeJsonData(value, path = 'foreign runtime callable interface', seen = new WeakSet()) {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path} numbers must be finite`);
      return value;
    case 'object': {
      if (seen.has(value)) throw new TypeError(`${path} must not contain cycles`);
      seen.add(value);
      if (Array.isArray(value)) {
        const normalized = Object.freeze(value.map((entry, index) => normalizeJsonData(entry, `${path}[${index}]`, seen)));
        seen.delete(value);
        return normalized;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} objects must be plain records`);
      }
      const normalized = {};
      for (const key of Object.keys(value).sort()) {
        normalized[key] = normalizeJsonData(value[key], `${path}.${key}`, seen);
      }
      seen.delete(value);
      return Object.freeze(normalized);
    }
    default:
      throw new TypeError(`${path} contains unsupported ${typeof value}; v0 interface data must be JSON-compatible`);
  }
}

function normalizeInterface(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('foreign runtime callable interface must be a plain record');
  }
  return normalizeJsonData(value);
}

function normalizeArgumentCount(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError('foreign runtime callable argumentCount must be a non-negative integer');
  }
  return value;
}

function normalizeForeignRuntimeCallableDescriptor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('foreign runtime callable descriptor must be an object');
  }
  const expected = ['abi', 'argumentCount', 'interface'];
  const actual = Object.keys(input).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`foreign runtime callable descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (input.abi !== FOREIGN_RUNTIME_VALUE_CALL_V0) {
    throw new TypeError(`unsupported foreign runtime callable ABI: ${input.abi}`);
  }
  return Object.freeze({
    abi: FOREIGN_RUNTIME_VALUE_CALL_V0,
    argumentCount: normalizeArgumentCount(input.argumentCount),
    interface: normalizeInterface(input.interface),
  });
}

function createForeignRuntimeCallableContent({interface: callableInterface, argumentCount} = {}) {
  const descriptor = normalizeForeignRuntimeCallableDescriptor({
    abi: FOREIGN_RUNTIME_VALUE_CALL_V0,
    argumentCount,
    interface: callableInterface,
  });
  return textValue(JSON.stringify(descriptor));
}

function parseForeignRuntimeCallableArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1) {
    throw new TypeError(`artifact must be ${FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1}`);
  }
  if (artifact.content?.kind !== 'text') {
    throw new TypeError('foreign runtime callable interface content must be a text Value');
  }
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('foreign runtime callable interface content must be valid JSON', {cause: error});
  }
  const descriptor = normalizeForeignRuntimeCallableDescriptor(decoded);
  const dependencies = artifact.dependencies ?? [];
  if (dependencies.length !== 1 || dependencies[0].role !== FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE) {
    throw new TypeError(`foreign runtime callable interface must have exactly one ${FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE} dependency`);
  }
  return Object.freeze({
    descriptor,
    runtimeDefinition: normalizeObjectRef(
      dependencies[0].artifact,
      'foreign runtime callable runtime definition',
    ),
  });
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getCodeArtifact', 'putCodeArtifact', 'putBlock']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

async function installForeignRuntimeCallable({
  images,
  runtimeDefinition,
  imageId = null,
  interface: callableInterface,
  argumentCount,
  interfaceId = randomUUID(),
  blockId = randomUUID(),
  interfaceMetadata = {},
  blockMetadata = {},
} = {}) {
  const imageService = assertImages(images);
  const definitionRef = normalizeObjectRef(runtimeDefinition, 'foreign runtime definition');
  const definition = await imageService.getCodeArtifact(definitionRef.imageId, definitionRef.objectId);
  if (!definition) {
    throw new TypeError(`foreign runtime definition not found: ${definitionRef.imageId}/${definitionRef.objectId}`);
  }
  const targetImageId = imageId ?? definitionRef.imageId;
  requiredText(targetImageId, 'foreign runtime callable imageId');

  const interfaceArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: interfaceId,
    representation: FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1,
    content: createForeignRuntimeCallableContent({interface: callableInterface, argumentCount}),
    dependencies: [{role: FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE, artifact: definitionRef}],
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
  FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1,
  FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE,
  FOREIGN_RUNTIME_VALUE_CALL_V0,
  createForeignRuntimeCallableContent,
  installForeignRuntimeCallable,
  normalizeForeignRuntimeCallableDescriptor,
  parseForeignRuntimeCallableArtifact,
};
