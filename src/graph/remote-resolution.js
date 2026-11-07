import {assertBackendTransaction} from '../backend/backend-contract.js';
import {IMAGE_COLLECTION, records} from '../image/storage-layout.js';
import {isObjectRef} from '../value/scalars.js';
import {
  PER_OBJECT_RESIDENCY,
  RELOCATED_RECORD_KIND,
  backendForResidency,
  isRemoteResidency,
} from './locator.js';

class RemoteRecordResolver {
  #recordReads = 0;
  #crossNodeRecordReads = 0;
  #localRecordReads = 0;
  #perObjectRecordReads = 0;
  #imageResidencyRecordReads = 0;
  #imageReads = 0;
  #recordWrites = 0;
  #crossNodeRecordWrites = 0;
  #localRecordWrites = 0;
  #perObjectRecordWrites = 0;

  stats() {
    return Object.freeze({
      recordReads: this.#recordReads,
      crossNodeRecordReads: this.#crossNodeRecordReads,
      localRecordReads: this.#localRecordReads,
      perObjectRecordReads: this.#perObjectRecordReads,
      imageResidencyRecordReads: this.#imageResidencyRecordReads,
      imageReads: this.#imageReads,
      recordWrites: this.#recordWrites,
      crossNodeRecordWrites: this.#crossNodeRecordWrites,
      localRecordWrites: this.#localRecordWrites,
      perObjectRecordWrites: this.#perObjectRecordWrites,
    });
  }

  resetStats() {
    this.#recordReads = 0;
    this.#crossNodeRecordReads = 0;
    this.#localRecordReads = 0;
    this.#perObjectRecordReads = 0;
    this.#imageResidencyRecordReads = 0;
    this.#imageReads = 0;
    this.#recordWrites = 0;
    this.#crossNodeRecordWrites = 0;
    this.#localRecordWrites = 0;
    this.#perObjectRecordWrites = 0;
  }

  async resolveAt(ref, residency) {
    if (!isObjectRef(ref)) throw new TypeError('remote resolution requires an ObjectRef');
    if (!residency || residency.imageId !== ref.imageId) {
      throw new TypeError('remote resolution residency does not match the ObjectRef image');
    }
    if (residency.kind === PER_OBJECT_RESIDENCY && residency.objectId !== ref.objectId) {
      throw new TypeError('remote resolution residency does not match the ObjectRef object');
    }
    const backend = backendForResidency(residency);
    const remote = isRemoteResidency(residency);
    this.#recordReads += 1;
    if (remote) {
      this.#crossNodeRecordReads += 1;
      if (residency.kind === PER_OBJECT_RESIDENCY) {
        this.#perObjectRecordReads += 1;
      } else {
        this.#imageResidencyRecordReads += 1;
      }
    } else {
      this.#localRecordReads += 1;
    }
    const record = await backend.get(records(ref.imageId), ref.objectId);
    if (record?.kind === RELOCATED_RECORD_KIND) return null;
    return record;
  }

  async resolveImageAt(imageId, residency) {
    if (typeof imageId !== 'string' || imageId.length === 0) {
      throw new TypeError('remote image resolution requires a non-empty imageId');
    }
    if (!residency || residency.imageId !== imageId) {
      throw new TypeError('remote resolution residency does not match the imageId');
    }
    const backend = backendForResidency(residency);
    this.#imageReads += 1;
    return await backend.get(IMAGE_COLLECTION, imageId);
  }

  async writeRecordAt(ref, residency, {value, expectedVersion, stream, event}) {
    if (!isObjectRef(ref)) throw new TypeError('remote resolution requires an ObjectRef');
    if (!residency || residency.imageId !== ref.imageId) {
      throw new TypeError('remote resolution residency does not match the ObjectRef image');
    }
    if (residency.kind === PER_OBJECT_RESIDENCY && residency.objectId !== ref.objectId) {
      throw new TypeError('remote resolution residency does not match the ObjectRef object');
    }
    const backend = backendForResidency(residency);
    const remote = isRemoteResidency(residency);
    this.#recordWrites += 1;
    if (remote) {
      this.#crossNodeRecordWrites += 1;
      if (residency.kind === PER_OBJECT_RESIDENCY) {
        this.#perObjectRecordWrites += 1;
      }
    } else {
      this.#localRecordWrites += 1;
    }
    return await backend.transaction(async (candidate) => {
      const transaction = assertBackendTransaction(candidate);
      const stored = await transaction.put(records(ref.imageId), ref.objectId, value, {expectedVersion});
      await transaction.append(stream, event(stored));
      return stored;
    });
  }
}

export {RemoteRecordResolver};
