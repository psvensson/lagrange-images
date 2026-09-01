import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {bytesToHex, utf8Encode} from '../support/portable-bytes.js';
import {canonicalizeValue, isObjectRef} from '../value/index.js';

const PROJECT_DESCRIPTOR_V1 = 'lagrange-project/v1';
const PROJECT_DEPLOYMENT_PROFILE_V1 = 'lagrange-project-deployment-profile/v1';
const PROJECT_RELEASE_MANIFEST_V1 = 'lagrange-project-release-manifest/v1';
const PROJECT_RELEASE_PROVENANCE_V1 = 'lagrange-project-release-provenance/v1';
const PROJECT_INSTALLATION_V1 = 'lagrange-project-installation/v1';
const PROJECT_RECONCILIATION_V1 = 'lagrange-project-reconciliation/v1';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain record`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(', ')}`);
  }
}

function normalizeRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

function normalizeUniqueTexts(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const normalized = values.map((value, index) => requiredText(value, `${label}[${index}]`));
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze([...normalized].sort(compareText));
}

function normalizeProjectMember(value, label = 'project member') {
  plainRecord(value, label);
  assertExactKeys(value, ['key', 'role', 'target'], label);
  return Object.freeze({
    key: requiredText(value.key, `${label}.key`),
    role: requiredText(value.role, `${label}.role`),
    target: normalizeRef(value.target, `${label}.target`),
  });
}

function normalizeProjectDescriptor(value) {
  plainRecord(value, 'Project descriptor');
  assertExactKeys(value, ['format', 'members', 'name', 'namespace', 'projectId'], 'Project descriptor');
  if (value.format !== PROJECT_DESCRIPTOR_V1) {
    throw new TypeError(`unsupported Project descriptor format: ${value.format}`);
  }
  if (!Array.isArray(value.members)) throw new TypeError('Project members must be an array');
  const members = value.members.map((member, index) => normalizeProjectMember(member, `Project members[${index}]`));
  members.sort((a, b) => compareText(a.key, b.key));
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member.key)) throw new TypeError(`duplicate Project member key: ${member.key}`);
    seen.add(member.key);
  }
  return Object.freeze({
    format: PROJECT_DESCRIPTOR_V1,
    projectId: requiredText(value.projectId, 'Project projectId'),
    name: requiredText(value.name, 'Project name'),
    namespace: value.namespace === null ? null : normalizeRef(value.namespace, 'Project namespace'),
    members: Object.freeze(members),
  });
}

function createProjectId() {
  return `project:${getDefaultCryptoProvider().uuid()}`;
}

function createProjectDescriptor({projectId = createProjectId(), name, namespace = null, members = []} = {}) {
  return normalizeProjectDescriptor({
    format: PROJECT_DESCRIPTOR_V1,
    projectId,
    name,
    namespace,
    members,
  });
}

function normalizeDeploymentProfile(value) {
  plainRecord(value, 'Project deployment profile');
  assertExactKeys(value, ['format', 'members', 'profileId', 'projectId'], 'Project deployment profile');
  if (value.format !== PROJECT_DEPLOYMENT_PROFILE_V1) {
    throw new TypeError(`unsupported Project deployment profile format: ${value.format}`);
  }
  const members = normalizeUniqueTexts(value.members, 'Project deployment profile members');
  if (members.length === 0) throw new TypeError('Project deployment profile must select at least one member');
  return Object.freeze({
    format: PROJECT_DEPLOYMENT_PROFILE_V1,
    projectId: requiredText(value.projectId, 'Project deployment profile projectId'),
    profileId: requiredText(value.profileId, 'Project deployment profile profileId'),
    members,
  });
}

function createDeploymentProfile({project, profileId, members} = {}) {
  const normalizedProject = normalizeProjectDescriptor(project);
  const profile = normalizeDeploymentProfile({
    format: PROJECT_DEPLOYMENT_PROFILE_V1,
    projectId: normalizedProject.projectId,
    profileId,
    members,
  });
  selectProjectMembers(normalizedProject, profile);
  return profile;
}

function selectProjectMembers(project, profile) {
  const normalizedProject = normalizeProjectDescriptor(project);
  const normalizedProfile = normalizeDeploymentProfile(profile);
  if (normalizedProject.projectId !== normalizedProfile.projectId) {
    throw new TypeError(
      `deployment profile projectId ${normalizedProfile.projectId} does not match Project ${normalizedProject.projectId}`,
    );
  }
  const byKey = new Map(normalizedProject.members.map((member) => [member.key, member]));
  return Object.freeze(normalizedProfile.members.map((key) => {
    const member = byKey.get(key);
    if (!member) throw new TypeError(`deployment profile selects unknown Project member: ${key}`);
    return member;
  }));
}

function normalizeReleaseMember(value, label = 'Project release member') {
  plainRecord(value, label);
  assertExactKeys(value, ['contentIdentity', 'key', 'representation', 'role'], label);
  return Object.freeze({
    key: requiredText(value.key, `${label}.key`),
    role: requiredText(value.role, `${label}.role`),
    representation: requiredText(value.representation, `${label}.representation`),
    contentIdentity: requiredText(value.contentIdentity, `${label}.contentIdentity`),
  });
}

function normalizeReleaseDependency(value, label = 'Project release dependency') {
  plainRecord(value, label);
  assertExactKeys(value, ['projectId', 'releaseId'], label);
  return Object.freeze({
    projectId: requiredText(value.projectId, `${label}.projectId`),
    releaseId: requiredText(value.releaseId, `${label}.releaseId`),
  });
}

function canonicalJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry));
  plainRecord(value, 'canonical JSON value');
  const result = {};
  for (const key of Object.keys(value).sort(compareText)) result[key] = canonicalJsonValue(value[key]);
  return result;
}

function releaseBody({projectId, profileId, members, dependencies}) {
  return {projectId, profileId, members, dependencies};
}

function releaseIdentity(body) {
  const canonical = JSON.stringify(canonicalJsonValue(body));
  return `sha256:${bytesToHex(getDefaultCryptoProvider().sha256(utf8Encode(canonical)))}`;
}

function normalizeReleaseMembers(values) {
  if (!Array.isArray(values)) throw new TypeError('Project release members must be an array');
  const members = values.map((member, index) => normalizeReleaseMember(member, `Project release members[${index}]`));
  members.sort((a, b) => compareText(a.key, b.key));
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member.key)) throw new TypeError(`duplicate Project release member key: ${member.key}`);
    seen.add(member.key);
  }
  if (members.length === 0) throw new TypeError('Project release must contain at least one member');
  return Object.freeze(members);
}

function normalizeReleaseDependencies(values, projectId) {
  if (!Array.isArray(values)) throw new TypeError('Project release dependencies must be an array');
  const dependencies = values.map((dependency, index) =>
    normalizeReleaseDependency(dependency, `Project release dependencies[${index}]`));
  dependencies.sort((a, b) =>
    compareText(a.projectId, b.projectId) || compareText(a.releaseId, b.releaseId));
  const seen = new Set();
  for (const dependency of dependencies) {
    const key = `${dependency.projectId}\u0000${dependency.releaseId}`;
    if (seen.has(key)) throw new TypeError(`duplicate Project release dependency: ${dependency.projectId}/${dependency.releaseId}`);
    seen.add(key);
    if (dependency.projectId === projectId) {
      throw new TypeError('Project release must not depend directly on another release of itself');
    }
  }
  return Object.freeze(dependencies);
}

function normalizeProjectReleaseManifest(value) {
  plainRecord(value, 'Project release manifest');
  assertExactKeys(value, ['dependencies', 'format', 'members', 'profileId', 'projectId', 'releaseId'], 'Project release manifest');
  if (value.format !== PROJECT_RELEASE_MANIFEST_V1) {
    throw new TypeError(`unsupported Project release manifest format: ${value.format}`);
  }
  const projectId = requiredText(value.projectId, 'Project release projectId');
  const profileId = requiredText(value.profileId, 'Project release profileId');
  const members = normalizeReleaseMembers(value.members);
  const dependencies = normalizeReleaseDependencies(value.dependencies, projectId);
  const expectedReleaseId = releaseIdentity(releaseBody({projectId, profileId, members, dependencies}));
  if (value.releaseId !== expectedReleaseId) {
    throw new TypeError(`Project releaseId does not match canonical content; expected ${expectedReleaseId}`);
  }
  return Object.freeze({format: PROJECT_RELEASE_MANIFEST_V1, projectId, profileId, releaseId: expectedReleaseId, members, dependencies});
}

function normalizeMaterializations(value, selectedMembers) {
  plainRecord(value, 'Project release materializations');
  const selectedKeys = new Set(selectedMembers.map(({key}) => key));
  for (const key of Object.keys(value)) {
    if (!selectedKeys.has(key)) throw new TypeError(`materialization supplied for unselected Project member: ${key}`);
  }
  const result = [];
  for (const member of selectedMembers) {
    const materialization = value[member.key];
    plainRecord(materialization, `materialization for Project member ${member.key}`);
    assertExactKeys(materialization, ['contentIdentity', 'representation'], `materialization for Project member ${member.key}`);
    result.push(Object.freeze({
      key: member.key,
      role: member.role,
      representation: requiredText(materialization.representation, `materialization ${member.key}.representation`),
      contentIdentity: requiredText(materialization.contentIdentity, `materialization ${member.key}.contentIdentity`),
    }));
  }
  return result;
}

function createProjectReleaseManifest({project, profile, materializations, dependencies = []} = {}) {
  const normalizedProject = normalizeProjectDescriptor(project);
  const normalizedProfile = normalizeDeploymentProfile(profile);
  const selectedMembers = selectProjectMembers(normalizedProject, normalizedProfile);
  const members = normalizeReleaseMembers(normalizeMaterializations(materializations, selectedMembers));
  const normalizedDependencies = normalizeReleaseDependencies(dependencies, normalizedProject.projectId);
  const body = releaseBody({projectId: normalizedProject.projectId, profileId: normalizedProfile.profileId, members, dependencies: normalizedDependencies});
  return normalizeProjectReleaseManifest({format: PROJECT_RELEASE_MANIFEST_V1, ...body, releaseId: releaseIdentity(body)});
}

function normalizeFrontierRevision(value, label) {
  let revision;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
    revision = BigInt(value);
  } else if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError(`${label} must be a non-negative integer`);
    revision = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    revision = BigInt(value);
  } else {
    throw new TypeError(`${label} must be a non-negative integer or decimal string`);
  }
  return revision.toString(10);
}

function normalizeFrontierMap(value) {
  plainRecord(value, 'Project release sourceFrontiers');
  const imageIds = Object.keys(value).sort(compareText);
  if (imageIds.length === 0) throw new TypeError('Project release sourceFrontiers must not be empty');
  const normalized = {};
  for (const imageId of imageIds) {
    requiredText(imageId, 'Project release frontier imageId');
    normalized[imageId] = normalizeFrontierRevision(value[imageId], `Project release frontier ${imageId}`);
  }
  return Object.freeze(normalized);
}

function normalizeMemberSource(value, label = 'Project release member source') {
  plainRecord(value, label);
  assertExactKeys(value, ['key', 'source'], label);
  return Object.freeze({key: requiredText(value.key, `${label}.key`), source: normalizeRef(value.source, `${label}.source`)});
}

function normalizeProjectReleaseProvenance(value) {
  plainRecord(value, 'Project release provenance');
  assertExactKeys(value, ['format', 'memberSources', 'projectId', 'releaseId', 'sourceFrontiers'], 'Project release provenance');
  if (value.format !== PROJECT_RELEASE_PROVENANCE_V1) {
    throw new TypeError(`unsupported Project release provenance format: ${value.format}`);
  }
  if (!Array.isArray(value.memberSources)) throw new TypeError('Project release memberSources must be an array');
  const memberSources = value.memberSources.map((source, index) => normalizeMemberSource(source, `Project release memberSources[${index}]`));
  memberSources.sort((a, b) => compareText(a.key, b.key));
  const seen = new Set();
  for (const source of memberSources) {
    if (seen.has(source.key)) throw new TypeError(`duplicate Project release member source key: ${source.key}`);
    seen.add(source.key);
  }
  if (memberSources.length === 0) throw new TypeError('Project release provenance must contain at least one member source');
  return Object.freeze({
    format: PROJECT_RELEASE_PROVENANCE_V1,
    projectId: requiredText(value.projectId, 'Project release provenance projectId'),
    releaseId: requiredText(value.releaseId, 'Project release provenance releaseId'),
    sourceFrontiers: normalizeFrontierMap(value.sourceFrontiers),
    memberSources: Object.freeze(memberSources),
  });
}

function createProjectReleaseProvenance({release, project, sourceFrontiers} = {}) {
  const normalizedRelease = normalizeProjectReleaseManifest(release);
  const normalizedProject = normalizeProjectDescriptor(project);
  if (normalizedProject.projectId !== normalizedRelease.projectId) {
    throw new TypeError('Project release provenance Project does not match release projectId');
  }
  const projectMembers = new Map(normalizedProject.members.map((member) => [member.key, member]));
  const memberSources = normalizedRelease.members.map((releaseMember) => {
    const member = projectMembers.get(releaseMember.key);
    if (!member) throw new TypeError(`release member is not present in provenance Project: ${releaseMember.key}`);
    if (member.role !== releaseMember.role) {
      throw new TypeError(`release member role no longer matches provenance Project: ${releaseMember.key}`);
    }
    return Object.freeze({key: releaseMember.key, source: member.target});
  });
  const frontiers = normalizeFrontierMap(sourceFrontiers);
  for (const {source} of memberSources) {
    if (!Object.hasOwn(frontiers, source.imageId)) {
      throw new TypeError(`Project release sourceFrontiers does not cover member source image: ${source.imageId}`);
    }
  }
  return normalizeProjectReleaseProvenance({
    format: PROJECT_RELEASE_PROVENANCE_V1,
    projectId: normalizedRelease.projectId,
    releaseId: normalizedRelease.releaseId,
    sourceFrontiers: frontiers,
    memberSources,
  });
}

function normalizeInstallationMember(value, targetImageId, label = 'Project installation member') {
  plainRecord(value, label);
  assertExactKeys(value, ['contentIdentity', 'key', 'representation', 'role', 'target'], label);
  const target = normalizeRef(value.target, `${label}.target`);
  if (target.imageId !== targetImageId) {
    throw new TypeError(`${label}.target must belong to installation target image ${targetImageId}`);
  }
  return Object.freeze({
    key: requiredText(value.key, `${label}.key`),
    role: requiredText(value.role, `${label}.role`),
    representation: requiredText(value.representation, `${label}.representation`),
    contentIdentity: requiredText(value.contentIdentity, `${label}.contentIdentity`),
    target,
  });
}

function normalizeProjectInstallation(value) {
  plainRecord(value, 'Project installation');
  assertExactKeys(value, ['format', 'members', 'projectId', 'releaseId', 'targetImageId'], 'Project installation');
  if (value.format !== PROJECT_INSTALLATION_V1) {
    throw new TypeError(`unsupported Project installation format: ${value.format}`);
  }
  const targetImageId = requiredText(value.targetImageId, 'Project installation targetImageId');
  if (!Array.isArray(value.members)) throw new TypeError('Project installation members must be an array');
  const members = value.members.map((member, index) => normalizeInstallationMember(member, targetImageId, `Project installation members[${index}]`));
  members.sort((a, b) => compareText(a.key, b.key));
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member.key)) throw new TypeError(`duplicate Project installation member key: ${member.key}`);
    seen.add(member.key);
  }
  if (members.length === 0) throw new TypeError('Project installation must contain at least one member');
  return Object.freeze({
    format: PROJECT_INSTALLATION_V1,
    projectId: requiredText(value.projectId, 'Project installation projectId'),
    releaseId: requiredText(value.releaseId, 'Project installation releaseId'),
    targetImageId,
    members: Object.freeze(members),
  });
}

function createProjectInstallation({release, targetImageId, targets} = {}) {
  const normalizedRelease = normalizeProjectReleaseManifest(release);
  plainRecord(targets, 'Project installation targets');
  const releaseKeys = new Set(normalizedRelease.members.map(({key}) => key));
  for (const key of Object.keys(targets)) {
    if (!releaseKeys.has(key)) throw new TypeError(`installation target supplied for unknown release member: ${key}`);
  }
  const members = normalizedRelease.members.map((releaseMember) => {
    if (!Object.hasOwn(targets, releaseMember.key)) {
      throw new TypeError(`missing installation target for release member: ${releaseMember.key}`);
    }
    return {
      key: releaseMember.key,
      role: releaseMember.role,
      representation: releaseMember.representation,
      contentIdentity: releaseMember.contentIdentity,
      target: targets[releaseMember.key],
    };
  });
  return normalizeProjectInstallation({format: PROJECT_INSTALLATION_V1, projectId: normalizedRelease.projectId, releaseId: normalizedRelease.releaseId, targetImageId, members});
}

function frozenMaterial(member) {
  return Object.freeze({role: member.role, representation: member.representation, contentIdentity: member.contentIdentity});
}

function planProjectUpgrade({installation, nextRelease} = {}) {
  const current = normalizeProjectInstallation(installation);
  const next = normalizeProjectReleaseManifest(nextRelease);
  if (current.projectId !== next.projectId) {
    throw new TypeError(`cannot upgrade Project ${current.projectId} with release for ${next.projectId}`);
  }
  const currentByKey = new Map(current.members.map((member) => [member.key, member]));
  const nextByKey = new Map(next.members.map((member) => [member.key, member]));
  const keys = [...new Set([...currentByKey.keys(), ...nextByKey.keys()])].sort(compareText);
  const actions = keys.map((key) => {
    const installed = currentByKey.get(key) ?? null;
    const desired = nextByKey.get(key) ?? null;
    if (!installed) return Object.freeze({kind: 'install', key, desired: frozenMaterial(desired)});
    if (!desired) {
      return Object.freeze({kind: 'detach', key, target: installed.target, installed: frozenMaterial(installed)});
    }
    if (
      installed.role === desired.role &&
      installed.representation === desired.representation &&
      installed.contentIdentity === desired.contentIdentity
    ) {
      return Object.freeze({kind: 'retain', key, target: installed.target, material: frozenMaterial(installed)});
    }
    return Object.freeze({kind: 'replace', key, target: installed.target, installed: frozenMaterial(installed), desired: frozenMaterial(desired)});
  });
  return Object.freeze({
    format: PROJECT_RECONCILIATION_V1,
    projectId: current.projectId,
    targetImageId: current.targetImageId,
    fromReleaseId: current.releaseId,
    toReleaseId: next.releaseId,
    actions: Object.freeze(actions),
  });
}

export {
  PROJECT_DEPLOYMENT_PROFILE_V1,
  PROJECT_DESCRIPTOR_V1,
  PROJECT_INSTALLATION_V1,
  PROJECT_RECONCILIATION_V1,
  PROJECT_RELEASE_MANIFEST_V1,
  PROJECT_RELEASE_PROVENANCE_V1,
  createDeploymentProfile,
  createProjectDescriptor,
  createProjectId,
  createProjectInstallation,
  createProjectReleaseManifest,
  createProjectReleaseProvenance,
  normalizeDeploymentProfile,
  normalizeProjectDescriptor,
  normalizeProjectInstallation,
  normalizeProjectReleaseManifest,
  normalizeProjectReleaseProvenance,
  planProjectUpgrade,
  selectProjectMembers,
};
