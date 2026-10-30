import {records} from '../image/storage-layout.js';
import {isObjectRef} from '../value/scalars.js';
import {backendForResidency} from './locator.js';

class RemoteRecordResolver {
  async resolveAt(ref, residency) {
    if (!isObjectRef(ref)) throw new TypeError('remote resolution requires an ObjectRef');
    if (!residency || residency.imageId !== ref.imageId) {
      throw new TypeError('remote resolution residency does not match the ObjectRef image');
    }
    const backend = backendForResidency(residency);
    return await backend.get(records(ref.imageId), ref.objectId);
  }
}

export {RemoteRecordResolver};
