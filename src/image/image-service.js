import {randomUUID} from 'node:crypto';
import {assertBackend} from '../backend/backend-contract.js';

const IMAGE_COLLECTION = 'images';

function objectCollection(imageId) {
  return `image:${imageId}:objects`;
}

function snapshotCollection(imageId) {
  return `image:${imageId}:snapshots`;
}

function historyStream(imageId) {
  return `image:${imageId}:history`;
}

class ImageNotFoundError extends Error {
  constructor(imageId) {
    super(`image not found: ${imageId}`);
    this.name = 'ImageNotFoundError';
    this.imageId = imageId;
  }
}

class ImageService {
  constructor({backend, clock = () => new Date()} = {}) {
    this.backend = assertBackend(backend);
    this.clock = clock;
  }

  now() {
    return this.clock().toISOString();
  }

  async createImage({id = randomUUID(), name = id, language = 'symmetric-smalltalk', metadata = {}} = {}) {
    const createdAt = this.now();
    const existing = await this.backend.get(IMAGE_COLLECTION, id);
    if (existing) throw new Error(`image already exists: ${id}`);

    const image = await this.backend.put(
      IMAGE_COLLECTION,
      id,
      {
        id,
        name,
        language,
        rootObjectId: null,
        metadata: structuredClone(metadata),
        createdAt,
        updatedAt: createdAt,
      },
      {expectedVersion: 0},
    );

    await this.backend.append(historyStream(id), {
      type: 'image.created',
      at: createdAt,
      image: structuredClone(image),
    });

    return image;
  }

  async getImage(imageId) {
    const image = await this.backend.get(IMAGE_COLLECTION, imageId);
    if (!image) throw new ImageNotFoundError(imageId);
    return image;
  }

  async listImages() {
    const rows = await this.backend.scan(IMAGE_COLLECTION);
    return rows.map(({value}) => value);
  }

  async putObject(imageId, object, {expectedVersion} = {}) {
    await this.getImage(imageId);

    const id = object.id ?? randomUUID();
    const at = this.now();
    const stored = await this.backend.put(
      objectCollection(imageId),
      id,
      {
        id,
        imageId,
        classId: object.classId ?? 'Object',
        slots: structuredClone(object.slots ?? {}),
        source: object.source ?? null,
        metadata: structuredClone(object.metadata ?? {}),
        updatedAt: at,
      },
      {expectedVersion},
    );

    await this.backend.append(historyStream(imageId), {
      type: 'object.put',
      at,
      objectId: id,
      objectVersion: stored._version,
      object: structuredClone(stored),
    });

    return stored;
  }

  async getObject(imageId, objectId) {
    await this.getImage(imageId);
    return await this.backend.get(objectCollection(imageId), objectId);
  }

  async listObjects(imageId) {
    await this.getImage(imageId);
    const rows = await this.backend.scan(objectCollection(imageId));
    return rows.map(({value}) => value);
  }

  async setRoot(imageId, rootObjectId, {expectedVersion} = {}) {
    const image = await this.getImage(imageId);
    const root = await this.getObject(imageId, rootObjectId);
    if (!root) throw new Error(`root object not found: ${rootObjectId}`);

    const at = this.now();
    const stored = await this.backend.put(
      IMAGE_COLLECTION,
      imageId,
      {
        ...image,
        rootObjectId,
        updatedAt: at,
        _version: undefined,
      },
      {expectedVersion: expectedVersion ?? image._version},
    );

    await this.backend.append(historyStream(imageId), {
      type: 'image.root-set',
      at,
      rootObjectId,
      imageVersion: stored._version,
    });

    return stored;
  }

  async history(imageId, options = {}) {
    await this.getImage(imageId);
    return await this.backend.readStream(historyStream(imageId), options);
  }

  async snapshot(imageId, {id = randomUUID(), label = null} = {}) {
    const image = await this.getImage(imageId);
    const objects = await this.listObjects(imageId);
    const createdAt = this.now();

    return await this.backend.put(
      snapshotCollection(imageId),
      id,
      {
        id,
        imageId,
        label,
        createdAt,
        image,
        objects,
      },
      {expectedVersion: 0},
    );
  }
}

export {ImageNotFoundError, ImageService};
