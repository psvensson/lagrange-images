import {canonicalizeValue, isObjectRef, objectRef} from '../value/index.js';
import {
  SHAPE_INDEXED,
  assertObjectMatchesShape,
  assertShapeRecord,
  createObjectRecord,
  shapeIndexedKind,
} from './model.js';

const IMAGE_SHAPE_MIGRATION_PLAN_V1 = 'lagrange-image-shape-migration-plan/v1';
const IMAGE_SHAPE_MIGRATION_RECEIPT_V1 = 'lagrange-image-shape-migration-receipt/v1';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeShapeIdInput(shapeOrId, label) {
  if (typeof shapeOrId === 'string' && shapeOrId.length > 0) return shapeOrId;
  if (isObjectRef(shapeOrId)) return shapeOrId.objectId;
  if (shapeOrId && typeof shapeOrId === 'object' && typeof shapeOrId.id === 'string' && shapeOrId.id.length > 0) {
    return shapeOrId.id;
  }
  throw new TypeError(`${label} must be a non-empty shape id, shape ObjectRef, or shape record`);
}

function buildShapeSlotMigrationPlan({
  fromShape,
  toShape,
  slotMapping = {},
  defaultSlotValues = {},
  defaultSlotValue = null,
  allowDropIndexed = false,
} = {}) {
  assertShapeRecord(fromShape);
  assertShapeRecord(toShape);
  if (!slotMapping || typeof slotMapping !== 'object' || Array.isArray(slotMapping)) {
    throw new TypeError('slotMapping must be a plain object');
  }
  if (!defaultSlotValues || typeof defaultSlotValues !== 'object' || Array.isArray(defaultSlotValues)) {
    throw new TypeError('defaultSlotValues must be a plain object');
  }

  const fromIndexed = shapeIndexedKind(fromShape);
  const toIndexed = shapeIndexedKind(toShape);
  if (fromIndexed === SHAPE_INDEXED.VALUES && toIndexed === SHAPE_INDEXED.NONE && !allowDropIndexed) {
    throw new TypeError(
      `shape migration from ${fromShape.id} to ${toShape.id} drops indexed values storage without allowDropIndexed`,
    );
  }

  const fromSlotById = new Map(fromShape.slots.map((slot) => [slot.id, slot]));
  const fromSlotByName = new Map();
  for (const slot of fromShape.slots) {
    if (!fromSlotByName.has(slot.name)) {
      fromSlotByName.set(slot.name, slot);
    }
  }

  const mappedSourceSlotIds = new Set();
  const slotActions = [];

  for (const targetSlot of toShape.slots) {
    const explicitKey = Object.hasOwn(slotMapping, targetSlot.id)
      ? slotMapping[targetSlot.id]
      : Object.hasOwn(slotMapping, targetSlot.name)
        ? slotMapping[targetSlot.name]
        : null;

    let sourceSlot = null;
    if (explicitKey !== null && explicitKey !== undefined) {
      requiredText(explicitKey, `slotMapping target for ${targetSlot.name}`);
      sourceSlot = fromSlotById.get(explicitKey) ?? fromSlotByName.get(explicitKey) ?? null;
      if (!sourceSlot) {
        throw new TypeError(
          `slotMapping for target slot ${targetSlot.name} (${targetSlot.id}) references missing source slot ${explicitKey} in shape ${fromShape.id}`,
        );
      }
    } else {
      sourceSlot = fromSlotById.get(targetSlot.id) ?? fromSlotByName.get(targetSlot.name) ?? null;
    }

    if (sourceSlot) {
      mappedSourceSlotIds.add(sourceSlot.id);
      slotActions.push(
        Object.freeze({
          targetSlotId: targetSlot.id,
          targetSlotName: targetSlot.name,
          action: 'copy',
          sourceSlotId: sourceSlot.id,
          sourceSlotName: sourceSlot.name,
        }),
      );
    } else {
      const rawDefault = Object.hasOwn(defaultSlotValues, targetSlot.id)
        ? defaultSlotValues[targetSlot.id]
        : Object.hasOwn(defaultSlotValues, targetSlot.name)
          ? defaultSlotValues[targetSlot.name]
          : defaultSlotValue;
      if (rawDefault === null || rawDefault === undefined) {
        throw new TypeError(
          `new slot ${targetSlot.name} (${targetSlot.id}) in shape ${toShape.id} requires a default Value in defaultSlotValues or defaultSlotValue`,
        );
      }
      const canonicalDefault = canonicalizeValue(rawDefault);
      slotActions.push(
        Object.freeze({
          targetSlotId: targetSlot.id,
          targetSlotName: targetSlot.name,
          action: 'initialize',
          defaultValue: canonicalDefault,
        }),
      );
    }
  }

  const removedSlots = fromShape.slots
    .filter((slot) => !mappedSourceSlotIds.has(slot.id))
    .map((slot) => Object.freeze({id: slot.id, name: slot.name}));

  return Object.freeze({
    fromShapeId: fromShape.id,
    toShapeId: toShape.id,
    fromIndexed,
    toIndexed,
    slotActions: Object.freeze(slotActions),
    removedSlots: Object.freeze(removedSlots),
  });
}

function migrateObjectRecordToShape(
  objectRecord,
  {
    fromShape,
    toShape,
    slotMapping = {},
    defaultSlotValues = {},
    defaultSlotValue = null,
    allowDropIndexed = false,
    _compiledPlan = null,
  } = {},
) {
  assertObjectMatchesShape(objectRecord, fromShape);
  assertShapeRecord(toShape);

  const plan =
    _compiledPlan
    ?? buildShapeSlotMigrationPlan({
      fromShape,
      toShape,
      slotMapping,
      defaultSlotValues,
      defaultSlotValue,
      allowDropIndexed,
    });

  const nextSlots = {};
  for (const step of plan.slotActions) {
    if (step.action === 'copy') {
      nextSlots[step.targetSlotId] = objectRecord.slots[step.sourceSlotId];
    } else {
      nextSlots[step.targetSlotId] = step.defaultValue;
    }
  }

  const nextInput = {
    id: objectRecord.id,
    imageId: objectRecord.imageId,
    shape: objectRef(toShape.imageId, toShape.id),
    behavior: objectRecord.behavior ?? null,
    slots: nextSlots,
    metadata: objectRecord.metadata ?? {},
  };

  if (plan.toIndexed === SHAPE_INDEXED.VALUES) {
    nextInput.indexed = Object.hasOwn(objectRecord, 'indexed') ? [...objectRecord.indexed] : [];
  }

  const migrated = createObjectRecord(nextInput);
  assertObjectMatchesShape(migrated, toShape);
  return migrated;
}

function matchesBehaviorFilter(record, behaviorFilter, imageId) {
  if (!behaviorFilter) return true;
  const targetId = typeof behaviorFilter === 'string'
    ? behaviorFilter
    : isObjectRef(behaviorFilter)
      ? behaviorFilter.objectId
      : null;
  requiredText(targetId, 'behaviorFilter');
  return (
    isObjectRef(record.behavior)
    && record.behavior.imageId === imageId
    && record.behavior.objectId === targetId
  );
}

async function planImageShapeMigration({
  images,
  imageId,
  fromShapeId,
  toShapeId,
  behaviorFilter = null,
  slotMapping = {},
  defaultSlotValues = {},
  defaultSlotValue = null,
  allowDropIndexed = false,
} = {}) {
  if (!images || typeof images.getShape !== 'function' || typeof images.listObjects !== 'function') {
    throw new TypeError('planImageShapeMigration requires an ImageService with getShape and listObjects');
  }
  requiredText(imageId, 'imageId');
  const resolvedFromId = normalizeShapeIdInput(fromShapeId, 'fromShapeId');
  const resolvedToId = normalizeShapeIdInput(toShapeId, 'toShapeId');

  const fromShape = await images.getShape(imageId, resolvedFromId);
  if (!fromShape) {
    throw new TypeError(`source shape not found: ${imageId}/${resolvedFromId}`);
  }
  const toShape = await images.getShape(imageId, resolvedToId);
  if (!toShape) {
    throw new TypeError(`target shape not found: ${imageId}/${resolvedToId}`);
  }

  const compiledPlan = buildShapeSlotMigrationPlan({
    fromShape,
    toShape,
    slotMapping,
    defaultSlotValues,
    defaultSlotValue,
    allowDropIndexed,
  });

  if (resolvedFromId === resolvedToId) {
    return Object.freeze({
      format: IMAGE_SHAPE_MIGRATION_PLAN_V1,
      imageId,
      fromShapeId: resolvedFromId,
      toShapeId: resolvedToId,
      slotActions: compiledPlan.slotActions,
      removedSlots: compiledPlan.removedSlots,
      objectIds: Object.freeze([]),
      objectCount: 0,
      migratedRecords: Object.freeze([]),
    });
  }

  const allObjects = await images.listObjects(imageId);
  const candidates = allObjects
    .filter(
      (obj) =>
        isObjectRef(obj.shape)
        && obj.shape.imageId === imageId
        && obj.shape.objectId === resolvedFromId
        && matchesBehaviorFilter(obj, behaviorFilter, imageId),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const migratedRecords = candidates.map((obj) =>
    migrateObjectRecordToShape(obj, {
      fromShape,
      toShape,
      _compiledPlan: compiledPlan,
    }),
  );

  return Object.freeze({
    format: IMAGE_SHAPE_MIGRATION_PLAN_V1,
    imageId,
    fromShapeId: resolvedFromId,
    toShapeId: resolvedToId,
    slotActions: compiledPlan.slotActions,
    removedSlots: compiledPlan.removedSlots,
    objectIds: Object.freeze(migratedRecords.map((r) => r.id)),
    objectCount: migratedRecords.length,
    migratedRecords: Object.freeze(migratedRecords),
  });
}

async function migrateImageObjectsToShape({
  images,
  imageId,
  fromShapeId,
  toShapeId,
  behaviorFilter = null,
  slotMapping = {},
  defaultSlotValues = {},
  defaultSlotValue = null,
  allowDropIndexed = false,
  dryRun = false,
} = {}) {
  if (!images || typeof images.putObject !== 'function') {
    throw new TypeError('migrateImageObjectsToShape requires an ImageService with putObject');
  }
  const plan = await planImageShapeMigration({
    images,
    imageId,
    fromShapeId,
    toShapeId,
    behaviorFilter,
    slotMapping,
    defaultSlotValues,
    defaultSlotValue,
    allowDropIndexed,
  });

  if (!dryRun) {
    for (const migratedRecord of plan.migratedRecords) {
      await images.putObject(imageId, {
        id: migratedRecord.id,
        shape: migratedRecord.shape,
        behavior: migratedRecord.behavior ?? null,
        slots: migratedRecord.slots,
        ...(Object.hasOwn(migratedRecord, 'indexed') ? {indexed: migratedRecord.indexed} : {}),
        metadata: migratedRecord.metadata ?? {},
      });
    }
  }

  return Object.freeze({
    format: IMAGE_SHAPE_MIGRATION_RECEIPT_V1,
    imageId,
    fromShapeId: plan.fromShapeId,
    toShapeId: plan.toShapeId,
    dryRun: Boolean(dryRun),
    migratedObjectIds: plan.objectIds,
    migratedCount: plan.objectCount,
    slotActions: plan.slotActions,
    removedSlots: plan.removedSlots,
  });
}

export {
  IMAGE_SHAPE_MIGRATION_PLAN_V1,
  IMAGE_SHAPE_MIGRATION_RECEIPT_V1,
  buildShapeSlotMigrationPlan,
  migrateImageObjectsToShape,
  migrateObjectRecordToShape,
  planImageShapeMigration,
};
