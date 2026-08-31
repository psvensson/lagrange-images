import {isObjectRef, objectRef, textValue} from '../value/index.js';
import {SHAPE_INDEXED} from '../object/model.js';
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
// release / deployment semantics: `readProjectDescriptor` hands the assembled
// record straight to `normalizeProjectDescriptor`, so duplicate-key, shape and
// canonicalization rules live in exactly one place.
//
// Authority: Project membership conveys NO authority over the referenced object
// (ADR 0073). These are plain graph reads/writes; no authorization is added or
// implied here.

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

// Read a durable working Project back into the canonical Project descriptor. The
// assembled record is handed unchanged to `normalizeProjectDescriptor`, so the
// pure model owns every descriptor rule (key uniqueness, sorting, ref and shape
// checks). A missing Project is an error; a member ref that dangles surfaces the
// graph's own dangling-edge outcome rather than a Project-specific one.
async function readProjectDescriptor({images, imageId, projectId} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  const idRef = projectObjectId(projectId);
  const project = await images.getObject(imageId, idRef);
  if (!project) throw new TypeError(`durable Project not found: ${idRef}`);

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
  return normalizeProjectDescriptor({
    format: 'lagrange-project/v1',
    projectId: project.slots[SLOT.projectId].value,
    name: project.slots[SLOT.name].value,
    // The none-marker reads back as the model's `namespace: null`.
    namespace: isObjectRef(namespace) && namespace.objectId !== PROJECT_NONE_ID ? namespace : null,
    members,
  });
}

export {
  PROJECT_MEMBER_SHAPE_ID,
  PROJECT_SHAPE_ID,
  addProjectMember,
  createProject,
  projectMemberObjectId,
  projectObjectId,
  readProjectDescriptor,
};
