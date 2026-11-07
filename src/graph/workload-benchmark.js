import {
  buildImageGraphIndex,
  findArtifactsByLogicalPath,
  findDerivedArtifacts,
  findIncomingReferences,
  findOutgoingReferences,
} from './reachability.js';
import {referencesOfRecord} from './references.js';
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/scalars.js';

const WORKLOAD_BENCHMARK_REPORT_V1 = 'lagrange-workload-benchmark-report/v1';
const PARTITION_BENCHMARK_REPORT_V1 = 'lagrange-partition-benchmark-report/v1';
const MUTABLE_DOMAIN_CLOSURE_V1 = 'lagrange-mutable-domain-closure/v1';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function isSharedLanguageOrKernelObject(record) {
  if (!record || record.kind !== 'object') return true;
  const id = record.id ?? '';
  if (
    id === 'smalltalk-kernel/v1'
    || id === 'smalltalk/kernel'
    || id === 'smalltalk-global-namespace/v1'
    || id === 'smalltalk/globals'
    || id === 'smalltalk-block-protocol/v1'
    || id === 'smalltalk/block-protocol'
    || id === 'smalltalk-block-unwind/v1'
    || id === 'smalltalk/block-unwind'
    || id === 'smalltalk/symbol-table'
    || id === 'smalltalk/subclasses'
    || id.startsWith('smalltalk/class/')
    || id.startsWith('smalltalk/metaclass/')
    || id.startsWith('smalltalk/behavior/')
    || id.startsWith('smalltalk/method-dict/')
    || id.startsWith('smalltalk/symbol/')
    || id.startsWith('smalltalk/char/')
    || id.startsWith('smalltalk/global-binding/')
    || id.startsWith('lagrange-project/')
    || id.startsWith('lagrange-project-installation/')
    || id.endsWith('/namespace/v1')
  ) {
    return true;
  }
  const stMeta = record.metadata?.smalltalk;
  if (
    stMeta === 'behavior'
    || stMeta === 'singleton'
    || stMeta === 'class-state'
    || stMeta === 'subclass-registry'
    || stMeta === 'kernel-primitive'
    || stMeta === 'class'
    || stMeta === 'metaclass'
    || stMeta === 'method-dictionary'
    || stMeta === 'symbol'
    || stMeta === 'character'
  ) {
    return true;
  }
  const shapeId = record.shape?.objectId ?? '';
  if (
    shapeId.includes('behavior-shape')
    || shapeId.includes('class-shape')
    || shapeId.includes('metaclass-shape')
    || shapeId.includes('method-dictionary-shape')
    || shapeId.includes('symbol-shape')
    || shapeId.includes('character-shape')
    || shapeId.includes('global-namespace-shape')
    || shapeId.includes('global-binding-shape')
  ) {
    return true;
  }
  return false;
}

function collectObjectValueRefs(record) {
  if (!record || record.kind !== 'object') return [];
  const refs = [];
  for (const val of Object.values(record.slots ?? {})) {
    if (isObjectRef(val)) refs.push(val);
  }
  for (const val of record.indexed ?? []) {
    if (isObjectRef(val)) refs.push(val);
  }
  return refs;
}

async function discoverMutableDomainClosure({
  images,
  imageId,
  rootRef,
  maxDepth = 16,
} = {}) {
  const imgId = requiredText(imageId, 'imageId');
  const root = canonicalizeValue(rootRef);
  if (!isObjectRef(root)) {
    throw new TypeError('discoverMutableDomainClosure requires rootRef to be an ObjectRef');
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError('maxDepth must be a non-negative integer');
  }

  const visited = new Set();
  const closureRefs = [];
  const queue = [{ref: root, depth: 0}];

  while (queue.length > 0) {
    const {ref, depth} = queue.shift();
    if (ref.imageId !== imgId) continue;
    if (visited.has(ref.objectId)) continue;
    visited.add(ref.objectId);

    // eslint-disable-next-line no-await-in-loop
    const record = await images.getRecord(imgId, ref.objectId);
    if (!record || record.kind !== 'object') continue;
    if (ref.objectId !== root.objectId && isSharedLanguageOrKernelObject(record)) {
      continue;
    }

    closureRefs.push(objectRef(imgId, record.id));
    if (depth >= maxDepth) continue;

    for (const childRef of collectObjectValueRefs(record)) {
      if (childRef.imageId === imgId && !visited.has(childRef.objectId)) {
        queue.push({ref: childRef, depth: depth + 1});
      }
    }
  }

  return deepFreeze({
    format: MUTABLE_DOMAIN_CLOSURE_V1,
    imageId: imgId,
    rootRef: objectRef(root.imageId, root.objectId),
    objectIds: closureRefs.map((r) => r.objectId),
    refs: closureRefs,
  });
}

function resetAllNodeStats(placement) {
  for (const nodeId of placement.listNodes()) {
    const runtime = placement.getNodeRuntime(nodeId);
    if (typeof runtime?.images?.remoteResolution?.resetStats === 'function') {
      runtime.images.remoteResolution.resetStats();
    }
  }
}

function collectAllNodeStats(placement) {
  const statsByNode = {};
  let perObjectRecordReads = 0;
  let perObjectRecordWrites = 0;
  let wholeImageRecordReads = 0;
  let wholeImageRecordWrites = 0;
  let localRecordReads = 0;
  let localRecordWrites = 0;

  for (const nodeId of placement.listNodes()) {
    const runtime = placement.getNodeRuntime(nodeId);
    const raw = typeof runtime?.images?.remoteResolution?.stats === 'function'
      ? runtime.images.remoteResolution.stats()
      : {
          perObjectRecordReads: 0,
          perObjectRecordWrites: 0,
          wholeImageRecordReads: 0,
          wholeImageRecordWrites: 0,
          localRecordReads: 0,
          localRecordWrites: 0,
        };
    statsByNode[nodeId] = {...raw};
    perObjectRecordReads += raw.perObjectRecordReads ?? 0;
    perObjectRecordWrites += raw.perObjectRecordWrites ?? 0;
    wholeImageRecordReads += raw.wholeImageRecordReads ?? 0;
    wholeImageRecordWrites += raw.wholeImageRecordWrites ?? 0;
    localRecordReads += raw.localRecordReads ?? 0;
    localRecordWrites += raw.localRecordWrites ?? 0;
  }

  const totalRemoteRecordReads = perObjectRecordReads + wholeImageRecordReads;
  const totalRemoteRecordWrites = perObjectRecordWrites + wholeImageRecordWrites;
  return {
    statsByNode,
    perObjectRecordReads,
    perObjectRecordWrites,
    wholeImageRecordReads,
    wholeImageRecordWrites,
    localRecordReads,
    localRecordWrites,
    totalRemoteRecordReads,
    totalRemoteRecordWrites,
    totalRemoteRoundTrips: totalRemoteRecordReads + totalRemoteRecordWrites,
  };
}

async function runMessageSteps({
  placement,
  mode,
  fromNode,
  receiver,
  message,
  args,
  languageId,
  dispatchImage,
  steps,
  inspectState,
}) {
  const originRuntime = placement.getNodeRuntime(fromNode);
  if (!originRuntime) {
    throw new TypeError(`Unknown origin node ${fromNode}`);
  }
  const msgVal = typeof message === 'string' ? textValue(message) : canonicalizeValue(message);
  const states = [];
  if (typeof inspectState === 'function') {
    states.push(await inspectState());
  }

  resetAllNodeStats(placement);
  let targetNode = fromNode;
  for (let i = 0; i < steps; i += 1) {
    if (mode === 'remote-receiver') {
      // Execute directly on fromNode so remote receiver/closure reads and writes cross the node boundary
      // eslint-disable-next-line no-await-in-loop
      const activation = await originRuntime.invocations.sendMessage(
        {
          languageId,
          receiver,
          message: msgVal,
          arguments: args,
        },
        {dispatchImage: dispatchImage ?? receiver.imageId},
      );
      // eslint-disable-next-line no-await-in-loop
      await originRuntime.executor.execute(activation);
    } else if (mode === 'compute-near-object') {
      // Route execution to the node where receiver resides via PlacementPolicy.dispatchSend
      // eslint-disable-next-line no-await-in-loop
      const dispatched = await placement.dispatchSend({
        fromNode,
        languageId,
        receiver,
        message: msgVal,
        arguments: args,
        dispatchImage: dispatchImage ?? receiver.imageId,
      });
      targetNode = dispatched.node;
    } else {
      throw new TypeError(`Unsupported benchmark mode: ${mode}`);
    }
  }
  const aggregated = collectAllNodeStats(placement);

  if (typeof inspectState === 'function') {
    states.push(await inspectState());
  }

  return {
    mode,
    fromNode,
    targetNode,
    steps,
    states,
    ...aggregated,
  };
}

async function measureComputeNearObjectWorkload({
  placement,
  fromNode,
  receiver,
  message,
  arguments: args = [],
  languageId = 'symmetric-smalltalk',
  dispatchImage = null,
  steps = 2,
  inspectState = null,
} = {}) {
  if (
    !placement
    || typeof placement.listNodes !== 'function'
    || typeof placement.getNodeRuntime !== 'function'
  ) {
    throw new TypeError('measureComputeNearObjectWorkload requires a PlacementPolicy instance');
  }
  requiredText(fromNode, 'fromNode');
  const normalizedReceiver = canonicalizeValue(receiver);
  if (!isObjectRef(normalizedReceiver)) {
    throw new TypeError('receiver must be an ObjectRef');
  }
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new TypeError('steps must be a positive integer');
  }

  const remoteReceiverMode = await runMessageSteps({
    placement,
    mode: 'remote-receiver',
    fromNode,
    receiver: normalizedReceiver,
    message,
    args,
    languageId,
    dispatchImage,
    steps,
    inspectState,
  });

  const computeNearObjectMode = await runMessageSteps({
    placement,
    mode: 'compute-near-object',
    fromNode,
    receiver: normalizedReceiver,
    message,
    args,
    languageId,
    dispatchImage,
    steps,
    inspectState,
  });

  const remoteReadReduction =
    remoteReceiverMode.totalRemoteRecordReads - computeNearObjectMode.totalRemoteRecordReads;
  const remoteWriteReduction =
    remoteReceiverMode.totalRemoteRecordWrites - computeNearObjectMode.totalRemoteRecordWrites;
  const perObjectReadReduction =
    remoteReceiverMode.perObjectRecordReads - computeNearObjectMode.perObjectRecordReads;
  const perObjectWriteReduction =
    remoteReceiverMode.perObjectRecordWrites - computeNearObjectMode.perObjectRecordWrites;
  const roundTripReduction =
    remoteReceiverMode.totalRemoteRoundTrips - computeNearObjectMode.totalRemoteRoundTrips;

  const statesMatch =
    remoteReceiverMode.states.length === computeNearObjectMode.states.length
    && remoteReceiverMode.states.every((st, idx) => st === computeNearObjectMode.states[idx]);

  return deepFreeze({
    format: WORKLOAD_BENCHMARK_REPORT_V1,
    receiver: normalizedReceiver,
    fromNode,
    steps,
    remoteReceiverMode,
    computeNearObjectMode,
    comparison: {
      remoteReadReduction,
      remoteWriteReduction,
      perObjectReadReduction,
      perObjectWriteReduction,
      roundTripReduction,
      eliminatedAllPerObjectRoundTrips:
        computeNearObjectMode.perObjectRecordReads === 0
        && computeNearObjectMode.perObjectRecordWrites === 0
        && remoteReceiverMode.perObjectRecordReads + remoteReceiverMode.perObjectRecordWrites > 0,
      statesMatch,
    },
  });
}

async function evaluateImagePartitioningAndIndexing({
  images,
  imageId,
  domainRoots = [],
  sampleLookupIds = [],
  sampleLogicalPaths = [],
} = {}) {
  const imgId = requiredText(imageId, 'imageId');
  const currentRecords = await images.listRecords(imgId);
  const index = buildImageGraphIndex(currentRecords, {imageId: imgId});

  const closures = [];
  const domainObjectIdSet = new Set();
  for (const rootRef of domainRoots) {
    // eslint-disable-next-line no-await-in-loop
    const closure = await discoverMutableDomainClosure({
      images,
      imageId: imgId,
      rootRef,
    });
    closures.push(closure);
    for (const id of closure.objectIds) {
      domainObjectIdSet.add(id);
    }
  }

  // Classify every record into one of three partitions:
  // 1. 'mutable-domain': objects belonging to discovered mutable domain closures
  // 2. 'immutable-code-and-shapes': 'shape' and 'code-artifact' records
  // 3. 'shared-language-runtime': all remaining records (behaviors, classes, symbols, blocks, lexical environments)
  const partitionById = new Map();
  const partitionCounts = {
    'mutable-domain': 0,
    'immutable-code-and-shapes': 0,
    'shared-language-runtime': 0,
  };

  for (const [id, rec] of Object.entries(index.recordsById)) {
    let part;
    if (domainObjectIdSet.has(id)) {
      part = 'mutable-domain';
    } else if (rec.kind === 'shape' || rec.kind === 'code-artifact') {
      part = 'immutable-code-and-shapes';
    } else {
      part = 'shared-language-runtime';
    }
    partitionById.set(id, part);
    partitionCounts[part] += 1;
  }

  let totalEdges = 0;
  let internalEdges = 0;
  let crossPartitionEdges = 0;
  let mutableDomainInternalObjectEdges = 0;
  let mutableDomainToSharedRuntimeEdges = 0;
  let mutableDomainCrossCutEdges = 0;

  for (const [sourceId, targets] of Object.entries(index.outgoingRefsById)) {
    const sourcePart = partitionById.get(sourceId);
    const sourceRec = index.recordsById[sourceId];
    for (const targetRef of targets) {
      if (targetRef.imageId !== imgId) continue;
      const targetPart = partitionById.get(targetRef.objectId);
      if (!targetPart) continue;
      totalEdges += 1;
      if (sourcePart === targetPart) {
        internalEdges += 1;
      } else {
        crossPartitionEdges += 1;
      }
    }

    if (sourcePart === 'mutable-domain' && sourceRec?.kind === 'object') {
      for (const valRef of collectObjectValueRefs(sourceRec)) {
        if (valRef.imageId !== imgId) continue;
        const targetPart = partitionById.get(valRef.objectId);
        const targetRec = index.recordsById[valRef.objectId];
        if (targetPart === 'mutable-domain') {
          mutableDomainInternalObjectEdges += 1;
        } else if (targetRec && isSharedLanguageOrKernelObject(targetRec)) {
          mutableDomainToSharedRuntimeEdges += 1;
        } else if (targetPart) {
          mutableDomainCrossCutEdges += 1;
        }
      }
    }
  }

  const totalRecords = index.recordCount;
  const countsByKind = {};
  for (const [kind, ids] of Object.entries(index.recordIdsByKind)) {
    countsByKind[kind] = ids.length;
  }

  // Evaluate O(1) indexed lookups vs full-image linear scan
  const lookupTargets = sampleLookupIds.length > 0
    ? sampleLookupIds
    : Object.keys(index.recordsById).slice(0, Math.min(10, totalRecords));

  let indexedQueryCount = 0;
  let indexedRecordsInspected = 0;
  let linearScanRecordsInspected = 0;

  for (const targetId of lookupTargets) {
    findOutgoingReferences(index, targetId);
    findIncomingReferences(index, targetId);
    findDerivedArtifacts(index, targetId);
    indexedQueryCount += 3;
    indexedRecordsInspected += 3;
    linearScanRecordsInspected += totalRecords * 3;
  }

  for (const logicalPath of sampleLogicalPaths) {
    findArtifactsByLogicalPath(index, logicalPath);
    indexedQueryCount += 1;
    indexedRecordsInspected += 1;
    linearScanRecordsInspected += totalRecords;
  }

  // Verify that linear scan over referencesOfRecord yields the exact same incoming count for the first sample
  if (lookupTargets.length > 0) {
    const firstId = lookupTargets[0];
    const indexedIncoming = findIncomingReferences(index, firstId);
    let scannedCount = 0;
    for (const rec of Object.values(index.recordsById)) {
      const refs = referencesOfRecord(rec);
      if (refs.some((r) => r.imageId === imgId && r.objectId === firstId)) {
        scannedCount += 1;
      }
    }
    if (scannedCount !== indexedIncoming.length) {
      throw new Error(`Index incoming count mismatch for ${firstId}: ${indexedIncoming.length} vs ${scannedCount}`);
    }
  }

  const speedupFactor = indexedRecordsInspected > 0
    ? Number((linearScanRecordsInspected / indexedRecordsInspected).toFixed(2))
    : 1;

  return deepFreeze({
    format: PARTITION_BENCHMARK_REPORT_V1,
    imageId: imgId,
    totalRecords,
    countsByKind,
    domainClosures: closures,
    partitionAnalysis: {
      partitionCounts,
      totalEdges,
      internalEdges,
      crossPartitionEdges,
      cutRatio: totalEdges > 0 ? Number((crossPartitionEdges / totalEdges).toFixed(4)) : 0,
      mutableDomainInternalObjectEdges,
      mutableDomainToSharedRuntimeEdges,
      mutableDomainCrossCutEdges,
    },
    indexVsScan: {
      queryCount: indexedQueryCount,
      indexedRecordsInspected,
      linearScanRecordsInspected,
      speedupFactor,
    },
  });
}

export {
  MUTABLE_DOMAIN_CLOSURE_V1,
  PARTITION_BENCHMARK_REPORT_V1,
  WORKLOAD_BENCHMARK_REPORT_V1,
  discoverMutableDomainClosure,
  evaluateImagePartitioningAndIndexing,
  measureComputeNearObjectWorkload,
};
