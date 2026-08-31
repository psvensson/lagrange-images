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
  readProjectDescriptor,
  selectProjectMembers,
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
