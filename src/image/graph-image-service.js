import {randomUUID} from 'node:crypto';
import {assertBackend} from '../backend/backend-contract.js';
import {assertObjectMatchesShape, createObjectRecord, createShapeRecord, normalizeMetadata} from '../object/index.js';
import {
  assertLexicalEnvironmentLayoutCompatible,
  createBlockRecord,
  createCodeArtifactRecord,
  createLexicalEnvironmentRecord,
} from '../execution/model.js';

const IMAGE_COLLECTION = 'images';
const records = (id) => `image:${id}:objects`;
const snapshots = (id) => `image:${id}:snapshots`;
const history = (id) => `image:${id}:history`;

function assertAllowedFields(input, allowed, label) {
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) throw new TypeError(`unknown ${label} fields: ${extra.join(', ')}`);
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
    const image = await this.backend.put(IMAGE_COLLECTION, id, {
      id, name, language, rootObjectId: null,
      metadata: normalizeMetadata(metadata, 'image metadata'),
      createdAt: at, updatedAt: at,
    }, {expectedVersion: 0});
    await this.backend.append(history(id), {type: 'image.created', at, image: structuredClone(image)});
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
    const id = input.id ?? randomUUID();
    const at = this.now();
    const shape = createShapeRecord({id, imageId, slots: input.slots ?? [], metadata: input.metadata ?? {}, updatedAt: at});
    const stored = await this.backend.put(records(imageId), id, shape, {expectedVersion: 0});
    await this.backend.append(history(imageId), {type: 'shape.put', at, shapeId: id, shapeVersion: stored._version, shape: structuredClone(stored)});
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
    assertAllowedFields(input, new Set(['id', 'shape', 'behavior', 'slots', 'metadata']), 'generic object');
    const id = input.id ?? randomUUID();
    const at = this.now();
    const object = createObjectRecord({
      id, imageId, shape: input.shape, behavior: input.behavior ?? null,
      slots: input.slots ?? {}, metadata: input.metadata ?? {}, updatedAt: at,
    });
    const shape = await this.getShape(object.shape.imageId, object.shape.objectId);
    if (!shape) throw new TypeError(`shape not found: ${object.shape.imageId}/${object.shape.objectId}`);
    assertObjectMatchesShape(object, shape);
    const stored = await this.backend.put(records(imageId), id, object, {expectedVersion});
    await this.backend.append(history(imageId), {type: 'object.put', at, objectId: id, objectVersion: stored._version, object: structuredClone(stored)});
    return stored;
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
    assertAllowedFields(input, new Set(['id', 'languageId', 'representation', 'content', 'derivedFrom', 'metadata']), 'code artifact');
    const id = input.id ?? randomUUID();
    const at = this.now();
    const artifact = createCodeArtifactRecord({
      id,
      imageId,
      languageId: input.languageId ?? null,
      representation: input.representation,
      content: input.content,
      derivedFrom: input.derivedFrom ?? [],
      metadata: input.metadata ?? {},
      updatedAt: at,
    });
    const stored = await this.backend.put(records(imageId), id, artifact, {expectedVersion: 0});
    await this.backend.append(history(imageId), {type: 'code-artifact.put', at, artifactId: id, artifactVersion: stored._version, artifact: structuredClone(stored)});
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
    const stored = await this.backend.put(records(imageId), id, environment, {
      expectedVersion: expectedVersion ?? current?._version ?? 0,
    });
    await this.backend.append(history(imageId), {type: 'lexical-environment.put', at, environmentId: id, environmentVersion: stored._version, environment: structuredClone(stored)});
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
    const stored = await this.backend.put(records(imageId), id, block, {expectedVersion: 0});
    await this.backend.append(history(imageId), {type: 'block.put', at, blockId: id, blockVersion: stored._version, block: structuredClone(stored)});
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
    const stored = await this.backend.put(IMAGE_COLLECTION, imageId, {
      ...image, rootObjectId, updatedAt: at, _version: undefined,
    }, {expectedVersion: expectedVersion ?? image._version});
    await this.backend.append(history(imageId), {type: 'image.root-set', at, rootObjectId, imageVersion: stored._version});
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
