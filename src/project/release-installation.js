import {importGraphBundle} from '../graph/bundle.js';
import {createProjectInstallation, normalizeProjectReleaseManifest} from './model.js';
import {validateProjectReleaseMaterialForRelease} from './graph-release-materialization.js';

// The FIRST Project installation coordinator (ADR 0075, Decision 8): the ONE owner of
//
//   ProjectReleaseManifest + ProjectReleaseMaterial/v1 + existing target Image
//     -> imported fresh graph + canonical ProjectInstallation/v1 descriptor.
//
// It ORCHESTRATES the existing owners and absorbs none of them:
//   - `src/project/graph-release-materialization.js` owns ProjectReleaseMaterial/v1
//     intrinsic validation + release<->material linkage (consumed here as the
//     SINGLE linkage owner — these checks are never copied);
//   - `src/graph/bundle.js::importGraphBundle` owns bundle validation,
//     content-identity verification, target-id minting and generic graph import;
//   - `GraphImageService.createRecords` (below importGraphBundle) owns atomic
//     heterogeneous durable publication;
//   - `src/project/model.js::createProjectInstallation` owns ProjectInstallation/v1
//     semantic mapping.
//
// This coordinator owns ONLY sequencing / pre-effect validation / handoff. It does
// NOT read or write the backend, append history, recreate graph-import logic,
// recreate installation semantics, persist an installation record, or invent
// reconciliation/idempotency. It issues no grants and infers no authority from
// Project membership/material — a host-level substrate seam only.
//
// KNOWN CRASH WINDOW (deliberately NOT solved here): this slice does NOT persist
// the returned ProjectInstallation. A process crash after importGraphBundle's
// commit but before some future owner durably records the returned descriptor can
// leave a fresh imported graph that is no longer associated with managed
// installation state. That pressure belongs to the NEXT slice — durable/idempotent
// ProjectInstallation storage + recovery/reconciliation ownership — and must not
// be worked around locally (no installation JSON in the bundle, no importer
// callback, no ad-hoc durable installation object, no Project-model-spanning
// transaction, no delete-on-failure).

class ProjectReleaseInstallationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProjectReleaseInstallationError';
    Object.assign(this, details);
  }
}

async function installProjectRelease({images, targetImageId, release, material, crypto} = {}) {
  if (!images || typeof images.getRecord !== 'function') {
    throw new ProjectReleaseInstallationError('images must be a GraphImageService');
  }
  if (typeof targetImageId !== 'string' || targetImageId.length === 0) {
    throw new ProjectReleaseInstallationError('targetImageId must be a non-empty string');
  }

  // (2) Normalize the release BEFORE the first async effect, and use THIS
  // immutable snapshot for both linked validation and the final descriptor — the
  // semantic inputs to preflight are the exact semantic inputs used after import
  // (no TOCTOU through a caller-mutated original).
  const normalizedRelease = normalizeProjectReleaseManifest(release);

  // (1+3) COMPLETE preflight before any durable target effect: intrinsic material
  // validation + every release<->material linkage rule, through the ONE linkage
  // owner. The returned snapshot is isolated and deeply frozen, so a
  // caller-mutated material object cannot race the async import window.
  // ADR 0075 Decision 8's orphan-prevention boundary.
  const validatedMaterial = validateProjectReleaseMaterialForRelease({
    release: normalizedRelease,
    material,
    crypto,
  });

  // (4) V1 has NO external bindings: the material is fully closed
  // (validatedMaterial.bundle.externals === {} is enforced by the material owner).
  // No externalBindings option exists here — well-known bindings, pinned refs and
  // semantic external requirements are future representation evolution.

  // (5) Import EXACTLY ONCE for the whole release — never once per member. This
  // preserves cross-member sharing, cross-member cycles and one fresh target
  // graph. expectedContentIdentity is the final identity gate immediately before
  // target materialization. A publication failure has the importer's proven
  // all-or-none atomicity; there is no cleanup arm here.
  const imported = await importGraphBundle({
    images,
    targetImageId,
    bundle: validatedMaterial.bundle,
    expectedContentIdentity: validatedMaterial.contentIdentity,
    crypto,
  });

  // (6+7) Hand the imported roots to the Project model — the sole semantic owner
  // of the installation descriptor. Post-import semantic failure is STRUCTURALLY
  // impossible by the owner contracts: linked preflight proved
  //   bundle root keys === release member keys;
  // the importer guarantees returned roots keys === bundle root keys and every
  // returned ObjectRef belongs to targetImageId. Therefore every precondition of
  // createProjectInstallation is satisfied after import, and there is NO
  // compensation/cleanup path for semantic mismatches.
  return createProjectInstallation({
    release: normalizedRelease,
    targetImageId,
    targets: imported.roots,
  });
}

export {
  ProjectReleaseInstallationError,
  installProjectRelease,
};
