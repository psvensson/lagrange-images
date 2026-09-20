// The trusted provisioning seam (GitHub #224, handoff from the Lagrange Object Environment).
//
// One public operation shape: create a well-known object or Shape at a CALLER-CHOSEN stable id,
// replayed idempotently, so a later session finds it from a well-known id without scanning the
// image. The admission rule is NOT decided here: this module is a thin public boundary over the
// one ensure-exact-or-create owner in ./ensure-records.js, which owns convergence, projections
// and the insert-only CAS. Adding a second admission implementation here would be exactly the
// duplicated-policy defect the ensure owner exists to prevent.
//
// The covenant: provisioning is TRUSTED, install-time and host-invoked (ADR 0015 consumers in the
// Object Environment); it is not an authorized user-facing creation lane, and every later READ
// still crosses the ordinary object/read authorization. It never depends on the Smalltalk kernel
// wrapper — the public `ensureObject`/`ensureShape` exported from src/runtime.js belong to
// src/language/smalltalk-kernel.js, which reports a provisioning conflict as a Smalltalk KERNEL
// error. Durable-state provisioning that is not Smalltalk's must not be gated on (or typed by)
// the Smalltalk personality, and a name collision that happens to behave correctly is a worse
// trap than this explicit seam.
//
//   identical replay      -> write-free (the record's version does not move)
//   divergent occupant    -> ProvisioningConflictError, overwrite nothing
//   concurrent races      -> converge on the identical winner (or conflict on a divergent one)
//   deliberate replacement-> `seed: true`: the desired record is only the INITIAL value of a
//                            record mutated afterwards under its own CAS; a present or winning
//                            occupant is adopted AS-IS and the CALLER applies its own domain
//                            check. Neither mode ever overwrites.
//
// The caller always names the id. This seam mints nothing.
import {ensureObject, ensureShape} from './ensure-records.js';

class ProvisioningConflictError extends TypeError {
  constructor(kind, imageId, objectId) {
    super(`provisioning conflict: ${kind} ${imageId}/${objectId} already exists and differs; refusing to overwrite it`);
    this.name = 'ProvisioningConflictError';
    this.kind = kind;
    this.imageId = imageId;
    this.objectId = objectId;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`provisioning: ${label} must be a non-empty string`);
  }
  return value;
}

// A durable record whose id the caller never named would make replay unprovable (a minted id
// cannot be re-provisioned at the same id by construction), so a caller-chosen id is a
// precondition of the seam, not a convention.
function assertCallerChosenId(desired, label) {
  if (!desired || typeof desired !== 'object') throw new TypeError(`provisioning: ${label} record is required`);
  requiredText(desired.id, `${label} id (chosen by the caller; provisioning mints nothing)`);
  return desired;
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('provisioning: images service is required');
  return images;
}

async function provisionObject({images, imageId, object, seed = false}) {
  assertImages(images);
  requiredText(imageId, 'imageId');
  assertCallerChosenId(object, 'object');
  for (const method of ['getObject', 'putObject']) {
    if (typeof images[method] !== 'function') {
      throw new TypeError(`provisioning: images service must implement ${method}`);
    }
  }
  return await ensureObject(images, imageId, object, {
    seed,
    conflict: (kind, image, id) => new ProvisioningConflictError(kind, image, id),
  });
}

async function provisionShape({images, imageId, shape}) {
  assertImages(images);
  requiredText(imageId, 'imageId');
  assertCallerChosenId(shape, 'shape');
  return await ensureShape(images, imageId, shape, {
    conflict: (kind, image, id) => new ProvisioningConflictError(kind, image, id),
  });
}

export {
  ProvisioningConflictError,
  provisionObject,
  provisionShape,
};
