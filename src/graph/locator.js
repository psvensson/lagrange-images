import {assertBackend} from '../backend/backend-contract.js';
import {IMAGE_COLLECTION, records} from '../image/storage-layout.js';
import {isObjectRef} from '../value/scalars.js';

const WHOLE_IMAGE_RESIDENCY = 'whole-image/v1';
const PER_OBJECT_RESIDENCY = 'per-object/v1';
const RELOCATED_RECORD_KIND = 'relocated';
const backendByResidency = new WeakMap();
const remoteByResidency = new WeakMap();

class ObjectResidency {
  constructor({backend, imageId, kind = WHOLE_IMAGE_RESIDENCY, objectId = undefined, remote = false}) {
    this.kind = kind;
    this.imageId = imageId;
    if (kind === PER_OBJECT_RESIDENCY) {
      this.objectId = objectId;
    }
    backendByResidency.set(this, backend);
    remoteByResidency.set(this, Boolean(remote));
    Object.freeze(this);
  }
}

function backendForResidency(residency) {
  const backend = backendByResidency.get(residency);
  if (!backend) throw new TypeError('object residency did not come from the object locator');
  return backend;
}

function isRemoteResidency(residency) {
  return Boolean(remoteByResidency.get(residency));
}

class ObjectLocator {
  #residencies = new Map();
  #objectResidencies = new Map();
  #peers = new Map();

  constructor({backend, peers = {}} = {}) {
    this.backend = assertBackend(backend);
    if (peers && typeof peers === 'object') {
      const entries = peers instanceof Map || Array.isArray(peers)
        ? peers
        : Object.entries(peers);
      for (const [nodeId, peerBackend] of entries) {
        this.registerPeer(nodeId, peerBackend);
      }
    }
  }

  registerPeer(nodeId, peerBackend) {
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      throw new TypeError('peer nodeId must be a non-empty string');
    }
    const validated = assertBackend(peerBackend);
    this.#peers.set(nodeId, validated);
    this.#residencies.clear();
    this.#objectResidencies.clear();
    return this;
  }

  unregisterPeer(nodeId) {
    this.#peers.delete(nodeId);
    this.#residencies.clear();
    this.#objectResidencies.clear();
    return this;
  }

  hasPeers() {
    return this.#peers.size > 0;
  }

  peerBackend(nodeId) {
    return this.#peers.get(nodeId) ?? null;
  }

  invalidate(ref = null) {
    if (!ref) {
      this.#residencies.clear();
      this.#objectResidencies.clear();
      return;
    }
    if (!isObjectRef(ref)) throw new TypeError('object locator invalidate requires an ObjectRef');
    this.#objectResidencies.delete(`${ref.imageId}\0${ref.objectId}`);
    this.#residencies.delete(ref.imageId);
  }

  async locateImage(imageId) {
    if (typeof imageId !== 'string' || imageId.length === 0) {
      throw new TypeError('object locator requires a non-empty imageId');
    }
    const cached = this.#residencies.get(imageId);
    if (cached) return cached;
    const localImage = await this.backend.get(IMAGE_COLLECTION, imageId);
    if (localImage) {
      const residency = new ObjectResidency({backend: this.backend, imageId, kind: WHOLE_IMAGE_RESIDENCY});
      this.#residencies.set(imageId, residency);
      return residency;
    }
    for (const [, peerBackend] of this.#peers.entries()) {
      const peerImage = await peerBackend.get(IMAGE_COLLECTION, imageId);
      if (peerImage) {
        const residency = new ObjectResidency({
          backend: peerBackend,
          imageId,
          kind: WHOLE_IMAGE_RESIDENCY,
          remote: peerBackend !== this.backend,
        });
        this.#residencies.set(imageId, residency);
        return residency;
      }
    }
    return null;
  }

  async locate(ref) {
    if (!isObjectRef(ref)) throw new TypeError('object locator requires an ObjectRef');
    if (this.#peers.size === 0) {
      return await this.locateImage(ref.imageId);
    }

    const key = `${ref.imageId}\0${ref.objectId}`;
    const cachedObject = this.#objectResidencies.get(key);
    if (cachedObject) return cachedObject;

    const localRecord = await this.backend.get(records(ref.imageId), ref.objectId);
    if (localRecord) {
      if (localRecord.kind === RELOCATED_RECORD_KIND) {
        let hopRecord = localRecord;
        let hops = 0;
        while (hopRecord?.kind === RELOCATED_RECORD_KIND && hops <= this.#peers.size) {
          hops += 1;
          const peerBackend = this.#peers.get(hopRecord.node);
          if (!peerBackend) break;
          const peerRecord = await peerBackend.get(records(ref.imageId), ref.objectId);
          if (!peerRecord) break;
          if (peerRecord.kind !== RELOCATED_RECORD_KIND) {
            const residency = new ObjectResidency({
              backend: peerBackend,
              imageId: ref.imageId,
              kind: PER_OBJECT_RESIDENCY,
              objectId: ref.objectId,
              remote: peerBackend !== this.backend,
            });
            this.#objectResidencies.set(key, residency);
            return residency;
          }
          hopRecord = peerRecord;
        }
      } else {
        const localImage = await this.backend.get(IMAGE_COLLECTION, ref.imageId);
        if (localImage) {
          return await this.locateImage(ref.imageId);
        }
        const residency = new ObjectResidency({
          backend: this.backend,
          imageId: ref.imageId,
          kind: PER_OBJECT_RESIDENCY,
          objectId: ref.objectId,
          remote: false,
        });
        this.#objectResidencies.set(key, residency);
        return residency;
      }
    }

    for (const [, peerBackend] of this.#peers.entries()) {
      const peerRecord = await peerBackend.get(records(ref.imageId), ref.objectId);
      if (peerRecord && peerRecord.kind !== RELOCATED_RECORD_KIND) {
        const peerImage = await peerBackend.get(IMAGE_COLLECTION, ref.imageId);
        if (peerImage) {
          return await this.locateImage(ref.imageId);
        }
        const residency = new ObjectResidency({
          backend: peerBackend,
          imageId: ref.imageId,
          kind: PER_OBJECT_RESIDENCY,
          objectId: ref.objectId,
          remote: peerBackend !== this.backend,
        });
        this.#objectResidencies.set(key, residency);
        return residency;
      }
    }

    return await this.locateImage(ref.imageId);
  }
}

export {
  ObjectLocator,
  PER_OBJECT_RESIDENCY,
  RELOCATED_RECORD_KIND,
  WHOLE_IMAGE_RESIDENCY,
  backendForResidency,
  isRemoteResidency,
};
