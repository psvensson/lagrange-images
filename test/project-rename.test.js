import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  ObjectMutationConflictError,
  addProjectMember,
  authorizedReadProject,
  authorizedRenameProject,
  createProject,
  createProjectId,
  createRuntime,
  objectResource,
  objectRef,
  objectVersionToken,
  parseObjectVersionToken,
  projectObjectId,
  textValue,
} from '../src/runtime.js';
import * as workingState from '../src/project/working-state.js';

// The AUTHORIZED Project rename (ADR 0080 decision 5, issue #188 slice B):
// authorizedRenameProject({images, imageId, projectId, name, expectedVersionToken,
// require}) -> frozen {versionToken}. Non-storage inputs first, object/write
// BEFORE any existence read, the field->slot translation inside the owner, and
// the caller's expected token as a REAL storage CAS precondition (never
// read-compare-write). A stale token is the existing opaque conflict.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

function requireFor(runtime, grants) {
  const context = runtime.authority.issue({principal: 'alice', grants});
  return (demand) => runtime.authority.require(context, demand);
}

const grant = (operation, imageId, projectId) => ({operation, resource: objectResource(imageId, projectObjectId(projectId))});
const readWrite = (imageId, projectId) => [grant(OBJECT_READ_OPERATION, imageId, projectId), grant(OBJECT_WRITE_OPERATION, imageId, projectId)];

// Observe every record read and write; optionally interfere. Everything else passes through.
function observedImages(images, {onRead = () => {}, onPut = () => {}} = {}) {
  return new Proxy(images, {
    get(target, property) {
      if (property === 'getObject' || property === 'getRecord') {
        return async (imageId, objectId) => {
          const record = await target[property](imageId, objectId);
          return (await onRead({imageId, objectId, record})) ?? record;
        };
      }
      if (property === 'putObject') {
        return async (imageId, input, options) => {
          onPut({imageId, input, options});
          return target.putObject(imageId, input, options);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function seedProject(runtime, imageId = 'img', name = 'Demo') {
  await runtime.images.createImage({id: imageId});
  const projectId = createProjectId();
  await createProject({images: runtime.images, imageId, projectId, name});
  return projectId;
}

async function tokenOf(runtime, imageId, projectId) {
  return (await authorizedReadProject({images: runtime.images, imageId, projectId, require: requireFor(runtime, readWrite(imageId, projectId))})).versionToken;
}

async function nameOf(runtime, imageId, projectId) {
  return (await authorizedReadProject({images: runtime.images, imageId, projectId, require: requireFor(runtime, readWrite(imageId, projectId))})).descriptor.name;
}

test('NO-EXISTENCE-ORACLE: a denied rename of an EXISTING and a MISSING Project both surface AuthorityError with no storage access', async () => {
  await withRuntime(async (runtime) => {
    const existingId = await seedProject(runtime);
    const token = await tokenOf(runtime, 'img', existingId);
    const missingId = createProjectId();
    const denied = requireFor(runtime, [grant(OBJECT_READ_OPERATION, 'img', existingId)]); // read-only: no object/write
    let reads = 0;
    let puts = 0;
    const images = observedImages(runtime.images, {onRead: () => { reads += 1; }, onPut: () => { puts += 1; }});
    await assert.rejects(
      authorizedRenameProject({images, imageId: 'img', projectId: existingId, name: 'X', expectedVersionToken: token, require: denied}),
      (e) => e?.name === 'AuthorityError',
      'denied rename of an EXISTING Project (even with object/read) -> AuthorityError',
    );
    await assert.rejects(
      authorizedRenameProject({images, imageId: 'img', projectId: missingId, name: 'X', expectedVersionToken: objectVersionToken('img', projectObjectId(missingId), 1), require: denied}),
      (e) => e?.name === 'AuthorityError',
      'denied rename of a MISSING Project -> AuthorityError (NOT not-found)',
    );
    assert.equal(reads, 0, 'the require fires BEFORE any existence read');
    assert.equal(puts, 0);
    assert.equal(await nameOf(runtime, 'img', existingId), 'Demo');
  });
});

test('INPUT CONTRACT: a missing, malformed or foreign expected token is rejected before authorization and before any storage access', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    let reads = 0;
    let demands = 0;
    const images = observedImages(runtime.images, {onRead: () => { reads += 1; }});
    const require = (demand) => { demands += 1; return requireFor(runtime, readWrite('img', projectId))(demand); };
    const attempt = (expectedVersionToken, extra = {}) =>
      authorizedRenameProject({images, imageId: 'img', projectId, name: 'X', expectedVersionToken, require, ...extra});

    await assert.rejects(attempt(undefined), /expectedVersionToken must be a non-empty string/);
    await assert.rejects(attempt(''), /expectedVersionToken must be a non-empty string/);
    await assert.rejects(attempt('not-a-token'), (e) => e?.name === 'ObjectVersionTokenError');
    await assert.rejects(attempt('object-version/v0:garbage:garbage'), (e) => e?.name === 'ObjectVersionTokenError');
    // A token issued for ANOTHER object is rejected, not reinterpreted.
    await assert.rejects(attempt(objectVersionToken('img', 'some-other-object', 1)), /different object/);
    // Other static arguments are validated in the same pre-storage phase.
    const token = await tokenOf(runtime, 'img', projectId);
    await assert.rejects(attempt(token, {name: ''}), /Project name must be a non-empty string/);
    await assert.rejects(attempt(token, {projectId: ''}), /projectId must be a non-empty string/);
    await assert.rejects(attempt(token, {require: undefined}), /requires a require\(demand\)/);
    assert.equal(reads, 0, 'no storage access for any invalid input');
    assert.equal(demands, 0, 'input validation precedes authorization');
    assert.equal(await nameOf(runtime, 'img', projectId), 'Demo');
  });
});

test('SUCCESS: the rename changes the name, returns the NEW Project token, and the old token is stale immediately afterward', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    const require = requireFor(runtime, readWrite('img', projectId));
    const before = await authorizedReadProject({images: runtime.images, imageId: 'img', projectId, require});

    const result = await authorizedRenameProject({images: runtime.images, imageId: 'img', projectId, name: 'Renamed', expectedVersionToken: before.versionToken, require});
    assert.deepEqual(Object.keys(result), ['versionToken']);
    assert.ok(Object.isFrozen(result));
    assert.equal(typeof result.versionToken, 'string');
    assert.notEqual(result.versionToken, before.versionToken, 'a successful rename changes the Project token');

    const after = await authorizedReadProject({images: runtime.images, imageId: 'img', projectId, require});
    assert.equal(after.descriptor.name, 'Renamed');
    assert.equal(after.versionToken, result.versionToken, 'the returned token is exactly what a fresh authorized read yields');
    // Only the name changed: every other descriptor field is as before.
    assert.deepEqual({...after.descriptor, name: before.descriptor.name}, before.descriptor);

    // The old token is stale immediately, and the new one is live.
    await assert.rejects(
      authorizedRenameProject({images: runtime.images, imageId: 'img', projectId, name: 'Again', expectedVersionToken: before.versionToken, require}),
      ObjectMutationConflictError,
    );
    assert.equal(await nameOf(runtime, 'img', projectId), 'Renamed', 'the stale attempt changed nothing');
    const second = await authorizedRenameProject({images: runtime.images, imageId: 'img', projectId, name: 'Again', expectedVersionToken: result.versionToken, require});
    assert.equal(await nameOf(runtime, 'img', projectId), 'Again');
    assert.notEqual(second.versionToken, result.versionToken);
  });
});

test('STALE: a stale expected token refuses the mutation, and the conflict exposes no actual/current version, token or cause', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    const require = requireFor(runtime, readWrite('img', projectId));
    const stale = await tokenOf(runtime, 'img', projectId);
    // Any Project-object write in between makes the token stale — here a member add.
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'lib', target: objectRef('img', 'one')});
    const current = await tokenOf(runtime, 'img', projectId);
    assert.notEqual(current, stale);

    const error = await authorizedRenameProject({images: runtime.images, imageId: 'img', projectId, name: 'X', expectedVersionToken: stale, require})
      .then(() => null, (e) => e);
    assert.ok(error instanceof ObjectMutationConflictError, 'the existing opaque conflict class');
    assert.equal(error.cause, undefined, 'attaching the cause would leave actualVersion reachable');
    for (const leaked of ['actualVersion', 'expectedVersion', 'collection', 'key', 'versionToken', 'currentVersionToken']) {
      assert.equal(error[leaked], undefined, `conflict exposed ${leaked}`);
    }
    const text = JSON.stringify({message: error.message, ...error});
    assert.ok(!text.includes(current), 'the current token is not reachable through the conflict');
    assert.ok(!text.includes(stale.split(':').pop()), 'nor the expected version material');
    // Apart from the (public, derivable) Project object id, the message carries no number at all.
    assert.ok(!/\d/.test(error.message.replace(projectObjectId(projectId), '')), `conflict message leaked a number: ${error.message}`);
    assert.ok(!text.includes('project-name'), 'no slot id escapes');
    assert.equal(await nameOf(runtime, 'img', projectId), 'Demo', 'the stale rename changed nothing');
    assert.equal(await tokenOf(runtime, 'img', projectId), current, 'and bumped nothing');
  });
});

test('TOKEN SCOPE: a member ADD invalidates an outstanding rename token; a member RETARGET does not', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    const require = requireFor(runtime, readWrite('img', projectId));
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'lib', target: objectRef('img', 'one')});

    const outstanding = await tokenOf(runtime, 'img', projectId);
    // Retarget an existing member: only the member record changes.
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'lib', target: objectRef('img', 'two')});
    const afterRetarget = await authorizedRenameProject({images: runtime.images, imageId: 'img', projectId, name: 'After-retarget', expectedVersionToken: outstanding, require});
    assert.equal(await nameOf(runtime, 'img', projectId), 'After-retarget', 'a retarget does not invalidate the rename token');

    // Add a NEW member: the Project object's linkage set is rewritten.
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'j', role: 'lib', target: objectRef('img', 'three')});
    await assert.rejects(
      authorizedRenameProject({images: runtime.images, imageId: 'img', projectId, name: 'After-add', expectedVersionToken: afterRetarget.versionToken, require}),
      ObjectMutationConflictError,
      'a member add invalidates the outstanding rename token',
    );
    assert.equal(await nameOf(runtime, 'img', projectId), 'After-retarget');
  });
});

test('RACE: a Project change after the validation read but before the write is caught by the storage CAS, not by a JavaScript compare', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    const require = requireFor(runtime, readWrite('img', projectId));
    const token = await tokenOf(runtime, 'img', projectId);
    const projectRecordId = projectObjectId(projectId);
    let interfered = false;
    let putOptions = null;
    // The moment the rename's validation read returns (so the read saw a record
    // whose version STILL matches the caller's token), a competitor renames the
    // Project in storage. A read-compare-write implementation would compare
    // equal and overwrite the competitor; the CAS on the actual write cannot.
    const images = observedImages(runtime.images, {
      onRead: async ({objectId, record}) => {
        if (objectId !== projectRecordId || interfered) return record;
        interfered = true;
        await runtime.images.putObject('img', {
          id: record.id, shape: record.shape, behavior: null,
          slots: {...record.slots, 'project-name': textValue('Competitor')},
          indexed: record.indexed, metadata: record.metadata,
        }, {expectedVersion: record._version});
        return record;
      },
      onPut: ({options}) => { putOptions = options; },
    });
    await assert.rejects(
      authorizedRenameProject({images, imageId: 'img', projectId, name: 'Loser', expectedVersionToken: token, require}),
      ObjectMutationConflictError,
    );
    assert.ok(interfered, 'the competitor wrote between the validation read and the write');
    assert.equal(putOptions?.expectedVersion, parseObjectVersionToken(token, 'img', projectRecordId),
      'the write\'s precondition is the CALLER\'S expected version, not the version of the record just read');
    assert.equal(await nameOf(runtime, 'img', projectId), 'Competitor', 'the competitor\'s write survives; the stale rename is refused');
  });
});

test('ORDERING: an authorized writer of a MISSING or malformed Project learns so only after authorization; a foreign occupant is refused', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    const missingId = createProjectId();
    await assert.rejects(
      authorizedRenameProject({images: runtime.images, imageId: 'img', projectId: missingId, name: 'X', expectedVersionToken: objectVersionToken('img', projectObjectId(missingId), 1), require: requireFor(runtime, readWrite('img', missingId))}),
      /durable Project not found/,
    );
    // A Project whose stored stable id differs from the requested one is not renamed.
    const record = await runtime.images.getObject('img', projectObjectId(projectId));
    await runtime.images.putObject('img', {
      id: record.id, shape: record.shape, behavior: null,
      slots: {...record.slots, 'project-id': textValue('someone-else')},
      indexed: record.indexed, metadata: record.metadata,
    }, {expectedVersion: record._version});
    const bumped = await runtime.images.getObject('img', projectObjectId(projectId));
    await assert.rejects(
      authorizedRenameProject({images: runtime.images, imageId: 'img', projectId, name: 'X', expectedVersionToken: objectVersionToken('img', projectObjectId(projectId), bumped._version), require: requireFor(runtime, readWrite('img', projectId))}),
      /not the expected Project representation/,
    );
    assert.equal((await runtime.images.getObject('img', projectObjectId(projectId)))._version, bumped._version, 'nothing was written');
  });
});

test('REPLAY: the original createProject request replayed after a rename preserves the renamed value', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime, 'img', 'A');
    const require = requireFor(runtime, readWrite('img', projectId));
    await authorizedRenameProject({images: runtime.images, imageId: 'img', projectId, name: 'B', expectedVersionToken: await tokenOf(runtime, 'img', projectId), require});
    const tokenBefore = await tokenOf(runtime, 'img', projectId);
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'A'});
    assert.equal(await nameOf(runtime, 'img', projectId), 'B');
    assert.equal(await tokenOf(runtime, 'img', projectId), tokenBefore, 'the replay wrote nothing');
  });
});

test('NO GENERIC LANE: rename is the only Project mutation seam; no slot id or slot-mutation API is exposed', async () => {
  await withRuntime(async (runtime) => {
    const exported = Object.keys(workingState).sort();
    assert.deepEqual(exported, [
      'PROJECT_MEMBER_SHAPE_ID', 'PROJECT_SHAPE_ID', 'addProjectMember', 'authorizedReadProject',
      'authorizedReadProjectDescriptor', 'authorizedRenameProject', 'createProject',
      'projectMemberObjectId', 'projectObjectId', 'readProjectDescriptor',
    ]);
    assert.ok(!exported.some((name) => /slot|mutate|write|set[A-Z]/.test(name)), 'no generic slot/semantic-write export');

    // Extra "slot-like" arguments are not a hidden generic lane: they are ignored
    // and only the name changes.
    const projectId = await seedProject(runtime);
    const ns = objectRef('img', 'ns');
    await createProject({images: runtime.images, imageId: 'img', projectId: createProjectId(), name: 'other', namespace: ns});
    const require = requireFor(runtime, readWrite('img', projectId));
    const before = await authorizedReadProject({images: runtime.images, imageId: 'img', projectId, require});
    const result = await authorizedRenameProject({
      images: runtime.images, imageId: 'img', projectId, name: 'Only-this', expectedVersionToken: before.versionToken, require,
      namespace: ns, slot: 'project-namespace', slots: {'project-namespace': ns}, value: ns,
    });
    const after = await authorizedReadProject({images: runtime.images, imageId: 'img', projectId, require});
    assert.equal(after.descriptor.name, 'Only-this');
    assert.equal(after.descriptor.namespace, null, 'namespace untouched');
    assert.deepEqual(after.descriptor.members, before.descriptor.members);
    assert.ok(!JSON.stringify(result).includes('project-'), 'no slot id in the result');
  });
});
