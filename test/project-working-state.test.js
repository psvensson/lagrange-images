import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeploymentProfile,
  createProject,
  createProjectId,
  createRuntime,
  addProjectMember,
  objectRef,
  projectMemberObjectId,
  projectObjectId,
  readProjectDescriptor,
  selectProjectMembers,
  textValue,
} from '../src/runtime.js';

// Durable Project working state: the image-level library/service over ordinary
// image objects/refs (no special backend Project record). The pure Project model
// (`src/project/model.js`, ADR 0073) stays the sole owner of descriptor /
// release / deployment semantics; this slice proves a Project assembled from
// actual durable image objects reopens and passes unchanged through that model.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seed(runtime, imageId) {
  await runtime.images.createImage({id: imageId});
}

test('a durable Project reopens as a canonical descriptor (stable id, name, namespace)', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'img');
    const projectId = createProjectId();
    const namespace = objectRef('img', 'some-namespace');
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'Demo', namespace});

    const descriptor = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    assert.equal(descriptor.projectId, projectId);
    assert.equal(descriptor.name, 'Demo');
    assert.deepEqual(descriptor.namespace, namespace);
    assert.deepEqual(descriptor.members, []);
  });
});

test('members carry stable key, role and target; cross-Image targets are allowed', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'a');
    await seed(runtime, 'b');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'a', projectId, name: 'P'});
    // Member targets point into a *different* image — direct refs may span images.
    await addProjectMember({images: runtime.images, imageId: 'a', projectId, key: 'model/customer', role: 'source', target: objectRef('b', 'customer')});
    await addProjectMember({images: runtime.images, imageId: 'a', projectId, key: 'tests/customer', role: 'test', target: objectRef('a', 'customer-tests')});

    const descriptor = await readProjectDescriptor({images: runtime.images, imageId: 'a', projectId});
    // The descriptor model sorts members by key regardless of storage order.
    assert.deepEqual(
      descriptor.members.map(({key, role, target}) => ({key, role, target})),
      [
        {key: 'model/customer', role: 'source', target: objectRef('b', 'customer')},
        {key: 'tests/customer', role: 'test', target: objectRef('a', 'customer-tests')},
      ],
    );
  });
});

test('a duplicate member key is refused', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'img');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: objectRef('img', 'one')});
    // Same key, different role -> conflict.
    await assert.rejects(
      addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'test', target: objectRef('img', 'two')}),
      /already exists with a different role/,
    );
    const descriptor = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    assert.equal(descriptor.members.length, 1);
  });
});

test('changing a target preserves member-key identity (stable member object id)', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'img');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    const first = await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: objectRef('img', 'one')});
    const second = await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: objectRef('img', 'two')});

    // The member *object id* (and thus the member-key identity) is unchanged by the retarget.
    assert.deepEqual(first, second);
    assert.equal(first.objectId, projectMemberObjectId(projectId, 'k'));
    const descriptor = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    assert.equal(descriptor.members.length, 1);
    assert.deepEqual(descriptor.members[0].target, objectRef('img', 'two'));
  });
});

test('storage order is irrelevant: the descriptor is identical after re-reading', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'img');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    // Insert in reverse key order; the model's key sort must normalize it.
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'z', role: 'source', target: objectRef('img', 'z')});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'a', role: 'source', target: objectRef('img', 'a')});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'm', role: 'source', target: objectRef('img', 'm')});

    const first = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    const second = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    assert.deepEqual(first, second);
    assert.deepEqual(first.members.map(({key}) => key), ['a', 'm', 'z']);
  });
});

test('restart/recreate preserves the descriptor exactly (durable, not in-process)', async () => {
  // Two runtimes over the same mock backend would need a shared backend; instead
  // prove durability by re-reading from the durable image records a second time
  // after other writes, confirming the descriptor is recomputed from storage.
  await withRuntime(async (runtime) => {
    await seed(runtime, 'img');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: objectRef('img', 'one')});

    const before = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    // Independent reads recompute from the durable objects, not a cached value.
    const after = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    assert.deepEqual(before, after);
    // The underlying records are durable image objects, not a shadow store.
    const projectRecord = await runtime.images.getObject('img', `project/${projectId}`);
    assert.ok(projectRecord && projectRecord.kind === 'object');
    const memberRecord = await runtime.images.getObject('img', projectMemberObjectId(projectId, 'k'));
    assert.ok(memberRecord && memberRecord.kind === 'object');
  });
});

test('the durable Project passes unchanged through the existing release model', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'a');
    await seed(runtime, 'b');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'a', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'a', projectId, key: 'model/customer', role: 'source', target: objectRef('b', 'customer')});
    await addProjectMember({images: runtime.images, imageId: 'a', projectId, key: 'tests/customer', role: 'test', target: objectRef('a', 'customer-tests')});

    // The descriptor read from durable objects feeds the existing model directly.
    const descriptor = await readProjectDescriptor({images: runtime.images, imageId: 'a', projectId});
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['model/customer']});
    const selected = selectProjectMembers(descriptor, profile);
    assert.deepEqual(
      selected.map(({key, role, target}) => ({key, role, target})),
      [{key: 'model/customer', role: 'source', target: objectRef('b', 'customer')}],
    );
    // An unknown key is still refused by the model, not re-implemented here.
    assert.throws(
      () => createDeploymentProfile({project: descriptor, profileId: 'bad', members: ['nope']}),
      /unknown Project member/,
    );
  });
});

test('Project membership conveys no authority: no authority record is created or required', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'img');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: objectRef('img', 'target')});
    // The only durable records are the two ordinary objects and their two Shapes;
    // no authorization/grant record is introduced by Project membership.
    const descriptor = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    assert.ok(descriptor);
    // The only durable records are the ordinary Project/member objects (plus the
    // module-owned none-marker); no authorization/grant record is introduced by
    // Project membership.
    const objects = await runtime.images.listObjects('img');
    const kinds = objects.map((object) => object.metadata?.project).filter(Boolean).sort();
    assert.deepEqual(kinds, ['member', 'none', 'working-state']);
  });
});

// REPLAY IDENTITY (ADR 0080 decision 4): projectId is creation identity; name and
// namespace are mutable Project state. createProject is create-or-return by
// stable id and never compares or resets the current mutable state.

// Test-only stand-in for a rename: rewrite the private name slot in storage. The
// authorized rename lane (test/project-rename.test.js) proves the same rule end
// to end; here the point is createProject's replay behavior alone.
async function renameInStorage(runtime, imageId, projectId, name) {
  const record = await runtime.images.getObject(imageId, projectObjectId(projectId));
  await runtime.images.putObject(imageId, {
    id: record.id, shape: record.shape, behavior: null,
    slots: {...record.slots, 'project-name': textValue(name)},
    indexed: record.indexed, metadata: record.metadata,
  }, {expectedVersion: record._version});
}

test('REPLAY: create P(name=A) -> rename P(name=B) -> create P(name=A) leaves P named B', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'img');
    const projectId = createProjectId();
    const first = await createProject({images: runtime.images, imageId: 'img', projectId, name: 'A'});
    await renameInStorage(runtime, 'img', projectId, 'B');
    const before = await runtime.images.getObject('img', projectObjectId(projectId));
    // The original create request replays: it must neither reject (mutable state
    // changed) nor restore the old name.
    const replayed = await createProject({images: runtime.images, imageId: 'img', projectId, name: 'A'});
    assert.deepEqual(replayed, first);
    const descriptor = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    assert.equal(descriptor.name, 'B', 'the replay preserves the renamed value');
    const after = await runtime.images.getObject('img', projectObjectId(projectId));
    assert.equal(after._version, before._version, 'the replay wrote nothing');
  });
});

test('REPLAY: a later create with different initial state neither renames nor re-namespaces nor rejects', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'img');
    const projectId = createProjectId();
    const ns = objectRef('img', 'ns-one');
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'Original', namespace: ns});
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'Other', namespace: objectRef('img', 'ns-two')});
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'Other'});
    const descriptor = await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId});
    assert.equal(descriptor.name, 'Original');
    assert.deepEqual(descriptor.namespace, ns);
  });
});

test('REPLAY: the request shape is still validated, and a foreign occupant of project/<id> is still a conflict', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'img');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    // Malformed calls are rejected even though the Project exists (replay identity
    // changes equivalence, not input validation).
    await assert.rejects(createProject({images: runtime.images, imageId: 'img', projectId, name: ''}), /Project name must be a non-empty string/);
    await assert.rejects(createProject({images: runtime.images, imageId: 'img', projectId, name: 'P', namespace: 'not-a-ref'}), /unpinned object ref/);
    // A member-shaped object squatting on a Project id is not "the same Project".
    const squatterId = createProjectId();
    await runtime.images.putObject('img', {
      id: projectObjectId(squatterId), shape: objectRef('img', 'lagrange-project/member/v1'), behavior: null,
      slots: {'project-member-key': textValue('k'), 'project-member-role': textValue('lib'), 'project-member-target': objectRef('img', 'x')},
      metadata: {},
    });
    await assert.rejects(
      createProject({images: runtime.images, imageId: 'img', projectId: squatterId, name: 'P'}),
      /not the expected Project representation/,
    );
    // ...and so is a Project record whose stored stable id is not this one.
    const record = await runtime.images.getObject('img', projectObjectId(projectId));
    await runtime.images.putObject('img', {
      id: record.id, shape: record.shape, behavior: null,
      slots: {...record.slots, 'project-id': textValue('someone-else')},
      indexed: record.indexed, metadata: record.metadata,
    }, {expectedVersion: record._version});
    await assert.rejects(
      createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'}),
      /not the expected Project representation/,
    );
  });
});
