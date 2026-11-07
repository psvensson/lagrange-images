import {OBJECT_READ_OPERATION, OBJECT_WRITE_OPERATION, objectResource} from '../authority/object-resource.js';
import {
  advanceBranch,
  branchObjectId,
  createBranch,
  diffBranches,
  getBranch,
  mergeBranches,
} from '../graph/branches.js';
import {reconstructImageRecordsAtFrontier} from '../graph/diff.js';
import {rehomeRecordToImage} from '../graph/merge.js';
import {parseObjectVersionToken} from '../object/version-token.js';
import {isObjectRef} from '../value/index.js';
import {diffProjectDescriptors} from './diff.js';
import {mergeProjectDescriptors} from './merge.js';
import {normalizeProjectDescriptor} from './model.js';
import {PROJECT_SHAPE_ID, projectObjectId} from './working-state.js';

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

function requireAuthorityCallback(require) {
  if (typeof require !== 'function') {
    throw new TypeError('require must be an authority check function');
  }
  return require;
}

function invokeRequire(require, operation, resource) {
  if (require.length >= 2) {
    return require(operation, resource);
  }
  return require({operation, resource});
}

function normalizeRevisionNumber(frontierOrRevision, label = 'frontier revision') {
  const raw =
    typeof frontierOrRevision === 'number' || typeof frontierOrRevision === 'bigint'
      ? Number(frontierOrRevision)
      : frontierOrRevision && typeof frontierOrRevision === 'object'
        ? Object.hasOwn(frontierOrRevision, 'revision')
          ? Number(frontierOrRevision.revision)
          : Object.hasOwn(frontierOrRevision, 'frontier')
            ? Number(frontierOrRevision.frontier)
            : Number.NaN
        : Number.NaN;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return raw;
}

function assembleProjectDescriptorFromRecords(records, projectId) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const idRef = projectObjectId(projectId);
  const project = byId.get(idRef);
  if (
    !project
    || project.kind !== 'object'
    || !isObjectRef(project.shape)
    || project.shape.objectId !== PROJECT_SHAPE_ID
    || project.slots?.['project-id']?.value !== projectId
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

async function authorizedCreateBranch({
  images,
  imageId,
  name,
  frontier = null,
  parentRevision = null,
  description = '',
  overwrite = false,
  require,
} = {}) {
  if (!images || typeof images.putObject !== 'function') {
    throw new TypeError('authorizedCreateBranch requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  requiredText(name, 'branch name');
  if (typeof description !== 'string') {
    throw new TypeError('branch description must be a string');
  }
  requireAuthorityCallback(require);

  const id = branchObjectId(name);
  // Demand write authority on the deterministic branch head object BEFORE any storage read (no-existence-oracle)
  invokeRequire(require, OBJECT_WRITE_OPERATION, objectResource(imageId, id));

  return await createBranch({
    images,
    imageId,
    name,
    frontier,
    parentRevision,
    description,
    overwrite,
  });
}

async function authorizedReadBranch({images, imageId, name, require} = {}) {
  if (!images || typeof images.getObject !== 'function') {
    throw new TypeError('authorizedReadBranch requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  requiredText(name, 'branch name');
  requireAuthorityCallback(require);

  const id = branchObjectId(name);
  // Demand read authority BEFORE any storage read (no-existence-oracle)
  invokeRequire(require, OBJECT_READ_OPERATION, objectResource(imageId, id));

  const entry = await getBranch({images, imageId, name});
  if (!entry) {
    throw new TypeError(`branch not found: ${imageId}/${name}`);
  }
  return entry;
}

async function authorizedAdvanceBranch({
  images,
  imageId,
  name,
  toFrontier = null,
  expectedVersionToken = null,
  expectedRevision = null,
  description = null,
  allowNonFastForward = false,
  require,
} = {}) {
  if (!images || typeof images.putObject !== 'function') {
    throw new TypeError('authorizedAdvanceBranch requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  requiredText(name, 'branch name');
  requireAuthorityCallback(require);

  const id = branchObjectId(name);
  // Validate expectedVersionToken for this exact branch object before authority/storage if supplied
  if (expectedVersionToken !== null && expectedVersionToken !== undefined) {
    parseObjectVersionToken(expectedVersionToken, imageId, id);
  }

  // Demand write authority BEFORE any storage read (no-existence-oracle)
  invokeRequire(require, OBJECT_WRITE_OPERATION, objectResource(imageId, id));

  return await advanceBranch({
    images,
    imageId,
    name,
    toFrontier,
    expectedVersionToken,
    expectedRevision,
    description,
    allowNonFastForward,
  });
}

async function diffProjectBranches({
  images,
  imageId,
  projectId,
  leftBranch,
  rightBranch,
  rightImageId = imageId,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(leftBranch, 'leftBranch');
  requiredText(rightBranch, 'rightBranch');
  requiredText(rightImageId, 'rightImageId');

  const leftEntry = await getBranch({images, imageId, name: leftBranch});
  if (!leftEntry) {
    throw new TypeError(`left branch not found: ${imageId}/${leftBranch}`);
  }
  const rightEntry = await getBranch({images, imageId: rightImageId, name: rightBranch});
  if (!rightEntry) {
    throw new TypeError(`right branch not found: ${rightImageId}/${rightBranch}`);
  }

  const [leftRecords, rawRightRecords] = await Promise.all([
    reconstructImageRecordsAtFrontier({
      images,
      imageId,
      frontier: leftEntry.descriptor.frontier.revision,
    }),
    reconstructImageRecordsAtFrontier({
      images,
      imageId: rightImageId,
      frontier: rightEntry.descriptor.frontier.revision,
    }),
  ]);

  const rightRecords =
    rightImageId !== imageId
      ? rawRightRecords.map((rec) => rehomeRecordToImage(rec, rightImageId, imageId))
      : rawRightRecords;

  const leftDescriptor = assembleProjectDescriptorFromRecords(leftRecords, projectId);
  const rightDescriptor = assembleProjectDescriptorFromRecords(rightRecords, projectId);
  const diff = diffProjectDescriptors(leftDescriptor, rightDescriptor);

  const memberChanges = [
    ...diff.addedMembers.map((m) => Object.freeze({key: m.key, change: 'added', member: m})),
    ...diff.removedMembers.map((m) => Object.freeze({key: m.key, change: 'removed', member: m})),
    ...diff.modifiedMembers.map((m) =>
      Object.freeze({key: m.key, change: 'modified', before: m.before, after: m.after}),
    ),
  ].sort((a, b) => compareText(a.key, b.key));

  return Object.freeze({
    ...diff,
    leftBranch: leftEntry.descriptor,
    rightBranch: rightEntry.descriptor,
    memberChanges: Object.freeze(memberChanges),
  });
}

async function mergeProjectBranches({
  images,
  imageId,
  projectId,
  baseFrontier = null,
  baseBranch = null,
  leftBranch,
  rightBranch,
  rightImageId = imageId,
  resolutions = {},
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(leftBranch, 'leftBranch');
  requiredText(rightBranch, 'rightBranch');
  requiredText(rightImageId, 'rightImageId');

  const leftEntry = await getBranch({images, imageId, name: leftBranch});
  if (!leftEntry) {
    throw new TypeError(`left branch not found: ${imageId}/${leftBranch}`);
  }
  const rightEntry = await getBranch({images, imageId: rightImageId, name: rightBranch});
  if (!rightEntry) {
    throw new TypeError(`right branch not found: ${rightImageId}/${rightBranch}`);
  }

  let resolvedBaseFrontier = baseFrontier;
  if (resolvedBaseFrontier === null && baseBranch !== null) {
    const baseEntry = await getBranch({images, imageId, name: baseBranch});
    if (!baseEntry) {
      throw new TypeError(`base branch not found: ${imageId}/${baseBranch}`);
    }
    resolvedBaseFrontier = baseEntry.descriptor.frontier;
  }
  if (resolvedBaseFrontier === null) {
    resolvedBaseFrontier =
      rightEntry.descriptor.parentRevision !== null
        ? {imageId, revision: rightEntry.descriptor.parentRevision}
        : leftEntry.descriptor.frontier;
  }

  const baseRev = normalizeRevisionNumber(resolvedBaseFrontier, 'baseFrontier');
  const [baseRecords, leftRecords, rightRecords] = await Promise.all([
    reconstructImageRecordsAtFrontier({images, imageId, frontier: baseRev}),
    reconstructImageRecordsAtFrontier({
      images,
      imageId,
      frontier: leftEntry.descriptor.frontier.revision,
    }),
    reconstructImageRecordsAtFrontier({
      images,
      imageId: rightImageId,
      frontier: rightEntry.descriptor.frontier.revision,
    }),
  ]);

  const baseDescriptor = assembleProjectDescriptorFromRecords(baseRecords, projectId);
  const leftDescriptor = assembleProjectDescriptorFromRecords(leftRecords, projectId);
  const rightDescriptor = assembleProjectDescriptorFromRecords(rightRecords, projectId);

  const merged = mergeProjectDescriptors(baseDescriptor, leftDescriptor, rightDescriptor, {
    targetImageId: imageId,
    ignoreImageId: rightImageId !== imageId,
    resolutions,
  });

  return Object.freeze({
    ...merged,
    baseFrontier: Object.freeze({imageId, revision: baseRev}),
    leftBranch: leftEntry.descriptor,
    rightBranch: rightEntry.descriptor,
  });
}

async function authorizedDiffBranches({
  images,
  imageId,
  baseBranch,
  targetBranch,
  targetImageId = imageId,
  require,
} = {}) {
  if (!images || typeof images.getObject !== 'function') {
    throw new TypeError('authorizedDiffBranches requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  requiredText(baseBranch, 'baseBranch');
  requiredText(targetBranch, 'targetBranch');
  requiredText(targetImageId, 'targetImageId');
  requireAuthorityCallback(require);

  const demands = [
    {imageId, objectId: branchObjectId(baseBranch)},
    {imageId: targetImageId, objectId: branchObjectId(targetBranch)},
  ].sort((a, b) => {
    const c = compareText(a.imageId, b.imageId);
    return c !== 0 ? c : compareText(a.objectId, b.objectId);
  });

  const seen = new Set();
  for (const d of demands) {
    const key = `${d.imageId}\0${d.objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    invokeRequire(require, OBJECT_READ_OPERATION, objectResource(d.imageId, d.objectId));
  }

  return await diffBranches({
    images,
    imageId,
    baseBranch,
    targetBranch,
    targetImageId,
  });
}

async function authorizedMergeBranches({
  images,
  imageId,
  baseFrontier = null,
  baseBranch = null,
  sourceBranch,
  sourceImageId = imageId,
  targetBranch,
  resolutions = {},
  allowConflicts = false,
  apply = true,
  require,
} = {}) {
  if (!images || typeof images.getObject !== 'function') {
    throw new TypeError('authorizedMergeBranches requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  requiredText(sourceBranch, 'sourceBranch');
  requiredText(sourceImageId, 'sourceImageId');
  requiredText(targetBranch, 'targetBranch');
  requireAuthorityCallback(require);

  const readDemands = [
    {imageId: sourceImageId, objectId: branchObjectId(sourceBranch)},
    {imageId, objectId: branchObjectId(targetBranch)},
    ...(baseBranch ? [{imageId, objectId: branchObjectId(baseBranch)}] : []),
  ].sort((a, b) => {
    const c = compareText(a.imageId, b.imageId);
    return c !== 0 ? c : compareText(a.objectId, b.objectId);
  });

  const seen = new Set();
  for (const d of readDemands) {
    const key = `${d.imageId}\0${d.objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    invokeRequire(require, OBJECT_READ_OPERATION, objectResource(d.imageId, d.objectId));
  }

  if (apply) {
    invokeRequire(require, OBJECT_WRITE_OPERATION, objectResource(imageId, branchObjectId(targetBranch)));
  }

  return await mergeBranches({
    images,
    imageId,
    baseFrontier,
    baseBranch,
    sourceBranch,
    sourceImageId,
    targetBranch,
    resolutions,
    allowConflicts,
    apply,
  });
}

async function authorizedDiffProjectBranches({
  images,
  imageId,
  projectId,
  leftBranch,
  rightBranch,
  rightImageId = imageId,
  require,
} = {}) {
  if (!images || typeof images.getObject !== 'function') {
    throw new TypeError('authorizedDiffProjectBranches requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(leftBranch, 'leftBranch');
  requiredText(rightBranch, 'rightBranch');
  requiredText(rightImageId, 'rightImageId');
  requireAuthorityCallback(require);

  const demands = [
    {imageId, objectId: projectObjectId(projectId)},
    {imageId: rightImageId, objectId: projectObjectId(projectId)},
    {imageId, objectId: branchObjectId(leftBranch)},
    {imageId: rightImageId, objectId: branchObjectId(rightBranch)},
  ].sort((a, b) => {
    const c = compareText(a.imageId, b.imageId);
    return c !== 0 ? c : compareText(a.objectId, b.objectId);
  });

  const seen = new Set();
  for (const d of demands) {
    const key = `${d.imageId}\0${d.objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    invokeRequire(require, OBJECT_READ_OPERATION, objectResource(d.imageId, d.objectId));
  }

  return await diffProjectBranches({
    images,
    imageId,
    projectId,
    leftBranch,
    rightBranch,
    rightImageId,
  });
}

export {
  authorizedAdvanceBranch,
  authorizedCreateBranch,
  authorizedDiffBranches,
  authorizedDiffProjectBranches,
  authorizedMergeBranches,
  authorizedReadBranch,
  diffProjectBranches,
  mergeProjectBranches,
};
