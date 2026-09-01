import {uuid as randomUUID} from '../support/default-crypto.js';
import {assertBackend, assertBackendTransaction} from '../backend/backend-contract.js';
import {assertObjectMatchesShape, createObjectRecord, createShapeRecord, normalizeMetadata} from '../object/index.js';
import {
  assertLexicalEnvironmentLayoutCompatible,
  createBlockRecord,
  createCodeArtifactRecord,
  createLexicalEnvironmentRecord,
} from '../execution/model.js';
import {findTransientRefs, isTransientObjectId} from '../value/transient-ref.js';

const IMAGE_COLLECTION = 'images';
const records = (id) => `image:${id}:objects`;
const snapshots = (id) => `image:${id}:snapshots`;
const history = (id) => `image:${id}:history`;

function assertAllowedFields(input, allowed, label) {
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) throw new TypeError(`unknown ${label} fields: ${extra.join(', ')}`);
}

// ADR 0052 decision 5b. Every durable write in this service funnels through here, which is why the
// guard lives here rather than in each `put*`: one seam, so a record kind added later is covered
// without anyone remembering to cover it.
//
// Two refusals, and they are different failures with different scopes.
//
// A reserved *id* would create a durable record that arena-first resolution could later shadow,
// which decision 5c forbids outright. That check applies only where the key *is* an object id — the
// per-image record collection. ADR 0052 reserves the namespace for REF `objectId` specifically, not
// for every storage key, so an image may legitimately be named anything at all; an image id is not
// an object id and never appears as one in a REF.
//
// A reserved *ref* would persist a pointer to something that dies with the arena — a dangling
// reference the moment the execution ends. That applies to every durable value, image records
// included, because a transient ref is just as dangling wherever it is stored.
//
// Neither should ever fire in correct operation: the central promotion operation runs first and
// rewrites transient refs. This is the proof that it did, not the mechanism that does it.
function assertNoTransientIdentity(collection, key, value, {keyIsObjectId}) {
  if (keyIsObjectId && isTransientObjectId(key)) {
    throw new TypeError(
      `cannot write a durable record at the runtime-reserved transient id ${key} in ${collection}`,
    );
  }
  const embedded = findTransientRefs(value);
  if (embedded.length > 0) {
    const {imageId, objectId} = embedded[0];
    throw new TypeError(
      `cannot write a durable record embedding the unpromoted transient reference `
      + `${imageId}/${objectId}; it must be promoted first`,
    );
  }
}

async function putWithHistory(backend, {
  collection,
  key,
  value,
  expectedVersion,
  stream,
  event,
  // True where `key` is a graph object id, which is the only place ADR 0052's reserved namespace
  // applies. Default false so a new caller has to say so deliberately rather than inherit a
  // restriction on whatever its keys happen to mean.
  keyIsObjectId = false,
}) {
  assertNoTransientIdentity(collection, key, value, {keyIsObjectId});
  return await backend.transaction(async (candidate) => {
    const transaction = assertBackendTransaction(candidate);
    const stored = await transaction.put(collection, key, value, {expectedVersion});
    await transaction.append(stream, event(stored));
    return stored;
  });
}

// --- atomic heterogeneous record creation (bead lagrange-images-595) ----------
//
// ONE owner for "N durable records + N history events -> one backend transaction".
// Both the existing single-record put paths and the heterogeneous batch route
// through the SAME per-kind prepare/validate/event owners below, so the batch can
// never drift from the single-record semantics. The backend stays unaware of
// record kinds/image semantics.
//
// The per-kind history event. Single owner for the exact event payload each record
// kind emits; the single-record put methods and the batch share it, so no generic
// `record.put` event can ever be invented and ADR 0071 replay stays truthful.
function putEventForRecord(saved, at) {
  switch (saved.kind) {
    case 'shape':
      return {type: 'shape.put', at, shapeId: saved.id, shapeVersion: saved._version, shape: structuredClone(saved)};
    case 'object':
      return {type: 'object.put', at, objectId: saved.id, objectVersion: saved._version, object: structuredClone(saved)};
    case 'code-artifact':
      return {type: 'code-artifact.put', at, artifactId: saved.id, artifactVersion: saved._version, artifact: structuredClone(saved)};
    case 'lexical-environment':
      return {type: 'lexical-environment.put', at, environmentId: saved.id, environmentVersion: saved._version, environment: structuredClone(saved)};
    case 'block':
      return {type: 'block.put', at, blockId: saved.id, blockVersion: saved._version, block: structuredClone(saved)};
    default:
      throw new TypeError(`unknown record kind for history event: ${saved?.kind ?? 'missing'}`);
  }
}

// The ONE owner of "N prepared candidate records + N history events -> one backend
// transaction". Both `putObjects` (generic-object batch) and `createRecords`
// (heterogeneous batch) delegate the actual atomic commit here, so there is exactly
// one place that pairs a per-record put with its per-kind history append inside a
// single transaction. A module-level function (not a private method) because the
// service is consumed through lane wrappers that cannot reach private receivers.
// expectedVersion is insert-only 0 unless a caller deliberately overrides (the ADR
// 0067 batch's CAS-retry contract).
async function commitCandidateRecords(backend, imageId, candidates, {at, expectedVersion = 0} = {}) {
  return await backend.transaction(async (candidate) => {
    const transaction = assertBackendTransaction(candidate);
    const results = [];
    for (const record of candidates) {
      assertNoTransientIdentity(records(imageId), record.id, record, {keyIsObjectId: true});
      const stored = await transaction.put(records(imageId), record.id, record, {expectedVersion});
      await transaction.append(history(imageId), putEventForRecord(stored, at));
      results.push(stored);
    }
    return results;
  });
}

// The field whitelist each kind's write seam enforces (identical to the single-record
// put methods). One definition so the batch cannot drift.
const RECORD_INPUT_FIELDS = Object.freeze({
  'shape': new Set(['id', 'slots', 'indexed', 'metadata']),
  'object': new Set(['id', 'shape', 'behavior', 'slots', 'indexed', 'metadata']),
  'code-artifact': new Set(['id', 'languageId', 'representation', 'content', 'dependencies', 'derivedFrom', 'metadata']),
  'lexical-environment': new Set(['id', 'parent', 'bindings', 'metadata']),
  'block': new Set(['id', 'code', 'environment', 'metadata']),
});

// The human-readable label each kind's field-whitelist error uses, matching the
// established single-record put contracts exactly (so error messages do not change).
const RECORD_INPUT_LABEL = Object.freeze({
  'shape': 'shape',
  'object': 'generic object',
  'code-artifact': 'code artifact',
  'lexical-environment': 'lexical environment',
  'block': 'block',
});

// Phase 1: build the canonical candidate record from the existing record-model
// owner, with the kind's field whitelist enforced. No relational validation and no
// durable effect here. `at` is the one operation timestamp for the whole batch.
function prepareCandidateRecord(kind, imageId, input, {at, mintId}) {
  // The `kind` discriminant selects the schema; it is not itself a record field, so
  // it is excluded from the field whitelist (the single-record put methods never
  // see it). Everything else is validated exactly as the single-record path does.
  const {kind: _kind, ...fields} = input;
  assertAllowedFields(fields, RECORD_INPUT_FIELDS[kind], RECORD_INPUT_LABEL[kind]);
  const id = input.id ?? mintId();
  switch (kind) {
    case 'shape':
      return createShapeRecord({
        id, imageId, slots: input.slots ?? [], metadata: input.metadata ?? {}, updatedAt: at,
        ...(Object.hasOwn(input, 'indexed') ? {indexed: input.indexed} : {}),
      });
    case 'object':
      return createObjectRecord({
        id, imageId, shape: input.shape, behavior: input.behavior ?? null, slots: input.slots ?? {},
        metadata: input.metadata ?? {}, updatedAt: at,
        ...(Object.hasOwn(input, 'indexed') ? {indexed: input.indexed} : {}),
      });
    case 'code-artifact':
      return createCodeArtifactRecord({
        id, imageId, languageId: input.languageId ?? null, representation: input.representation,
        content: input.content, dependencies: input.dependencies ?? [], derivedFrom: input.derivedFrom ?? [],
        metadata: input.metadata ?? {}, updatedAt: at,
      });
    case 'lexical-environment':
      return createLexicalEnvironmentRecord({
        id, imageId, parent: input.parent ?? null, bindings: input.bindings ?? {},
        metadata: input.metadata ?? {}, updatedAt: at,
      });
    case 'block':
      return createBlockRecord({
        id, imageId, code: input.code, environment: input.environment ?? null,
        metadata: input.metadata ?? {}, updatedAt: at,
      });
    default:
      throw new TypeError(`unknown record kind: ${kind}`);
  }
}

// Phase 3: relational validation against a resolver. EXACTLY the rules the
// single-record put methods enforce — no broadened or narrowed semantics. The
// resolver is batch-local for the heterogeneous path (a fresh record created in the
// same batch resolves), and the plain GraphImageService record read for a single
// put. `resolve(ref)` must return the candidate/existing record or null, and
// `resolveKind(ref)` its kind (or null). `existing` is the pre-existing durable
// record at the candidate's own id (for the lexical-environment layout rule), if any.
async function validateCandidateRecord(candidate, {resolve, resolveKind, existing}) {
  switch (candidate.kind) {
    case 'shape':
      return; // Shape's own model validation already ran in prepare; no graph edges.
    case 'object': {
      if ((await resolveKind(candidate.shape)) !== 'shape') {
        throw new TypeError(`shape not found: ${candidate.shape.imageId}/${candidate.shape.objectId}`);
      }
      assertObjectMatchesShape(candidate, await resolve(candidate.shape));
      return;
    }
    case 'code-artifact':
      for (const dependency of candidate.dependencies) {
        if ((await resolveKind(dependency.artifact)) !== 'code-artifact') {
          throw new TypeError(`code artifact dependency ${dependency.role} must reference a code-artifact: ${dependency.artifact.imageId}/${dependency.artifact.objectId}`);
        }
      }
      return;
    case 'lexical-environment':
      if (candidate.parent && (await resolveKind(candidate.parent)) !== 'lexical-environment') {
        throw new TypeError(`lexical environment parent must reference a lexical-environment: ${candidate.parent.imageId}/${candidate.parent.objectId}`);
      }
      if (existing) {
        if (existing.kind !== 'lexical-environment') {
          throw new TypeError(`record already exists with another kind: ${candidate.imageId}/${candidate.id}`);
        }
        assertLexicalEnvironmentLayoutCompatible(existing, candidate);
      }
      return;
    case 'block':
      if ((await resolveKind(candidate.code)) !== 'code-artifact') {
        throw new TypeError(`block code must reference a code-artifact: ${candidate.code.imageId}/${candidate.code.objectId}`);
      }
      if (candidate.environment && (await resolveKind(candidate.environment)) !== 'lexical-environment') {
        throw new TypeError(`block environment must reference a lexical-environment: ${candidate.environment.imageId}/${candidate.environment.objectId}`);
      }
      return;
    default:
      throw new TypeError(`unknown record kind: ${candidate.kind}`);
  }
}

class ImageService {
  constructor({backend, clock = () => new Date()} = {}) {
    this.backend = assertBackend(backend);
    this.clock = clock;
  }

  now() { return this.clock().toISOString(); }

  async createImage({id = randomUUID(), name = id, language = 'symmetric-smalltalk', metadata = {}} = {}) {
    const at = this.now();
    if (await this.backend.get(IMAGE_COLLECTION, id)) throw new TypeError(`image already exists: ${id}`);
    const image = await putWithHistory(this.backend, {
      collection: IMAGE_COLLECTION,
      key: id,
      value: {
        id, name, language, rootObjectId: null,
        metadata: normalizeMetadata(metadata, 'image metadata'),
        createdAt: at, updatedAt: at,
      },
      expectedVersion: 0,
      stream: history(id),
      event: (stored) => ({type: 'image.created', at, image: structuredClone(stored)}),
    });
    return image;
  }

  async getImage(imageId) {
    const image = await this.backend.get(IMAGE_COLLECTION, imageId);
    if (!image) throw new TypeError(`image not found: ${imageId}`);
    return image;
  }

  async listImages() {
    return (await this.backend.scan(IMAGE_COLLECTION)).map(({value}) => value);
  }

  async putShape(imageId, input) {
    await this.getImage(imageId);
    const at = this.now();
    // One owner: prepare/validate/event all route through the shared per-kind owners,
    // so the single-record path and the heterogeneous batch can never drift apart.
    const shape = prepareCandidateRecord('shape', imageId, input, {at, mintId: randomUUID});
    await validateCandidateRecord(shape, {resolve: () => null, resolveKind: () => null, existing: null});
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: shape.id,
      value: shape,
      expectedVersion: 0,
      stream: history(imageId),
      event: (saved) => putEventForRecord(saved, at),
    });
    return stored;
  }

  async getRecord(imageId, recordId) {
    await this.getImage(imageId);
    return await this.backend.get(records(imageId), recordId);
  }

  async requireRecordKind(ref, kind, label) {
    const record = await this.getRecord(ref.imageId, ref.objectId);
    if (!record || record.kind !== kind) {
      throw new TypeError(`${label} must reference a ${kind}: ${ref.imageId}/${ref.objectId}`);
    }
    return record;
  }

  async getShape(imageId, shapeId) {
    const record = await this.getRecord(imageId, shapeId);
    return record?.kind === 'shape' ? record : null;
  }

  async listRecords(imageId) {
    await this.getImage(imageId);
    return (await this.backend.scan(records(imageId))).map(({value}) => value);
  }

  async listShapes(imageId) {
    return (await this.listRecords(imageId)).filter(({kind}) => kind === 'shape');
  }

  async putObject(imageId, input, {expectedVersion} = {}) {
    await this.getImage(imageId);
    const at = this.now();
    const object = prepareCandidateRecord('object', imageId, input, {at, mintId: randomUUID});
    await validateCandidateRecord(object, {
      resolve: (ref) => this.getRecord(ref.imageId, ref.objectId),
      resolveKind: async (ref) => (await this.getRecord(ref.imageId, ref.objectId))?.kind ?? null,
      existing: null,
    });
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: object.id,
      value: object,
      expectedVersion,
      stream: history(imageId),
      event: (saved) => putEventForRecord(saved, at),
    });
    return stored;
  }

  // ADR 0067. N create specs, one transaction, all-or-none. Each element goes through the same
  // field/record/shape checks as putObject, but every put+append pair is committed inside a single
  // backend.transaction. The caller is expected to have already authorized every member (this is a
  // graph write, not an authority surface); the atomicity envelope is what this method adds.
  async putObjects(imageId, inputs, {expectedVersion = 0} = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new TypeError('putObjects inputs must be a non-empty array');
    }
    await this.getImage(imageId);
    const at = this.now();
    // Phase 1 + 3: build and validate each generic Object candidate through the SAME
    // owners the heterogeneous batch uses. putObjects is objects-only and resolves
    // Shapes from EXISTING storage (its ADR 0067 contract predates the batch-local
    // overlay), so its resolver is the plain record read — no fresh-in-batch shapes.
    const prepared = [];
    for (const [index, input] of inputs.entries()) {
      const object = prepareCandidateRecord('object', imageId, input, {at, mintId: randomUUID});
      await validateCandidateRecord(object, {
        resolve: (ref) => this.getRecord(ref.imageId, ref.objectId),
        resolveKind: async (ref) => (await this.getRecord(ref.imageId, ref.objectId))?.kind ?? null,
        existing: null,
      });
      prepared.push(object);
    }
    // Phase 4: the SAME atomic commit owner as the heterogeneous batch.
    return await commitCandidateRecords(this.backend, imageId, prepared, {at, expectedVersion});
  }

  // The ONE owner of "N prepared candidate records + N history events -> one
  // backend transaction". Both `putObjects` (generic-object batch) and
  // `createRecords` (heterogeneous batch) delegate the actual atomic commit here,
  // so there is exactly one place that pairs a per-record put with its history
  // ADR 0074 §H follow-up (bead lagrange-images-595): ONE atomic heterogeneous
  // insert-only creation operation for the existing durable record kinds. Every
  // prepared record + its correct per-kind history event commits, or none do. This
  // is a trusted GraphImageService substrate seam — NOT arbitrary heterogeneous
  // mutation, a general multi-record transaction API, deletion, a cross-Image
  // transaction, an authority surface, or graph-bundle import.
  //
  // Inputs are discriminated by the EXISTING durable record kind:
  //   {kind:'shape'| 'object'| 'code-artifact'| 'lexical-environment'| 'block', ...}
  //
  // The batch-local overlay (Phase 2) lets a record reference another record created
  // in the SAME batch — a fresh Object -> fresh Shape, Block -> fresh CodeArtifact +
  // LexicalEnvironment, CodeArtifact -> fresh CodeArtifact dependency — without
  // pretending the referenced record pre-existed. Validation reuses EXACTLY the
  // single-record semantic owners; no broadened or narrowed graph semantics.
  async createRecords(imageId, inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new TypeError('createRecords inputs must be a non-empty array');
    }
    await this.getImage(imageId);
    const at = this.now();

    // Phase 1 — structural preparation, no durable effect. Build every canonical
    // candidate via the existing record-model owner; enforce non-empty, known kinds,
    // unique candidate ids, target-image membership, no _version, no transient, and
    // insert-only semantics.
    const candidates = [];
    const byId = new Map();
    for (const [index, input] of inputs.entries()) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError(`createRecords input ${index} must be a record spec object`);
      }
      const kind = input.kind;
      if (!Object.hasOwn(RECORD_INPUT_FIELDS, kind)) {
        throw new TypeError(`createRecords input ${index} has unknown record kind: ${kind}`);
      }
      if (Object.hasOwn(input, '_version')) {
        throw new TypeError(`createRecords input ${index} must not supply _version (insert-only)`);
      }
      const record = prepareCandidateRecord(kind, imageId, input, {at, mintId: randomUUID});
      if (byId.has(record.id)) {
        throw new TypeError(`createRecords duplicate candidate id: ${imageId}/${record.id}`);
      }
      if (record.imageId !== imageId) {
        throw new TypeError(`createRecords candidate ${record.id} belongs to image ${record.imageId}, not ${imageId}`);
      }
      byId.set(record.id, record);
      candidates.push(record);
    }

    // Phase 2 — batch-local overlay resolver. Exactly one purpose: resolve(ref) is
    // the prepared batch candidate if ref names one, otherwise the existing durable
    // record via GraphImageService. Transaction/preparation-local only — not a new
    // graph namespace or durable identity system.
    const resolveOverlay = async (ref) => {
      if (ref.imageId === imageId && byId.has(ref.objectId)) return byId.get(ref.objectId);
      return await this.getRecord(ref.imageId, ref.objectId);
    };
    const resolveKind = async (ref) => (await resolveOverlay(ref))?.kind ?? null;

    // Phase 3 — relational validation via the overlay, reusing EXACTLY the
    // single-record semantic owners. Any failure -> ZERO records, ZERO history.
    for (const candidate of candidates) {
      const existing = await this.getRecord(imageId, candidate.id);
      await validateCandidateRecord(candidate, {resolve: resolveOverlay, resolveKind, existing});
    }

    // Phase 4 — ONE backend transaction. Each candidate put insert-only
    // (expectedVersion: 0) + the EXACT per-kind history event the single-record path
    // would emit. Any put/append/backend failure aborts the whole transaction.
    return await commitCandidateRecords(this.backend, imageId, candidates, {at, expectedVersion: 0});
  }

  async getObject(imageId, objectId) {
    const record = await this.getRecord(imageId, objectId);
    return record?.kind === 'object' ? record : null;
  }

  async listObjects(imageId) {
    return (await this.listRecords(imageId)).filter(({kind}) => kind === 'object');
  }

  async putCodeArtifact(imageId, input) {
    await this.getImage(imageId);
    const at = this.now();
    const artifact = prepareCandidateRecord('code-artifact', imageId, input, {at, mintId: randomUUID});
    await validateCandidateRecord(artifact, {
      resolve: (ref) => this.getRecord(ref.imageId, ref.objectId),
      resolveKind: async (ref) => (await this.getRecord(ref.imageId, ref.objectId))?.kind ?? null,
      existing: null,
    });
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: artifact.id,
      value: artifact,
      expectedVersion: 0,
      stream: history(imageId),
      event: (saved) => putEventForRecord(saved, at),
    });
    return stored;
  }

  async getCodeArtifact(imageId, artifactId) {
    const record = await this.getRecord(imageId, artifactId);
    return record?.kind === 'code-artifact' ? record : null;
  }

  async listCodeArtifacts(imageId) {
    return (await this.listRecords(imageId)).filter(({kind}) => kind === 'code-artifact');
  }

  async putLexicalEnvironment(imageId, input, {expectedVersion} = {}) {
    await this.getImage(imageId);
    const at = this.now();
    const environment = prepareCandidateRecord('lexical-environment', imageId, input, {at, mintId: randomUUID});
    const current = await this.getRecord(imageId, environment.id);
    await validateCandidateRecord(environment, {
      resolve: (ref) => this.getRecord(ref.imageId, ref.objectId),
      resolveKind: async (ref) => (await this.getRecord(ref.imageId, ref.objectId))?.kind ?? null,
      existing: current,
    });
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: environment.id,
      value: environment,
      expectedVersion: expectedVersion ?? current?._version ?? 0,
      stream: history(imageId),
      event: (saved) => putEventForRecord(saved, at),
    });
    return stored;
  }

  async getLexicalEnvironment(imageId, environmentId) {
    const record = await this.getRecord(imageId, environmentId);
    return record?.kind === 'lexical-environment' ? record : null;
  }

  async listLexicalEnvironments(imageId) {
    return (await this.listRecords(imageId)).filter(({kind}) => kind === 'lexical-environment');
  }

  async putBlock(imageId, input) {
    await this.getImage(imageId);
    const at = this.now();
    const block = prepareCandidateRecord('block', imageId, input, {at, mintId: randomUUID});
    await validateCandidateRecord(block, {
      resolve: (ref) => this.getRecord(ref.imageId, ref.objectId),
      resolveKind: async (ref) => (await this.getRecord(ref.imageId, ref.objectId))?.kind ?? null,
      existing: null,
    });
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: block.id,
      value: block,
      expectedVersion: 0,
      stream: history(imageId),
      event: (saved) => putEventForRecord(saved, at),
    });
    return stored;
  }

  async getBlock(imageId, blockId) {
    const record = await this.getRecord(imageId, blockId);
    return record?.kind === 'block' ? record : null;
  }

  async listBlocks(imageId) {
    return (await this.listRecords(imageId)).filter(({kind}) => kind === 'block');
  }

  async setRoot(imageId, rootObjectId, {expectedVersion} = {}) {
    const image = await this.getImage(imageId);
    if (!await this.getObject(imageId, rootObjectId)) throw new TypeError(`root object not found: ${rootObjectId}`);
    const at = this.now();
    const stored = await putWithHistory(this.backend, {
      collection: IMAGE_COLLECTION,
      key: imageId,
      value: {...image, rootObjectId, updatedAt: at, _version: undefined},
      expectedVersion: expectedVersion ?? image._version,
      stream: history(imageId),
      event: (saved) => ({type: 'image.root-set', at, rootObjectId, imageVersion: saved._version}),
    });
    return stored;
  }

  async history(imageId, options = {}) {
    await this.getImage(imageId);
    return await this.backend.readStream(history(imageId), options);
  }

  // ADR 0071 Q1: the current committed Image frontier — the per-image
  // history-stream high-water revision. This is a stable-current-position fence,
  // not an as-of read, atomic snapshot, retention promise, multi-Image
  // transaction, or Project frontier capture. Reading it advances nothing.
  //
  // Ownership: this method is about the current committed IMAGE FRONTIER. The
  // private history-stream name stays inside the Images layer; the backend's
  // `streamHead` stays about stream heads and never learns what an Image
  // frontier is. Frontier is the HISTORY revision, categorically distinct from a
  // record's per-record `_version` (ADR 0069/0071).
  async frontier(imageId) {
    await this.getImage(imageId);
    return await this.backend.streamHead(history(imageId));
  }

  async snapshot(imageId, {id = randomUUID(), label = null} = {}) {
    const image = await this.getImage(imageId);
    const data = {id, imageId, label, createdAt: this.now(), image, records: await this.listRecords(imageId)};
    return await this.backend.put(snapshots(imageId), id, data, {expectedVersion: 0});
  }
}

export {ImageService};
