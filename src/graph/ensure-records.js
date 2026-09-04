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

const defaultConflict = (kind, imageId, id) => new RecordConflictError(kind, imageId, id);

async function ensureCodeArtifact(images, imageId, desired, {conflict = defaultConflict} = {}) {
  const existing = await images.getCodeArtifact(imageId, desired.id);
  if (!existing) return await images.putCodeArtifact(imageId, desired);
  if (codeArtifactProjection(desired) !== codeArtifactProjection(existing)) {
    throw conflict('code artifact', imageId, desired.id);
  }
  return existing;
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
  const existing = await images.getBlock(imageId, desired.id);
  if (!existing) return await images.putBlock(imageId, desired);
  if (blockProjection(desired) !== blockProjection(existing)) {
    throw conflict('block', imageId, desired.id);
  }
  return existing;
}

// ADR 0052 decision 7a. Promotion writes at deterministic ids, so a retry after a lost
// acknowledgement must converge rather than mint a second identity for one closure.
async function ensureLexicalEnvironment(images, imageId, desired, {conflict = defaultConflict} = {}) {
  const existing = await images.getLexicalEnvironment(imageId, desired.id);
  if (!existing) return await images.putLexicalEnvironment(imageId, desired);
  if (lexicalEnvironmentProjection(desired) !== lexicalEnvironmentProjection(existing)) {
    throw conflict('lexical environment', imageId, desired.id);
  }
  return existing;
}

// ADR 0060. Object promotion writes at a derived id, so a retry after a lost acknowledgement
// converges on the same durable object rather than minting a second identity for one transient one.
async function ensureObject(images, imageId, desired, {conflict = defaultConflict} = {}) {
  const existing = await images.getObject(imageId, desired.id);
  if (!existing) return await images.putObject(imageId, desired);
  if (objectProjection(desired) !== objectProjection(existing)) {
    throw conflict('object', imageId, desired.id);
  }
  return existing;
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
  lexicalEnvironmentProjection,
  objectProjection,
};
