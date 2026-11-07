import {base64urlEncode, utf8Encode} from '../support/portable-bytes.js';
import {integerValue, isObjectRef, objectRef, textValue} from '../value/index.js';
import {
  objectVersionToken,
  parseObjectVersionToken,
  putObjectAtExpectedVersion,
} from '../object/version-token.js';
import {ensureShape} from './ensure-records.js';
import {diffImageRecords, reconstructImageRecordsAtFrontier} from './diff.js';
import {applyImageMerge, mergeImageRecords, rehomeRecordToImage} from './merge.js';

const IMAGE_BRANCH_DESCRIPTOR_V1 = 'lagrange-image-branch/v1';
const BRANCH_HEAD_SHAPE_ID = 'lagrange-branch/head-shape/v1';
const BRANCH_OBJECT_PREFIX = 'lagrange-branch/head/';

const BRANCH_SLOT = Object.freeze({
  name: 'branch-name',
  imageId: 'branch-image-id',
  revision: 'branch-revision',
  parentRevision: 'branch-parent-revision',
  description: 'branch-description',
});

class BranchConflictError extends Error {
  constructor(message, {branchName = null, currentRevision = null, targetRevision = null} = {}) {
    super(message);
    this.name = 'BranchConflictError';
    this.branchName = branchName;
    this.currentRevision = currentRevision;
    this.targetRevision = targetRevision;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
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

function branchObjectId(name) {
  const validName = requiredText(name, 'branch name');
  return `${BRANCH_OBJECT_PREFIX}${base64urlEncode(utf8Encode(validName))}`;
}

function isBranchHeadRecord(record) {
  return (
    record?.kind === 'object'
    && ((typeof record.id === 'string' && record.id.startsWith(BRANCH_OBJECT_PREFIX))
      || (isObjectRef(record.shape) && record.shape.objectId === BRANCH_HEAD_SHAPE_ID))
  );
}

async function ensureBranchHeadShape(images, imageId) {
  const shape = await ensureShape(images, imageId, {
    id: BRANCH_HEAD_SHAPE_ID,
    slots: [
      {id: BRANCH_SLOT.name, name: 'name'},
      {id: BRANCH_SLOT.imageId, name: 'imageId'},
      {id: BRANCH_SLOT.revision, name: 'revision'},
      {id: BRANCH_SLOT.parentRevision, name: 'parentRevision'},
      {id: BRANCH_SLOT.description, name: 'description'},
    ],
  });
  return objectRef(imageId, shape.id);
}

function branchDescriptorFromRecord(record, expectedImageId, expectedName = null) {
  if (
    !record
    || record.kind !== 'object'
    || !isObjectRef(record.shape)
    || record.shape.objectId !== BRANCH_HEAD_SHAPE_ID
  ) {
    throw new TypeError(`malformed branch record: ${record?.id ?? 'unknown'}`);
  }
  const nameVal = record.slots?.[BRANCH_SLOT.name];
  const imgVal = record.slots?.[BRANCH_SLOT.imageId];
  const revVal = record.slots?.[BRANCH_SLOT.revision];
  const parentRevVal = record.slots?.[BRANCH_SLOT.parentRevision];
  const descVal = record.slots?.[BRANCH_SLOT.description];

  if (
    nameVal?.kind !== 'text'
    || imgVal?.kind !== 'text'
    || revVal?.kind !== 'integer'
    || parentRevVal?.kind !== 'integer'
    || descVal?.kind !== 'text'
  ) {
    throw new TypeError(`malformed branch slot values on ${record.id}`);
  }
  if (expectedName !== null && nameVal.value !== expectedName) {
    throw new TypeError(`branch record ${record.id} name mismatch: expected ${expectedName}, got ${nameVal.value}`);
  }
  const revision = Number(revVal.value);
  const parentRaw = Number(parentRevVal.value);
  return Object.freeze({
    format: IMAGE_BRANCH_DESCRIPTOR_V1,
    imageId: expectedImageId ?? record.imageId,
    name: nameVal.value,
    objectId: record.id,
    frontier: Object.freeze({
      imageId: imgVal.value,
      revision,
    }),
    parentRevision: parentRaw >= 0 ? parentRaw : null,
    description: descVal.value,
  });
}

function buildBranchRecordPayload({
  imageId,
  shapeRef,
  name,
  revision,
  parentRevision = null,
  description = '',
}) {
  return {
    id: branchObjectId(name),
    shape: shapeRef ?? objectRef(imageId, BRANCH_HEAD_SHAPE_ID),
    behavior: null,
    slots: {
      [BRANCH_SLOT.name]: textValue(name),
      [BRANCH_SLOT.imageId]: textValue(imageId),
      [BRANCH_SLOT.revision]: integerValue(BigInt(revision)),
      [BRANCH_SLOT.parentRevision]: integerValue(
        parentRevision !== null && parentRevision !== undefined && parentRevision >= 0
          ? BigInt(parentRevision)
          : -1n,
      ),
      [BRANCH_SLOT.description]: textValue(description ?? ''),
    },
    metadata: {branch: 'head', name},
  };
}

async function createBranch({
  images,
  imageId,
  name,
  frontier = null,
  parentRevision = null,
  description = '',
  overwrite = false,
} = {}) {
  if (!images || typeof images.frontier !== 'function' || typeof images.putObject !== 'function') {
    throw new TypeError('createBranch requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  requiredText(name, 'branch name');
  if (typeof description !== 'string') {
    throw new TypeError('branch description must be a string');
  }

  const headFrontier = normalizeRevisionNumber(await images.frontier(imageId), 'image head frontier');
  const targetRevision =
    frontier === null || frontier === undefined
      ? headFrontier
      : normalizeRevisionNumber(frontier, 'branch frontier');
  if (targetRevision > headFrontier) {
    throw new RangeError(
      `branch ${name} frontier revision ${targetRevision} exceeds image ${imageId} head revision ${headFrontier}`,
    );
  }

  const shapeRef = await ensureBranchHeadShape(images, imageId);
  const id = branchObjectId(name);
  const existing = await images.getObject(imageId, id);
  if (existing) {
    const existingDesc = branchDescriptorFromRecord(existing, imageId, name);
    if (!overwrite) {
      if (existingDesc.frontier.revision === targetRevision) {
        return Object.freeze({
          descriptor: existingDesc,
          versionToken: objectVersionToken(imageId, existing.id, existing._version),
        });
      }
      throw new BranchConflictError(
        `branch ${name} already exists in image ${imageId} at revision ${existingDesc.frontier.revision}`,
        {
          branchName: name,
          currentRevision: existingDesc.frontier.revision,
          targetRevision,
        },
      );
    }
  }

  const payload = buildBranchRecordPayload({
    imageId,
    shapeRef,
    name,
    revision: targetRevision,
    parentRevision,
    description,
  });
  const saved = existing
    ? await images.putObject(imageId, payload, {expectedVersion: existing._version})
    : await images.putObject(imageId, payload, {expectedVersion: 0});

  return Object.freeze({
    descriptor: branchDescriptorFromRecord(saved, imageId, name),
    versionToken: objectVersionToken(imageId, saved.id, saved._version),
  });
}

async function getBranch({images, imageId, name} = {}) {
  if (!images || typeof images.getObject !== 'function') {
    throw new TypeError('getBranch requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  requiredText(name, 'branch name');
  const record = await images.getObject(imageId, branchObjectId(name));
  if (!record) return null;
  return Object.freeze({
    descriptor: branchDescriptorFromRecord(record, imageId, name),
    versionToken: objectVersionToken(imageId, record.id, record._version),
  });
}

async function listBranches({images, imageId} = {}) {
  if (!images || typeof images.listObjects !== 'function') {
    throw new TypeError('listBranches requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  const objects = await images.listObjects(imageId);
  const descriptors = [];
  for (const obj of objects) {
    if (isObjectRef(obj.shape) && obj.shape.objectId === BRANCH_HEAD_SHAPE_ID) {
      descriptors.push(branchDescriptorFromRecord(obj, imageId));
    }
  }
  descriptors.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze(descriptors);
}

async function advanceBranch({
  images,
  imageId,
  name,
  toFrontier = null,
  expectedVersionToken = null,
  expectedRevision = null,
  description = null,
  allowNonFastForward = false,
} = {}) {
  if (!images || typeof images.getObject !== 'function' || typeof images.putObject !== 'function') {
    throw new TypeError('advanceBranch requires an ImageService');
  }
  requiredText(imageId, 'imageId');
  requiredText(name, 'branch name');

  const id = branchObjectId(name);
  let expectedVersionFromToken = null;
  if (expectedVersionToken !== null && expectedVersionToken !== undefined) {
    expectedVersionFromToken = parseObjectVersionToken(expectedVersionToken, imageId, id);
  }
  const currentRecord = await images.getObject(imageId, id);
  if (!currentRecord) {
    throw new TypeError(`branch not found: ${imageId}/${name}`);
  }
  const currentDesc = branchDescriptorFromRecord(currentRecord, imageId, name);

  if (expectedRevision !== null && expectedRevision !== undefined) {
    const expRev = normalizeRevisionNumber(expectedRevision, 'expectedRevision');
    if (currentDesc.frontier.revision !== expRev) {
      throw new BranchConflictError(
        `branch ${name} expected revision ${expRev}, but current revision is ${currentDesc.frontier.revision}`,
        {
          branchName: name,
          currentRevision: currentDesc.frontier.revision,
          targetRevision: expRev,
        },
      );
    }
  }

  const headFrontier = normalizeRevisionNumber(await images.frontier(imageId), 'image head frontier');
  const targetRevision =
    toFrontier === null || toFrontier === undefined
      ? headFrontier
      : normalizeRevisionNumber(toFrontier, 'toFrontier');
  if (targetRevision > headFrontier) {
    throw new RangeError(
      `branch ${name} target revision ${targetRevision} exceeds image ${imageId} head revision ${headFrontier}`,
    );
  }

  if (targetRevision < currentDesc.frontier.revision && !allowNonFastForward) {
    throw new BranchConflictError(
      `cannot non-fast-forward branch ${name} from revision ${currentDesc.frontier.revision} to ${targetRevision} without allowNonFastForward`,
      {
        branchName: name,
        currentRevision: currentDesc.frontier.revision,
        targetRevision,
      },
    );
  }

  const payload = buildBranchRecordPayload({
    imageId,
    shapeRef: currentRecord.shape,
    name,
    revision: targetRevision,
    parentRevision: currentDesc.frontier.revision,
    description: description !== null && description !== undefined ? description : currentDesc.description,
  });

  const saved =
    expectedVersionFromToken !== null
      ? await putObjectAtExpectedVersion(images, imageId, payload, expectedVersionFromToken)
      : await images.putObject(imageId, payload, {expectedVersion: currentRecord._version});

  return Object.freeze({
    descriptor: branchDescriptorFromRecord(saved, imageId, name),
    versionToken: objectVersionToken(imageId, saved.id, saved._version),
    fastForward: targetRevision >= currentDesc.frontier.revision,
  });
}

async function deleteBranch({images, imageId, name} = {}) {
  if (!images || typeof images.sweepRecords !== 'function') {
    throw new TypeError('deleteBranch requires an ImageService with sweepRecords');
  }
  requiredText(imageId, 'imageId');
  requiredText(name, 'branch name');
  const id = branchObjectId(name);
  const existing = await images.getObject(imageId, id);
  if (!existing) {
    return Object.freeze({deleted: false, imageId, name});
  }
  await images.sweepRecords(imageId, [id]);
  return Object.freeze({deleted: true, imageId, name});
}

function candidateRecordForCreate(rehomedRecord) {
  switch (rehomedRecord.kind) {
    case 'shape':
      return {
        kind: 'shape',
        id: rehomedRecord.id,
        slots: rehomedRecord.slots,
        ...(Object.hasOwn(rehomedRecord, 'indexed') ? {indexed: rehomedRecord.indexed} : {}),
        metadata: rehomedRecord.metadata ?? {},
      };
    case 'code-artifact':
      return {
        kind: 'code-artifact',
        id: rehomedRecord.id,
        languageId: rehomedRecord.languageId ?? null,
        representation: rehomedRecord.representation,
        content: rehomedRecord.content,
        logicalPath: rehomedRecord.logicalPath ?? null,
        dependencies: rehomedRecord.dependencies ?? [],
        derivedFrom: rehomedRecord.derivedFrom ?? [],
        metadata: rehomedRecord.metadata ?? {},
      };
    case 'lexical-environment':
      return {
        kind: 'lexical-environment',
        id: rehomedRecord.id,
        parent: rehomedRecord.parent ?? null,
        bindings: rehomedRecord.bindings ?? {},
        metadata: rehomedRecord.metadata ?? {},
      };
    case 'block':
      return {
        kind: 'block',
        id: rehomedRecord.id,
        code: rehomedRecord.code,
        environment: rehomedRecord.environment ?? null,
        metadata: rehomedRecord.metadata ?? {},
      };
    case 'object':
      return {
        kind: 'object',
        id: rehomedRecord.id,
        shape: rehomedRecord.shape,
        behavior: rehomedRecord.behavior ?? null,
        slots: rehomedRecord.slots ?? {},
        ...(Object.hasOwn(rehomedRecord, 'indexed') ? {indexed: rehomedRecord.indexed} : {}),
        metadata: rehomedRecord.metadata ?? {},
      };
    default:
      throw new TypeError(`unsupported record kind in forkImageFromFrontier: ${rehomedRecord.kind}`);
  }
}

async function forkImageFromFrontier({
  images,
  sourceImageId,
  frontier = null,
  targetImageId,
  targetImageName = null,
  createBranchName = null,
  includeBranches = false,
} = {}) {
  if (!images || typeof images.createImage !== 'function' || typeof images.createRecords !== 'function') {
    throw new TypeError('forkImageFromFrontier requires an ImageService with createImage and createRecords');
  }
  requiredText(sourceImageId, 'sourceImageId');
  requiredText(targetImageId, 'targetImageId');
  if (sourceImageId === targetImageId) {
    throw new TypeError('forkImageFromFrontier targetImageId must differ from sourceImageId');
  }

  const headRevision = normalizeRevisionNumber(
    await images.frontier(sourceImageId),
    'sourceImageId head frontier',
  );
  const sourceRevision =
    frontier === null || frontier === undefined
      ? headRevision
      : normalizeRevisionNumber(frontier, 'frontier');

  const records = await reconstructImageRecordsAtFrontier({
    images,
    imageId: sourceImageId,
    frontier: sourceRevision,
  });

  await images.createImage({
    id: targetImageId,
    name: targetImageName ?? `Fork of ${sourceImageId}@${sourceRevision}`,
  });

  const filteredRecords = records.filter((record) => {
    if (includeBranches) return true;
    if (isBranchHeadRecord(record)) return false;
    if (record.kind === 'shape' && record.id === BRANCH_HEAD_SHAPE_ID) return false;
    return true;
  });

  const candidates = filteredRecords.map((rec) =>
    candidateRecordForCreate(rehomeRecordToImage(rec, sourceImageId, targetImageId)),
  );
  if (candidates.length > 0) {
    await images.createRecords(targetImageId, candidates);
  }

  const targetRev = normalizeRevisionNumber(
    await images.frontier(targetImageId),
    'targetImageId head frontier',
  );
  let branch = null;
  if (createBranchName !== null && createBranchName !== undefined) {
    branch = await createBranch({
      images,
      imageId: targetImageId,
      name: createBranchName,
      frontier: targetRev,
      description: `Forked from ${sourceImageId}@${sourceRevision}`,
    });
  }

  return Object.freeze({
    sourceImageId,
    sourceFrontier: Object.freeze({
      imageId: sourceImageId,
      revision: sourceRevision,
    }),
    targetImageId,
    targetFrontier: Object.freeze({
      imageId: targetImageId,
      revision: targetRev,
    }),
    recordCount: candidates.length,
    branch: branch ? branch.descriptor : null,
  });
}

async function forkImageFromBranch({
  images,
  imageId,
  branchName,
  targetImageId,
  targetImageName = null,
  createBranchName = branchName,
  includeBranches = false,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(branchName, 'branchName');
  const branchEntry = await getBranch({images, imageId, name: branchName});
  if (!branchEntry) {
    throw new TypeError(`branch not found: ${imageId}/${branchName}`);
  }
  return await forkImageFromFrontier({
    images,
    sourceImageId: imageId,
    frontier: branchEntry.descriptor.frontier,
    targetImageId,
    targetImageName,
    createBranchName,
    includeBranches,
  });
}

async function diffBranches({
  images,
  imageId,
  baseBranch,
  targetBranch,
  targetImageId = imageId,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(baseBranch, 'baseBranch');
  requiredText(targetBranch, 'targetBranch');
  requiredText(targetImageId, 'targetImageId');

  const baseEntry = await getBranch({images, imageId, name: baseBranch});
  if (!baseEntry) {
    throw new TypeError(`base branch not found: ${imageId}/${baseBranch}`);
  }
  const targetEntry = await getBranch({images, imageId: targetImageId, name: targetBranch});
  if (!targetEntry) {
    throw new TypeError(`target branch not found: ${targetImageId}/${targetBranch}`);
  }

  const baseRev = baseEntry.descriptor.frontier.revision;
  const targetRev = targetEntry.descriptor.frontier.revision;

  const [rawFromRecords, rawToRecords] = await Promise.all([
    reconstructImageRecordsAtFrontier({images, imageId, frontier: baseRev}),
    reconstructImageRecordsAtFrontier({images, imageId: targetImageId, frontier: targetRev}),
  ]);

  const filterNonBranch = (record) =>
    !isBranchHeadRecord(record) && !(record.kind === 'shape' && record.id === BRANCH_HEAD_SHAPE_ID);

  const fromRecords = rawFromRecords.filter(filterNonBranch);
  const toRecords = rawToRecords
    .filter(filterNonBranch)
    .map((rec) => (targetImageId !== imageId ? rehomeRecordToImage(rec, targetImageId, imageId) : rec));

  const diff = diffImageRecords({
    fromRecords,
    toRecords,
    fromImageId: imageId,
    toImageId: targetImageId,
    fromFrontier: baseRev,
    toFrontier: targetRev,
  });

  return Object.freeze({
    ...diff,
    baseBranch: baseEntry.descriptor,
    targetBranch: targetEntry.descriptor,
  });
}

async function mergeBranches({
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
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(sourceBranch, 'sourceBranch');
  requiredText(sourceImageId, 'sourceImageId');
  requiredText(targetBranch, 'targetBranch');

  const targetEntry = await getBranch({images, imageId, name: targetBranch});
  if (!targetEntry) {
    throw new TypeError(`target branch not found: ${imageId}/${targetBranch}`);
  }
  const sourceEntry = await getBranch({images, imageId: sourceImageId, name: sourceBranch});
  if (!sourceEntry) {
    throw new TypeError(`source branch not found: ${sourceImageId}/${sourceBranch}`);
  }

  let resolvedBaseFrontier = baseFrontier;
  if (resolvedBaseFrontier === null && baseBranch !== null) {
    const baseBranchEntry = await getBranch({images, imageId, name: baseBranch});
    if (!baseBranchEntry) {
      throw new TypeError(`base branch not found: ${imageId}/${baseBranch}`);
    }
    resolvedBaseFrontier = baseBranchEntry.descriptor.frontier;
  }
  if (resolvedBaseFrontier === null) {
    if (sourceEntry.descriptor.parentRevision !== null) {
      resolvedBaseFrontier = {imageId, revision: sourceEntry.descriptor.parentRevision};
    } else {
      resolvedBaseFrontier = targetEntry.descriptor.frontier;
    }
  }

  const baseRev = normalizeRevisionNumber(resolvedBaseFrontier, 'baseFrontier');
  const targetRev = targetEntry.descriptor.frontier.revision;
  const sourceRev = sourceEntry.descriptor.frontier.revision;

  const filterNonBranch = (record) =>
    !isBranchHeadRecord(record) && !(record.kind === 'shape' && record.id === BRANCH_HEAD_SHAPE_ID);

  const [rawBaseRecords, rawLeftRecords, rawRightRecords] = await Promise.all([
    reconstructImageRecordsAtFrontier({images, imageId, frontier: baseRev}),
    reconstructImageRecordsAtFrontier({images, imageId, frontier: targetRev}),
    reconstructImageRecordsAtFrontier({images, imageId: sourceImageId, frontier: sourceRev}),
  ]);

  const mergePlan = mergeImageRecords({
    baseRecords: rawBaseRecords.filter(filterNonBranch),
    leftRecords: rawLeftRecords.filter(filterNonBranch),
    rightRecords: rawRightRecords.filter(filterNonBranch),
    baseImageId: imageId,
    leftImageId: imageId,
    rightImageId: sourceImageId,
    targetImageId: imageId,
    baseFrontier: baseRev,
    leftFrontier: targetRev,
    rightFrontier: sourceRev,
    resolutions,
  });

  if (!mergePlan.clean && !allowConflicts) {
    return Object.freeze({
      clean: false,
      fastForward: false,
      applied: false,
      sourceBranch: sourceEntry.descriptor,
      targetBranch: targetEntry.descriptor,
      mergePlan,
      conflicts: mergePlan.conflicts,
    });
  }

  if (!apply) {
    return Object.freeze({
      clean: mergePlan.clean,
      fastForward: sourceImageId === imageId && baseRev === targetRev && sourceRev >= targetRev,
      applied: false,
      sourceBranch: sourceEntry.descriptor,
      targetBranch: targetEntry.descriptor,
      mergePlan,
      conflicts: mergePlan.conflicts,
    });
  }

  const headBeforeApply = normalizeRevisionNumber(
    await images.frontier(imageId),
    'image head frontier',
  );
  const isPureFastForward =
    sourceImageId === imageId
    && baseRev === targetRev
    && sourceRev >= targetRev
    && headBeforeApply === sourceRev;

  if (isPureFastForward) {
    const advanced = await advanceBranch({
      images,
      imageId,
      name: targetBranch,
      toFrontier: {imageId, revision: sourceRev},
    });
    return Object.freeze({
      clean: true,
      fastForward: true,
      applied: true,
      sourceBranch: sourceEntry.descriptor,
      targetBranch: advanced.descriptor,
      mergePlan,
      conflicts: mergePlan.conflicts,
    });
  }

  await applyImageMerge({
    images,
    targetImageId: imageId,
    mergePlan,
    allowConflicts,
  });

  if (mergePlan.removedIds.length > 0 && typeof images.sweepRecords === 'function') {
    await images.sweepRecords(imageId, [...mergePlan.removedIds]);
  }

  const postMergeFrontier = normalizeRevisionNumber(
    await images.frontier(imageId),
    'post-merge frontier',
  );
  const advanced = await advanceBranch({
    images,
    imageId,
    name: targetBranch,
    toFrontier: postMergeFrontier,
    allowNonFastForward: true,
  });

  return Object.freeze({
    clean: mergePlan.clean,
    fastForward: false,
    applied: true,
    sourceBranch: sourceEntry.descriptor,
    targetBranch: advanced.descriptor,
    mergePlan,
    conflicts: mergePlan.conflicts,
  });
}

export {
  BRANCH_HEAD_SHAPE_ID,
  BranchConflictError,
  IMAGE_BRANCH_DESCRIPTOR_V1,
  advanceBranch,
  branchObjectId,
  createBranch,
  deleteBranch,
  diffBranches,
  forkImageFromBranch,
  forkImageFromFrontier,
  getBranch,
  isBranchHeadRecord,
  listBranches,
  mergeBranches,
};
