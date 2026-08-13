import {randomUUID} from 'node:crypto';
import {assertBackend} from '../backend/backend-contract.js';
import {assertObjectMatchesShape, createObjectRecord, createShapeRecord, normalizeMetadata} from '../object/index.js';

const IMAGE_COLLECTION = 'images';
const records = (id) => `image:${id}:objects`;
const snapshots = (id) => `image:${id}:snapshots`;
const history = (id) => `image:${id}:history`;

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

  async getRecord(imageId, objectId) {
    await this.getImage(imageId);
    return await this.backend.get(records(imageId), objectId);
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
    const allowed = new Set(['id', 'shape', 'behavior', 'slots', 'metadata']);
    const extra = Object.keys(input).filter((key) => !allowed.has(key));
    if (extra.length) throw new TypeError(`unknown generic object fields: ${extra.join(', ')}`);
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
