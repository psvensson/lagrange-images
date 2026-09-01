import {createProjectReleaseManifest, createProjectReleaseProvenance, selectProjectMembers} from './model.js';
import {readProjectDescriptor} from './working-state.js';
import {createProjectReleaseMaterial, materializeProjectGraphRelease} from './graph-release-materialization.js';

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

// --- THE stable-current read session (ADR 0075, first prerequisite) --------------
// ONE bracket owner for truthful current capture. READING is what brackets an
// Image: the FIRST read from Image X awaits images.frontier(X) and records it as
// X's BEFORE frontier BEFORE any record is read from X; every later read from X
// reuses the same BEFORE. assertStable() re-reads every Image actually read and
// refuses on any movement. frontierMap() is the provenance evidence, available
// ONLY after stability has held (so a caller cannot lift a frontier map from an
// unproven capture window).
//
// Semantic equivalence to eager bracketing (ADR 0075): v1's truthfulness claim is
// per-Image — every record read from Image X occurred while X remained at one
// unchanged frontier window. v1 does NOT claim one atomic cross-Image instant, and
// this session does not strengthen it into one.
//
// This session is part of the Project release-capture coordinator owner. It is NOT
// a generic Image primitive: frontier semantics live here, not in
// src/graph/bundle.js, not in working-state.js, not in GraphImageService beyond
// its existing frontier(), and not in a generic utility package.
function createStableCurrentReadSession({images}) {
  if (!images || typeof images.frontier !== 'function' || typeof images.getRecord !== 'function') {
    throw new TypeError('stable-current read session requires an images reader with frontier() and getRecord()');
  }
  const before = new Map(); // imageId -> BEFORE frontier, set on FIRST read from that Image
  let stable = false;

  // The FIRST read from an Image brackets it: the frontier read MUST complete
  // before the first record read from that Image.
  async function bracket(imageId) {
    if (!before.has(imageId)) before.set(imageId, await images.frontier(imageId));
  }

  async function getRecord(imageId, objectId) {
    await bracket(imageId);
    return await images.getRecord(imageId, objectId);
  }

  // Derived THROUGH getRecord — never a raw images.getObject — so the durable
  // Project descriptor and its backing member records sit inside the same
  // host-Image bracket as everything else the capture reads.
  async function getObject(imageId, objectId) {
    const record = await getRecord(imageId, objectId);
    return record?.kind === 'object' ? record : null;
  }

  async function assertStable() {
    // Canonical image-id order so the conflict choice is deterministic. No retries.
    for (const imageId of [...before.keys()].sort()) {
      const after = await images.frontier(imageId);
      if (before.get(imageId) !== after) {
        throw new ProjectCaptureConflictError({imageId, before: before.get(imageId), after});
      }
    }
    stable = true;
  }

  // Provenance evidence only — {imageId -> BEFORE frontier} for every Image
  // actually read, canonicalized by image id. NOT an as-of read or retained
  // snapshot, and only available after stability has been proven.
  function frontierMap() {
    if (!stable) throw new TypeError('frontierMap is available only after assertStable() has held');
    const map = {};
    for (const imageId of [...before.keys()].sort()) map[imageId] = before.get(imageId);
    return map;
  }

  return Object.freeze({getRecord, getObject, assertStable, frontierMap});
}

// --- ONE private capture coordinator ----------------------------------------------
// The DIRECT path and the GRAPH path share EXACTLY this sequence: session ->
// descriptor -> selection -> materializeSelection -> assertStable -> release ->
// provenance. `materializeSelection` is MODULE-OWNED only — never a public
// graph-capable callback. It receives the session and the selected members and
// returns {materializations, ...path-specific output}. There is no second copy of
// the capture algorithm.
async function runCurrentProjectCapture({
  images,
  projectImageId,
  projectId,
  profile,
  dependencies = [],
  materializeSelection,
}) {
  // 1. ONE bracket owner: the stable-current read session. No eager frontier
  //    pre-computation — reading is what brackets an Image.
  const session = createStableCurrentReadSession({images});

  // 2. Read the durable Project through the working-state owner, with the SESSION
  //    as its images reader — the Project object AND its backing member records
  //    are inside the same host-Image bracket.
  const project = await readProjectDescriptor({images: session, imageId: projectImageId, projectId});

  // 3. Select members with the EXISTING Project model — no profile semantics here.
  const selected = selectProjectMembers(project, profile);

  // 4. The module-owned materialization path. Whatever it reads goes THROUGH THE
  //    SESSION, so every Image it touches (direct or transitively discovered) is
  //    bracketed by the ONE stability owner.
  const materialized = await materializeSelection({session, selected, project});

  // 5. Re-read every Image actually read, INCLUDING the Project host and any
  //    dynamically discovered transitive Image. Any before/after difference
  //    refuses the whole capture — no release+warn, no partial output.
  await session.assertStable();

  // 6. Only now, with the stability fence held, derive the release + provenance
  //    through the EXISTING Project model. The frontier map covers every Image the
  //    capture actually read: the Project host (descriptor input unchanged) plus
  //    every direct or transitively-read source Image.
  const release = createProjectReleaseManifest({
    project, profile, materializations: materialized.materializations, dependencies,
  });
  const provenance = createProjectReleaseProvenance({release, project, sourceFrontiers: session.frontierMap()});

  return {project, release, provenance, materialized};
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

  const {release, provenance} = await runCurrentProjectCapture({
    images,
    projectImageId,
    projectId,
    profile,
    dependencies,
    // The DIRECT path. The public callback STILL receives only
    // {member, source, immutable isolated direct-record snapshot} — no session,
    // no reader, no images, no frontier API.
    materializeSelection: async ({session, selected}) => {
      const materializations = {};
      for (const member of selected) {
        const source = member.target;
        // The generic graph-record seam: any durable record kind the graph owner
        // can return (object, shape, code-artifact, lexical-environment, block)
        // is a valid member source. The coordinator does NOT branch on record
        // kind and learns no CodeArtifact/Shape/Block/Smalltalk semantics — that
        // stays the representation-specific materializer's concern. A genuinely
        // missing record still raises the explicit source error.
        const record = await session.getRecord(source.imageId, source.objectId);
        if (!record) throw new ProjectCaptureSourceError({key: member.key, source});
        const materialization = requireMaterialization(
          // An isolated AND immutable snapshot: deep-cloned and recursively
          // frozen, so no alias reaches live graph state and the materializer
          // cannot rewrite its own input (which would make identity depend on
          // callback mutation). The stored graph record itself is never frozen
          // or mutated.
          await materializeRecord({member, source, record: deepFreeze(structuredClone(record))}),
          member.key,
        );
        materializations[member.key] = materialization;
      }
      return {materializations};
    },
  });
  return Object.freeze({release, provenance});
}

// The GRAPH path (ADR 0075 first materialization slice). The coordinator wires the
// TRUSTED graph release materializer to the session itself — no arbitrary caller
// gets the scoped graph reader. Returns {release, provenance, material} where
// material is ONE fully-closed multi-root graph bundle for the entire selection.
async function captureCurrentGraphProjectRelease({
  images,
  projectImageId,
  projectId,
  profile,
  dependencies = [],
  crypto,
} = {}) {
  requiredText(projectImageId, 'projectImageId');
  requiredText(projectId, 'projectId');

  const {release, provenance, materialized} = await runCurrentProjectCapture({
    images,
    projectImageId,
    projectId,
    profile,
    dependencies,
    // Module-owned ONLY: the graph materializer receives {getRecord} from the
    // session — never the session, the images service, a frontier or a backend.
    // Ordering: the bundle is exported BEFORE assertStable runs (inside the
    // coordinator); if a transitively discovered source Image moved, there is no
    // successful release, provenance or material.
    materializeSelection: async ({session, selected}) =>
      await materializeProjectGraphRelease({
        reader: {getRecord: session.getRecord},
        members: selected,
        crypto,
      }),
  });

  const material = createProjectReleaseMaterial({
    release,
    bundle: materialized.bundle,
    contentIdentity: materialized.contentIdentity,
    crypto,
  });

  return Object.freeze({release, provenance, material});
}

export {
  ProjectCaptureConflictError,
  ProjectCaptureSourceError,
  captureCurrentGraphProjectRelease,
  captureCurrentProjectRelease,
  createStableCurrentReadSession,
};
