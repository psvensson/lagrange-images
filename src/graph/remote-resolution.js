import {assertBackendTransaction} from '../backend/backend-contract.js';
import {IMAGE_COLLECTION, records} from '../image/storage-layout.js';
import {isObjectRef} from '../value/scalars.js';
import {PER_OBJECT_RESIDENCY, RELOCATED_RECORD_KIND, backendForResidency} from './locator.js';

class RemoteRecordResolver {
  async resolveAt(ref, residency) {
    if (!isObjectRef(ref)) throw new TypeError('remote resolution requires an ObjectRef');
    if (!residency || residency.imageId !== ref.imageId) {
      throw new TypeError('remote resolution residency does not match the ObjectRef image');
    }
    if (residency.kind === PER_OBJECT_RESIDENCY && residency.objectId !== ref.objectId) {
      throw new TypeError('remote resolution residency does not match the ObjectRef object');
    }
    const backend = backendForResidency(residency);
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
    return await backend.transaction(async (candidate) => {
      const transaction = assertBackendTransaction(candidate);
      const stored = await transaction.put(records(ref.imageId), ref.objectId, value, {expectedVersion});
      await transaction.append(stream, event(stored));
      return stored;
    });
  }
}

export {RemoteRecordResolver};
