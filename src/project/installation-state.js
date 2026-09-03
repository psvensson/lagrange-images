import {VersionConflictError} from '../backend/backend-contract.js';
import {SHAPE_INDEXED, shapeIndexedKind} from '../object/model.js';
import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/index.js';
import {PROJECT_INSTALLATION_V1, normalizeProjectInstallation} from './model.js';

// Durable ProjectInstallation/v1 storage translation (ADR 0076 Decisions 3, 4,
// 9, 10 and 12). These are ordinary target-Image Shapes and Objects. The stable
// head is the sole installation commit point; this owner never scans for or
// adopts a snapshot/member record that is not reachable from that head.

const PROJECT_INSTALLATION_HEAD_SHAPE_ID = 'lagrange-project-installation/head-shape/v1';
const PROJECT_INSTALLATION_SNAPSHOT_SHAPE_ID = 'lagrange-project-installation/snapshot-shape/v1';
const PROJECT_INSTALLATION_MEMBER_SHAPE_ID = 'lagrange-project-installation/member-shape/v1';

const SLOT = Object.freeze({
  projectId: 'installation-project-id',
  snapshot: 'installation-snapshot',
  releaseId: 'installation-release-id',
  memberKey: 'installation-member-key',
  role: 'installation-member-role',
  representation: 'installation-member-representation',
  contentIdentity: 'installation-member-content-identity',
  target: 'installation-member-target',
});

const INSTALLATION_SHAPES = Object.freeze([
  Object.freeze({
    id: PROJECT_INSTALLATION_HEAD_SHAPE_ID,
    slots: Object.freeze([
      Object.freeze({id: SLOT.projectId, name: 'projectId'}),
      Object.freeze({id: SLOT.snapshot, name: 'snapshot'}),
    ]),
    indexed: SHAPE_INDEXED.NONE,
  }),
  Object.freeze({
    id: PROJECT_INSTALLATION_SNAPSHOT_SHAPE_ID,
    slots: Object.freeze([
      Object.freeze({id: SLOT.projectId, name: 'projectId'}),
      Object.freeze({id: SLOT.releaseId, name: 'releaseId'}),
    ]),
    indexed: SHAPE_INDEXED.VALUES,
  }),
  Object.freeze({
    id: PROJECT_INSTALLATION_MEMBER_SHAPE_ID,
    slots: Object.freeze([
      Object.freeze({id: SLOT.memberKey, name: 'key'}),
      Object.freeze({id: SLOT.role, name: 'role'}),
      Object.freeze({id: SLOT.representation, name: 'representation'}),
      Object.freeze({id: SLOT.contentIdentity, name: 'contentIdentity'}),
      Object.freeze({id: SLOT.target, name: 'target'}),
    ]),
    indexed: SHAPE_INDEXED.NONE,
  }),
]);

class ProjectInstallationStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProjectInstallationStateError';
    Object.assign(this, details);
  }
}

function fail(message, details) {
  throw new ProjectInstallationStateError(message, details);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireImages(images, methods) {
  if (!images || typeof images !== 'object' || methods.some((method) => typeof images[method] !== 'function')) {
    throw new TypeError(`images must provide ${methods.join(' and ')}`);
  }
  return images;
}

function installationHeadObjectId(projectId) {
  return `lagrange-project-installation/${requiredText(projectId, 'projectId')}/head`;
}

function sameSlots(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((slot, index) => slot?.id === expected[index].id && slot?.name === expected[index].name);
}

function requireShapeDefinition(record, expected, targetImageId) {
  let indexed;
  try {
    indexed = shapeIndexedKind(record);
  } catch (cause) {
    fail(`Project installation Shape ${expected.id} diverges from its fixed definition`, {cause});
  }
  if (
    record.id !== expected.id
    || record.imageId !== targetImageId
    || !sameSlots(record.slots, expected.slots)
    || indexed !== expected.indexed
  ) {
    fail(`Project installation Shape ${expected.id} diverges from its fixed definition`);
  }
  return record;
}

async function ensureOneShape(images, targetImageId, expected) {
  const existing = await images.getRecord(targetImageId, expected.id);
  if (existing) return requireShapeDefinition(existing, expected, targetImageId);

  try {
    return await images.putShape(targetImageId, {
      id: expected.id,
      slots: expected.slots,
      ...(expected.indexed === SHAPE_INDEXED.VALUES ? {indexed: expected.indexed} : {}),
    });
  } catch (error) {
    if (!(error instanceof VersionConflictError)) throw error;
    const winner = await images.getRecord(targetImageId, expected.id);
    if (!winner) {
      fail(`Project installation Shape ${expected.id} is missing after a concurrent bootstrap conflict`, {cause: error});
    }
    return requireShapeDefinition(winner, expected, targetImageId);
  }
}

async function ensureInstallationShapes({images, targetImageId} = {}) {
  requireImages(images, ['getRecord', 'putShape']);
  requiredText(targetImageId, 'targetImageId');
  for (const shape of INSTALLATION_SHAPES) {
    // eslint-disable-next-line no-await-in-loop
    await ensureOneShape(images, targetImageId, shape);
  }
  return Object.freeze({
    headShape: objectRef(targetImageId, PROJECT_INSTALLATION_HEAD_SHAPE_ID),
    snapshotShape: objectRef(targetImageId, PROJECT_INSTALLATION_SNAPSHOT_SHAPE_ID),
    memberShape: objectRef(targetImageId, PROJECT_INSTALLATION_MEMBER_SHAPE_ID),
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function materializeInstallationRecords({installation, crypto} = {}) {
  // The Project model remains the semantic owner. This normalization validates
  // the caller's descriptor and supplies canonical member order; the translator
  // only maps that canonical meaning to ordinary record specs.
  const normalized = normalizeProjectInstallation(installation);
  const activeCrypto = crypto ?? getDefaultCryptoProvider();
  if (!activeCrypto || typeof activeCrypto.uuid !== 'function') {
    throw new TypeError('crypto must provide uuid');
  }

  const memberRecords = normalized.members.map((member) => ({
    kind: 'object',
    id: requiredText(activeCrypto.uuid(), 'member record id'),
    shape: objectRef(normalized.targetImageId, PROJECT_INSTALLATION_MEMBER_SHAPE_ID),
    slots: {
      [SLOT.memberKey]: textValue(member.key),
      [SLOT.role]: textValue(member.role),
      [SLOT.representation]: textValue(member.representation),
      [SLOT.contentIdentity]: textValue(member.contentIdentity),
      [SLOT.target]: member.target,
    },
  }));
  const snapshotId = requiredText(activeCrypto.uuid(), 'snapshot record id');
  const snapshot = {
    kind: 'object',
    id: snapshotId,
    shape: objectRef(normalized.targetImageId, PROJECT_INSTALLATION_SNAPSHOT_SHAPE_ID),
    slots: {
      [SLOT.projectId]: textValue(normalized.projectId),
      [SLOT.releaseId]: textValue(normalized.releaseId),
    },
    indexed: memberRecords.map(({id}) => objectRef(normalized.targetImageId, id)),
  };
  const head = {
    kind: 'object',
    id: installationHeadObjectId(normalized.projectId),
    shape: objectRef(normalized.targetImageId, PROJECT_INSTALLATION_HEAD_SHAPE_ID),
    slots: {
      [SLOT.projectId]: textValue(normalized.projectId),
      [SLOT.snapshot]: objectRef(normalized.targetImageId, snapshotId),
    },
  };
  return deepFreeze([...memberRecords, snapshot, head]);
}

function sameRef(value, imageId, objectId) {
  return isObjectRef(value) && value.imageId === imageId && value.objectId === objectId;
}

function requireStoredObject(record, {id, targetImageId, shapeId, slotIds, indexed}) {
  if (!record || record.kind !== 'object') fail(`Project installation object ${id} is malformed`);
  if (record.id !== id || record.imageId !== targetImageId) {
    fail(`Project installation object ${id} has inconsistent durable identity`);
  }
  if (!sameRef(record.shape, targetImageId, shapeId)) {
    fail(`Project installation object ${id} has the wrong Shape`);
  }
  if (record.behavior !== null) fail(`Project installation object ${id} must not have behavior`);
  const actualSlots = Object.keys(record.slots ?? {}).sort();
  const expectedSlots = [...slotIds].sort();
  if (actualSlots.length !== expectedSlots.length || actualSlots.some((slot, index) => slot !== expectedSlots[index])) {
    fail(`Project installation object ${id} has malformed slots`);
  }
  if (indexed) {
    if (!Array.isArray(record.indexed)) fail(`Project installation object ${id} has malformed indexed members`);
  } else if (Object.hasOwn(record, 'indexed')) {
    fail(`Project installation object ${id} must not have an indexed part`);
  }
  return record;
}

function requireStoredValue(value, label, kind) {
  let normalized;
  try {
    normalized = canonicalizeValue(value);
  } catch (cause) {
    fail(`${label} is malformed`, {cause});
  }
  if (normalized.kind !== kind) fail(`${label} is malformed`);
  return normalized;
}

function requireStoredText(value, label) {
  const normalized = requireStoredValue(value, label, 'text');
  if (normalized.value.length === 0) fail(`${label} is malformed`);
  return normalized.value;
}

function requireStoredRef(value, label, targetImageId) {
  const normalized = requireStoredValue(value, label, 'ref');
  if (normalized.imageId !== targetImageId) fail(`${label} must belong to target Image ${targetImageId}`);
  return normalized;
}

async function readManagedProjectInstallation({images, targetImageId, projectId} = {}) {
  requireImages(images, ['getRecord']);
  requiredText(targetImageId, 'targetImageId');
  requiredText(projectId, 'projectId');

  const headId = installationHeadObjectId(projectId);
  const head = await images.getRecord(targetImageId, headId);
  if (!head) return null;
  requireStoredObject(head, {
    id: headId,
    targetImageId,
    shapeId: PROJECT_INSTALLATION_HEAD_SHAPE_ID,
    slotIds: [SLOT.projectId, SLOT.snapshot],
    indexed: false,
  });
  const headProjectId = requireStoredText(head.slots[SLOT.projectId], 'head projectId');
  if (headProjectId !== projectId) fail('head projectId does not match its stable head key');
  const snapshotRef = requireStoredRef(head.slots[SLOT.snapshot], 'head snapshot ref', targetImageId);

  const snapshot = await images.getRecord(targetImageId, snapshotRef.objectId);
  if (!snapshot) fail(`Project installation snapshot is missing: ${snapshotRef.objectId}`);
  requireStoredObject(snapshot, {
    id: snapshotRef.objectId,
    targetImageId,
    shapeId: PROJECT_INSTALLATION_SNAPSHOT_SHAPE_ID,
    slotIds: [SLOT.projectId, SLOT.releaseId],
    indexed: true,
  });
  const snapshotProjectId = requireStoredText(snapshot.slots[SLOT.projectId], 'snapshot projectId');
  if (snapshotProjectId !== headProjectId) fail('snapshot projectId does not match the stable head projectId');
  const releaseId = requireStoredText(snapshot.slots[SLOT.releaseId], 'snapshot releaseId');

  const members = [];
  for (const [index, storedRef] of snapshot.indexed.entries()) {
    const memberRef = requireStoredRef(storedRef, `snapshot member ref ${index}`, targetImageId);
    // eslint-disable-next-line no-await-in-loop
    const member = await images.getRecord(targetImageId, memberRef.objectId);
    if (!member) fail(`Project installation member is missing: ${memberRef.objectId}`);
    requireStoredObject(member, {
      id: memberRef.objectId,
      targetImageId,
      shapeId: PROJECT_INSTALLATION_MEMBER_SHAPE_ID,
      slotIds: [SLOT.memberKey, SLOT.role, SLOT.representation, SLOT.contentIdentity, SLOT.target],
      indexed: false,
    });
    members.push({
      key: requireStoredText(member.slots[SLOT.memberKey], `member ${index} key`),
      role: requireStoredText(member.slots[SLOT.role], `member ${index} role`),
      representation: requireStoredText(member.slots[SLOT.representation], `member ${index} representation`),
      contentIdentity: requireStoredText(member.slots[SLOT.contentIdentity], `member ${index} contentIdentity`),
      target: requireStoredValue(member.slots[SLOT.target], `member ${index} target`, 'ref'),
    });
  }

  try {
    return normalizeProjectInstallation({
      format: PROJECT_INSTALLATION_V1,
      projectId: headProjectId,
      releaseId,
      targetImageId,
      members,
    });
  } catch (cause) {
    fail(`Project installation state is invalid: ${cause.message}`, {cause});
  }
}

export {
  PROJECT_INSTALLATION_HEAD_SHAPE_ID,
  PROJECT_INSTALLATION_MEMBER_SHAPE_ID,
  PROJECT_INSTALLATION_SNAPSHOT_SHAPE_ID,
  ProjectInstallationStateError,
  ensureInstallationShapes,
  installationHeadObjectId,
  materializeInstallationRecords,
  readManagedProjectInstallation,
};
