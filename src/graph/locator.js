import {assertBackend} from '../backend/backend-contract.js';
import {IMAGE_COLLECTION} from '../image/storage-layout.js';
import {isObjectRef} from '../value/scalars.js';

const WHOLE_IMAGE_RESIDENCY = 'whole-image/v1';
const backendByResidency = new WeakMap();

class ObjectResidency {
  constructor({backend, imageId}) {
    this.kind = WHOLE_IMAGE_RESIDENCY;
    this.imageId = imageId;
    backendByResidency.set(this, backend);
    Object.freeze(this);
  }
}

function backendForResidency(residency) {
  const backend = backendByResidency.get(residency);
  if (!backend) throw new TypeError('object residency did not come from the object locator');
  return backend;
}

class ObjectLocator {
  #residencies = new Map();

  constructor({backend} = {}) {
    this.backend = assertBackend(backend);
  }

  async locate(ref) {
    if (!isObjectRef(ref)) throw new TypeError('object locator requires an ObjectRef');
    const cached = this.#residencies.get(ref.imageId);
    if (cached) return cached;
    const image = await this.backend.get(IMAGE_COLLECTION, ref.imageId);
    if (!image) return null;
    const residency = new ObjectResidency({backend: this.backend, imageId: ref.imageId});
    this.#residencies.set(ref.imageId, residency);
    return residency;
  }
}

export {
  ObjectLocator,
  WHOLE_IMAGE_RESIDENCY,
  backendForResidency,
};
