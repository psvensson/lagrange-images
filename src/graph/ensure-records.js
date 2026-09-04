// Ensure-exact-or-create for durable records at deterministic ids.
//
// The rule this substrate applies everywhere a record's id is derived rather than minted:
//
//   absent                  -> create
//   present and identical   -> reuse, write nothing
//   present and different   -> fail, overwrite nothing
//
// It lives here, language-neutral, because both the Symmetric Smalltalk builders and the WASM tree
// installers write deterministic ids and both owe the same convergence guarantee. Two copies would
// be two chances to disagree about what "identical" means.
import {SHAPE_INDEXED} from '../object/model.js';

class RecordConflictError extends TypeError {
  constructor(kind, imageId, objectId) {
    super(`${kind} ${imageId}/${objectId} already exists and differs; refusing to overwrite it`);
    this.name = 'RecordConflictError';
    this.imageId = imageId;
    this.objectId = objectId;
  }
}

// Key order is not part of a record's meaning, so compare a canonical projection rather than
// whatever order the caller or the backend happened to produce.
function canonicalRecordJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalRecordJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalRecordJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// "Exact" for a code artifact includes `dependencies` and `derivedFrom`: those are durable semantic
// and provenance edges, so an artifact differing there is a different artifact. Matching provenance
// is not matching output.
function codeArtifactProjection(record) {
  return canonicalRecordJson({
    representation: record.representation ?? null,
    languageId: record.languageId ?? null,
    content: record.content ?? null,
    dependencies: record.dependencies ?? [],
    derivedFrom: record.derivedFrom ?? [],
    metadata: record.metadata ?? {},
  });
}

function blockProjection(record) {
  return canonicalRecordJson({
    code: record.code ?? null,
    environment: record.environment ?? null,
    metadata: record.metadata ?? {},
  });
}

function lexicalEnvironmentProjection(record) {
  return canonicalRecordJson({
    parent: record.parent ?? null,
    bindings: record.bindings ?? {},
    metadata: record.metadata ?? {},
  });
}

// ADR 0060. The durable object record carries `indexed` only for an indexed Shape, so the
// projection includes it only when present — matching how putObject stores it.
function objectProjection(record) {
  return canonicalRecordJson({
    shape: record.shape ?? null,
    behavior: record.behavior ?? null,
    slots: record.slots ?? {},
    ...(Object.hasOwn(record, 'indexed') ? {indexed: record.indexed} : {}),
    metadata: record.metadata ?? {},
  });
}

// A Shape's meaning is its LAYOUT: named slots and the indexed declaration (ADR 0047: absence of
// `indexed` is the old `none` meaning, and a values Shape must never compare equal to a no-indexed
// Shape by accident). Metadata is provenance and does not decide whether two Shapes are the same.
function shapeProjection(record) {
  return canonicalRecordJson({
    slots: record.slots ?? [],
    indexed: Object.hasOwn(record, 'indexed') ? record.indexed : SHAPE_INDEXED.NONE,
  });
}

const defaultConflict = (kind, imageId, id) => new RecordConflictError(kind, imageId, id);

// THE ensure-exact-or-create core, including its concurrency rule (bead lagrange-images-ea8):
//
//   read absent -> INSERT-ONLY create (the image service's expectedVersion:0 CAS in one backend
//                  transaction, so a record is never overwritten or half-written)
//   the insert loses the CAS -> another caller created the record between our read and our
//                  insert; re-read and treat the WINNER as the authority: identical -> converge on
//                  it, different -> conflict. Which contender wins scheduling never changes the
//                  outcome, and a retry after the winner commits is idempotent.
//   read present -> identical reuses, different conflicts, nothing is written.
//
// Every per-kind ensure below is this rule over its kind's read/insert/projection; none of them
// decides the rule again.
//
// Two modes, one rule. EXACT (default): the record is immutable by construction, so a present or
// winning record must be IDENTICAL to be adopted. SEED (`seed: true`): the desired record is only
// the initial value of a record that is mutated afterwards through its own CAS (a registry that
// is appended to, a companion whose values change), so a present or winning record is adopted AS
// IT IS — the caller applies its own domain check to what it gets back — and only creation is
// decided here. Neither mode ever overwrites.
async function ensureRecord({kind, imageId, desired, read, insert, projection, conflict, seed = false}) {
  const adopt = (record) => {
    if (!seed && projection(desired) !== projection(record)) throw conflict(kind, imageId, desired.id);
    return record;
  };
  const existing = await read();
  if (existing) return adopt(existing);
  try {
    return await insert();
  } catch (error) {
    if (error?.name !== 'VersionConflictError') throw error;
    const winner = await read();
    // No readable winner of this kind means the id is occupied by something that is not this
    // kind of record: a conflicting occupant, never normalized into success.
    if (!winner) throw conflict(kind, imageId, desired.id);
    return adopt(winner);
  }
}

// The ONE Shape admission owner. Reads through getRecord so a non-Shape occupant of the id is a
// conflict rather than "absent"; inserts through the insert-only putShape.
async function ensureShape(images, imageId, desired, {conflict = defaultConflict} = {}) {
  const read = async () => {
    const record = typeof images.getRecord === 'function'
      ? await images.getRecord(imageId, desired.id)
      : await images.getShape(imageId, desired.id);
    if (!record) return null;
    if (record.kind !== 'shape') throw conflict('shape', imageId, desired.id);
    return record;
  };
  return await ensureRecord({
    kind: 'shape', imageId, desired, read, conflict, projection: shapeProjection,
    insert: () => images.putShape(imageId, desired),
  });
}

async function ensureCodeArtifact(images, imageId, desired, {conflict = defaultConflict} = {}) {
  return await ensureRecord({
    kind: 'code artifact', imageId, desired, conflict, projection: codeArtifactProjection,
    read: () => images.getCodeArtifact(imageId, desired.id),
    insert: () => images.putCodeArtifact(imageId, desired),
  });
}

// Ensure-exact-or-create for a SMALL GRAPH of code artifacts that must become durable together
// (ADR 0080-adjacent; ygi): all absent -> ONE insert-only createRecords batch (so no member is ever
// visible without the others); all present and identical -> reuse, write nothing; anything else
// (a partial graph, or a differing member) -> fail, overwrite nothing. The atomicity envelope is
// ImageService.createRecords' — this owner adds only the convergence rule.
async function ensureCodeArtifacts(images, imageId, desiredList, {conflict = defaultConflict} = {}) {
  if (!Array.isArray(desiredList) || desiredList.length === 0) throw new TypeError('ensureCodeArtifacts requires a non-empty list');
  const existing = [];
  for (const desired of desiredList) existing.push(await images.getCodeArtifact(imageId, desired.id));
  if (existing.every((record) => !record)) {
    if (typeof images.createRecords !== 'function') throw new TypeError('ensureCodeArtifacts requires images.createRecords');
    return await images.createRecords(imageId, desiredList.map((desired) => ({kind: 'code-artifact', ...desired})));
  }
  for (const [index, desired] of desiredList.entries()) {
    if (!existing[index] || codeArtifactProjection(desired) !== codeArtifactProjection(existing[index])) {
      throw conflict('code artifact', imageId, desired.id);
    }
  }
  return existing;
}

async function ensureBlock(images, imageId, desired, {conflict = defaultConflict} = {}) {
  return await ensureRecord({
    kind: 'block', imageId, desired, conflict, projection: blockProjection,
    read: () => images.getBlock(imageId, desired.id),
    insert: () => images.putBlock(imageId, desired),
  });
}

// ADR 0052 decision 7a. Promotion writes at deterministic ids, so a retry after a lost
// acknowledgement must converge rather than mint a second identity for one closure.
async function ensureLexicalEnvironment(images, imageId, desired, {conflict = defaultConflict} = {}) {
  return await ensureRecord({
    kind: 'lexical environment', imageId, desired, conflict, projection: lexicalEnvironmentProjection,
    read: () => images.getLexicalEnvironment(imageId, desired.id),
    // Insert-only: an ensure never overwrites, even when two callers raced past the read.
    insert: () => images.putLexicalEnvironment(imageId, desired, {expectedVersion: 0}),
  });
}

// ADR 0060. Object promotion writes at a derived id, so a retry after a lost acknowledgement
// converges on the same durable object rather than minting a second identity for one transient one.
async function ensureObject(images, imageId, desired, {conflict = defaultConflict, seed = false} = {}) {
  return await ensureRecord({
    kind: 'object', imageId, desired, conflict, seed, projection: objectProjection,
    read: () => images.getObject(imageId, desired.id),
    // Insert-only: an ensure never overwrites, even when two callers raced past the read.
    insert: () => images.putObject(imageId, desired, {expectedVersion: 0}),
  });
}

export {
  RecordConflictError,
  blockProjection,
  canonicalRecordJson,
  codeArtifactProjection,
  ensureBlock,
  ensureCodeArtifact,
  ensureCodeArtifacts,
  ensureLexicalEnvironment,
  ensureObject,
  ensureShape,
  lexicalEnvironmentProjection,
  objectProjection,
  shapeProjection,
};
