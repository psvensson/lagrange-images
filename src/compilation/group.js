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

function createCompilationGroup({policyId, targetRepresentation, members, options = {}} = {}) {
  const policy = requiredText(policyId, 'compilation group policyId');
  const target = normalizeRepresentation(targetRepresentation, 'compilation group target representation');
  if (!Array.isArray(members) || members.length === 0) throw new TypeError('compilation group members must be a non-empty array');
  const normalizedMembers = Object.freeze(members.map(normalizeMember));
  const seen = new Set();
  for (const member of normalizedMembers) {
    const key = `${member.imageId}\u0000${member.objectId}`;
    if (seen.has(key)) throw new TypeError(`duplicate compilation group member: ${member.imageId}/${member.objectId}`);
    seen.add(key);
  }
  const normalizedOptions = normalizeDerivationKeyMaterial(options, 'compilation group options');
  return Object.freeze({
    kind: COMPILATION_GROUP_KIND,
    policyId: policy,
    targetRepresentation: target,
    members: normalizedMembers,
    options: normalizedOptions,
  });
}

export {COMPILATION_GROUP_KIND, createCompilationGroup};
