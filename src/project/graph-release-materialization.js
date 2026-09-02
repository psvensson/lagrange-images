import {
  assertGraphBundleV1,
  contentIdentityForBundle,
  exportGraphBundle,
  GRAPH_BUNDLE_V1,
} from '../graph/bundle.js';
import {normalizeProjectReleaseManifest} from './model.js';

// The graph release materializer (ADR 0075, Decisions 1–6): the ONE owner of
//
//   selected Project members -> portable graph release material.
//
// It ORCHESTRATES the existing owners and absorbs none of them: it receives the
// selected semantic members and a scoped {getRecord} read facade from the Project
// release-capture coordinator (never GraphImageService, a backend, a frontier or
// an authority surface), drives exactly ONE multi-root export through the graph
// bundle owner, and freezes the release-material package contract. It does NOT
// bracket frontiers (capture coordinator), walk durable edges itself (bundle
// owner), define manifest/releaseId semantics (Project model) or publish target
// records (GraphImageService.createRecords).

const PROJECT_RELEASE_MATERIAL_V1 = 'lagrange-project-release-material/v1';

class ProjectGraphReleaseMaterializationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProjectGraphReleaseMaterializationError';
    Object.assign(this, details);
  }
}

function fail(message, details) {
  throw new ProjectGraphReleaseMaterializationError(message, details);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function isPlainMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Recursively freeze an isolated copy of the package material so later mutation
// cannot make `material.contentIdentity != contentIdentityForBundle(material.bundle)`.
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

// Canonical code-unit ordering for key-set comparisons.
function sortedKeys(map) {
  return Object.keys(map).sort();
}

// ADR 0075 Decisions 2–4: ONE multi-root export for the whole selection, fully
// closed. `reader` is the coordinator's scoped read facade; ONLY its getRecord is
// used — frontier/stability semantics never reach this module or the bundle
// owner. `members` are the selected semantic Project members ({key, role,
// target}); only their keys and targets are read — this module learns no role
// semantics.
async function materializeProjectGraphRelease({reader, members, crypto} = {}) {
  if (!reader || typeof reader.getRecord !== 'function') {
    fail('materializeProjectGraphRelease requires a scoped reader with getRecord');
  }
  if (!Array.isArray(members) || members.length === 0) {
    fail('materializeProjectGraphRelease requires a non-empty selected member list');
  }

  // The narrowness is by construction: the bundle owner's `images` seam is built
  // from the reader's getRecord and NOTHING else, even if the caller handed a
  // richer session object. No frontier, assertStable, frontierMap, createRecords,
  // backend, put* or authority method can leak through.
  const images = {getRecord: (imageId, objectId) => reader.getRecord(imageId, objectId)};

  // Decision 2: ONE multi-root export. Root labels are the Project member keys —
  // caller-owned opaque labels at the bundle boundary; the bundle owner never
  // learns they are Project member keys.
  const roots = {};
  for (const member of members) {
    if (isPlainMap(member) && typeof member.key === 'string' && member.key.length > 0) {
      if (Object.hasOwn(roots, member.key)) fail(`duplicate selected member key: ${member.key}`);
      roots[member.key] = member.target;
    } else {
      fail('selected members must carry a non-empty string key and a target ref');
    }
  }

  // Decision 4: fully closed portable material. EVERY unpinned ref is internal —
  // including cross-Image refs (the bundle owner's cross-Image-external DEFAULT is
  // deliberately not used for release material). Pinned refs remain
  // external-by-construction inside the bundle owner.
  const referencePolicy = {classify: () => 'internal'};

  const {bundle, contentIdentity} = await exportGraphBundle({images, roots, referencePolicy, crypto});

  // The executable proof that development Image/ObjectRef identity cannot enter
  // Project release identity through the graph bundle: externals MUST be empty.
  // A reachable pinned ref therefore fails the release loudly — it is NOT bound,
  // read, dropped or reclassified; there is no historical read and no
  // "source-bound release" category.
  if (Object.keys(bundle.externals).length !== 0) {
    fail(
      `Project graph release material is not fully closed: ${Object.keys(bundle.externals).length} external requirement(s) remain `
      + `(a reachable pinned ref is a hard v1 failure)`,
      {externals: bundle.externals},
    );
  }

  // Decision 3: EVERY selected member's materialization is the WHOLE-bundle
  // identity. Coarse-but-truthful manifest v1 identity — no per-root hashes, no
  // manifest v2. No source ObjectRefs appear in materializations.
  const materializations = {};
  for (const member of members) {
    materializations[member.key] = Object.freeze({
      representation: GRAPH_BUNDLE_V1,
      contentIdentity,
    });
  }

  return {bundle, contentIdentity, materializations};
}

// --- ProjectReleaseMaterial/v1 (ADR 0075 Decision 6) -----------------------------
// One immutable, content-addressed package per release, internally LINKED to the
// release (not merely colocated with it).

// Intrinsic validation: exact v1 fields, supported format, non-empty identity
// texts, the graph-bundle representation, a valid v1 bundle whose recomputed
// content identity MATCHES the package's, and empty externals.
function normalizeProjectReleaseMaterial(value, {crypto} = {}) {
  if (!isPlainMap(value)) fail('Project release material must be a plain object');
  const keys = Object.keys(value).sort();
  const expected = ['bundle', 'contentIdentity', 'format', 'projectId', 'releaseId', 'representation'];
  if (keys.join(',') !== expected.join(',')) {
    fail(`Project release material must have exactly the v1 fields {${expected.join(', ')}}; got {${keys.join(', ')}}`);
  }
  if (value.format !== PROJECT_RELEASE_MATERIAL_V1) {
    fail(`unsupported Project release material format: ${JSON.stringify(value.format)}`);
  }
  requiredText(value.projectId, 'Project release material projectId');
  requiredText(value.releaseId, 'Project release material releaseId');
  requiredText(value.contentIdentity, 'Project release material contentIdentity');
  if (value.representation !== GRAPH_BUNDLE_V1) {
    fail(`Project release material representation must be ${GRAPH_BUNDLE_V1}: ${JSON.stringify(value.representation)}`);
  }
  try {
    assertGraphBundleV1(value.bundle);
  } catch (error) {
    fail(`Project release material bundle is invalid: ${error.message}`, {cause: error});
  }
  if (Object.keys(value.bundle.externals).length !== 0) {
    fail('Project release material bundle must be fully closed (externals empty)');
  }
  const actual = contentIdentityForBundle(value.bundle, {crypto});
  if (actual !== value.contentIdentity) {
    fail(`Project release material contentIdentity does not match its bundle: declared ${value.contentIdentity}, actual ${actual}`);
  }
  return value;
}

// THE release <-> material linkage owner. Validates an ALREADY-SUPPLIED material
// package intrinsically AND against the release it claims to belong to, then
// returns an ISOLATED, DEEPLY FROZEN snapshot of that material. Both the capture
// constructor (createProjectReleaseMaterial) and the installation coordinator
// route through this ONE definition — linkage rules are never copied.
//
// The isolated snapshot matters: installation has an async import between
// validation and descriptor creation, and the caller must not be able to mutate a
// previously validated material object during that window.
function validateProjectReleaseMaterialForRelease({release, material, crypto} = {}) {
  const normalizedRelease = normalizeProjectReleaseManifest(release);
  normalizeProjectReleaseMaterial(material, {crypto});

  // Release linkage: the package's identity fields match the release; EVERY
  // release member carries this representation and the whole-bundle identity; and
  // the bundle root-key set EXACTLY equals the release member-key set (canonical
  // code-unit comparison — no extra root, no missing root). This is the ADR 0075
  // Decision 8 property that makes a later installation's semantic-mismatch
  // failure impossible after import succeeds.
  if (material.projectId !== normalizedRelease.projectId) {
    fail(`material projectId ${JSON.stringify(material.projectId)} does not match the release projectId`);
  }
  if (material.releaseId !== normalizedRelease.releaseId) {
    fail(`material releaseId ${JSON.stringify(material.releaseId)} does not match the release releaseId`);
  }
  for (const member of normalizedRelease.members) {
    if (member.representation !== GRAPH_BUNDLE_V1) {
      fail(`release member ${member.key} representation ${JSON.stringify(member.representation)} does not match the material representation`);
    }
    if (member.contentIdentity !== material.contentIdentity) {
      fail(`release member ${member.key} contentIdentity does not match the material contentIdentity`);
    }
  }
  // Exact sequence equality after canonical sorting — NEVER a joined-string
  // comparison: member keys/root labels are arbitrary opaque text, so
  // concatenation is not injective (["ab","c"] and ["a","bc"] both join to "abc",
  // the same defect class PR #166 repaired for ObjectRef bookkeeping). A false
  // positive here would let malformed material pass preflight, commit the graph
  // import, and only then have createProjectInstallation reject the roots — an
  // orphan imported graph. Structural equality only.
  const rootKeys = sortedKeys(material.bundle.roots);
  const memberKeys = normalizedRelease.members.map(({key}) => key).sort();
  const sameKeySet = rootKeys.length === memberKeys.length
    && rootKeys.every((key, index) => key === memberKeys[index]);
  if (!sameKeySet) {
    fail('bundle root-key set must exactly equal the release member-key set');
  }

  // Isolate AND immobilize: the returned snapshot cannot be mutated into a state
  // where material.contentIdentity != contentIdentityForBundle(material.bundle),
  // and caller-side mutation of the original cannot race the async window.
  return deepFreeze(structuredClone(material));
}

// Construct + link: the candidate package is assembled from the release and then
// routed through THE SAME linked-validation owner — one definition of
// release<->material linkage.
function createProjectReleaseMaterial({release, bundle, contentIdentity, crypto} = {}) {
  const normalizedRelease = normalizeProjectReleaseManifest(release);
  const candidate = {
    format: PROJECT_RELEASE_MATERIAL_V1,
    projectId: normalizedRelease.projectId,
    releaseId: normalizedRelease.releaseId,
    representation: GRAPH_BUNDLE_V1,
    contentIdentity,
    bundle,
  };
  return validateProjectReleaseMaterialForRelease({release: normalizedRelease, material: candidate, crypto});
}

export {
  GRAPH_BUNDLE_V1,
  PROJECT_RELEASE_MATERIAL_V1,
  ProjectGraphReleaseMaterializationError,
  createProjectReleaseMaterial,
  materializeProjectGraphRelease,
  normalizeProjectReleaseMaterial,
  validateProjectReleaseMaterialForRelease,
};
