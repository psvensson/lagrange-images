import {
  canonicalizeValue,
  isObjectRef,
  isReference,
} from '../value/index.js';
import {normalizeMetadata} from '../object/model.js';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(', ')}`);
  }
  return value;
}

function normalizeObjectRef(value, label) {
  const normalized = canonicalizeValue(value);
  if (!isObjectRef(normalized)) {
    throw new TypeError(`${label} must be an unpinned object ref`);
  }
  return normalized;
}

function normalizeReferenceList(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(values.map((value, index) => {
    const normalized = canonicalizeValue(value);
    if (!isReference(normalized)) throw new TypeError(`${label}[${index}] must be a reference`);
    return normalized;
  }));
}

function normalizeArtifactDependencies(values, {imageId = null, artifactId = null} = {}) {
  if (!Array.isArray(values)) throw new TypeError('code artifact dependencies must be an array');
  const seen = new Set();
  return Object.freeze(values.map((dependency, index) => {
    exactKeys(dependency, ['artifact', 'role'], `code artifact dependency ${index}`);
    const role = requiredText(dependency.role, `code artifact dependency ${index} role`);
    const artifact = normalizeObjectRef(dependency.artifact, `code artifact dependency ${index} artifact`);
    if (imageId !== null && artifactId !== null && artifact.imageId === imageId && artifact.objectId === artifactId) {
      throw new TypeError('code artifact cannot depend on itself');
    }
    const key = `${role}\u0000${artifact.imageId}\u0000${artifact.objectId}`;
    if (seen.has(key)) throw new TypeError(`duplicate code artifact dependency: ${role} ${artifact.imageId}/${artifact.objectId}`);
    seen.add(key);
    return Object.freeze({role, artifact});
  }));
}

function createCodeArtifactRecord({
  id,
  imageId,
  languageId = null,
  representation,
  content,
  dependencies = [],
  derivedFrom = [],
  metadata = {},
  updatedAt = null,
}) {
  const recordId = requiredText(id, 'code artifact id');
  const recordImageId = requiredText(imageId, 'code artifact imageId');
  return Object.freeze({
    kind: 'code-artifact',
    id: recordId,
    imageId: recordImageId,
    languageId: languageId === null ? null : requiredText(languageId, 'code artifact languageId'),
    representation: requiredText(representation, 'code artifact representation'),
    content: canonicalizeValue(content),
    dependencies: normalizeArtifactDependencies(dependencies, {imageId: recordImageId, artifactId: recordId}),
    derivedFrom: normalizeReferenceList(derivedFrom, 'code artifact derivedFrom'),
    metadata: normalizeMetadata(metadata, 'code artifact metadata'),
    updatedAt,
  });
}

function assertCodeArtifactRecord(record) {
  if (!record || record.kind !== 'code-artifact') throw new TypeError('record is not a code artifact');
  createCodeArtifactRecord(record);
  return record;
}

function normalizeBindings(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError('lexical environment bindings must be keyed by stable binding id');
  }
  const normalized = {};
  for (const [bindingId, binding] of Object.entries(bindings)) {
    requiredText(bindingId, 'binding id');
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new TypeError(`binding ${bindingId} must be an object`);
    }
    const keys = Object.keys(binding).sort();
    if (keys.length !== 2 || keys[0] !== 'name' || keys[1] !== 'value') {
      throw new TypeError(`binding ${bindingId} must contain exactly name and value`);
    }
    if (binding.name !== null && typeof binding.name !== 'string') {
      throw new TypeError(`binding ${bindingId} name must be text or null`);
    }
    normalized[bindingId] = Object.freeze({
      name: binding.name,
      value: canonicalizeValue(binding.value),
    });
  }
  return Object.freeze(normalized);
}

function createLexicalEnvironmentRecord({
  id,
  imageId,
  parent = null,
  bindings = {},
  metadata = {},
  updatedAt = null,
}) {
  const recordId = requiredText(id, 'lexical environment id');
  const recordImageId = requiredText(imageId, 'lexical environment imageId');
  const normalizedParent = parent === null ? null : normalizeObjectRef(parent, 'lexical environment parent');
  if (normalizedParent && normalizedParent.imageId === recordImageId && normalizedParent.objectId === recordId) {
    throw new TypeError('lexical environment cannot be its own parent');
  }
  return Object.freeze({
    kind: 'lexical-environment',
    id: recordId,
    imageId: recordImageId,
    parent: normalizedParent,
    bindings: normalizeBindings(bindings),
    metadata: normalizeMetadata(metadata, 'lexical environment metadata'),
    updatedAt,
  });
}

function assertLexicalEnvironmentRecord(record) {
  if (!record || record.kind !== 'lexical-environment') throw new TypeError('record is not a lexical environment');
  createLexicalEnvironmentRecord(record);
  return record;
}

function sameRef(left, right) {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.imageId === right.imageId && left.objectId === right.objectId;
}

function assertLexicalEnvironmentLayoutCompatible(current, next) {
  assertLexicalEnvironmentRecord(current);
  assertLexicalEnvironmentRecord(next);
  if (!sameRef(current.parent, next.parent)) {
    throw new TypeError('lexical environment parent is part of its stable layout');
  }
  const currentIds = Object.keys(current.bindings).sort();
  const nextIds = Object.keys(next.bindings).sort();
  if (currentIds.length !== nextIds.length || currentIds.some((id, index) => id !== nextIds[index])) {
    throw new TypeError('lexical environment binding ids are part of its stable layout');
  }
  return next;
}

function createBlockRecord({
  id,
  imageId,
  code,
  environment = null,
  metadata = {},
  updatedAt = null,
}) {
  return Object.freeze({
    kind: 'block',
    id: requiredText(id, 'block id'),
    imageId: requiredText(imageId, 'block imageId'),
    code: normalizeObjectRef(code, 'block code'),
    environment: environment === null ? null : normalizeObjectRef(environment, 'block environment'),
    metadata: normalizeMetadata(metadata, 'block metadata'),
    updatedAt,
  });
}

function assertBlockRecord(record) {
  if (!record || record.kind !== 'block') throw new TypeError('record is not a block');
  createBlockRecord(record);
  return record;
}

export {
  assertBlockRecord,
  assertCodeArtifactRecord,
  assertLexicalEnvironmentLayoutCompatible,
  assertLexicalEnvironmentRecord,
  createBlockRecord,
  createCodeArtifactRecord,
  createLexicalEnvironmentRecord,
  normalizeArtifactDependencies,
};
