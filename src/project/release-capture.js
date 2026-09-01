import {createProjectReleaseManifest, createProjectReleaseProvenance, selectProjectMembers} from './model.js';
import {readProjectDescriptor} from './working-state.js';

// First truthful current Project release capture (ADR 0073), the coordinator owner
// for the interaction:
//
//   durable working Project -> stable-current member capture -> Project model
//
// OWNERSHIP. This module owns ONLY the sequencing/stability between owners:
//   - `src/project/working-state.js` owns durable Project storage/read translation;
//   - `src/project/model.js` owns descriptor/profile/release/releaseId/provenance;
//   - `GraphImageService.frontier()` owns Image current-position semantics;
//   - the caller's `materializeRecord` owns representation-specific
//     {representation, contentIdentity} derivation.
// No arbitrary graph hashing or serialization lives here.
//
// WHAT A SUCCESSFUL CAPTURE MEANS. Every selected direct source record was read
// while its Image remained at one unchanged committed frontier, AND the durable
// Project descriptor remained unchanged during the capture. It does NOT mean the
// Images were captured atomically together, that the frontier map is one scalar
// revision, that historical reread is available, that any frontier is retained,
// or that the release is a portable graph bundle. Cross-Image capture stays a map
// of independently stable Image positions, exactly as ADR 0073 specifies.
//
// V1 MATERIALIZER CONTRACT (deliberately narrow). The coordinator reads each
// selected member's CURRENT direct source record and hands an immutable snapshot
// to `materializeRecord({member, source, record})`. `images` is never passed — a
// representation whose material identity requires traversing arbitrary transitive
// graph state is later graph-export/materializer pressure, not faked here.

// One explicit refusal when a participating Image's committed frontier moved
// during capture. Carries which Image changed, without inventing Project-history
// semantics. Not retried here — caller policy may retry a fresh capture later.
class ProjectCaptureConflictError extends Error {
  constructor({imageId, before, after}) {
    super(
      `Project release capture refused: Image ${imageId} advanced from frontier ${before} `
      + `to ${after} during capture; no release was produced`,
    );
    this.name = 'ProjectCaptureConflictError';
    this.imageId = imageId;
    this.before = before;
    this.after = after;
  }
}

class ProjectCaptureSourceError extends Error {
  constructor({key, source}) {
    super(`Project release capture failed: member ${key} source record is missing: ${source.imageId}/${source.objectId}`);
    this.name = 'ProjectCaptureSourceError';
    this.key = key;
    this.source = source;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

// Recursively freeze a plain record/array snapshot (already deep-cloned by the
// caller). Values are canonical tagged records / plain data; nothing here mutates
// the input — this freezes the clone, never the stored graph record.
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

function requireMaterialization(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`materializeRecord for member ${key} must return a record`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'contentIdentity' || keys[1] !== 'representation') {
    throw new TypeError(
      `materializeRecord for member ${key} must return exactly {representation, contentIdentity}; got ${keys.join(', ')}`,
    );
  }
  return {representation: value.representation, contentIdentity: value.contentIdentity};
}

async function captureCurrentProjectRelease({
  images,
  projectImageId,
  projectId,
  profile,
  materializeRecord,
  dependencies = [],
} = {}) {
  requiredText(projectImageId, 'projectImageId');
  requiredText(projectId, 'projectId');
  if (typeof materializeRecord !== 'function') throw new TypeError('materializeRecord must be a function');

  // 1. Bracket the Project host BEFORE reading the durable descriptor.
  const beforeHostFrontier = await images.frontier(projectImageId);

  // 2. Read the durable Project through the working-state owner.
  const project = await readProjectDescriptor({images, imageId: projectImageId, projectId});

  // 3. Select members with the EXISTING Project model — no profile semantics here.
  const selected = selectProjectMembers(project, profile);

  // 4. The direct source Image ids of the selected member targets (canonical order).
  const sourceImageIds = [...new Set(selected.map(({target}) => target.imageId))].sort();

  // 5. BEFORE frontier per source Image, before reading any record from it. The
  //    Project host reuses its already-read frontier; other Images are read now.
  const beforeFrontiers = new Map([[projectImageId, beforeHostFrontier]]);
  for (const imageId of sourceImageIds) {
    if (!beforeFrontiers.has(imageId)) beforeFrontiers.set(imageId, await images.frontier(imageId));
  }

  // 6. Read each selected member's CURRENT direct source record via the graph
  //    owner; hand an isolated snapshot plus the semantic member/source identity
  //    to the materializer. A missing/dangling source is an explicit failure.
  const materializations = {};
  for (const member of selected) {
    const source = member.target;
    // The generic graph-record seam: any durable record kind the graph owner can
    // return (object, shape, code-artifact, lexical-environment, block) is a valid
    // member source. The coordinator does NOT branch on record kind and learns no
    // CodeArtifact/Shape/Block/Smalltalk semantics — that stays the
    // representation-specific materializer's concern. A genuinely missing record
    // still raises the explicit source error.
    const record = await images.getRecord(source.imageId, source.objectId);
    if (!record) throw new ProjectCaptureSourceError({key: member.key, source});
    const materialization = requireMaterialization(
      // An isolated AND immutable snapshot: deep-cloned and recursively frozen, so
      // no alias reaches live graph state and the materializer cannot rewrite its
      // own input (which would make identity depend on callback mutation). The
      // stored graph record itself is never frozen or mutated.
      await materializeRecord({member, source, record: deepFreeze(structuredClone(record))}),
      member.key,
    );
    materializations[member.key] = materialization;
  }

  // 7. Re-read every participating frontier, INCLUDING the Project host. Any
  //    before/after difference refuses the whole capture — no release+warn.
  for (const imageId of [...beforeFrontiers.keys()].sort()) {
    const before = beforeFrontiers.get(imageId);
    const after = await images.frontier(imageId);
    if (before !== after) throw new ProjectCaptureConflictError({imageId, before, after});
  }

  // 8. Only now, with the stability fence held, derive the release + provenance
  //    through the EXISTING Project model.
  const release = createProjectReleaseManifest({project, profile, materializations, dependencies});

  // The frontier map covers every direct member-source Image; the Project host is
  // added as an EXTRA frontier when it is not already a source (ADR 0073 permits
  // extra frontiers) — proving the descriptor/profile input itself was unchanged.
  const sourceFrontiers = {};
  for (const imageId of [...beforeFrontiers.keys()].sort()) {
    sourceFrontiers[imageId] = beforeFrontiers.get(imageId);
  }
  const provenance = createProjectReleaseProvenance({release, project, sourceFrontiers});

  // 9. Return both; nothing is persisted here.
  return Object.freeze({release, provenance});
}

export {
  ProjectCaptureConflictError,
  ProjectCaptureSourceError,
  captureCurrentProjectRelease,
};
