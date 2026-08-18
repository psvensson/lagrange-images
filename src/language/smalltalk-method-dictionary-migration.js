import {isObjectRef, objectRef, textValue} from '../value/index.js';
import {SHAPE_INDEXED} from '../object/model.js';
import {
  SmalltalkKernelConflictError,
  assertUniqueSelectorShape,
  canonicalJson,
  findSmalltalkKernel,
  readBehavior,
} from './smalltalk-kernel.js';
import {
  METHOD_DICTIONARY_SHAPE_ID,
  METHOD_DICTIONARY_SHAPE_SLOTS,
  SEAL_METADATA_KEY,
  buildMethodBuckets,
  isMethodDictionary,
  isSealed,
  methodDictionaryRecordFields,
  migratedDictionaryId,
  validateMethodDictionary,
} from './smalltalk-method-dictionary.js';

// ADR 0049 decision 7: migrating one Behavior's method dictionary from the ADR 0044 shape-backed
// representation to the hashed one.
//
// The whole design exists to answer one race. Method addition writes the *dictionary* guarded by the
// dictionary's version; migration writes the *Behavior* guarded by the Behavior's version. Those
// guards are disjoint, so an addition landing between migration's read and its swap changes neither
// record the swap is conditioned on — the CAS succeeds and the added method disappears with the
// abandoned dictionary.
//
// The irony is exact: ADR 0044 decision 1 gave Behaviors a fixed shape precisely so adding a method
// would not touch them, and that is what makes the Behavior's version useless here. Re-reading the
// legacy dictionary just before the swap narrows the window without closing it.
//
// So both writers are routed through the one record they share:
//
//   1. read legacy L at version v, validate it completely
//   2. seal L      CAS on L, expectedVersion = v      <- the serialization point
//   3. build the hashed dictionary at a deterministic id
//   4. CAS Behavior.methods:  L -> H
class SmalltalkMigrationConflictError extends TypeError {
  constructor(kind, ref) {
    super(
      `Symmetric Smalltalk method dictionary migration for ${ref.imageId}/${ref.objectId} lost a `
      + `${kind} race; nothing was published, and an identical retry will converge`,
    );
    this.name = 'SmalltalkMigrationConflictError';
    this.kind = kind;
  }
}

async function ensureMethodDictionaryShape(images, imageId) {
  const desired = {id: METHOD_DICTIONARY_SHAPE_ID, slots: [...METHOD_DICTIONARY_SHAPE_SLOTS], indexed: SHAPE_INDEXED.VALUES};
  const existing = await images.getShape(imageId, desired.id);
  if (!existing) return await images.putShape(imageId, desired);
  const layout = (shape) => canonicalJson({
    slots: shape.slots,
    indexed: Object.hasOwn(shape, 'indexed') ? shape.indexed : SHAPE_INDEXED.NONE,
  });
  if (layout(existing) !== layout(desired)) throw new SmalltalkKernelConflictError('shape', imageId, desired.id);
  return existing;
}

// The legacy representation, read exactly as ADR 0044 dispatch reads it — including the selector
// uniqueness invariant, because migrating a corrupt dictionary would launder the corruption into a
// format that no longer records how it happened.
async function readLegacyEntries(images, dictionaryRef, record) {
  const shape = await images.getShape(record.shape.imageId, record.shape.objectId);
  if (!shape) throw new TypeError(`method dictionary shape not found: ${record.shape.objectId}`);
  assertUniqueSelectorShape(shape, `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  // The *target* representation's constraints are checked here, before the seal. A foreign method
  // ref is impossible to migrate, and that is knowable in step 1 — discovering it after sealing and
  // writing the target would stall the class for a reason that could have been reported first.
  return shape.slots.map((slot) => {
    const method = record.slots[slot.id];
    if (!isObjectRef(method)) {
      throw new TypeError(`method slot for ${slot.name} must contain an unpinned Block ref`);
    }
    if (method.imageId !== record.imageId) {
      throw new TypeError(
        `method ${slot.name} refers to ${method.imageId}/${method.objectId}, which is not local to `
        + `${record.imageId}; a hashed method dictionary holds only local Block refs`,
      );
    }
    if (typeof slot.name !== 'string' || slot.name.length === 0) {
      throw new TypeError('a method dictionary selector must be non-empty text');
    }
    return [textValue(slot.name), method];
  });
}

// Ensure-exact-or-create at the deterministic target. A retry after a committed-but-unacknowledged
// write finds its own previous output and reuses it rather than leaving another orphan — which is
// the whole reason this id is deterministic rather than fresh per attempt (contrast ADR 0048
// decision 6, where an unbounded series of snapshots needs the opposite rule).
async function ensureMigratedDictionary(images, imageId, desired) {
  const existing = await images.getObject(imageId, desired.id);
  const projection = (record) => canonicalJson({
    shape: record.shape ?? null,
    behavior: record.behavior ?? null,
    slots: record.slots ?? {},
    indexed: Object.hasOwn(record, 'indexed') ? record.indexed : null,
    metadata: record.metadata ?? {},
  });
  if (!existing) return await images.putObject(imageId, desired, {expectedVersion: 0});
  if (projection(desired) !== projection(existing)) {
    throw new SmalltalkKernelConflictError('method dictionary', imageId, desired.id);
  }
  return existing;
}

async function migrateMethodDictionary({images, imageId, behaviorRef} = {}) {
  if (!isObjectRef(behaviorRef) || behaviorRef.imageId !== imageId) {
    throw new TypeError(`migrateMethodDictionary behavior must be an unpinned ref in ${imageId}`);
  }
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  const behaviorRecord = await images.getObject(behaviorRef.imageId, behaviorRef.objectId);
  if (!behaviorRecord) throw new TypeError(`Behavior not found: ${behaviorRef.imageId}/${behaviorRef.objectId}`);
  const behavior = await readBehavior(images, behaviorRef);
  const dictionaryRef = behavior.methods;

  const legacy = await images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
  if (!legacy) throw new TypeError(`method dictionary not found: ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);

  // Already migrated is a success, not an error: migration must be safe to run twice, and a caller
  // that lost an acknowledgement cannot tell the difference.
  if (isMethodDictionary(legacy)) {
    return Object.freeze({migrated: false, dictionary: dictionaryRef, reason: 'already hashed'});
  }

  // Step 1. Read and validate before touching anything.
  const entries = await readLegacyEntries(images, dictionaryRef, legacy);

  // Step 2. Seal — the serialization point. If a method was added since step 1, the CAS fails and
  // the caller retries from a read that includes it.
  if (!isSealed(legacy)) {
    try {
      await images.putObject(imageId, {
        id: legacy.id,
        shape: legacy.shape,
        behavior: legacy.behavior ?? null,
        slots: legacy.slots,
        metadata: {...legacy.metadata, [SEAL_METADATA_KEY]: true},
      }, {expectedVersion: legacy._version});
    } catch (error) {
      if (error?.name === 'VersionConflictError') throw new SmalltalkMigrationConflictError('method-addition', dictionaryRef);
      throw error;
    }
  }

  // Step 3. Build the hashed dictionary. Still invisible: nothing points at it yet.
  await ensureMethodDictionaryShape(images, imageId);
  const {buckets} = buildMethodBuckets(entries);
  const migratedId = migratedDictionaryId(behaviorRef.objectId);
  const stored = await ensureMigratedDictionary(images, imageId, {
    id: migratedId,
    ...methodDictionaryRecordFields({
      buckets,
      shapeRef: objectRef(imageId, METHOD_DICTIONARY_SHAPE_ID),
      nilRef: kernel.nil,
      metadata: {owner: behaviorRef.objectId, migratedFrom: dictionaryRef.objectId},
    }),
  });
  validateMethodDictionary(await images.getObject(imageId, stored.id), objectRef(imageId, stored.id), kernel.nil);

  // Step 4. One CAS on the Behavior's methods edge. A reader sees the complete legacy dictionary or
  // the complete hashed one; the sealed legacy record stays readable and dispatchable until this
  // lands, so a crash here is a visible stall rather than a broken class.
  try {
    await images.putObject(imageId, {
      id: behaviorRecord.id,
      shape: behaviorRecord.shape,
      behavior: behaviorRecord.behavior,
      slots: {...behaviorRecord.slots, 'behavior-methods': objectRef(imageId, stored.id)},
      metadata: behaviorRecord.metadata,
    }, {expectedVersion: behaviorRecord._version});
  } catch (error) {
    if (error?.name === 'VersionConflictError') throw new SmalltalkMigrationConflictError('behavior', behaviorRef);
    throw error;
  }

  return Object.freeze({migrated: true, dictionary: objectRef(imageId, stored.id), from: dictionaryRef});
}

export {
  SmalltalkMigrationConflictError,
  ensureMethodDictionaryShape,
  migrateMethodDictionary,
};
