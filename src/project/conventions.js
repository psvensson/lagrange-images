import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {ensureObject, ensureShape} from '../graph/ensure-records.js';
import {SHAPE_INDEXED} from '../object/model.js';
import {
  booleanValue,
  canonicalizeValue,
  integerValue,
  isObjectRef,
  objectRef,
  textValue,
} from '../value/index.js';
import {
  PROJECT_SHAPE_ID,
  addProjectMember,
  projectObjectId,
  readProjectDescriptor,
} from './working-state.js';

const PROJECT_GRAPH_V1 = 'lagrange-project-graph/v1';
const PROJECT_TEST_REPORT_V1 = 'lagrange-project-test-report/v1';
const PROJECT_NOTE_SHAPE_ID = 'lagrange-project/note/v1';
const PROJECT_WORK_ITEM_SHAPE_ID = 'lagrange-project/work-item/v1';
const PROJECT_TEST_CASE_SHAPE_ID = 'lagrange-project/test-case/v1';
const PROJECT_TEST_NONE_SHAPE_ID = 'lagrange-project/test-none-shape/v1';
const PROJECT_TEST_NONE_ID = 'lagrange-project/test-none/v1';
const GLOBAL_BINDING_SHAPE_ID = 'smalltalk/global-binding-shape/v1';

const PROJECT_MEMBER_ROLES = Object.freeze({
  CODE: 'code',
  SOURCE: 'source',
  NOTE: 'note',
  TEST: 'test',
  DATA: 'data',
  WORK_ITEM: 'work-item',
  SUBPROJECT: 'subproject',
  RELATED_PROJECT: 'related-project',
  NAMESPACE: 'namespace',
});

const WORK_ITEM_STATUSES = Object.freeze([
  'open',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
]);

const NOTE_SLOT = Object.freeze({
  noteId: 'project-note-id',
  projectId: 'project-note-project-id',
  title: 'project-note-title',
  body: 'project-note-body',
});

const WORK_ITEM_SLOT = Object.freeze({
  workItemId: 'project-work-item-id',
  projectId: 'project-work-item-project-id',
  title: 'project-work-item-title',
  description: 'project-work-item-description',
  status: 'project-work-item-status',
  priority: 'project-work-item-priority',
  assignee: 'project-work-item-assignee',
});

const TEST_CASE_SLOT = Object.freeze({
  testId: 'project-test-id',
  name: 'project-test-name',
  target: 'project-test-target',
  languageId: 'project-test-language-id',
  selector: 'project-test-selector',
  expected: 'project-test-expected',
});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalText(value, label, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function valueEquals(a, b) {
  return JSON.stringify(canonicalizeValue(a)) === JSON.stringify(canonicalizeValue(b));
}

function projectNoteObjectId(projectId, noteId) {
  return `project/${requiredText(projectId, 'projectId')}/note/${requiredText(noteId, 'noteId')}`;
}

function projectWorkItemObjectId(projectId, workItemId) {
  return `project/${requiredText(projectId, 'projectId')}/work-item/${requiredText(workItemId, 'workItemId')}`;
}

function projectTestCaseObjectId(projectId, testId) {
  return `project/${requiredText(projectId, 'projectId')}/test-case/${requiredText(testId, 'testId')}`;
}

async function ensureConventionShapes(images, imageId) {
  const noteShapeRef = objectRef(imageId, PROJECT_NOTE_SHAPE_ID);
  await ensureShape(images, imageId, {
    id: PROJECT_NOTE_SHAPE_ID,
    slots: [
      {id: NOTE_SLOT.noteId, name: 'noteId'},
      {id: NOTE_SLOT.projectId, name: 'projectId'},
      {id: NOTE_SLOT.title, name: 'title'},
      {id: NOTE_SLOT.body, name: 'body'},
    ],
    indexed: SHAPE_INDEXED.VALUES,
  });

  const workItemShapeRef = objectRef(imageId, PROJECT_WORK_ITEM_SHAPE_ID);
  await ensureShape(images, imageId, {
    id: PROJECT_WORK_ITEM_SHAPE_ID,
    slots: [
      {id: WORK_ITEM_SLOT.workItemId, name: 'workItemId'},
      {id: WORK_ITEM_SLOT.projectId, name: 'projectId'},
      {id: WORK_ITEM_SLOT.title, name: 'title'},
      {id: WORK_ITEM_SLOT.description, name: 'description'},
      {id: WORK_ITEM_SLOT.status, name: 'status'},
      {id: WORK_ITEM_SLOT.priority, name: 'priority'},
      {id: WORK_ITEM_SLOT.assignee, name: 'assignee'},
    ],
    indexed: SHAPE_INDEXED.VALUES,
  });

  const testNoneShapeRef = objectRef(imageId, PROJECT_TEST_NONE_SHAPE_ID);
  await ensureShape(images, imageId, {
    id: PROJECT_TEST_NONE_SHAPE_ID,
    slots: [],
  });
  await ensureObject(images, imageId, {
    id: PROJECT_TEST_NONE_ID,
    shape: testNoneShapeRef,
    behavior: null,
    slots: {},
    metadata: {project: 'test-none'},
  });

  const testCaseShapeRef = objectRef(imageId, PROJECT_TEST_CASE_SHAPE_ID);
  await ensureShape(images, imageId, {
    id: PROJECT_TEST_CASE_SHAPE_ID,
    slots: [
      {id: TEST_CASE_SLOT.testId, name: 'testId'},
      {id: TEST_CASE_SLOT.name, name: 'name'},
      {id: TEST_CASE_SLOT.target, name: 'target'},
      {id: TEST_CASE_SLOT.languageId, name: 'languageId'},
      {id: TEST_CASE_SLOT.selector, name: 'selector'},
      {id: TEST_CASE_SLOT.expected, name: 'expected'},
    ],
  });

  return {noteShapeRef, workItemShapeRef, testCaseShapeRef};
}

// --- Member Organization & Classification ---

function classifyProjectMembers(descriptor) {
  const members = Array.isArray(descriptor?.members) ? descriptor.members : [];
  const classified = {
    code: [],
    notes: [],
    tests: [],
    data: [],
    workItems: [],
    subprojects: [],
    relatedProjects: [],
    namespaces: [],
    other: [],
  };

  for (const member of members) {
    switch (member.role) {
      case PROJECT_MEMBER_ROLES.CODE:
      case PROJECT_MEMBER_ROLES.SOURCE:
        classified.code.push(member);
        break;
      case PROJECT_MEMBER_ROLES.NOTE:
        classified.notes.push(member);
        break;
      case PROJECT_MEMBER_ROLES.TEST:
        classified.tests.push(member);
        break;
      case PROJECT_MEMBER_ROLES.DATA:
        classified.data.push(member);
        break;
      case PROJECT_MEMBER_ROLES.WORK_ITEM:
        classified.workItems.push(member);
        break;
      case PROJECT_MEMBER_ROLES.SUBPROJECT:
        classified.subprojects.push(member);
        break;
      case PROJECT_MEMBER_ROLES.RELATED_PROJECT:
        classified.relatedProjects.push(member);
        break;
      case PROJECT_MEMBER_ROLES.NAMESPACE:
        classified.namespaces.push(member);
        break;
      default:
        classified.other.push(member);
        break;
    }
  }
  return deepFreeze(classified);
}

// --- Notes ---

async function createProjectNote({
  images,
  imageId,
  projectId,
  noteId,
  title,
  body,
  tags = [],
  memberKey = null,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(noteId, 'noteId');
  requiredText(title, 'note title');
  const noteBody = optionalText(body, 'note body', '');
  if (!Array.isArray(tags)) throw new TypeError('note tags must be an array of strings');
  const tagValues = tags.map((t, i) => textValue(requiredText(t, `tag[${i}]`)));

  const {noteShapeRef} = await ensureConventionShapes(images, imageId);
  const id = projectNoteObjectId(projectId, noteId);
  const existing = await images.getObject(imageId, id);

  await images.putObject(
    imageId,
    {
      id,
      shape: noteShapeRef,
      behavior: null,
      slots: {
        [NOTE_SLOT.noteId]: textValue(noteId),
        [NOTE_SLOT.projectId]: textValue(projectId),
        [NOTE_SLOT.title]: textValue(title),
        [NOTE_SLOT.body]: textValue(noteBody),
      },
      indexed: tagValues,
      metadata: {project: 'note'},
    },
    existing ? {expectedVersion: existing._version} : {expectedVersion: 0},
  );

  const noteRef = objectRef(imageId, id);
  const key = memberKey ?? `note/${noteId}`;
  await addProjectMember({
    images,
    imageId,
    projectId,
    key,
    role: PROJECT_MEMBER_ROLES.NOTE,
    target: noteRef,
  });

  return deepFreeze({
    noteId,
    projectId,
    title,
    body: noteBody,
    tags: [...tags],
    memberKey: key,
    target: noteRef,
  });
}

async function readProjectNote({images, imageId, projectId, noteId} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(noteId, 'noteId');
  const id = projectNoteObjectId(projectId, noteId);
  const record = await images.getObject(imageId, id);
  if (!record || record.shape?.objectId !== PROJECT_NOTE_SHAPE_ID) {
    return null;
  }
  return deepFreeze({
    noteId: record.slots[NOTE_SLOT.noteId]?.value ?? noteId,
    projectId: record.slots[NOTE_SLOT.projectId]?.value ?? projectId,
    title: record.slots[NOTE_SLOT.title]?.value ?? '',
    body: record.slots[NOTE_SLOT.body]?.value ?? '',
    tags: (record.indexed ?? []).map((v) => v.value),
    target: objectRef(imageId, id),
  });
}

// --- Work Items ---

function assertWorkItemStatus(status) {
  requiredText(status, 'work item status');
  if (!WORK_ITEM_STATUSES.includes(status)) {
    throw new TypeError(
      `unsupported work item status ${JSON.stringify(status)}; expected one of ${WORK_ITEM_STATUSES.join(', ')}`,
    );
  }
  return status;
}

async function createProjectWorkItem({
  images,
  imageId,
  projectId,
  workItemId,
  title,
  description = '',
  status = 'open',
  priority = 2,
  assignee = '',
  relatedTargets = [],
  memberKey = null,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(workItemId, 'workItemId');
  requiredText(title, 'work item title');
  const normalizedStatus = assertWorkItemStatus(status);
  const normalizedDesc = optionalText(description, 'work item description', '');
  const normalizedAssignee = optionalText(assignee, 'work item assignee', '');
  if (!Number.isInteger(priority) || priority < 0) {
    throw new TypeError('work item priority must be a non-negative integer');
  }
  if (!Array.isArray(relatedTargets) || relatedTargets.some((ref) => !isObjectRef(ref))) {
    throw new TypeError('work item relatedTargets must be an array of unpinned ObjectRefs');
  }

  const {workItemShapeRef} = await ensureConventionShapes(images, imageId);
  const id = projectWorkItemObjectId(projectId, workItemId);
  const existing = await images.getObject(imageId, id);

  await images.putObject(
    imageId,
    {
      id,
      shape: workItemShapeRef,
      behavior: null,
      slots: {
        [WORK_ITEM_SLOT.workItemId]: textValue(workItemId),
        [WORK_ITEM_SLOT.projectId]: textValue(projectId),
        [WORK_ITEM_SLOT.title]: textValue(title),
        [WORK_ITEM_SLOT.description]: textValue(normalizedDesc),
        [WORK_ITEM_SLOT.status]: textValue(normalizedStatus),
        [WORK_ITEM_SLOT.priority]: integerValue(priority),
        [WORK_ITEM_SLOT.assignee]: textValue(normalizedAssignee),
      },
      indexed: relatedTargets,
      metadata: {project: 'work-item'},
    },
    existing ? {expectedVersion: existing._version} : {expectedVersion: 0},
  );

  const workItemRef = objectRef(imageId, id);
  const key = memberKey ?? `work-item/${workItemId}`;
  await addProjectMember({
    images,
    imageId,
    projectId,
    key,
    role: PROJECT_MEMBER_ROLES.WORK_ITEM,
    target: workItemRef,
  });

  return readProjectWorkItem({images, imageId, projectId, workItemId});
}

async function readProjectWorkItem({images, imageId, projectId, workItemId} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(workItemId, 'workItemId');
  const id = projectWorkItemObjectId(projectId, workItemId);
  const record = await images.getObject(imageId, id);
  if (!record || record.shape?.objectId !== PROJECT_WORK_ITEM_SHAPE_ID) {
    return null;
  }
  return deepFreeze({
    workItemId: record.slots[WORK_ITEM_SLOT.workItemId]?.value ?? workItemId,
    projectId: record.slots[WORK_ITEM_SLOT.projectId]?.value ?? projectId,
    title: record.slots[WORK_ITEM_SLOT.title]?.value ?? '',
    description: record.slots[WORK_ITEM_SLOT.description]?.value ?? '',
    status: record.slots[WORK_ITEM_SLOT.status]?.value ?? 'open',
    priority: Number(record.slots[WORK_ITEM_SLOT.priority]?.value ?? 2),
    assignee: record.slots[WORK_ITEM_SLOT.assignee]?.value ?? '',
    relatedTargets: [...(record.indexed ?? [])],
    target: objectRef(imageId, id),
  });
}

async function updateProjectWorkItem({
  images,
  imageId,
  projectId,
  workItemId,
  title,
  description,
  status,
  priority,
  assignee,
  relatedTargets,
} = {}) {
  const current = await readProjectWorkItem({images, imageId, projectId, workItemId});
  if (!current) {
    throw new TypeError(`Project work item not found: ${workItemId} in Project ${projectId}`);
  }
  const id = projectWorkItemObjectId(projectId, workItemId);
  const record = await images.getObject(imageId, id);
  const nextTitle = title !== undefined ? requiredText(title, 'work item title') : current.title;
  const nextDesc = description !== undefined ? optionalText(description, 'description', '') : current.description;
  const nextStatus = status !== undefined ? assertWorkItemStatus(status) : current.status;
  const nextPriority = priority !== undefined ? priority : current.priority;
  if (!Number.isInteger(nextPriority) || nextPriority < 0) {
    throw new TypeError('work item priority must be a non-negative integer');
  }
  const nextAssignee = assignee !== undefined ? optionalText(assignee, 'assignee', '') : current.assignee;
  const nextTargets = relatedTargets !== undefined ? relatedTargets : current.relatedTargets;
  if (!Array.isArray(nextTargets) || nextTargets.some((ref) => !isObjectRef(ref))) {
    throw new TypeError('work item relatedTargets must be an array of unpinned ObjectRefs');
  }

  await images.putObject(
    imageId,
    {
      id,
      shape: record.shape,
      behavior: null,
      slots: {
        [WORK_ITEM_SLOT.workItemId]: textValue(workItemId),
        [WORK_ITEM_SLOT.projectId]: textValue(projectId),
        [WORK_ITEM_SLOT.title]: textValue(nextTitle),
        [WORK_ITEM_SLOT.description]: textValue(nextDesc),
        [WORK_ITEM_SLOT.status]: textValue(nextStatus),
        [WORK_ITEM_SLOT.priority]: integerValue(nextPriority),
        [WORK_ITEM_SLOT.assignee]: textValue(nextAssignee),
      },
      indexed: nextTargets,
      metadata: record.metadata ?? {project: 'work-item'},
    },
    {expectedVersion: record._version},
  );

  return readProjectWorkItem({images, imageId, projectId, workItemId});
}

async function listProjectWorkItems({images, imageId, projectId, status = null} = {}) {
  const descriptor = await readProjectDescriptor({images, imageId, projectId});
  const workItemMembers = descriptor.members.filter((m) => m.role === PROJECT_MEMBER_ROLES.WORK_ITEM);
  const items = [];
  for (const member of workItemMembers) {
    // eslint-disable-next-line no-await-in-loop
    const record = await images.getObject(member.target.imageId, member.target.objectId);
    if (!record || record.shape?.objectId !== PROJECT_WORK_ITEM_SHAPE_ID) continue;
    const item = {
      key: member.key,
      workItemId: record.slots[WORK_ITEM_SLOT.workItemId]?.value ?? member.key,
      projectId: record.slots[WORK_ITEM_SLOT.projectId]?.value ?? projectId,
      title: record.slots[WORK_ITEM_SLOT.title]?.value ?? '',
      description: record.slots[WORK_ITEM_SLOT.description]?.value ?? '',
      status: record.slots[WORK_ITEM_SLOT.status]?.value ?? 'open',
      priority: Number(record.slots[WORK_ITEM_SLOT.priority]?.value ?? 2),
      assignee: record.slots[WORK_ITEM_SLOT.assignee]?.value ?? '',
      relatedTargets: [...(record.indexed ?? [])],
      target: member.target,
    };
    if (status === null || item.status === status) {
      items.push(item);
    }
  }
  items.sort((a, b) => a.priority - b.priority || compareText(a.workItemId, b.workItemId));
  return deepFreeze(items);
}

// --- Nested / Related Projects & Namespace Conventions ---

async function addSubprojectMember({
  images,
  imageId,
  projectId,
  subprojectId,
  subprojectImageId = imageId,
  key = null,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(subprojectId, 'subprojectId');
  requiredText(subprojectImageId, 'subprojectImageId');
  if (imageId === subprojectImageId && projectId === subprojectId) {
    throw new TypeError(`Project ${projectId} cannot add itself as a subproject`);
  }
  const memberKey = key ?? `subproject/${subprojectId}`;
  const target = objectRef(subprojectImageId, projectObjectId(subprojectId));
  return addProjectMember({
    images,
    imageId,
    projectId,
    key: memberKey,
    role: PROJECT_MEMBER_ROLES.SUBPROJECT,
    target,
  });
}

async function addRelatedProjectMember({
  images,
  imageId,
  projectId,
  relatedProjectId,
  relatedProjectImageId = imageId,
  key = null,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(relatedProjectId, 'relatedProjectId');
  requiredText(relatedProjectImageId, 'relatedProjectImageId');
  const memberKey = key ?? `related/${relatedProjectId}`;
  const target = objectRef(relatedProjectImageId, projectObjectId(relatedProjectId));
  return addProjectMember({
    images,
    imageId,
    projectId,
    key: memberKey,
    role: PROJECT_MEMBER_ROLES.RELATED_PROJECT,
    target,
  });
}

async function addProjectNamespaceMember({
  images,
  imageId,
  projectId,
  namespaceRef,
  name,
  key = null,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  if (!isObjectRef(namespaceRef)) {
    throw new TypeError('namespaceRef must be an unpinned ObjectRef');
  }
  requiredText(name, 'namespace name');
  const memberKey = key ?? `namespace/${name}`;
  return addProjectMember({
    images,
    imageId,
    projectId,
    key: memberKey,
    role: PROJECT_MEMBER_ROLES.NAMESPACE,
    target: namespaceRef,
  });
}

function parseProjectIdFromRef(ref) {
  if (!isObjectRef(ref) || typeof ref.objectId !== 'string') return null;
  if (!ref.objectId.startsWith('project/')) return null;
  const rest = ref.objectId.slice('project/'.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  return {imageId: ref.imageId, projectId: rest};
}

async function resolveNestedProjectGraph({
  images,
  imageId,
  projectId,
  includeRelated = true,
  onReadProject = null,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');

  const descriptorsByKey = new Map(); // `${imageId}:${projectId}` -> {imageId, projectId, descriptor}
  const subprojectEdges = [];
  const relatedProjectEdges = [];
  const namespaces = [];
  const cycles = [];

  const visiting = new Set();
  const visited = new Set();
  const topologicalOrder = [];

  async function dfs(currImageId, currProjectId, followKind = 'subproject') {
    const nodeKey = `${currImageId}:${currProjectId}`;
    if (visiting.has(nodeKey)) {
      cycles.push({imageId: currImageId, projectId: currProjectId, kind: followKind});
      return;
    }
    if (visited.has(nodeKey)) return;

    visiting.add(nodeKey);
    if (typeof onReadProject === 'function') {
      onReadProject(currImageId, currProjectId);
    }
    const descriptor = await readProjectDescriptor({
      images,
      imageId: currImageId,
      projectId: currProjectId,
    });
    descriptorsByKey.set(nodeKey, {imageId: currImageId, projectId: currProjectId, descriptor});

    if (descriptor.namespace) {
      namespaces.push({
        imageId: currImageId,
        projectId: currProjectId,
        key: '<primary-namespace>',
        target: descriptor.namespace,
      });
    }
    for (const member of descriptor.members) {
      if (member.role === PROJECT_MEMBER_ROLES.NAMESPACE) {
        namespaces.push({
          imageId: currImageId,
          projectId: currProjectId,
          key: member.key,
          target: member.target,
        });
      } else if (member.role === PROJECT_MEMBER_ROLES.SUBPROJECT) {
        const parsed = parseProjectIdFromRef(member.target);
        if (parsed) {
          subprojectEdges.push({
            fromImageId: currImageId,
            fromProjectId: currProjectId,
            memberKey: member.key,
            toImageId: parsed.imageId,
            toProjectId: parsed.projectId,
          });
          // eslint-disable-next-line no-await-in-loop
          await dfs(parsed.imageId, parsed.projectId, 'subproject');
        }
      } else if (includeRelated && member.role === PROJECT_MEMBER_ROLES.RELATED_PROJECT) {
        const parsed = parseProjectIdFromRef(member.target);
        if (parsed) {
          relatedProjectEdges.push({
            fromImageId: currImageId,
            fromProjectId: currProjectId,
            memberKey: member.key,
            toImageId: parsed.imageId,
            toProjectId: parsed.projectId,
          });
          // eslint-disable-next-line no-await-in-loop
          await dfs(parsed.imageId, parsed.projectId, 'related-project');
        }
      }
    }

    visiting.delete(nodeKey);
    visited.add(nodeKey);
    topologicalOrder.push({
      imageId: currImageId,
      projectId: currProjectId,
      descriptor,
    });
  }

  await dfs(imageId, projectId, 'root');

  return deepFreeze({
    format: PROJECT_GRAPH_V1,
    rootImageId: imageId,
    rootProjectId: projectId,
    projects: topologicalOrder,
    subprojectEdges,
    relatedProjectEdges,
    namespaces,
    cycles,
  });
}

// --- In-Image Project Test Cases & Runner ---

async function createProjectTestCase({
  images,
  imageId,
  projectId,
  testId,
  name,
  target,
  languageId = 'symmetric-smalltalk',
  selector = '',
  expected = null,
  memberKey = null,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  requiredText(testId, 'testId');
  const testName = optionalText(name, 'test name', testId);
  if (!isObjectRef(target)) {
    throw new TypeError('test case target must be an unpinned ObjectRef');
  }
  const normalizedLang = optionalText(languageId, 'languageId', 'symmetric-smalltalk');
  const normalizedSelector = optionalText(selector, 'selector', '');
  const expectedSlotValue =
    expected === null || expected === undefined
      ? objectRef(imageId, PROJECT_TEST_NONE_ID)
      : canonicalizeValue(expected);

  const {testCaseShapeRef} = await ensureConventionShapes(images, imageId);
  const id = projectTestCaseObjectId(projectId, testId);
  const existing = await images.getObject(imageId, id);

  await images.putObject(
    imageId,
    {
      id,
      shape: testCaseShapeRef,
      behavior: null,
      slots: {
        [TEST_CASE_SLOT.testId]: textValue(testId),
        [TEST_CASE_SLOT.name]: textValue(testName),
        [TEST_CASE_SLOT.target]: target,
        [TEST_CASE_SLOT.languageId]: textValue(normalizedLang),
        [TEST_CASE_SLOT.selector]: textValue(normalizedSelector),
        [TEST_CASE_SLOT.expected]: expectedSlotValue,
      },
      metadata: {project: 'test-case'},
    },
    existing ? {expectedVersion: existing._version} : {expectedVersion: 0},
  );

  const testCaseRef = objectRef(imageId, id);
  const key = memberKey ?? `test/${testId}`;
  await addProjectMember({
    images,
    imageId,
    projectId,
    key,
    role: PROJECT_MEMBER_ROLES.TEST,
    target: testCaseRef,
  });

  return deepFreeze({
    testId,
    projectId,
    name: testName,
    target,
    languageId: normalizedLang,
    selector: normalizedSelector,
    expected: expected === null || expected === undefined ? null : canonicalizeValue(expected),
    memberKey: key,
    testCaseRef,
  });
}

function isFalsyTestOutcome(actual) {
  if (actual?.kind === 'boolean' && actual.value === false) return true;
  if (
    isObjectRef(actual)
    && (actual.objectId === 'smalltalk/false' || actual.objectId === 'smalltalk/nil')
  ) {
    return true;
  }
  return false;
}

async function sendTestMessage({invocations, executor, languageId, receiver, selector}) {
  if (invocations && typeof invocations.sendMessage === 'function' && typeof executor.execute === 'function') {
    const activation = await invocations.sendMessage(
      {
        languageId,
        receiver,
        message: textValue(selector),
        arguments: [],
      },
      {dispatchImage: receiver.imageId},
    );
    return executor.execute(activation);
  }
  if (typeof executor.send === 'function') {
    return executor.send({
      languageId,
      receiver,
      selector,
      arguments: [],
    });
  }
  throw new TypeError('runProjectTests requires invocations.sendMessage + executor.execute or executor.send');
}

async function invokeTestBlock({invocations, executor, blockRef}) {
  if (invocations && typeof invocations.invokeBlock === 'function' && typeof executor.execute === 'function') {
    const activation = await invocations.invokeBlock(blockRef, []);
    return executor.execute(activation);
  }
  if (typeof executor.executeBlock === 'function') {
    return executor.executeBlock({
      block: blockRef,
      arguments: [],
    });
  }
  throw new TypeError('runProjectTests requires invocations.invokeBlock + executor.execute or executor.executeBlock');
}

async function executeSingleTestTarget({
  images,
  invocations = null,
  executor,
  targetRef,
  defaultLanguageId = 'symmetric-smalltalk',
  defaultSelector = 'run',
}) {
  const record = await images.getRecord(targetRef.imageId, targetRef.objectId);
  if (!record) {
    throw new TypeError(`test target record not found: ${targetRef.imageId}/${targetRef.objectId}`);
  }

  // Case 1: Durable ProjectTestCase descriptor object
  if (record.kind === 'object' && record.shape?.objectId === PROJECT_TEST_CASE_SHAPE_ID) {
    const innerTarget = record.slots[TEST_CASE_SLOT.target];
    const lang = record.slots[TEST_CASE_SLOT.languageId]?.value || defaultLanguageId;
    const selector = record.slots[TEST_CASE_SLOT.selector]?.value || '';
    const rawExpected = record.slots[TEST_CASE_SLOT.expected];
    const hasExpected =
      rawExpected
      && !(isObjectRef(rawExpected) && rawExpected.objectId === PROJECT_TEST_NONE_ID);
    const name = record.slots[TEST_CASE_SLOT.name]?.value || record.slots[TEST_CASE_SLOT.testId]?.value || targetRef.objectId;

    let actual;
    if (selector.length > 0) {
      actual = await sendTestMessage({
        invocations,
        executor,
        languageId: lang,
        receiver: innerTarget,
        selector,
      });
    } else {
      const subExec = await executeSingleTestTarget({
        images,
        invocations,
        executor,
        targetRef: innerTarget,
        defaultLanguageId: lang,
        defaultSelector,
      });
      actual = subExec.actual;
    }

    if (hasExpected) {
      const passed = valueEquals(actual, rawExpected);
      return {
        name,
        passed,
        actual,
        expected: rawExpected,
        error: passed ? null : `expected ${JSON.stringify(rawExpected)}, got ${JSON.stringify(actual)}`,
      };
    }
    const passed = !isFalsyTestOutcome(actual);
    return {
      name,
      passed,
      actual,
      expected: null,
      error: passed ? null : 'test returned falsy outcome',
    };
  }

  // Case 2: Direct executable Block record
  if (record.kind === 'block') {
    const actual = await invokeTestBlock({
      invocations,
      executor,
      blockRef: targetRef,
    });
    const passed = !isFalsyTestOutcome(actual);
    return {
      name: targetRef.objectId,
      passed,
      actual,
      expected: null,
      error: passed ? null : 'test block returned falsy outcome',
    };
  }

  // Case 3: GlobalBinding object holding a Block or callable target in its value slot
  const boundRef = record.slots?.['global-binding-value'] ?? record.slots?.value;
  if (
    record.kind === 'object'
    && isObjectRef(boundRef)
    && (record.shape?.objectId === GLOBAL_BINDING_SHAPE_ID || isObjectRef(boundRef))
  ) {
    const sub = await executeSingleTestTarget({
      images,
      invocations,
      executor,
      targetRef: boundRef,
      defaultLanguageId,
      defaultSelector,
    });
    return {
      ...sub,
      name:
        record.slots?.['global-binding-name']?.value
        || record.slots?.name?.value
        || targetRef.objectId,
    };
  }

  // Case 4: Ordinary Object receiver -> send defaultSelector (e.g. `run` or `value`)
  if (record.kind === 'object') {
    const actual = await sendTestMessage({
      invocations,
      executor,
      languageId: defaultLanguageId,
      receiver: targetRef,
      selector: defaultSelector,
    });
    const passed = !isFalsyTestOutcome(actual);
    return {
      name: targetRef.objectId,
      passed,
      actual,
      expected: null,
      error: passed ? null : `test receiver #${defaultSelector} returned falsy outcome`,
    };
  }

  throw new TypeError(`unsupported test target kind ${JSON.stringify(record.kind)} at ${targetRef.objectId}`);
}

async function runProjectTests({
  runtime = null,
  images: rawImages = null,
  invocations: rawInvocations = null,
  executor: rawExecutor = null,
  imageId,
  projectId,
  includeSubprojects = false,
  filterKeys = null,
  languageId = 'symmetric-smalltalk',
  defaultSelector = 'run',
  onReadProject = null,
} = {}) {
  const images = rawImages ?? runtime?.images;
  const invocations = rawInvocations ?? runtime?.invocations ?? null;
  const executor = rawExecutor ?? runtime?.executor;
  if (!images || typeof images.getRecord !== 'function' || typeof images.getObject !== 'function') {
    throw new TypeError('runProjectTests requires an ImageService');
  }
  if (
    !executor
    || (typeof executor.execute !== 'function'
      && (typeof executor.executeBlock !== 'function' || typeof executor.send !== 'function'))
  ) {
    throw new TypeError('runProjectTests requires an ActivationExecutor');
  }
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');

  const filterSet = Array.isArray(filterKeys) ? new Set(filterKeys) : null;
  let projectEntries;
  if (includeSubprojects) {
    const graph = await resolveNestedProjectGraph({
      images,
      imageId,
      projectId,
      includeRelated: false,
      onReadProject,
    });
    projectEntries = graph.projects;
  } else {
    if (typeof onReadProject === 'function') {
      onReadProject(imageId, projectId);
    }
    const descriptor = await readProjectDescriptor({images, imageId, projectId});
    projectEntries = [{imageId, projectId, descriptor}];
  }

  const results = [];
  for (const projEntry of projectEntries) {
    const testMembers = projEntry.descriptor.members.filter(
      (m) => m.role === PROJECT_MEMBER_ROLES.TEST && (filterSet === null || filterSet.has(m.key)),
    );
    for (const member of testMembers) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await executeSingleTestTarget({
          images,
          invocations,
          executor,
          targetRef: member.target,
          defaultLanguageId: languageId,
          defaultSelector,
        });
        results.push({
          projectId: projEntry.projectId,
          imageId: projEntry.imageId,
          key: member.key,
          name: outcome.name,
          status: outcome.passed ? 'passed' : 'failed',
          actual: outcome.actual,
          expected: outcome.expected,
          error: outcome.error,
        });
      } catch (error) {
        results.push({
          projectId: projEntry.projectId,
          imageId: projEntry.imageId,
          key: member.key,
          name: member.key,
          status: 'failed',
          actual: null,
          expected: null,
          error: error?.message ?? String(error),
        });
      }
    }
  }

  const passedCount = results.filter((r) => r.status === 'passed').length;
  const failedCount = results.length - passedCount;

  return deepFreeze({
    format: PROJECT_TEST_REPORT_V1,
    projectId,
    imageId,
    passed: failedCount === 0,
    totalCount: results.length,
    passedCount,
    failedCount,
    results,
  });
}

// --- Authorized Seams ---

function invokeRequire(require, authority, authorityContext, operation, resource) {
  if (typeof require === 'function') {
    if (require.length >= 2) {
      require(operation, resource);
    } else {
      require({operation, resource});
    }
    return;
  }
  if (authority && typeof authority.require === 'function') {
    authority.require(authorityContext, {operation, resource});
    return;
  }
  throw new TypeError('authorized project convention operation requires a require function or {authority, authorityContext}');
}

async function authorizedResolveNestedProjectGraph({
  authority,
  authorityContext,
  require,
  images,
  imageId,
  projectId,
  includeRelated = true,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  const onReadProject = (targetImageId, targetProjectId) => {
    invokeRequire(
      require,
      authority,
      authorityContext,
      OBJECT_READ_OPERATION,
      objectResource(targetImageId, projectObjectId(targetProjectId)),
    );
  };
  return resolveNestedProjectGraph({
    images,
    imageId,
    projectId,
    includeRelated,
    onReadProject,
  });
}

async function authorizedRunProjectTests({
  authority,
  authorityContext,
  require,
  runtime = null,
  images = null,
  invocations = null,
  executor = null,
  imageId,
  projectId,
  includeSubprojects = false,
  filterKeys = null,
  languageId = 'symmetric-smalltalk',
  defaultSelector = 'run',
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  const onReadProject = (targetImageId, targetProjectId) => {
    invokeRequire(
      require,
      authority,
      authorityContext,
      OBJECT_READ_OPERATION,
      objectResource(targetImageId, projectObjectId(targetProjectId)),
    );
  };
  return runProjectTests({
    runtime,
    images,
    invocations,
    executor,
    imageId,
    projectId,
    includeSubprojects,
    filterKeys,
    languageId,
    defaultSelector,
    onReadProject,
  });
}

export {
  PROJECT_GRAPH_V1,
  PROJECT_MEMBER_ROLES,
  PROJECT_NOTE_SHAPE_ID,
  PROJECT_TEST_CASE_SHAPE_ID,
  PROJECT_TEST_REPORT_V1,
  PROJECT_WORK_ITEM_SHAPE_ID,
  WORK_ITEM_STATUSES,
  addProjectNamespaceMember,
  addRelatedProjectMember,
  addSubprojectMember,
  authorizedResolveNestedProjectGraph,
  authorizedRunProjectTests,
  classifyProjectMembers,
  createProjectNote,
  createProjectTestCase,
  createProjectWorkItem,
  listProjectWorkItems,
  projectNoteObjectId,
  projectTestCaseObjectId,
  projectWorkItemObjectId,
  readProjectNote,
  readProjectWorkItem,
  resolveNestedProjectGraph,
  runProjectTests,
  updateProjectWorkItem,
};
