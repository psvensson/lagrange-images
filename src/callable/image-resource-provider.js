import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {CALLABLE_INTERFACE_DEPENDENCY_ROLE, normalizeObjectRef, resolveCallableInterface} from './binding-artifacts.js';
import {
  assertFieldMappingCovers,
  assertProjectionInterface,
  parseImageProjectionBindingArtifact,
  projectObjectSlots,
} from './image-projection-binding.js';

// A prebound WIT resource over one image object, per ADR 0040.
//
// The handle is opaque to the guest and carries identity only: it resolves to host-private
// {imageId, objectId} and never to an authority context, principal, grant or cached decision.
// Every method re-runs require, so revocation stays live and — because the executor context
// expires with its activation — a handle retained past the activation is dead through the same
// lifetime record rather than through a second mechanism of its own.
//
// `own` here owns the transient handle. Dropping one releases that handle and mutates nothing
// durable: no deletion, no revocation, no history.
//
// Implementation constraint worth stating plainly: a WIT `snapshot: func() -> item-record` is
// synchronous, while image reads are asynchronous. So the object record is loaded once when the
// interface is wired — resolving what this prebound resource is bound to, which is
// configuration resolution rather than an authorized data access — and every *observation* is
// gated by a live require. Making the read itself per-call needs async-capable host imports;
// jco exposes asyncMode/asyncImports but wiring them for a resource method did not work in the
// version pinned here, so that is recorded rather than assumed.
const DISPOSE = Symbol.dispose ?? Symbol.for('dispose');

class DroppedResourceHandleError extends TypeError {
  constructor() {
    super('image resource handle has been dropped');
    this.name = 'DroppedResourceHandleError';
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

async function resolvePrebinding(images, projectionRef) {
  const artifact = await images.getCodeArtifact(projectionRef.imageId, projectionRef.objectId);
  if (!artifact) {
    throw new TypeError(`image projection binding not found: ${projectionRef.imageId}/${projectionRef.objectId}`);
  }
  const binding = parseImageProjectionBindingArtifact(artifact);
  const {descriptor} = await resolveCallableInterface(images, artifact, 'image resource provider');
  const record = assertProjectionInterface(descriptor);
  const mapped = assertFieldMappingCovers(record, binding.fields, 'image resource provider');
  return {record, mapped, imageId: artifact.imageId};
}

// Returns a host import provider suitable for ComponentHostImportRegistry. The runtime, not the
// durable graph, decides which object a prebound resource is bound to: how a guest might
// instead *discover* image identity is deliberately a later decision.
function createPreboundImageResourceProvider({images, projection, objectId} = {}) {
  if (!images || typeof images.getObject !== 'function') {
    throw new TypeError('image resource provider requires an images service');
  }
  const projectionRef = normalizeObjectRef(projection, 'image resource projection binding');
  const boundObjectId = requiredText(objectId, 'image resource objectId');

  return async ({require}) => {
    if (typeof require !== 'function') throw new TypeError('image resource provider requires a require(demand) function');
    const {record, mapped, imageId} = await resolvePrebinding(images, projectionRef);
    const demand = {operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, boundObjectId)};
    const object = await images.getObject(imageId, boundObjectId);

    class Item {
      #dropped = false;

      snapshot() {
        // Dropped-ness is independent of authority: a dropped handle is unusable even while
        // the caller's grants remain perfectly valid.
        if (this.#dropped) throw new DroppedResourceHandleError();
        // Live per call: this is where revocation, and activation expiry, both surface.
        require(demand);
        if (!object) throw new TypeError(`projected object not found: ${imageId}/${boundObjectId}`);
        return projectObjectSlots({object, record, mapped, imageId, objectId: boundObjectId});
      }

      // Releases this handle and nothing else. Never deletes the object, revokes authority or
      // touches history. jco calls this when the guest drops an owned handle; a trapping guest
      // does not drop, which is why the activation lifetime rather than this is the cleanup.
      [DISPOSE]() {
        this.#dropped = true;
      }
    }

    return {
      Item,
      openItem() {
        require(demand);
        return new Item();
      },
    };
  };
}

export {
  DroppedResourceHandleError,
  createPreboundImageResourceProvider,
};
