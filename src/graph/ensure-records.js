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

const defaultConflict = (kind, imageId, id) => new RecordConflictError(kind, imageId, id);

async function ensureCodeArtifact(images, imageId, desired, {conflict = defaultConflict} = {}) {
  const existing = await images.getCodeArtifact(imageId, desired.id);
  if (!existing) return await images.putCodeArtifact(imageId, desired);
  if (codeArtifactProjection(desired) !== codeArtifactProjection(existing)) {
    throw conflict('code artifact', imageId, desired.id);
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

export {
  RecordConflictError,
  blockProjection,
  canonicalRecordJson,
  codeArtifactProjection,
  ensureBlock,
  ensureCodeArtifact,
  ensureLexicalEnvironment,
  lexicalEnvironmentProjection,
};
