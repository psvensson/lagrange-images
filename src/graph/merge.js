import {RELOCATED_RECORD_KIND, SWEPT_RECORD_KIND} from './locator.js';
import {normalizeRecordForDiff, reconstructImageRecordsAtFrontier} from './diff.js';
import {isObjectRef, objectRef} from '../value/index.js';

const IMAGE_RECORD_MERGE_V1 = 'lagrange-image-record-merge/v1';

const MERGE_CONFLICT_KINDS = Object.freeze({
  ADD_ADD: 'add-add',
  DELETE_MODIFY: 'delete-modify',
  KIND_CONFLICT: 'kind-conflict',
  OBJECT_CONFLICT: 'object-conflict',
  LEXICAL_ENVIRONMENT_CONFLICT: 'lexical-environment-conflict',
  RECORD_CONFLICT: 'record-conflict',
});

class MergeConflictError extends Error {
  constructor(message, {conflicts = []} = {}) {
    super(message);
    this.name = 'MergeConflictError';
    this.conflicts = Object.freeze([...conflicts]);
  }
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => canonicalClone(item)));
  }
  const result = {};
  for (const key of Object.keys(value).sort(compareText)) {
    if (value[key] !== undefined) {
      result[key] = canonicalClone(value[key]);
    }
  }
  return Object.freeze(result);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalClone(value));
}

function rehomeValueToImage(value, fromImageId, targetImageId) {
  if (!fromImageId || !targetImageId || fromImageId === targetImageId) {
    return canonicalClone(value);
  }
  if (isObjectRef(value)) {
    return value.imageId === fromImageId
      ? objectRef(targetImageId, value.objectId)
      : canonicalClone(value);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => rehomeValueToImage(item, fromImageId, targetImageId)));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort(compareText)) {
      if (value[key] !== undefined) {
        out[key] = rehomeValueToImage(value[key], fromImageId, targetImageId);
      }
    }
    return Object.freeze(out);
  }
  return value;
}

function rehomeRecordToImage(record, fromImageId, targetImageId) {
  const normalized = normalizeRecordForDiff(record);
  if (!fromImageId || !targetImageId || fromImageId === targetImageId) {
    return normalized;
  }
  const rehomed = rehomeValueToImage(normalized, fromImageId, targetImageId);
  if (typeof rehomed.imageId === 'string') {
    return canonicalClone({...rehomed, imageId: targetImageId});
  }
  return rehomed;
}

function indexRecordsById(records, label, fromImageId, targetImageId) {
  if (!Array.isArray(records)) {
    throw new TypeError(`${label} must be an array`);
  }
  const map = new Map();
  for (const raw of records) {
    if (raw?.kind === RELOCATED_RECORD_KIND || raw?.kind === SWEPT_RECORD_KIND) continue;
    const normalized = rehomeRecordToImage(raw, fromImageId, targetImageId);
    if (map.has(normalized.id)) {
      throw new TypeError(`duplicate record id in ${label}: ${normalized.id}`);
    }
    map.set(normalized.id, normalized);
  }
  return map;
}

function mergeKeyValueMapThreeWay(baseMap = {}, leftMap = {}, rightMap = {}) {
  const allKeys = [
    ...new Set([...Object.keys(baseMap), ...Object.keys(leftMap), ...Object.keys(rightMap)]),
  ].sort(compareText);
  const merged = {};
  const conflicts = [];

  for (const key of allKeys) {
    const hasBase = Object.hasOwn(baseMap, key);
    const hasLeft = Object.hasOwn(leftMap, key);
    const hasRight = Object.hasOwn(rightMap, key);
    const baseVal = hasBase ? baseMap[key] : undefined;
    const leftVal = hasLeft ? leftMap[key] : undefined;
    const rightVal = hasRight ? rightMap[key] : undefined;

    const leftSameAsBase = hasLeft === hasBase && canonicalJson(leftVal) === canonicalJson(baseVal);
    const rightSameAsBase = hasRight === hasBase && canonicalJson(rightVal) === canonicalJson(baseVal);
    const leftSameAsRight = hasLeft === hasRight && canonicalJson(leftVal) === canonicalJson(rightVal);

    if (leftSameAsBase) {
      if (hasRight) merged[key] = canonicalClone(rightVal);
      continue;
    }
    if (rightSameAsBase) {
      if (hasLeft) merged[key] = canonicalClone(leftVal);
      continue;
    }
    if (leftSameAsRight) {
      if (hasLeft) merged[key] = canonicalClone(leftVal);
      continue;
    }
    conflicts.push(
      Object.freeze({
        key,
        base: hasBase ? canonicalClone(baseVal) : null,
        left: hasLeft ? canonicalClone(leftVal) : null,
        right: hasRight ? canonicalClone(rightVal) : null,
      }),
    );
    if (hasBase) {
      merged[key] = canonicalClone(baseVal);
    }
  }

  return {
    merged: Object.freeze(merged),
    conflicts: Object.freeze(conflicts),
  };
}

function mergeIndexedArrayThreeWay(baseIndexed, leftIndexed, rightIndexed) {
  const leftSameAsBase = canonicalJson(leftIndexed) === canonicalJson(baseIndexed);
  const rightSameAsBase = canonicalJson(rightIndexed) === canonicalJson(baseIndexed);
  const leftSameAsRight = canonicalJson(leftIndexed) === canonicalJson(rightIndexed);

  if (leftSameAsBase) {
    return {merged: rightIndexed ? canonicalClone(rightIndexed) : undefined, conflict: null};
  }
  if (rightSameAsBase || leftSameAsRight) {
    return {merged: leftIndexed ? canonicalClone(leftIndexed) : undefined, conflict: null};
  }

  if (
    Array.isArray(baseIndexed) &&
    Array.isArray(leftIndexed) &&
    Array.isArray(rightIndexed) &&
    baseIndexed.length === leftIndexed.length &&
    baseIndexed.length === rightIndexed.length
  ) {
    const mergedElements = [];
    const elementConflicts = [];
    for (let index = 0; index < baseIndexed.length; index += 1) {
      const bElem = baseIndexed[index];
      const lElem = leftIndexed[index];
      const rElem = rightIndexed[index];
      const lUnchanged = canonicalJson(lElem) === canonicalJson(bElem);
      const rUnchanged = canonicalJson(rElem) === canonicalJson(bElem);
      const lrSame = canonicalJson(lElem) === canonicalJson(rElem);
      if (lUnchanged) {
        mergedElements.push(canonicalClone(rElem));
      } else if (rUnchanged || lrSame) {
        mergedElements.push(canonicalClone(lElem));
      } else {
        elementConflicts.push(
          Object.freeze({
            index,
            base: canonicalClone(bElem),
            left: canonicalClone(lElem),
            right: canonicalClone(rElem),
          }),
        );
        mergedElements.push(canonicalClone(bElem));
      }
    }
    if (elementConflicts.length === 0) {
      return {merged: Object.freeze(mergedElements), conflict: null};
    }
    return {
      merged: Object.freeze(mergedElements),
      conflict: Object.freeze({
        base: canonicalClone(baseIndexed),
        left: canonicalClone(leftIndexed),
        right: canonicalClone(rightIndexed),
        elementConflicts: Object.freeze(elementConflicts),
      }),
    };
  }

  return {
    merged: baseIndexed ? canonicalClone(baseIndexed) : undefined,
    conflict: Object.freeze({
      base: baseIndexed ? canonicalClone(baseIndexed) : null,
      left: leftIndexed ? canonicalClone(leftIndexed) : null,
      right: rightIndexed ? canonicalClone(rightIndexed) : null,
      elementConflicts: Object.freeze([]),
    }),
  };
}

function mergeScalarFieldThreeWay(baseVal, leftVal, rightVal) {
  const leftSameAsBase = canonicalJson(leftVal) === canonicalJson(baseVal);
  const rightSameAsBase = canonicalJson(rightVal) === canonicalJson(baseVal);
  const leftSameAsRight = canonicalJson(leftVal) === canonicalJson(rightVal);

  if (leftSameAsBase) {
    return {merged: canonicalClone(rightVal), conflict: null};
  }
  if (rightSameAsBase || leftSameAsRight) {
    return {merged: canonicalClone(leftVal), conflict: null};
  }
  return {
    merged: canonicalClone(baseVal),
    conflict: Object.freeze({
      base: canonicalClone(baseVal ?? null),
      left: canonicalClone(leftVal ?? null),
      right: canonicalClone(rightVal ?? null),
    }),
  };
}

function mergeObjectRecordThreeWay(base, left, right) {
  const shapeResult = mergeScalarFieldThreeWay(base.shape, left.shape, right.shape);
  const behaviorResult = mergeScalarFieldThreeWay(
    base.behavior ?? null,
    left.behavior ?? null,
    right.behavior ?? null,
  );
  const slotsResult = mergeKeyValueMapThreeWay(base.slots ?? {}, left.slots ?? {}, right.slots ?? {});
  const indexedResult = mergeIndexedArrayThreeWay(base.indexed, left.indexed, right.indexed);
  const metadataResult = mergeKeyValueMapThreeWay(
    base.metadata ?? {},
    left.metadata ?? {},
    right.metadata ?? {},
  );

  const slotConflicts = slotsResult.conflicts.map(({key, base: b, left: l, right: r}) =>
    Object.freeze({slotId: key, base: b, left: l, right: r}),
  );
  const metadataConflicts = metadataResult.conflicts;

  const hasConflict =
    shapeResult.conflict !== null ||
    behaviorResult.conflict !== null ||
    slotConflicts.length > 0 ||
    indexedResult.conflict !== null ||
    metadataConflicts.length > 0;

  const mergedRecord = canonicalClone({
    ...base,
    shape: shapeResult.merged,
    behavior: behaviorResult.merged,
    slots: slotsResult.merged,
    ...(indexedResult.merged !== undefined ? {indexed: indexedResult.merged} : {}),
    metadata: metadataResult.merged,
  });

  if (!hasConflict) {
    return {mergedRecord, conflict: null};
  }

  return {
    mergedRecord,
    conflict: Object.freeze({
      id: base.id,
      kind: 'object',
      conflictKind: MERGE_CONFLICT_KINDS.OBJECT_CONFLICT,
      base,
      left,
      right,
      shapeConflict: shapeResult.conflict,
      behaviorConflict: behaviorResult.conflict,
      slotConflicts: Object.freeze(slotConflicts),
      indexedConflict: indexedResult.conflict,
      metadataConflicts: Object.freeze(metadataConflicts),
    }),
  };
}

function mergeLexicalEnvironmentRecordThreeWay(base, left, right) {
  const parentResult = mergeScalarFieldThreeWay(
    base.parent ?? null,
    left.parent ?? null,
    right.parent ?? null,
  );
  const bindingsResult = mergeKeyValueMapThreeWay(
    base.bindings ?? {},
    left.bindings ?? {},
    right.bindings ?? {},
  );
  const metadataResult = mergeKeyValueMapThreeWay(
    base.metadata ?? {},
    left.metadata ?? {},
    right.metadata ?? {},
  );

  const bindingConflicts = bindingsResult.conflicts.map(({key, base: b, left: l, right: r}) =>
    Object.freeze({bindingId: key, base: b, left: l, right: r}),
  );
  const metadataConflicts = metadataResult.conflicts;

  const hasConflict =
    parentResult.conflict !== null ||
    bindingConflicts.length > 0 ||
    metadataConflicts.length > 0;

  const mergedRecord = canonicalClone({
    ...base,
    parent: parentResult.merged,
    bindings: bindingsResult.merged,
    metadata: metadataResult.merged,
  });

  if (!hasConflict) {
    return {mergedRecord, conflict: null};
  }

  return {
    mergedRecord,
    conflict: Object.freeze({
      id: base.id,
      kind: 'lexical-environment',
      conflictKind: MERGE_CONFLICT_KINDS.LEXICAL_ENVIRONMENT_CONFLICT,
      base,
      left,
      right,
      parentConflict: parentResult.conflict,
      bindingConflicts: Object.freeze(bindingConflicts),
      metadataConflicts: Object.freeze(metadataConflicts),
    }),
  };
}

function applyConflictResolution(conflict, resolution, targetImageId) {
  if (resolution === 'left') {
    return conflict.left ? canonicalClone(conflict.left) : null;
  }
  if (resolution === 'right') {
    return conflict.right ? canonicalClone(conflict.right) : null;
  }
  if (resolution === 'base') {
    return conflict.base ? canonicalClone(conflict.base) : null;
  }
  if (resolution && typeof resolution === 'object') {
    return rehomeRecordToImage(resolution, resolution.imageId ?? null, targetImageId);
  }
  throw new TypeError(
    `invalid merge conflict resolution for ${conflict.id}: expected 'left', 'right', 'base', or a record object`,
  );
}

function mergeImageRecords({
  baseRecords,
  leftRecords,
  rightRecords,
  baseImageId = null,
  leftImageId = baseImageId,
  rightImageId = baseImageId,
  targetImageId = baseImageId ?? leftImageId ?? rightImageId ?? null,
  baseFrontier = null,
  leftFrontier = null,
  rightFrontier = null,
  resolutions = {},
} = {}) {
  if (resolutions !== null && typeof resolutions !== 'object') {
    throw new TypeError('resolutions must be an object map');
  }
  const resolutionMap = resolutions ?? {};

  const baseMap = indexRecordsById(baseRecords, 'baseRecords', baseImageId, targetImageId);
  const leftMap = indexRecordsById(leftRecords, 'leftRecords', leftImageId, targetImageId);
  const rightMap = indexRecordsById(rightRecords, 'rightRecords', rightImageId, targetImageId);

  const allIds = [
    ...new Set([...baseMap.keys(), ...leftMap.keys(), ...rightMap.keys()]),
  ].sort(compareText);

  const mergedRecords = [];
  const appliedChanges = [];
  const removedIds = [];
  const conflicts = [];
  let unchangedCount = 0;

  for (const id of allIds) {
    const base = baseMap.get(id) ?? null;
    const left = leftMap.get(id) ?? null;
    const right = rightMap.get(id) ?? null;

    // Case 1: Absent in base (addition on left, right, or both)
    if (!base) {
      if (left && !right) {
        mergedRecords.push(left);
        appliedChanges.push(Object.freeze({id, kind: left.kind, action: 'added-left', record: left}));
        continue;
      }
      if (!left && right) {
        mergedRecords.push(right);
        appliedChanges.push(Object.freeze({id, kind: right.kind, action: 'added-right', record: right}));
        continue;
      }
      if (left && right) {
        if (canonicalJson(left) === canonicalJson(right)) {
          mergedRecords.push(left);
          appliedChanges.push(Object.freeze({id, kind: left.kind, action: 'added-both', record: left}));
          continue;
        }
        const conflict = Object.freeze({
          id,
          kind: left.kind === right.kind ? left.kind : `${left.kind}|${right.kind}`,
          conflictKind: MERGE_CONFLICT_KINDS.ADD_ADD,
          base: null,
          left,
          right,
        });
        if (Object.hasOwn(resolutionMap, id)) {
          const resolved = applyConflictResolution(conflict, resolutionMap[id], targetImageId);
          if (resolved) {
            mergedRecords.push(resolved);
            appliedChanges.push(
              Object.freeze({id, kind: resolved.kind, action: 'resolved-conflict', record: resolved}),
            );
          } else {
            removedIds.push(id);
          }
        } else {
          conflicts.push(conflict);
        }
      }
      continue;
    }

    // Case 2: Present in base, deleted on both sides
    if (!left && !right) {
      removedIds.push(id);
      appliedChanges.push(Object.freeze({id, kind: base.kind, action: 'removed-both', record: null}));
      continue;
    }

    // Case 3: Present in base, deleted on left only
    if (!left && right) {
      if (canonicalJson(right) === canonicalJson(base)) {
        removedIds.push(id);
        appliedChanges.push(Object.freeze({id, kind: base.kind, action: 'removed-left', record: null}));
        continue;
      }
      const conflict = Object.freeze({
        id,
        kind: base.kind,
        conflictKind: MERGE_CONFLICT_KINDS.DELETE_MODIFY,
        deletedSide: 'left',
        modifiedSide: 'right',
        base,
        left: null,
        right,
      });
      if (Object.hasOwn(resolutionMap, id)) {
        const resolved = applyConflictResolution(conflict, resolutionMap[id], targetImageId);
        if (resolved) {
          mergedRecords.push(resolved);
          appliedChanges.push(
            Object.freeze({id, kind: resolved.kind, action: 'resolved-conflict', record: resolved}),
          );
        } else {
          removedIds.push(id);
          appliedChanges.push(
            Object.freeze({id, kind: base.kind, action: 'resolved-conflict', record: null}),
          );
        }
      } else {
        conflicts.push(conflict);
        mergedRecords.push(base);
      }
      continue;
    }

    // Case 4: Present in base, deleted on right only
    if (left && !right) {
      if (canonicalJson(left) === canonicalJson(base)) {
        removedIds.push(id);
        appliedChanges.push(Object.freeze({id, kind: base.kind, action: 'removed-right', record: null}));
        continue;
      }
      const conflict = Object.freeze({
        id,
        kind: base.kind,
        conflictKind: MERGE_CONFLICT_KINDS.DELETE_MODIFY,
        deletedSide: 'right',
        modifiedSide: 'left',
        base,
        left,
        right: null,
      });
      if (Object.hasOwn(resolutionMap, id)) {
        const resolved = applyConflictResolution(conflict, resolutionMap[id], targetImageId);
        if (resolved) {
          mergedRecords.push(resolved);
          appliedChanges.push(
            Object.freeze({id, kind: resolved.kind, action: 'resolved-conflict', record: resolved}),
          );
        } else {
          removedIds.push(id);
          appliedChanges.push(
            Object.freeze({id, kind: base.kind, action: 'resolved-conflict', record: null}),
          );
        }
      } else {
        conflicts.push(conflict);
        mergedRecords.push(base);
      }
      continue;
    }

    // Case 5: Present in base, left, and right
    const leftUnchanged = canonicalJson(left) === canonicalJson(base);
    const rightUnchanged = canonicalJson(right) === canonicalJson(base);
    const leftEqualsRight = canonicalJson(left) === canonicalJson(right);

    if (leftUnchanged && rightUnchanged) {
      unchangedCount += 1;
      mergedRecords.push(base);
      continue;
    }
    if (leftUnchanged && !rightUnchanged) {
      mergedRecords.push(right);
      appliedChanges.push(Object.freeze({id, kind: right.kind, action: 'modified-right', record: right}));
      continue;
    }
    if (!leftUnchanged && rightUnchanged) {
      mergedRecords.push(left);
      appliedChanges.push(Object.freeze({id, kind: left.kind, action: 'modified-left', record: left}));
      continue;
    }
    if (leftEqualsRight) {
      mergedRecords.push(left);
      appliedChanges.push(
        Object.freeze({id, kind: left.kind, action: 'modified-both-identical', record: left}),
      );
      continue;
    }

    // Both left and right modified the record differently
    if (left.kind !== right.kind || left.kind !== base.kind) {
      const conflict = Object.freeze({
        id,
        kind: `${left.kind}|${right.kind}`,
        conflictKind: MERGE_CONFLICT_KINDS.KIND_CONFLICT,
        base,
        left,
        right,
      });
      if (Object.hasOwn(resolutionMap, id)) {
        const resolved = applyConflictResolution(conflict, resolutionMap[id], targetImageId);
        if (resolved) {
          mergedRecords.push(resolved);
          appliedChanges.push(
            Object.freeze({id, kind: resolved.kind, action: 'resolved-conflict', record: resolved}),
          );
        }
      } else {
        conflicts.push(conflict);
        mergedRecords.push(base);
      }
      continue;
    }

    if (base.kind === 'object') {
      const {mergedRecord, conflict} = mergeObjectRecordThreeWay(base, left, right);
      if (!conflict) {
        mergedRecords.push(mergedRecord);
        appliedChanges.push(
          Object.freeze({id, kind: 'object', action: 'merged-object', record: mergedRecord}),
        );
      } else if (Object.hasOwn(resolutionMap, id)) {
        const resolved = applyConflictResolution(conflict, resolutionMap[id], targetImageId);
        if (resolved) {
          mergedRecords.push(resolved);
          appliedChanges.push(
            Object.freeze({id, kind: resolved.kind, action: 'resolved-conflict', record: resolved}),
          );
        }
      } else {
        conflicts.push(conflict);
        mergedRecords.push(mergedRecord);
      }
      continue;
    }

    if (base.kind === 'lexical-environment') {
      const {mergedRecord, conflict} = mergeLexicalEnvironmentRecordThreeWay(base, left, right);
      if (!conflict) {
        mergedRecords.push(mergedRecord);
        appliedChanges.push(
          Object.freeze({
            id,
            kind: 'lexical-environment',
            action: 'merged-lexical-environment',
            record: mergedRecord,
          }),
        );
      } else if (Object.hasOwn(resolutionMap, id)) {
        const resolved = applyConflictResolution(conflict, resolutionMap[id], targetImageId);
        if (resolved) {
          mergedRecords.push(resolved);
          appliedChanges.push(
            Object.freeze({id, kind: resolved.kind, action: 'resolved-conflict', record: resolved}),
          );
        }
      } else {
        conflicts.push(conflict);
        mergedRecords.push(mergedRecord);
      }
      continue;
    }

    // Atomic/immutable records (shape, code-artifact, block) modified divergently
    const fieldKeys = [
      ...new Set([...Object.keys(base), ...Object.keys(left), ...Object.keys(right)]),
    ]
      .filter((key) => key !== 'id' && key !== 'imageId' && key !== 'kind')
      .sort(compareText);
    const conflictingFields = fieldKeys.filter(
      (key) => canonicalJson(left[key]) !== canonicalJson(right[key]),
    );
    const conflict = Object.freeze({
      id,
      kind: base.kind,
      conflictKind: MERGE_CONFLICT_KINDS.RECORD_CONFLICT,
      base,
      left,
      right,
      conflictingFields: Object.freeze(conflictingFields),
    });
    if (Object.hasOwn(resolutionMap, id)) {
      const resolved = applyConflictResolution(conflict, resolutionMap[id], targetImageId);
      if (resolved) {
        mergedRecords.push(resolved);
        appliedChanges.push(
          Object.freeze({id, kind: resolved.kind, action: 'resolved-conflict', record: resolved}),
        );
      }
    } else {
      conflicts.push(conflict);
      mergedRecords.push(base);
    }
  }

  return Object.freeze({
    format: IMAGE_RECORD_MERGE_V1,
    baseImageId,
    leftImageId,
    rightImageId,
    targetImageId,
    baseFrontier,
    leftFrontier,
    rightFrontier,
    clean: conflicts.length === 0,
    unchangedCount,
    mergedRecords: Object.freeze(mergedRecords),
    appliedChanges: Object.freeze(appliedChanges),
    removedIds: Object.freeze(removedIds),
    conflicts: Object.freeze(conflicts),
  });
}

async function mergeImageFrontiers({
  images,
  imageId,
  baseFrontier,
  leftFrontier,
  rightFrontier,
  resolutions = {},
} = {}) {
  if (!images || typeof images.frontier !== 'function' || typeof images.history !== 'function') {
    throw new TypeError('mergeImageFrontiers requires an ImageService with frontier() and history()');
  }
  if (typeof imageId !== 'string' || imageId.length === 0) {
    throw new TypeError('imageId must be a non-empty string');
  }
  const [baseRecords, leftRecords, rightRecords] = await Promise.all([
    reconstructImageRecordsAtFrontier({images, imageId, frontier: baseFrontier}),
    reconstructImageRecordsAtFrontier({images, imageId, frontier: leftFrontier}),
    reconstructImageRecordsAtFrontier({images, imageId, frontier: rightFrontier}),
  ]);
  return mergeImageRecords({
    baseRecords,
    leftRecords,
    rightRecords,
    baseImageId: imageId,
    leftImageId: imageId,
    rightImageId: imageId,
    targetImageId: imageId,
    baseFrontier: Number(baseFrontier),
    leftFrontier: Number(leftFrontier),
    rightFrontier: Number(rightFrontier),
    resolutions,
  });
}

const KIND_APPLY_ORDER = Object.freeze({
  shape: 1,
  'code-artifact': 2,
  'lexical-environment': 3,
  block: 4,
  object: 5,
});

async function applySingleMergedRecord(images, targetImageId, record) {
  const rehomed = rehomeRecordToImage(record, record.imageId ?? null, targetImageId);
  switch (rehomed.kind) {
    case 'shape': {
      const existing = await images.getShape(targetImageId, rehomed.id);
      if (existing && canonicalJson(normalizeRecordForDiff(existing)) === canonicalJson(rehomed)) {
        return existing;
      }
      return await images.putShape(targetImageId, {
        id: rehomed.id,
        slots: rehomed.slots,
        ...(Object.hasOwn(rehomed, 'indexed') ? {indexed: rehomed.indexed} : {}),
        metadata: rehomed.metadata ?? {},
      });
    }
    case 'code-artifact': {
      const existing = await images.getCodeArtifact(targetImageId, rehomed.id);
      if (existing && canonicalJson(normalizeRecordForDiff(existing)) === canonicalJson(rehomed)) {
        return existing;
      }
      return await images.putCodeArtifact(targetImageId, {
        id: rehomed.id,
        languageId: rehomed.languageId ?? null,
        representation: rehomed.representation,
        content: rehomed.content,
        logicalPath: rehomed.logicalPath ?? null,
        dependencies: rehomed.dependencies ?? [],
        derivedFrom: rehomed.derivedFrom ?? [],
        metadata: rehomed.metadata ?? {},
      });
    }
    case 'lexical-environment': {
      const existing = await images.getLexicalEnvironment(targetImageId, rehomed.id);
      if (existing && canonicalJson(normalizeRecordForDiff(existing)) === canonicalJson(rehomed)) {
        return existing;
      }
      return await images.putLexicalEnvironment(targetImageId, {
        id: rehomed.id,
        parent: rehomed.parent ?? null,
        bindings: rehomed.bindings ?? {},
        metadata: rehomed.metadata ?? {},
      });
    }
    case 'block': {
      const existing = await images.getBlock(targetImageId, rehomed.id);
      if (existing && canonicalJson(normalizeRecordForDiff(existing)) === canonicalJson(rehomed)) {
        return existing;
      }
      return await images.putBlock(targetImageId, {
        id: rehomed.id,
        code: rehomed.code,
        environment: rehomed.environment ?? null,
        metadata: rehomed.metadata ?? {},
      });
    }
    case 'object': {
      const existing = await images.getObject(targetImageId, rehomed.id);
      if (existing && canonicalJson(normalizeRecordForDiff(existing)) === canonicalJson(rehomed)) {
        return existing;
      }
      return await images.putObject(targetImageId, {
        id: rehomed.id,
        shape: rehomed.shape,
        behavior: rehomed.behavior ?? null,
        slots: rehomed.slots ?? {},
        ...(Object.hasOwn(rehomed, 'indexed') ? {indexed: rehomed.indexed} : {}),
        metadata: rehomed.metadata ?? {},
      });
    }
    default:
      throw new TypeError(`unsupported record kind in applyImageMerge: ${rehomed.kind}`);
  }
}

async function applyImageMerge({
  images,
  targetImageId,
  mergePlan,
  allowConflicts = false,
} = {}) {
  if (!images || typeof images.putObject !== 'function') {
    throw new TypeError('applyImageMerge requires an ImageService');
  }
  if (typeof targetImageId !== 'string' || targetImageId.length === 0) {
    throw new TypeError('targetImageId must be a non-empty string');
  }
  if (!mergePlan || mergePlan.format !== IMAGE_RECORD_MERGE_V1) {
    throw new TypeError(`mergePlan must be a ${IMAGE_RECORD_MERGE_V1} descriptor`);
  }
  if (!mergePlan.clean && !allowConflicts) {
    throw new MergeConflictError(
      `cannot apply image merge with ${mergePlan.conflicts.length} unresolved conflict(s)`,
      {conflicts: mergePlan.conflicts},
    );
  }

  const recordsToWrite = mergePlan.appliedChanges
    .filter((change) => change.record !== null)
    .map((change) => change.record)
    .sort((a, b) => {
      const orderDiff = (KIND_APPLY_ORDER[a.kind] ?? 99) - (KIND_APPLY_ORDER[b.kind] ?? 99);
      return orderDiff !== 0 ? orderDiff : compareText(a.id, b.id);
    });

  const written = [];
  for (const record of recordsToWrite) {
    const saved = await applySingleMergedRecord(images, targetImageId, record);
    written.push(saved);
  }

  return Object.freeze({
    targetImageId,
    appliedCount: written.length,
    writtenIds: Object.freeze(written.map((r) => r.id)),
  });
}

export {
  IMAGE_RECORD_MERGE_V1,
  MERGE_CONFLICT_KINDS,
  MergeConflictError,
  applyImageMerge,
  mergeImageFrontiers,
  mergeImageRecords,
  rehomeRecordToImage,
};
