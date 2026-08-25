import {randomUUID} from 'node:crypto';
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
    // The write seam is where every other record kind rejects unknown input fields, and Shape was
    // the one that did not. That was survivable while every Shape field was mandatory; ADR 0047's
    // optional `indexed` made a typo silently store a *different layout* and fail at a distance, on
    // the later object write, naming neither the typo nor this call.
    assertAllowedFields(input, new Set(['id', 'slots', 'indexed', 'metadata']), 'shape');
    const id = input.id ?? randomUUID();
    const at = this.now();
    const shape = createShapeRecord({
      id,
      imageId,
      slots: input.slots ?? [],
      metadata: input.metadata ?? {},
      updatedAt: at,
      ...(Object.hasOwn(input, 'indexed') ? {indexed: input.indexed} : {}),
    });
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: id,
      value: shape,
      expectedVersion: 0,
      stream: history(imageId),
      event: (saved) => ({type: 'shape.put', at, shapeId: id, shapeVersion: saved._version, shape: structuredClone(saved)}),
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
    assertAllowedFields(input, new Set(['id', 'shape', 'behavior', 'slots', 'indexed', 'metadata']), 'generic object');
    const id = input.id ?? randomUUID();
    const at = this.now();
    const object = createObjectRecord({
      id,
      imageId,
      shape: input.shape,
      behavior: input.behavior ?? null,
      slots: input.slots ?? {},
      metadata: input.metadata ?? {},
      updatedAt: at,
      ...(Object.hasOwn(input, 'indexed') ? {indexed: input.indexed} : {}),
    });
    const shape = await this.getShape(object.shape.imageId, object.shape.objectId);
    if (!shape) throw new TypeError(`shape not found: ${object.shape.imageId}/${object.shape.objectId}`);
    assertObjectMatchesShape(object, shape);
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: id,
      value: object,
      expectedVersion,
      stream: history(imageId),
      event: (saved) => ({type: 'object.put', at, objectId: id, objectVersion: saved._version, object: structuredClone(saved)}),
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
    const prepared = [];
    for (const [index, input] of inputs.entries()) {
      assertAllowedFields(input, new Set(['id', 'shape', 'behavior', 'slots', 'indexed', 'metadata']), `generic object ${index}`);
      const id = input.id ?? randomUUID();
      const object = createObjectRecord({
        id,
        imageId,
        shape: input.shape,
        behavior: input.behavior ?? null,
        slots: input.slots ?? {},
        metadata: input.metadata ?? {},
        updatedAt: at,
        ...(Object.hasOwn(input, 'indexed') ? {indexed: input.indexed} : {}),
      });
      const shape = await this.getShape(object.shape.imageId, object.shape.objectId);
      if (!shape) throw new TypeError(`shape not found: ${object.shape.imageId}/${object.shape.objectId}`);
      assertObjectMatchesShape(object, shape);
      prepared.push({id, object});
    }
    const storedList = await this.backend.transaction(async (candidate) => {
      const transaction = assertBackendTransaction(candidate);
      const results = [];
      for (const {id, object} of prepared) {
        assertNoTransientIdentity(records(imageId), id, object, {keyIsObjectId: true});
        const stored = await transaction.put(records(imageId), id, object, {expectedVersion});
        await transaction.append(history(imageId), {
          type: 'object.put',
          at,
          objectId: id,
          objectVersion: stored._version,
          object: structuredClone(stored),
        });
        results.push(stored);
      }
      return results;
    });
    return storedList;
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
    assertAllowedFields(input, new Set(['id', 'languageId', 'representation', 'content', 'dependencies', 'derivedFrom', 'metadata']), 'code artifact');
    const id = input.id ?? randomUUID();
    const at = this.now();
    const artifact = createCodeArtifactRecord({
      id,
      imageId,
      languageId: input.languageId ?? null,
      representation: input.representation,
      content: input.content,
      dependencies: input.dependencies ?? [],
      derivedFrom: input.derivedFrom ?? [],
      metadata: input.metadata ?? {},
      updatedAt: at,
    });
    for (const dependency of artifact.dependencies) {
      await this.requireRecordKind(dependency.artifact, 'code-artifact', `code artifact dependency ${dependency.role}`);
    }
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: id,
      value: artifact,
      expectedVersion: 0,
      stream: history(imageId),
      event: (saved) => ({type: 'code-artifact.put', at, artifactId: id, artifactVersion: saved._version, artifact: structuredClone(saved)}),
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
    assertAllowedFields(input, new Set(['id', 'parent', 'bindings', 'metadata']), 'lexical environment');
    const id = input.id ?? randomUUID();
    const at = this.now();
    const environment = createLexicalEnvironmentRecord({
      id,
      imageId,
      parent: input.parent ?? null,
      bindings: input.bindings ?? {},
      metadata: input.metadata ?? {},
      updatedAt: at,
    });
    if (environment.parent) await this.requireRecordKind(environment.parent, 'lexical-environment', 'lexical environment parent');
    const current = await this.getRecord(imageId, id);
    if (current) {
      if (current.kind !== 'lexical-environment') throw new TypeError(`record already exists with another kind: ${imageId}/${id}`);
      assertLexicalEnvironmentLayoutCompatible(current, environment);
    }
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: id,
      value: environment,
      expectedVersion: expectedVersion ?? current?._version ?? 0,
      stream: history(imageId),
      event: (saved) => ({type: 'lexical-environment.put', at, environmentId: id, environmentVersion: saved._version, environment: structuredClone(saved)}),
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
    assertAllowedFields(input, new Set(['id', 'code', 'environment', 'metadata']), 'block');
    const id = input.id ?? randomUUID();
    const at = this.now();
    const block = createBlockRecord({
      id,
      imageId,
      code: input.code,
      environment: input.environment ?? null,
      metadata: input.metadata ?? {},
      updatedAt: at,
    });
    await this.requireRecordKind(block.code, 'code-artifact', 'block code');
    if (block.environment) await this.requireRecordKind(block.environment, 'lexical-environment', 'block environment');
    const stored = await putWithHistory(this.backend, {
      collection: records(imageId),
      keyIsObjectId: true,
      key: id,
      value: block,
      expectedVersion: 0,
      stream: history(imageId),
      event: (saved) => ({type: 'block.put', at, blockId: id, blockVersion: saved._version, block: structuredClone(saved)}),
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

  async snapshot(imageId, {id = randomUUID(), label = null} = {}) {
    const image = await this.getImage(imageId);
    const data = {id, imageId, label, createdAt: this.now(), image, records: await this.listRecords(imageId)};
    return await this.backend.put(snapshots(imageId), id, data, {expectedVersion: 0});
  }
}

export {ImageService};
