import {isObjectRef, objectRef, textValue} from '../value/index.js';
import {SHAPE_INDEXED} from '../object/model.js';
import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {objectVersionToken} from '../object/version-token.js';
import {normalizeProjectDescriptor} from './model.js';

// Durable Project working state: the image-level Project library/service
// (ownership.md row "Image-level Project working-state semantics").
//
// The representation is ordinary durable image objects/refs — no special backend
// Project record (ADR 0073 guardrail). A working Project is:
//
//   Project object   id    project/<projectId>
//                    shape lagrange-project/project/v1
//                    slots project-id (text), name (text), namespace (ref or nil)
//                    indexed  refs to the Project's member objects (any order)
//
//   member object    id    project/<projectId>/member/<key>
//                    shape lagrange-project/member/v1
//                    slots member-key (text), role (text), target (unpinned ref)
//
// Members are separate objects so that changing a target is a slot update on a
// stable member id — the member *key* is the identity, never the target ref.
// The Project object's indexed part is only a linkage set; storage order is
// irrelevant because the descriptor model sorts members by key.
//
// This module owns only the storage/read translation. The pure Project model
// (`src/project/model.js`, ADR 0073) remains the SOLE owner of descriptor /
// release / deployment semantics: `projectStateFromRecord` hands the assembled
// record straight to `normalizeProjectDescriptor`, so duplicate-key, shape and
// canonicalization rules live in exactly one place.
//
// PROJECT VERSION TOKEN (ADR 0080). A version-aware read returns the canonical
// descriptor together with an opaque version token, and both originate from the
// SAME Project-object record obtained by ONE Project-object read
// (`projectStateFromRecord` is the single assembly point). The token is the
// existing object-scoped `objectVersionToken` of the Project OBJECT ONLY — not
// of everything reachable through the descriptor: adding a member rewrites the
// Project's indexed linkage set (token changes), retargeting an existing member
// rewrites only the member record (token unchanged while the descriptor's
// target did change). Backing `_version` never escapes.
//
// Authority: Project membership conveys NO authority over the referenced object
// (ADR 0073). These are plain graph reads/writes; no authorization is added or
// implied here.
//
// THE UNIT-LEVEL PROJECT READ RULE (the authorized semantic read seam below).
// ADR 0039 §2 says "authority for A must not imply authority for B" — that rule
// is about refs as LOCATORS TO INDEPENDENT objects. A Project's backing member
// records are NOT independent objects: they ARE the Project's storage
// representation (members are separate objects only so a retarget is a slot
// update on a stable member id; the member key is the identity). Therefore ONE
// authorized `object/read` on the Project object authorizes reading the
// Project's own backing member records — this is the Project-semantic rule this
// module owns, NOT a transitive ref-follow. It does NOT extend to member
// TARGETS: a target is merely a locator, and reading a target's CONTENT still
// independently requires `object/read` on that target object. Membership itself
// creates NO grants.

const PROJECT_SHAPE_ID = 'lagrange-project/project/v1';
const PROJECT_MEMBER_SHAPE_ID = 'lagrange-project/member/v1';
// A module-owned "absent" marker for the optional namespace slot. Object slots must
// hold canonical Values and a Shape requires every slot to be present, so "no
// namespace" cannot be a raw null. This well-known empty object stands for absence
// (language-neutral — not the Smalltalk kernel nil) and reads back as `null`.
const PROJECT_NONE_ID = 'lagrange-project/none/v1';

const SLOT = Object.freeze({
  projectId: 'project-id',
  name: 'project-name',
  namespace: 'project-namespace',
  memberKey: 'project-member-key',
  role: 'project-member-role',
  target: 'project-member-target',
});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function projectObjectId(projectId) {
  return `project/${requiredText(projectId, 'projectId')}`;
}

function projectMemberObjectId(projectId, key) {
  return `${projectObjectId(projectId)}/member/${requiredText(key, 'member key')}`;
}

const PROJECT_NONE_SHAPE_ID = 'lagrange-project/none-shape/v1';

async function ensureShapes(images, imageId) {
  const noneShapeRef = objectRef(imageId, PROJECT_NONE_SHAPE_ID);
  if (!await images.getShape(imageId, PROJECT_NONE_SHAPE_ID)) {
    await images.putShape(imageId, {id: PROJECT_NONE_SHAPE_ID, slots: []});
  }
  if (!await images.getObject(imageId, PROJECT_NONE_ID)) {
    await images.putObject(imageId, {
      id: PROJECT_NONE_ID, shape: noneShapeRef, behavior: null, slots: {}, metadata: {project: 'none'},
    });
  }
  const projectShapeRef = objectRef(imageId, PROJECT_SHAPE_ID);
  if (!await images.getShape(imageId, PROJECT_SHAPE_ID)) {
    await images.putShape(imageId, {
      id: PROJECT_SHAPE_ID,
      slots: [
        {id: SLOT.projectId, name: 'projectId'},
        {id: SLOT.name, name: 'name'},
        {id: SLOT.namespace, name: 'namespace'},
      ],
      indexed: SHAPE_INDEXED.VALUES,
    });
  }
  const memberShapeRef = objectRef(imageId, PROJECT_MEMBER_SHAPE_ID);
  if (!await images.getShape(imageId, PROJECT_MEMBER_SHAPE_ID)) {
    await images.putShape(imageId, {
      id: PROJECT_MEMBER_SHAPE_ID,
      slots: [
        {id: SLOT.memberKey, name: 'key'},
        {id: SLOT.role, name: 'role'},
        {id: SLOT.target, name: 'target'},
      ],
    });
  }
  return {projectShapeRef, memberShapeRef};
}

function requireUnpinnedRef(value, label) {
  if (!isObjectRef(value)) throw new TypeError(`${label} must be an unpinned object ref`);
  return value;
}

// Create a durable working Project. Stable `projectId` (opaque text per ADR 0073;
// the caller supplies the semantic id, e.g. from `createProjectId()`), a display
// `name`, an optional `namespace` ref, and an empty member set. Idempotent on
// exact replay; a conflicting existing Project is an error.
async function createProject({images, imageId, projectId, name, namespace = null} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(name, 'Project name');
  if (namespace !== null) requireUnpinnedRef(namespace, 'Project namespace');
  const {projectShapeRef} = await ensureShapes(images, imageId);

  const id = projectObjectId(projectId);
  const existing = await images.getObject(imageId, id);
  if (existing) {
    // Replay-safe: an identical Project is returned; any divergence is a conflict.
    const same =
      existing.slots?.[SLOT.projectId]?.value === projectId &&
      existing.slots?.[SLOT.name]?.value === name;
    if (!same) throw new TypeError(`durable Project ${id} already exists with different identity`);
    return objectRef(imageId, id);
  }
  await images.putObject(imageId, {
    id,
    shape: projectShapeRef,
    behavior: null,
    slots: {
      [SLOT.projectId]: textValue(projectId),
      [SLOT.name]: textValue(name),
      [SLOT.namespace]: namespace ?? objectRef(imageId, PROJECT_NONE_ID),
    },
    indexed: [],
    metadata: {project: 'working-state'},
  });
  return objectRef(imageId, id);
}

// Add (or, with the same key and role, retarget) a Project member. `key` is the
// stable Project-local member identity; `role` is language/tool policy text;
// `target` is an unpinned ref that may point into another Image. A different
// member already holding `key` is refused. Changing only the target keeps the
// same member object id, preserving member-key identity.
async function addProjectMember({images, imageId, projectId, key, role, target} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(key, 'member key');
  requiredText(role, 'member role');
  requireUnpinnedRef(target, 'member target');
  const {memberShapeRef} = await ensureShapes(images, imageId);

  const projectIdRef = projectObjectId(projectId);
  const project = await images.getObject(imageId, projectIdRef);
  if (!project) throw new TypeError(`durable Project not found: ${projectIdRef}`);

  const memberId = projectMemberObjectId(projectId, key);
  const existingMember = await images.getObject(imageId, memberId);
  const memberRef = objectRef(imageId, memberId);
  if (existingMember) {
    if (existingMember.slots?.[SLOT.role]?.value !== role) {
      throw new TypeError(`Project member key ${key} already exists with a different role`);
    }
    // Retarget: update only the target slot on the stable member id.
    if (!sameRefValue(existingMember.slots?.[SLOT.target], target)) {
      await images.putObject(imageId, {
        id: memberId,
        shape: memberShapeRef,
        behavior: null,
        slots: {
          [SLOT.memberKey]: textValue(key),
          [SLOT.role]: textValue(role),
          [SLOT.target]: target,
        },
        metadata: existingMember.metadata ?? {project: 'member'},
      }, {expectedVersion: existingMember._version});
    }
    return memberRef;
  }

  await images.putObject(imageId, {
    id: memberId,
    shape: memberShapeRef,
    behavior: null,
    slots: {
      [SLOT.memberKey]: textValue(key),
      [SLOT.role]: textValue(role),
      [SLOT.target]: target,
    },
    metadata: {project: 'member'},
  });

  // Link the member into the Project's indexed set (membership-guarded; storage
  // order is irrelevant because the descriptor model sorts members by key).
  const current = Array.isArray(project.indexed) ? project.indexed : [];
  if (!current.some((ref) => isObjectRef(ref) && ref.objectId === memberId)) {
    await images.putObject(imageId, {
      id: projectIdRef,
      shape: project.shape,
      behavior: null,
      slots: project.slots,
      indexed: [...current, memberRef],
      metadata: project.metadata ?? {project: 'working-state'},
    }, {expectedVersion: project._version});
  }
  return memberRef;
}

function sameRefValue(a, b) {
  return isObjectRef(a) && isObjectRef(b) && a.imageId === b.imageId && a.objectId === b.objectId;
}

// The ONE validation of an object occupying `project/<projectId>`: it must be
// the expected Project representation (Shape lagrange-project/project/v1) and
// carry the expected stable project id in its private slot. Any other occupant
// of the id is an integrity conflict, never silently read as a Project.
function assertProjectRecord(record, projectId, idRef) {
  if (!record) throw new TypeError(`durable Project not found: ${idRef}`);
  if (
    !isObjectRef(record.shape) || record.shape.objectId !== PROJECT_SHAPE_ID ||
    record.slots?.[SLOT.projectId]?.value !== projectId
  ) {
    throw new TypeError(`durable Project ${projectId} is not the expected Project representation`);
  }
  return record;
}

// THE single Project-state assembly: from ONE already-read (and validated)
// Project record to `{descriptor, versionToken}`. Every piece of the descriptor's
// Project state (stable id, name, namespace, member linkage) AND the token come
// from this one `project` record; the Project object is never reread here. The
// backing member records are read while assembling (they are the Project's own
// storage representation), and the assembled record is handed unchanged to
// `normalizeProjectDescriptor`, so the pure model owns every descriptor rule
// (key uniqueness, sorting, ref and shape checks). A member ref that dangles
// surfaces the graph's own dangling-edge outcome rather than a Project-specific
// one. The token is `objectVersionToken` of the Project object at the version of
// this record (ADR 0042 decision 5): opaque, object-scoped, never raw `_version`.
// Its scope is `idRef` — the very object id the caller was authorized for — so
// authorization resource and token scope are identical by construction.
async function projectStateFromRecord({images, imageId, idRef, project}) {
  const memberRefs = Array.isArray(project.indexed) ? project.indexed : [];
  const members = [];
  for (const ref of memberRefs) {
    const record = await images.getObject(imageId, ref.objectId);
    if (!record) throw new TypeError(`durable Project member not found: ${ref.objectId}`);
    members.push({
      key: record.slots[SLOT.memberKey].value,
      role: record.slots[SLOT.role].value,
      target: record.slots[SLOT.target],
    });
  }

  const namespace = project.slots[SLOT.namespace];
  const descriptor = normalizeProjectDescriptor({
    format: 'lagrange-project/v1',
    projectId: project.slots[SLOT.projectId].value,
    name: project.slots[SLOT.name].value,
    // The none-marker reads back as the model's `namespace: null`.
    namespace: isObjectRef(namespace) && namespace.objectId !== PROJECT_NONE_ID ? namespace : null,
    members,
  });
  return Object.freeze({
    descriptor,
    versionToken: objectVersionToken(imageId, idRef, project._version),
  });
}

// Read the Project object EXACTLY ONCE, validate it as the expected Project
// representation for `projectId`, and assemble `{descriptor, versionToken}`
// from that one record. A missing Project is an error.
async function readProjectState({images, imageId, projectId} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  const idRef = projectObjectId(projectId);
  const project = assertProjectRecord(await images.getObject(imageId, idRef), projectId, idRef);
  return projectStateFromRecord({images, imageId, idRef, project});
}

// Read a durable working Project back into the canonical Project descriptor:
// the versioned read with the token discarded (one implementation, not two).
// For a valid Project this is behavior-identical to the pre-ADR-0080 read; it is
// stricter only for a malformed occupant of `project/<id>` (wrong Shape, or a
// stored project-id that differs from the requested one, which previously
// leaked through as the descriptor's projectId) and for a record without a
// backend `_version` (the token is always derived, even when discarded).
async function readProjectDescriptor(args) {
  return (await readProjectState(args)).descriptor;
}

function assertRequire(require, label) {
  if (typeof require !== 'function') {
    throw new TypeError(`${label} requires a require(demand) authority-check function`);
  }
  return require;
}

// The AUTHORIZED version-aware semantic Project read seam (ADR 0080): the
// authoritative internal operation behind every authorized Project read.
//
// `require` is the caller-supplied authority check (a closure over an issued,
// LIVE authority context — e.g. `(demand) => authorityService.require(context,
// demand)`). A revoked context fails closed with AuthorityError (the intended
// behavior). This function:
//   1. Authorizes `object/read` on the Project object BEFORE any existence
//      disclosure, so a denied caller learns AuthorityError whether or not the
//      Project exists (no-existence-oracle — the same property as
//      image-object-read-binding/v1). The Project object id is derived HERE
//      (projectObjectId), so the caller never builds a storage id.
//   2. Reads the Project object exactly once (readProjectState), validates it as
//      the expected Project representation, and assembles BOTH the canonical
//      descriptor and the opaque Project version token from that ONE record. The
//      single require on the Project object IS the authority boundary (see the
//      unit-level rule above): the backing member records are read internally
//      as the Project's own storage, with NO per-member authority and NO grants
//      created.
//
// The result is a frozen `{descriptor, versionToken}`: the canonical descriptor
// {format, projectId, name, namespace, members:[{key, role, target}]} — no
// backing ids, Shape ids, or slot ids escape — and the opaque, object-scoped
// version token of the Project OBJECT (scope: the Project object only, see the
// module header). A dangling member ref surfaces a distinct TypeError to an
// AUTHORIZED reader (the no-existence-oracle covers the Project object; a
// corrupt Project is a separate integrity error, correctly disclosed to one who
// may read it).
// TOCTOU note: the require check and the subsequent read are two steps (the
// Project could change between); for a reader this is benign — the token
// describes exactly the record the descriptor was assembled from, and a later
// conditional mutation supplying that token is caught by the storage CAS.
async function authorizedReadProject({images, imageId, projectId, require} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  assertRequire(require, 'authorizedReadProject');
  require({operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, projectObjectId(projectId))});
  return readProjectState({images, imageId, projectId});
}

// The AUTHORIZED descriptor-only read: `authorizedReadProject` with the token
// discarded. Behavior-identical to the versioned seam (same authorization
// ordering, same single Project-object read, same canonical descriptor); it
// exists so read-only consumers keep a stable return shape.
async function authorizedReadProjectDescriptor({images, imageId, projectId, require} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  assertRequire(require, 'authorizedReadProjectDescriptor');
  return (await authorizedReadProject({images, imageId, projectId, require})).descriptor;
}

export {
  PROJECT_MEMBER_SHAPE_ID,
  PROJECT_SHAPE_ID,
  addProjectMember,
  authorizedReadProject,
  authorizedReadProjectDescriptor,
  createProject,
  projectMemberObjectId,
  projectObjectId,
  readProjectDescriptor,
};
