import {RELOCATED_RECORD_KIND, SWEPT_RECORD_KIND} from './locator.js';
import {reconstructImageRecordsAtFrontier} from './diff.js';
import {referencesOfRecord} from './references.js';
import {isObjectRef} from '../value/scalars.js';

const IMAGE_GRAPH_INDEX_V1 = 'lagrange-image-graph-index/v1';
const IMAGE_REACHABILITY_CLOSURE_V1 = 'lagrange-image-reachability-closure/v1';
const IMAGE_GC_PLAN_V1 = 'lagrange-image-gc-plan/v1';
const IMAGE_GC_RECEIPT_V1 = 'lagrange-image-gc-receipt/v1';

const DURABLE_RECORD_KINDS = Object.freeze([
  'shape',
  'object',
  'code-artifact',
  'lexical-environment',
  'block',
]);

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareObjectRef(left, right) {
  const imageOrder = compareText(left.imageId, right.imageId);
  if (imageOrder !== 0) return imageOrder;
  return compareText(left.objectId, right.objectId);
}

function dedupeSortedStrings(values) {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function dedupeSortedObjectRefs(refs) {
  const byKey = new Map();
  for (const ref of refs) {
    if (!isObjectRef(ref)) continue;
    const key = `${ref.imageId}\0${ref.objectId}`;
    if (!byKey.has(key)) {
      byKey.set(key, Object.freeze({kind: 'ref', imageId: ref.imageId, objectId: ref.objectId}));
    }
  }
  return Object.freeze([...byKey.values()].sort(compareObjectRef));
}

function isIntrinsicRootRecord(record, {imageRootObjectId = null, preserveSystemShapes = true} = {}) {
  if (!record || typeof record !== 'object') return false;
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0) return false;
  if (imageRootObjectId && id === imageRootObjectId) return true;

  // Intrinsic system shapes for Smalltalk, Common Lisp, and Projects.
  if (
    preserveSystemShapes &&
    record.kind === 'shape' &&
    (id.startsWith('smalltalk/') ||
      id.startsWith('common-lisp/') ||
      id.startsWith('lagrange-project/') ||
      id.startsWith('lagrange-project-installation/'))
  ) {
    return true;
  }

  // Symmetric Smalltalk kernel, global namespace, interned symbols/characters, and behaviors.
  if (
    id === 'smalltalk-kernel/v1' ||
    id === 'smalltalk/kernel' ||
    id === 'smalltalk-global-namespace/v1' ||
    id === 'smalltalk/globals' ||
    id === 'smalltalk-block-protocol/v1' ||
    id === 'smalltalk/block-protocol' ||
    id === 'smalltalk-block-unwind/v1' ||
    id === 'smalltalk/block-unwind' ||
    id === 'smalltalk/symbol-table' ||
    id === 'smalltalk/subclasses' ||
    id.startsWith('smalltalk/symbol/') ||
    id.startsWith('smalltalk/char/')
  ) {
    return true;
  }
  const stMeta = record.metadata?.smalltalk;
  if (
    stMeta === 'behavior' ||
    stMeta === 'singleton' ||
    stMeta === 'class-state' ||
    stMeta === 'subclass-registry' ||
    stMeta === 'kernel-primitive'
  ) {
    return true;
  }
  const protocolMeta = record.metadata?.protocol;
  if (
    protocolMeta === 'smalltalk-kernel/v1' ||
    protocolMeta === 'smalltalk-kernel-protocol/v1' ||
    protocolMeta === 'smalltalk-global-namespace/v1' ||
    protocolMeta === 'smalltalk-block-protocol/v1' ||
    protocolMeta === 'smalltalk-block-unwind/v1' ||
    protocolMeta === 'smalltalk-block-unwind-protocol/v1'
  ) {
    return true;
  }

  // Common Lisp namespace, sentinels, and system descriptors.
  if (
    id === 'common-lisp/namespace/v1' ||
    id === 'common-lisp/hash-table-tombstone/v1' ||
    id === 'common-lisp/unsupplied/v1' ||
    id === 'common-lisp/nil' ||
    id === 'common-lisp/t'
  ) {
    return true;
  }
  const clMeta = record.metadata?.commonLisp;
  if (clMeta === 'sentinel' || clMeta === 'defsystem') {
    return true;
  }

  // Project working-state roots, sentinel, and installation heads.
  if (
    id === 'lagrange-project/none/v1' ||
    (id.startsWith('lagrange-project-installation/') && id.endsWith('/head'))
  ) {
    return true;
  }
  if (
    record.kind === 'object' &&
    (record.shape?.objectId === 'lagrange-project/project/v1' ||
      record.shape?.objectId === 'lagrange-project-installation/head-shape/v1' ||
      record.metadata?.project === 'working-state')
  ) {
    return true;
  }

  return false;
}

function buildImageGraphIndex(records, {imageId = null} = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError('buildImageGraphIndex requires an array of records');
  }

  const liveRecords = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.kind === RELOCATED_RECORD_KIND || record.kind === SWEPT_RECORD_KIND) continue;
    liveRecords.push(record);
  }

  const resolvedImageId =
    imageId ?? liveRecords.find((record) => typeof record.imageId === 'string')?.imageId ?? null;

  const recordsByIdMap = new Map();
  const byKindBuckets = new Map(DURABLE_RECORD_KINDS.map((kind) => [kind, []]));

  for (const record of liveRecords) {
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new TypeError('record must have a non-empty string id');
    }
    if (recordsByIdMap.has(record.id)) {
      throw new TypeError(`duplicate record id in image graph index: ${record.id}`);
    }
    if (!byKindBuckets.has(record.kind)) {
      throw new TypeError(`unknown record kind in image graph index: ${record.kind}`);
    }
    recordsByIdMap.set(record.id, record);
    byKindBuckets.get(record.kind).push(record.id);
  }

  const sortedIds = [...recordsByIdMap.keys()].sort(compareText);
  const recordsById = {};
  for (const id of sortedIds) {
    recordsById[id] = recordsByIdMap.get(id);
  }

  const recordIdsByKind = {};
  for (const kind of DURABLE_RECORD_KINDS) {
    recordIdsByKind[kind] = dedupeSortedStrings(byKindBuckets.get(kind));
  }

  const outgoingRefsById = {};
  const outgoingLocalIdsById = {};
  const outgoingExternalRefsById = {};
  const incomingLocalSets = new Map(sortedIds.map((id) => [id, new Set()]));

  const derivedFromByArtifactId = {};
  const dependentsOfSourceSets = new Map();
  const dependenciesByArtifactId = {};
  const reverseDependencyLists = new Map();
  const logicalPathSets = new Map();
  const representationSets = new Map();
  const blocksByCodeArtifactSets = new Map();

  for (const id of sortedIds) {
    const record = recordsById[id];
    const refs = dedupeSortedObjectRefs(referencesOfRecord(record));
    outgoingRefsById[id] = refs;

    const localTargets = [];
    const externalTargets = [];
    for (const ref of refs) {
      const sameImage = resolvedImageId === null || ref.imageId === resolvedImageId || ref.imageId === record.imageId;
      if (sameImage && recordsByIdMap.has(ref.objectId)) {
        localTargets.push(ref.objectId);
        incomingLocalSets.get(ref.objectId).add(id);
      } else {
        externalTargets.push(ref);
      }
    }
    outgoingLocalIdsById[id] = dedupeSortedStrings(localTargets);
    outgoingExternalRefsById[id] = Object.freeze(externalTargets);

    if (record.kind === 'code-artifact') {
      const derivedSources = [];
      for (const sourceRef of record.derivedFrom ?? []) {
        if (!isObjectRef(sourceRef)) continue;
        derivedSources.push(sourceRef.objectId);
        if (!dependentsOfSourceSets.has(sourceRef.objectId)) {
          dependentsOfSourceSets.set(sourceRef.objectId, new Set());
        }
        dependentsOfSourceSets.get(sourceRef.objectId).add(id);
      }
      derivedFromByArtifactId[id] = dedupeSortedStrings(derivedSources);

      const depEntries = [];
      for (const dep of record.dependencies ?? []) {
        if (!dep || !isObjectRef(dep.artifact)) continue;
        depEntries.push(
          Object.freeze({
            role: dep.role,
            imageId: dep.artifact.imageId,
            artifactId: dep.artifact.objectId,
          }),
        );
        if (!reverseDependencyLists.has(dep.artifact.objectId)) {
          reverseDependencyLists.set(dep.artifact.objectId, []);
        }
        reverseDependencyLists.get(dep.artifact.objectId).push(
          Object.freeze({
            role: dep.role,
            dependentArtifactId: id,
          }),
        );
      }
      depEntries.sort((left, right) => {
        const roleOrder = compareText(left.role, right.role);
        if (roleOrder !== 0) return roleOrder;
        return compareText(left.artifactId, right.artifactId);
      });
      dependenciesByArtifactId[id] = Object.freeze(depEntries);

      if (typeof record.logicalPath === 'string' && record.logicalPath.length > 0) {
        if (!logicalPathSets.has(record.logicalPath)) {
          logicalPathSets.set(record.logicalPath, new Set());
        }
        logicalPathSets.get(record.logicalPath).add(id);
      }

      if (typeof record.representation === 'string' && record.representation.length > 0) {
        if (!representationSets.has(record.representation)) {
          representationSets.set(record.representation, new Set());
        }
        representationSets.get(record.representation).add(id);
      }
    }

    if (record.kind === 'block' && isObjectRef(record.code)) {
      const codeId = record.code.objectId;
      if (!blocksByCodeArtifactSets.has(codeId)) {
        blocksByCodeArtifactSets.set(codeId, new Set());
      }
      blocksByCodeArtifactSets.get(codeId).add(id);
    }
  }

  const incomingLocalIdsById = {};
  for (const id of sortedIds) {
    incomingLocalIdsById[id] = dedupeSortedStrings(incomingLocalSets.get(id));
  }

  const dependentsOfSourceByArtifactId = {};
  for (const [sourceId, set] of [...dependentsOfSourceSets.entries()].sort(([a], [b]) => compareText(a, b))) {
    dependentsOfSourceByArtifactId[sourceId] = dedupeSortedStrings(set);
  }

  const reverseDependenciesByArtifactId = {};
  for (const [targetId, list] of [...reverseDependencyLists.entries()].sort(([a], [b]) => compareText(a, b))) {
    const sorted = [...list].sort((left, right) => {
      const roleOrder = compareText(left.role, right.role);
      if (roleOrder !== 0) return roleOrder;
      return compareText(left.dependentArtifactId, right.dependentArtifactId);
    });
    reverseDependenciesByArtifactId[targetId] = Object.freeze(sorted);
  }

  const artifactsByLogicalPath = {};
  for (const [logicalPath, set] of [...logicalPathSets.entries()].sort(([a], [b]) => compareText(a, b))) {
    artifactsByLogicalPath[logicalPath] = dedupeSortedStrings(set);
  }

  const artifactsByRepresentation = {};
  for (const [rep, set] of [...representationSets.entries()].sort(([a], [b]) => compareText(a, b))) {
    artifactsByRepresentation[rep] = dedupeSortedStrings(set);
  }

  const blocksByCodeArtifactId = {};
  for (const [codeId, set] of [...blocksByCodeArtifactSets.entries()].sort(([a], [b]) => compareText(a, b))) {
    blocksByCodeArtifactId[codeId] = dedupeSortedStrings(set);
  }

  return Object.freeze({
    format: IMAGE_GRAPH_INDEX_V1,
    imageId: resolvedImageId,
    recordCount: sortedIds.length,
    recordIds: Object.freeze(sortedIds),
    recordsById: Object.freeze(recordsById),
    recordIdsByKind: Object.freeze(recordIdsByKind),
    outgoingRefsById: Object.freeze(outgoingRefsById),
    outgoingLocalIdsById: Object.freeze(outgoingLocalIdsById),
    outgoingExternalRefsById: Object.freeze(outgoingExternalRefsById),
    incomingLocalIdsById: Object.freeze(incomingLocalIdsById),
    derivedFromByArtifactId: Object.freeze(derivedFromByArtifactId),
    dependentsOfSourceByArtifactId: Object.freeze(dependentsOfSourceByArtifactId),
    dependenciesByArtifactId: Object.freeze(dependenciesByArtifactId),
    reverseDependenciesByArtifactId: Object.freeze(reverseDependenciesByArtifactId),
    artifactsByLogicalPath: Object.freeze(artifactsByLogicalPath),
    artifactsByRepresentation: Object.freeze(artifactsByRepresentation),
    blocksByCodeArtifactId: Object.freeze(blocksByCodeArtifactId),
  });
}

function ensureGraphIndex(indexOrRecords, options = {}) {
  if (indexOrRecords && indexOrRecords.format === IMAGE_GRAPH_INDEX_V1) {
    return indexOrRecords;
  }
  return buildImageGraphIndex(indexOrRecords, options);
}

function traverseAdjacency(startIds, getNeighbors) {
  const visited = new Set();
  const queue = [...startIds];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of getNeighbors(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return dedupeSortedStrings(visited);
}

function findOutgoingReferences(indexOrRecords, sourceId, {transitive = false} = {}) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new TypeError('findOutgoingReferences requires a non-empty string sourceId');
  }
  const index = ensureGraphIndex(indexOrRecords);
  if (!transitive) {
    return index.outgoingLocalIdsById[sourceId] ?? Object.freeze([]);
  }
  return traverseAdjacency([sourceId], (id) => index.outgoingLocalIdsById[id]);
}

function findIncomingReferences(indexOrRecords, targetId, {transitive = false} = {}) {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new TypeError('findIncomingReferences requires a non-empty string targetId');
  }
  const index = ensureGraphIndex(indexOrRecords);
  if (!transitive) {
    return index.incomingLocalIdsById[targetId] ?? Object.freeze([]);
  }
  return traverseAdjacency([targetId], (id) => index.incomingLocalIdsById[id]);
}

function findDerivedArtifacts(indexOrRecords, sourceArtifactId, {transitive = true} = {}) {
  if (typeof sourceArtifactId !== 'string' || sourceArtifactId.length === 0) {
    throw new TypeError('findDerivedArtifacts requires a non-empty string sourceArtifactId');
  }
  const index = ensureGraphIndex(indexOrRecords);
  const artifactIds = transitive
    ? traverseAdjacency([sourceArtifactId], (id) => index.dependentsOfSourceByArtifactId[id])
    : index.dependentsOfSourceByArtifactId[sourceArtifactId] ?? Object.freeze([]);
  const artifacts = Object.freeze(
    artifactIds.map((id) => index.recordsById[id]).filter(Boolean),
  );
  const blockIds = [];
  for (const id of artifactIds) {
    for (const blockId of index.blocksByCodeArtifactId[id] ?? []) {
      blockIds.push(blockId);
    }
  }
  return Object.freeze({
    sourceArtifactId,
    artifactIds,
    artifacts,
    blocksReferencingDerived: dedupeSortedStrings(blockIds),
  });
}

function findArtifactSources(indexOrRecords, artifactId, {transitive = true} = {}) {
  if (typeof artifactId !== 'string' || artifactId.length === 0) {
    throw new TypeError('findArtifactSources requires a non-empty string artifactId');
  }
  const index = ensureGraphIndex(indexOrRecords);
  const sourceArtifactIds = transitive
    ? traverseAdjacency([artifactId], (id) => index.derivedFromByArtifactId[id])
    : index.derivedFromByArtifactId[artifactId] ?? Object.freeze([]);
  const sourceArtifacts = Object.freeze(
    sourceArtifactIds.map((id) => index.recordsById[id]).filter(Boolean),
  );
  return Object.freeze({
    artifactId,
    sourceArtifactIds,
    sourceArtifacts,
  });
}

function findArtifactDependents(indexOrRecords, targetArtifactId, {transitive = true} = {}) {
  if (typeof targetArtifactId !== 'string' || targetArtifactId.length === 0) {
    throw new TypeError('findArtifactDependents requires a non-empty string targetArtifactId');
  }
  const index = ensureGraphIndex(indexOrRecords);
  const directNeighbors = (id) =>
    (index.reverseDependenciesByArtifactId[id] ?? []).map((entry) => entry.dependentArtifactId);
  const dependentArtifactIds = transitive
    ? traverseAdjacency([targetArtifactId], directNeighbors)
    : dedupeSortedStrings(directNeighbors(targetArtifactId));
  const dependentArtifacts = Object.freeze(
    dependentArtifactIds.map((id) => index.recordsById[id]).filter(Boolean),
  );
  return Object.freeze({
    targetArtifactId,
    dependentArtifactIds,
    dependentArtifacts,
  });
}

function findArtifactsByLogicalPath(indexOrRecords, logicalPath) {
  if (typeof logicalPath !== 'string' || logicalPath.length === 0) {
    throw new TypeError('findArtifactsByLogicalPath requires a non-empty string logicalPath');
  }
  const index = ensureGraphIndex(indexOrRecords);
  const artifactIds = index.artifactsByLogicalPath[logicalPath] ?? Object.freeze([]);
  const artifacts = Object.freeze(
    artifactIds.map((id) => index.recordsById[id]).filter(Boolean),
  );
  return Object.freeze({
    logicalPath,
    artifactIds,
    artifacts,
  });
}

function discoverDefaultImageRoots(
  indexOrRecords,
  {imageId = null, imageRootObjectId = null, preserveSystemShapes = true} = {},
) {
  const index = ensureGraphIndex(indexOrRecords, {imageId});
  const roots = [];
  for (const id of index.recordIds) {
    const record = index.recordsById[id];
    if (isIntrinsicRootRecord(record, {imageRootObjectId, preserveSystemShapes})) {
      roots.push(id);
    }
  }
  return dedupeSortedStrings(roots);
}

function normalizeRootId(entry, imageId) {
  if (typeof entry === 'string' && entry.length > 0) {
    return entry;
  }
  if (isObjectRef(entry)) {
    if (imageId && entry.imageId !== imageId) {
      return null;
    }
    return entry.objectId;
  }
  if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0) {
    return entry.id;
  }
  throw new TypeError('root entry must be a record id string, ObjectRef, or record object');
}

function groupIdsByKind(ids, recordsById) {
  const buckets = new Map(DURABLE_RECORD_KINDS.map((kind) => [kind, []]));
  for (const id of ids) {
    const record = recordsById[id];
    if (record && buckets.has(record.kind)) {
      buckets.get(record.kind).push(id);
    }
  }
  const grouped = {};
  for (const kind of DURABLE_RECORD_KINDS) {
    grouped[kind] = dedupeSortedStrings(buckets.get(kind));
  }
  return Object.freeze(grouped);
}

function computeReachableImageClosure({
  records = null,
  index: providedIndex = null,
  imageId = null,
  imageRootObjectId = null,
  roots = [],
  includeDefaultRoots = true,
  preserveSystemShapes = true,
  includeDerivedArtifacts = false,
  pinnedRecordIds = [],
} = {}) {
  const index = providedIndex ?? ensureGraphIndex(records, {imageId});
  const resolvedImageId = imageId ?? index.imageId;

  if (!Array.isArray(roots)) {
    throw new TypeError('computeReachableImageClosure roots must be an array');
  }
  if (!Array.isArray(pinnedRecordIds)) {
    throw new TypeError('computeReachableImageClosure pinnedRecordIds must be an array');
  }

  const explicitRootIds = [];
  for (const entry of roots) {
    const normalized = normalizeRootId(entry, resolvedImageId);
    if (normalized && Object.hasOwn(index.recordsById, normalized)) {
      explicitRootIds.push(normalized);
    }
  }

  const normalizedPinnedIds = [];
  for (const entry of pinnedRecordIds) {
    const normalized = normalizeRootId(entry, resolvedImageId);
    if (normalized && Object.hasOwn(index.recordsById, normalized)) {
      normalizedPinnedIds.push(normalized);
    }
  }

  const defaultRootIds = includeDefaultRoots
    ? discoverDefaultImageRoots(index, {
        imageId: resolvedImageId,
        imageRootObjectId,
        preserveSystemShapes,
      })
    : Object.freeze([]);

  const rootIds = dedupeSortedStrings([
    ...defaultRootIds,
    ...explicitRootIds,
    ...normalizedPinnedIds,
  ]);

  const reachableSet = new Set(rootIds);
  const queue = [...rootIds];

  while (queue.length > 0) {
    const currentId = queue.shift();
    for (const targetId of index.outgoingLocalIdsById[currentId] ?? []) {
      if (!reachableSet.has(targetId)) {
        reachableSet.add(targetId);
        queue.push(targetId);
      }
    }
    if (includeDerivedArtifacts) {
      for (const derivedId of index.dependentsOfSourceByArtifactId[currentId] ?? []) {
        if (Object.hasOwn(index.recordsById, derivedId) && !reachableSet.has(derivedId)) {
          reachableSet.add(derivedId);
          queue.push(derivedId);
        }
      }
    }
  }

  const reachableIds = dedupeSortedStrings(reachableSet);
  const unreachableIds = dedupeSortedStrings(
    index.recordIds.filter((id) => !reachableSet.has(id)),
  );

  const externalRefs = [];
  for (const id of reachableIds) {
    for (const ref of index.outgoingExternalRefsById[id] ?? []) {
      externalRefs.push(ref);
    }
  }

  return Object.freeze({
    format: IMAGE_REACHABILITY_CLOSURE_V1,
    imageId: resolvedImageId,
    rootIds,
    defaultRootIds,
    explicitRootIds: dedupeSortedStrings(explicitRootIds),
    pinnedRecordIds: dedupeSortedStrings(normalizedPinnedIds),
    reachableIds,
    unreachableIds,
    reachableByKind: groupIdsByKind(reachableIds, index.recordsById),
    unreachableByKind: groupIdsByKind(unreachableIds, index.recordsById),
    reachableRecords: Object.freeze(reachableIds.map((id) => index.recordsById[id])),
    unreachableRecords: Object.freeze(unreachableIds.map((id) => index.recordsById[id])),
    externalRefs: dedupeSortedObjectRefs(externalRefs),
    index,
  });
}

async function planImageGarbageCollection({
  images,
  imageId,
  roots = [],
  pinnedFrontiers = [],
  includeDefaultRoots = true,
  preserveSystemShapes = true,
  includeDerivedArtifacts = false,
} = {}) {
  if (
    !images ||
    typeof images.getImage !== 'function' ||
    typeof images.listRecords !== 'function' ||
    typeof images.frontier !== 'function' ||
    typeof images.history !== 'function'
  ) {
    throw new TypeError(
      'planImageGarbageCollection requires an ImageService with getImage(), listRecords(), frontier(), and history()',
    );
  }
  if (typeof imageId !== 'string' || imageId.length === 0) {
    throw new TypeError('planImageGarbageCollection requires a non-empty string imageId');
  }
  if (!Array.isArray(pinnedFrontiers)) {
    throw new TypeError('planImageGarbageCollection pinnedFrontiers must be an array');
  }

  const image = await images.getImage(imageId);
  const currentFrontier = await images.frontier(imageId);
  const currentRecords = await images.listRecords(imageId);
  const currentIndex = buildImageGraphIndex(currentRecords, {imageId});

  const sortedPinnedFrontiers = [...new Set(pinnedFrontiers)].sort((a, b) => a - b);
  const pinnedFrontierIdSet = new Set();

  for (const frontier of sortedPinnedFrontiers) {
    const historicalRecords = await reconstructImageRecordsAtFrontier({
      images,
      imageId,
      frontier,
    });
    const historicalClosure = computeReachableImageClosure({
      records: historicalRecords,
      imageId,
      imageRootObjectId: image.rootObjectId ?? null,
      roots,
      includeDefaultRoots,
      preserveSystemShapes,
      includeDerivedArtifacts,
    });
    for (const id of historicalClosure.reachableIds) {
      if (Object.hasOwn(currentIndex.recordsById, id)) {
        pinnedFrontierIdSet.add(id);
      }
    }
  }

  const pinnedByFrontierIds = dedupeSortedStrings(pinnedFrontierIdSet);
  const closure = computeReachableImageClosure({
    index: currentIndex,
    imageId,
    imageRootObjectId: image.rootObjectId ?? null,
    roots,
    includeDefaultRoots,
    preserveSystemShapes,
    includeDerivedArtifacts,
    pinnedRecordIds: pinnedByFrontierIds,
  });

  return Object.freeze({
    format: IMAGE_GC_PLAN_V1,
    imageId,
    frontier: currentFrontier,
    pinnedFrontiers: Object.freeze(sortedPinnedFrontiers),
    rootIds: closure.rootIds,
    defaultRootIds: closure.defaultRootIds,
    explicitRootIds: closure.explicitRootIds,
    pinnedByFrontierIds,
    retainedIds: closure.reachableIds,
    sweptIds: closure.unreachableIds,
    retainedByKind: closure.reachableByKind,
    sweptByKind: closure.unreachableByKind,
    externalRefs: closure.externalRefs,
  });
}

async function collectUnreachableImageRecords({
  images,
  imageId,
  roots = [],
  pinnedFrontiers = [],
  includeDefaultRoots = true,
  preserveSystemShapes = true,
  includeDerivedArtifacts = false,
  reason = 'unreachable',
  dryRun = false,
} = {}) {
  const plan = await planImageGarbageCollection({
    images,
    imageId,
    roots,
    pinnedFrontiers,
    includeDefaultRoots,
    preserveSystemShapes,
    includeDerivedArtifacts,
  });

  let receipts = Object.freeze([]);
  if (!dryRun && plan.sweptIds.length > 0) {
    if (typeof images.sweepRecords !== 'function') {
      throw new TypeError('collectUnreachableImageRecords requires images.sweepRecords()');
    }
    receipts = await images.sweepRecords(imageId, plan.sweptIds, {reason});
  }

  const afterFrontier = await images.frontier(imageId);
  return Object.freeze({
    format: IMAGE_GC_RECEIPT_V1,
    imageId,
    dryRun: Boolean(dryRun),
    reason,
    beforeFrontier: plan.frontier,
    afterFrontier,
    sweptCount: plan.sweptIds.length,
    sweptIds: plan.sweptIds,
    retainedCount: plan.retainedIds.length,
    retainedIds: plan.retainedIds,
    pinnedFrontiers: plan.pinnedFrontiers,
    pinnedByFrontierIds: plan.pinnedByFrontierIds,
    plan,
    receipts,
  });
}

export {
  IMAGE_GC_PLAN_V1,
  IMAGE_GC_RECEIPT_V1,
  IMAGE_GRAPH_INDEX_V1,
  IMAGE_REACHABILITY_CLOSURE_V1,
  buildImageGraphIndex,
  collectUnreachableImageRecords,
  computeReachableImageClosure,
  discoverDefaultImageRoots,
  findArtifactDependents,
  findArtifactSources,
  findArtifactsByLogicalPath,
  findDerivedArtifacts,
  findIncomingReferences,
  findOutgoingReferences,
  planImageGarbageCollection,
};
