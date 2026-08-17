import {TupleSet} from '../support/tuple-map.js';
import {canonicalizeValue, isObjectRef} from '../value/index.js';
import {normalizeDerivationKeyMaterial} from './derivation-cache.js';
import {normalizeRepresentation} from './compiler-registry.js';

const COMPILATION_GROUP_KIND = 'compilation-group';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeMember(value, index) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`compilation group member ${index} must be an unpinned object ref`);
  return ref;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function normalizeOptions(options) {
  normalizeDerivationKeyMaterial(options, 'compilation group options');
  return deepFreeze(structuredClone(options));
}

function createCompilationGroup({policyId, targetRepresentation, members, options = {}} = {}) {
  const policy = requiredText(policyId, 'compilation group policyId');
  const target = normalizeRepresentation(targetRepresentation, 'compilation group target representation');
  if (!Array.isArray(members) || members.length === 0) throw new TypeError('compilation group members must be a non-empty array');
  const normalizedMembers = Object.freeze(members.map(normalizeMember));
  const seen = new TupleSet(2);
  for (const member of normalizedMembers) {
    const key = [member.imageId, member.objectId];
    if (seen.has(key)) throw new TypeError(`duplicate compilation group member: ${member.imageId}/${member.objectId}`);
    seen.add(key);
  }
  return Object.freeze({
    kind: COMPILATION_GROUP_KIND,
    policyId: policy,
    targetRepresentation: target,
    members: normalizedMembers,
    options: normalizeOptions(options),
  });
}

export {COMPILATION_GROUP_KIND, createCompilationGroup};
