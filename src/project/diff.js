import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {diffImageFrontiers, reconstructImageRecordsAtFrontier} from '../graph/diff.js';
import {isObjectRef} from '../value/index.js';
import {normalizeProjectDescriptor, normalizeProjectReleaseManifest} from './model.js';
import {PROJECT_SHAPE_ID, projectObjectId, readProjectDescriptor} from './working-state.js';

const PROJECT_DESCRIPTOR_DIFF_V1 = 'lagrange-project-descriptor-diff/v1';
const PROJECT_RELEASE_DIFF_V1 = 'lagrange-project-release-diff/v1';
const PROJECT_NONE_ID = 'lagrange-project/none/v1';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameRef(a, b) {
  if (a === null && b === null) return true;
  return isObjectRef(a) && isObjectRef(b) && a.imageId === b.imageId && a.objectId === b.objectId;
}

function diffProjectDescriptors(fromProject, toProject) {
  const from = normalizeProjectDescriptor(fromProject);
  const to = normalizeProjectDescriptor(toProject);

  const fromByKey = new Map(from.members.map((member) => [member.key, member]));
  const toByKey = new Map(to.members.map((member) => [member.key, member]));
  const allKeys = [...new Set([...fromByKey.keys(), ...toByKey.keys()])].sort(compareText);

  const addedMembers = [];
  const removedMembers = [];
  const modifiedMembers = [];
  const unchangedMembers = [];

  for (const key of allKeys) {
    const before = fromByKey.get(key) ?? null;
    const after = toByKey.get(key) ?? null;
    if (!before) {
      addedMembers.push(after);
    } else if (!after) {
      removedMembers.push(before);
    } else {
      const roleChanged = before.role !== after.role;
      const targetChanged = !sameRef(before.target, after.target);
      if (roleChanged || targetChanged) {
        modifiedMembers.push(
          Object.freeze({
            key,
            before,
            after,
            roleChanged,
            targetChanged,
          }),
        );
      } else {
        unchangedMembers.push(after);
      }
    }
  }

  const nameChanged = from.name !== to.name;
  const namespaceChanged = !sameRef(from.namespace, to.namespace);
  const identical =
    from.projectId === to.projectId &&
    !nameChanged &&
    !namespaceChanged &&
    addedMembers.length === 0 &&
    removedMembers.length === 0 &&
    modifiedMembers.length === 0;

  return Object.freeze({
    format: PROJECT_DESCRIPTOR_DIFF_V1,
    fromProjectId: from.projectId,
    toProjectId: to.projectId,
    fromName: from.name,
    toName: to.name,
    nameChanged,
    fromNamespace: from.namespace,
    toNamespace: to.namespace,
    namespaceChanged,
    identical,
    addedMembers: Object.freeze(addedMembers),
    removedMembers: Object.freeze(removedMembers),
    modifiedMembers: Object.freeze(modifiedMembers),
    unchangedMembers: Object.freeze(unchangedMembers),
  });
}

function diffProjectReleases(fromRelease, toRelease) {
  const from = normalizeProjectReleaseManifest(fromRelease);
  const to = normalizeProjectReleaseManifest(toRelease);

  const fromByKey = new Map(from.members.map((member) => [member.key, member]));
  const toByKey = new Map(to.members.map((member) => [member.key, member]));
  const allKeys = [...new Set([...fromByKey.keys(), ...toByKey.keys()])].sort(compareText);

  const addedMembers = [];
  const removedMembers = [];
  const modifiedMembers = [];
  const unchangedMembers = [];

  for (const key of allKeys) {
    const before = fromByKey.get(key) ?? null;
    const after = toByKey.get(key) ?? null;
    if (!before) {
      addedMembers.push(after);
    } else if (!after) {
      removedMembers.push(before);
    } else {
      const roleChanged = before.role !== after.role;
      const representationChanged = before.representation !== after.representation;
      const contentIdentityChanged = before.contentIdentity !== after.contentIdentity;
      if (roleChanged || representationChanged || contentIdentityChanged) {
        modifiedMembers.push(
          Object.freeze({
            key,
            before,
            after,
            roleChanged,
            representationChanged,
            contentIdentityChanged,
          }),
        );
      } else {
        unchangedMembers.push(after);
      }
    }
  }

  const depKey = (dep) => `${dep.projectId}\u0000${dep.releaseId}`;
  const fromDeps = new Map(from.dependencies.map((dep) => [depKey(dep), dep]));
  const toDeps = new Map(to.dependencies.map((dep) => [depKey(dep), dep]));
  const allDepKeys = [...new Set([...fromDeps.keys(), ...toDeps.keys()])].sort(compareText);
  const addedDependencies = [];
  const removedDependencies = [];
  for (const k of allDepKeys) {
    if (!fromDeps.has(k)) addedDependencies.push(toDeps.get(k));
    else if (!toDeps.has(k)) removedDependencies.push(fromDeps.get(k));
  }

  const profileChanged = from.profileId !== to.profileId;
  return Object.freeze({
    format: PROJECT_RELEASE_DIFF_V1,
    fromProjectId: from.projectId,
    toProjectId: to.projectId,
    fromReleaseId: from.releaseId,
    toReleaseId: to.releaseId,
    fromProfileId: from.profileId,
    toProfileId: to.profileId,
    profileChanged,
    identical: from.releaseId === to.releaseId,
    addedMembers: Object.freeze(addedMembers),
    removedMembers: Object.freeze(removedMembers),
    modifiedMembers: Object.freeze(modifiedMembers),
    unchangedMembers: Object.freeze(unchangedMembers),
    addedDependencies: Object.freeze(addedDependencies),
    removedDependencies: Object.freeze(removedDependencies),
  });
}

async function authorizedDiffProjects({
  images,
  fromImageId,
  fromProjectId,
  toImageId = fromImageId,
  toProjectId = fromProjectId,
  require,
} = {}) {
  requiredText(fromImageId, 'fromImageId');
  requiredText(fromProjectId, 'fromProjectId');
  requiredText(toImageId, 'toImageId');
  requiredText(toProjectId, 'toProjectId');
  if (typeof require !== 'function') {
    throw new TypeError('authorizedDiffProjects requires a require(demand) authority-check function');
  }

  const fromResource = objectResource(fromImageId, projectObjectId(fromProjectId));
  const toResource = objectResource(toImageId, projectObjectId(toProjectId));
  const resources =
    fromResource.imageId === toResource.imageId && fromResource.objectId === toResource.objectId
      ? [fromResource]
      : [fromResource, toResource].sort(
          (a, b) => compareText(a.imageId, b.imageId) || compareText(a.objectId, b.objectId),
        );

  for (const resource of resources) {
    require({operation: OBJECT_READ_OPERATION, resource});
  }

  const fromDescriptor = await readProjectDescriptor({
    images,
    imageId: fromImageId,
    projectId: fromProjectId,
  });
  const toDescriptor = await readProjectDescriptor({
    images,
    imageId: toImageId,
    projectId: toProjectId,
  });
  return diffProjectDescriptors(fromDescriptor, toDescriptor);
}

function assembleProjectDescriptorFromRecords(records, projectId) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const idRef = projectObjectId(projectId);
  const project = byId.get(idRef);
  if (
    !project ||
    project.kind !== 'object' ||
    !isObjectRef(project.shape) ||
    project.shape.objectId !== PROJECT_SHAPE_ID ||
    project.slots?.['project-id']?.value !== projectId
  ) {
    throw new TypeError(`durable Project not found at requested frontier: ${idRef}`);
  }
  const memberRefs = Array.isArray(project.indexed) ? project.indexed : [];
  const members = [];
  for (const ref of memberRefs) {
    const member = byId.get(ref.objectId);
    if (!member) {
      throw new TypeError(`durable Project member not found at requested frontier: ${ref.objectId}`);
    }
    members.push({
      key: member.slots['project-member-key'].value,
      role: member.slots['project-member-role'].value,
      target: member.slots['project-member-target'],
    });
  }
  const namespace = project.slots['project-namespace'];
  return normalizeProjectDescriptor({
    format: 'lagrange-project/v1',
    projectId: project.slots['project-id'].value,
    name: project.slots['project-name'].value,
    namespace: isObjectRef(namespace) && namespace.objectId !== PROJECT_NONE_ID ? namespace : null,
    members,
  });
}

async function diffProjectAtFrontiers({
  images,
  imageId,
  projectId,
  fromFrontier,
  toFrontier,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  const fromRecords = await reconstructImageRecordsAtFrontier({
    images,
    imageId,
    frontier: fromFrontier,
  });
  const toRecords = await reconstructImageRecordsAtFrontier({
    images,
    imageId,
    frontier: toFrontier,
  });
  const fromDescriptor = assembleProjectDescriptorFromRecords(fromRecords, projectId);
  const toDescriptor = assembleProjectDescriptorFromRecords(toRecords, projectId);
  const projectDiff = diffProjectDescriptors(fromDescriptor, toDescriptor);
  const frontierDiff = await diffImageFrontiers({
    images,
    imageId,
    fromFrontier,
    toFrontier,
  });
  return Object.freeze({
    projectDiff,
    frontierDiff,
  });
}

export {
  PROJECT_DESCRIPTOR_DIFF_V1,
  PROJECT_RELEASE_DIFF_V1,
  authorizedDiffProjects,
  diffProjectAtFrontiers,
  diffProjectDescriptors,
  diffProjectReleases,
};
