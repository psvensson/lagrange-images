import {canonicalizeValue, isObjectRef, isReference} from '../value/index.js';

const SHAPE_INDEXED = Object.freeze({
  NONE: 'none',
  VALUES: 'values',
});

function normalizeMetadata(metadata, label = 'metadata') {
  const seen = new Set();
  function visit(value, path) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError(`${path} must use finite JSON numbers`);
      return value;
    }
    if (typeof value !== 'object') throw new TypeError(`${path} must be JSON-compatible metadata`);
    if (isReference(value)) throw new TypeError(`${path} must not contain object references; graph edges belong in slots`);
    if (seen.has(value)) throw new TypeError(`${path} must not be cyclic`);
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry, index) => visit(entry, `${path}[${index}]`));
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError(`${path} must contain only plain objects and arrays`);
      }
      const normalized = {};
      for (const [key, entry] of Object.entries(value)) normalized[key] = visit(entry, `${path}.${key}`);
      return normalized;
    } finally {
      seen.delete(value);
    }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError(`${label} must be an object`);
  return visit(metadata, label);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeShapeSlots(slots) {
  if (!Array.isArray(slots)) throw new TypeError('shape slots must be an array');
  const seen = new Set();
  return slots.map((slot) => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) throw new TypeError('shape slot must be an object');
    const keys = Object.keys(slot).sort();
    if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'name') throw new TypeError('shape slot must contain exactly id and name');
    const id = requiredText(slot.id, 'slot id');
    const name = requiredText(slot.name, 'slot name');
    if (seen.has(id)) throw new TypeError(`duplicate slot id: ${id}`);
    seen.add(id);
    return Object.freeze({id, name});
  });
}

function normalizeShapeIndexed(indexed) {
  if (indexed !== SHAPE_INDEXED.NONE && indexed !== SHAPE_INDEXED.VALUES) {
    throw new TypeError(`shape indexed declaration must be ${SHAPE_INDEXED.NONE} or ${SHAPE_INDEXED.VALUES}`);
  }
  return indexed;
}

function shapeIndexedKind(shape) {
  if (!shape || shape.kind !== 'shape') throw new TypeError('record is not a shape');
  return normalizeShapeIndexed(Object.hasOwn(shape, 'indexed') ? shape.indexed : SHAPE_INDEXED.NONE);
}

// ADR 0047 keeps old records exact: absence of `indexed` is interpreted as `none`, but merely
// reading or rewriting an old Shape does not materialize a new field into its durable form.
function createShapeRecord(input) {
  const {id, imageId, slots = [], metadata = {}, updatedAt = null} = input ?? {};
  const record = {
    kind: 'shape',
    id: requiredText(id, 'shape id'),
    imageId: requiredText(imageId, 'shape imageId'),
    slots: normalizeShapeSlots(slots),
    metadata: normalizeMetadata(metadata, 'shape metadata'),
    updatedAt,
  };
  if (Object.hasOwn(input, 'indexed')) record.indexed = normalizeShapeIndexed(input.indexed);
  return Object.freeze(record);
}

function assertShapeRecord(record) {
  if (!record || record.kind !== 'shape') throw new TypeError('record is not a shape');
  createShapeRecord(record);
  return record;
}

function shapeSlotIds(shape) {
  assertShapeRecord(shape);
  return new Set(shape.slots.map(({id}) => id));
}

function normalizeRef(value, label) {
  const normalized = canonicalizeValue(value);
  if (!isObjectRef(normalized)) throw new TypeError(`${label} must be an unpinned object ref`);
  return normalized;
}

function normalizeObjectSlots(slots) {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) throw new TypeError('object slots must be keyed by stable slot id');
  const normalized = {};
  for (const [slotId, value] of Object.entries(slots)) {
    requiredText(slotId, 'slot id');
    normalized[slotId] = canonicalizeValue(value);
  }
  return Object.freeze(normalized);
}

function normalizeIndexedValues(indexed) {
  if (!Array.isArray(indexed)) throw new TypeError('object indexed part must be an array of canonical Values');
  return Object.freeze(indexed.map((value) => canonicalizeValue(value)));
}

// As for Shape, preserving property absence matters: old object records did not carry an indexed
// part, and loading one must not manufacture one. An explicitly present empty array is different —
// it is the zero-length indexed part of a Shape that declares `values`.
function createObjectRecord(input) {
  const {id, imageId, shape, behavior = null, slots = {}, metadata = {}, updatedAt = null} = input ?? {};
  const record = {
    kind: 'object',
    id: requiredText(id, 'object id'),
    imageId: requiredText(imageId, 'object imageId'),
    shape: normalizeRef(shape, 'object shape'),
    behavior: behavior === null ? null : normalizeRef(behavior, 'object behavior'),
    slots: normalizeObjectSlots(slots),
    metadata: normalizeMetadata(metadata, 'object metadata'),
    updatedAt,
  };
  if (Object.hasOwn(input, 'indexed')) record.indexed = normalizeIndexedValues(input.indexed);
  return Object.freeze(record);
}

function assertObjectRecord(record) {
  if (!record || record.kind !== 'object') throw new TypeError('record is not an object');
  createObjectRecord(record);
  return record;
}

function assertObjectMatchesShape(record, shape) {
  assertObjectRecord(record);
  assertShapeRecord(shape);
  const expected = shapeSlotIds(shape);
  const actual = new Set(Object.keys(record.slots));
  const missing = [...expected].filter((slotId) => !actual.has(slotId));
  const extra = [...actual].filter((slotId) => !expected.has(slotId));
  if (missing.length || extra.length) {
    throw new TypeError(`object slots do not match shape ${shape.id}; missing: ${missing.join(', ') || '-'}; extra: ${extra.join(', ') || '-'}`);
  }

  const indexedKind = shapeIndexedKind(shape);
  const hasIndexed = Object.hasOwn(record, 'indexed');
  if (indexedKind === SHAPE_INDEXED.VALUES && !hasIndexed) {
    throw new TypeError(`object does not match shape ${shape.id}; indexed values part is required`);
  }
  if (indexedKind === SHAPE_INDEXED.NONE && hasIndexed) {
    throw new TypeError(`object does not match shape ${shape.id}; shape declares no indexed part`);
  }
  return record;
}

export {
  SHAPE_INDEXED,
  assertObjectMatchesShape,
  assertObjectRecord,
  assertShapeRecord,
  createObjectRecord,
  createShapeRecord,
  normalizeMetadata,
  shapeIndexedKind,
  shapeSlotIds,
};
