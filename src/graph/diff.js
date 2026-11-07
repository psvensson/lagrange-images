import {assertGraphBundleV1, contentIdentityForBundle} from './bundle.js';
import {RELOCATED_RECORD_KIND} from './locator.js';

const IMAGE_RECORD_DIFF_V1 = 'lagrange-image-record-diff/v1';
const GRAPH_BUNDLE_DIFF_V1 = 'lagrange-graph-bundle-diff/v1';

const TRANSIENT_RECORD_KEYS = new Set(['_version', 'createdAt', 'updatedAt']);

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

function normalizeRecordForDiff(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('diff record must be a plain record');
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new TypeError('diff record.id must be a non-empty string');
  }
  if (typeof record.kind !== 'string' || record.kind.length === 0) {
    throw new TypeError(`diff record ${record.id} must declare a non-empty kind`);
  }
  const stripped = {};
  for (const key of Object.keys(record).sort(compareText)) {
    if (TRANSIENT_RECORD_KEYS.has(key) || record[key] === undefined) continue;
    stripped[key] = canonicalClone(record[key]);
  }
  return Object.freeze(stripped);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalClone(value));
}

function computeSlotChanges(beforeSlots = {}, afterSlots = {}) {
  const beforeKeys = Object.keys(beforeSlots).sort(compareText);
  const afterKeys = Object.keys(afterSlots).sort(compareText);
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);

  const added = [];
  const removed = [];
  const modified = [];

  for (const slotId of afterKeys) {
    if (!beforeSet.has(slotId)) {
      added.push(Object.freeze({slotId, value: canonicalClone(afterSlots[slotId])}));
    }
  }
  for (const slotId of beforeKeys) {
    if (!afterSet.has(slotId)) {
      removed.push(Object.freeze({slotId, value: canonicalClone(beforeSlots[slotId])}));
    } else if (canonicalJson(beforeSlots[slotId]) !== canonicalJson(afterSlots[slotId])) {
      modified.push(
        Object.freeze({
          slotId,
          before: canonicalClone(beforeSlots[slotId]),
          after: canonicalClone(afterSlots[slotId]),
        }),
      );
    }
  }
  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    modified: Object.freeze(modified),
  });
}

function diffImageRecords({
  fromRecords,
  toRecords,
  fromImageId = null,
  toImageId = null,
  fromFrontier = null,
  toFrontier = null,
} = {}) {
  if (!Array.isArray(fromRecords)) throw new TypeError('fromRecords must be an array');
  if (!Array.isArray(toRecords)) throw new TypeError('toRecords must be an array');

  const fromMap = new Map();
  for (const raw of fromRecords) {
    if (raw?.kind === RELOCATED_RECORD_KIND) continue;
    const normalized = normalizeRecordForDiff(raw);
    if (fromMap.has(normalized.id)) {
      throw new TypeError(`duplicate record id in fromRecords: ${normalized.id}`);
    }
    fromMap.set(normalized.id, normalized);
  }

  const toMap = new Map();
  for (const raw of toRecords) {
    if (raw?.kind === RELOCATED_RECORD_KIND) continue;
    const normalized = normalizeRecordForDiff(raw);
    if (toMap.has(normalized.id)) {
      throw new TypeError(`duplicate record id in toRecords: ${normalized.id}`);
    }
    toMap.set(normalized.id, normalized);
  }

  const allIds = [...new Set([...fromMap.keys(), ...toMap.keys()])].sort(compareText);
  const added = [];
  const removed = [];
  const modified = [];
  let unchangedCount = 0;

  for (const id of allIds) {
    const before = fromMap.get(id) ?? null;
    const after = toMap.get(id) ?? null;
    if (!before) {
      added.push(Object.freeze({id, kind: after.kind, record: after}));
      continue;
    }
    if (!after) {
      removed.push(Object.freeze({id, kind: before.kind, record: before}));
      continue;
    }
    // Strip imageId difference when comparing records across two distinct images.
    const beforeComparable = fromImageId && toImageId && fromImageId !== toImageId
      ? {...before, imageId: undefined}
      : before;
    const afterComparable = fromImageId && toImageId && fromImageId !== toImageId
      ? {...after, imageId: undefined}
      : after;
    if (canonicalJson(beforeComparable) === canonicalJson(afterComparable)) {
      unchangedCount += 1;
      continue;
    }
    const fieldKeys = [...new Set([...Object.keys(beforeComparable), ...Object.keys(afterComparable)])]
      .filter((key) => key !== 'id' && key !== 'imageId')
      .sort(compareText);
    const changedFields = fieldKeys.filter(
      (key) => canonicalJson(beforeComparable[key]) !== canonicalJson(afterComparable[key]),
    );
    const slotChanges = before.kind === 'object' && after.kind === 'object'
      ? computeSlotChanges(before.slots, after.slots)
      : null;
    modified.push(
      Object.freeze({
        id,
        kind: after.kind,
        before,
        after,
        changedFields: Object.freeze(changedFields),
        slotChanges,
      }),
    );
  }

  return Object.freeze({
    format: IMAGE_RECORD_DIFF_V1,
    fromImageId,
    toImageId,
    fromFrontier,
    toFrontier,
    identical: added.length === 0 && removed.length === 0 && modified.length === 0,
    unchangedCount,
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    modified: Object.freeze(modified),
  });
}

function assertFrontierNumber(value, currentFrontier, label) {
  const num = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  if (num > currentFrontier) {
    throw new RangeError(`${label} (${num}) exceeds current committed frontier (${currentFrontier})`);
  }
  return num;
}

function replayHistoryEventsToFrontier(events, frontier) {
  const byId = new Map();
  for (const event of events) {
    const rev = event?.revision ?? event?._revision ?? 0;
    if (rev > frontier) break;
    switch (event?.type) {
      case 'shape.put':
        if (event.shape?.id) byId.set(event.shape.id, structuredClone(event.shape));
        break;
      case 'object.put':
        if (event.object?.id) byId.set(event.object.id, structuredClone(event.object));
        break;
      case 'code-artifact.put':
        if (event.artifact?.id) byId.set(event.artifact.id, structuredClone(event.artifact));
        break;
      case 'lexical-environment.put':
        if (event.environment?.id) byId.set(event.environment.id, structuredClone(event.environment));
        break;
      case 'block.put':
        if (event.block?.id) byId.set(event.block.id, structuredClone(event.block));
        break;
      case 'object.relocated':
        if (event.objectId) byId.delete(event.objectId);
        break;
      default:
        break;
    }
  }
  return Object.freeze(
    [...byId.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, record]) => Object.freeze(record)),
  );
}

async function reconstructImageRecordsAtFrontier({images, imageId, frontier} = {}) {
  if (!images || typeof images.frontier !== 'function' || typeof images.history !== 'function') {
    throw new TypeError('reconstructImageRecordsAtFrontier requires an ImageService with frontier() and history()');
  }
  if (typeof imageId !== 'string' || imageId.length === 0) {
    throw new TypeError('imageId must be a non-empty string');
  }
  const currentFrontier = await images.frontier(imageId);
  const targetFrontier = assertFrontierNumber(frontier, currentFrontier, 'frontier');
  const events = await images.history(imageId);
  return replayHistoryEventsToFrontier(events, targetFrontier);
}

async function diffImageFrontiers({images, imageId, fromFrontier, toFrontier} = {}) {
  if (!images || typeof images.frontier !== 'function' || typeof images.history !== 'function') {
    throw new TypeError('diffImageFrontiers requires an ImageService with frontier() and history()');
  }
  if (typeof imageId !== 'string' || imageId.length === 0) {
    throw new TypeError('imageId must be a non-empty string');
  }
  const currentFrontier = await images.frontier(imageId);
  const resolvedFrom = assertFrontierNumber(fromFrontier, currentFrontier, 'fromFrontier');
  const resolvedTo = assertFrontierNumber(toFrontier, currentFrontier, 'toFrontier');
  const events = await images.history(imageId);
  const fromRecords = replayHistoryEventsToFrontier(events, resolvedFrom);
  const toRecords = replayHistoryEventsToFrontier(events, resolvedTo);
  return diffImageRecords({
    fromRecords,
    toRecords,
    fromImageId: imageId,
    toImageId: imageId,
    fromFrontier: resolvedFrom,
    toFrontier: resolvedTo,
  });
}

function diffGraphBundles(fromBundleInput, toBundleInput) {
  const fromBundle = fromBundleInput?.bundle ?? fromBundleInput;
  const toBundle = toBundleInput?.bundle ?? toBundleInput;
  assertGraphBundleV1(fromBundle);
  assertGraphBundleV1(toBundle);
  const fromContentIdentity = contentIdentityForBundle(fromBundle);
  const toContentIdentity = contentIdentityForBundle(toBundle);

  const fromByLocalId = new Map(
    Object.entries(fromBundle.records).map(([localId, entry]) => [localId, canonicalClone(entry)]),
  );
  const toByLocalId = new Map(
    Object.entries(toBundle.records).map(([localId, entry]) => [localId, canonicalClone(entry)]),
  );
  const allLocalIds = [...new Set([...fromByLocalId.keys(), ...toByLocalId.keys()])].sort(compareText);

  const addedRecords = [];
  const removedRecords = [];
  const modifiedRecords = [];
  for (const localId of allLocalIds) {
    const before = fromByLocalId.get(localId) ?? null;
    const after = toByLocalId.get(localId) ?? null;
    if (!before) {
      addedRecords.push(Object.freeze({localId, kind: after.kind, record: after}));
    } else if (!after) {
      removedRecords.push(Object.freeze({localId, kind: before.kind, record: before}));
    } else if (canonicalJson(before) !== canonicalJson(after)) {
      modifiedRecords.push(Object.freeze({localId, kind: after.kind, before, after}));
    }
  }

  const rootsChanged = canonicalJson(fromBundle.roots) !== canonicalJson(toBundle.roots);
  return Object.freeze({
    format: GRAPH_BUNDLE_DIFF_V1,
    fromContentIdentity,
    toContentIdentity,
    identical: fromContentIdentity === toContentIdentity,
    rootsChanged,
    addedRecords: Object.freeze(addedRecords),
    removedRecords: Object.freeze(removedRecords),
    modifiedRecords: Object.freeze(modifiedRecords),
  });
}

export {
  GRAPH_BUNDLE_DIFF_V1,
  IMAGE_RECORD_DIFF_V1,
  diffGraphBundles,
  diffImageFrontiers,
  diffImageRecords,
  normalizeRecordForDiff,
  reconstructImageRecordsAtFrontier,
};
