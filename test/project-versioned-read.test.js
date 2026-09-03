import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECT_READ_OPERATION,
  OBJECT_VERSION_TOKEN_V0,
  PROJECT_MEMBER_SHAPE_ID,
  PROJECT_SHAPE_ID,
  addProjectMember,
  authorizedReadProject,
  authorizedReadProjectDescriptor,
  createProject,
  createProjectId,
  createRuntime,
  objectResource,
  objectRef,
  parseObjectVersionToken,
  projectObjectId,
  textValue,
} from '../src/runtime.js';

// The version-aware AUTHORIZED Project read (ADR 0080, issue #188 slice A).
// authorizedReadProject returns a frozen {descriptor, versionToken} whose two
// halves originate from the SAME Project-object record obtained by ONE
// Project-object read. The token is the opaque object-scoped version token of
// the Project OBJECT ONLY (not of everything reachable through the descriptor).
// The descriptor-only seam delegates to this one and discards the token.

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

const readGrant = (imageId, projectId) => [{
  operation: OBJECT_READ_OPERATION,
  resource: objectResource(imageId, projectObjectId(projectId)),
}];

// A transparent images facade that lets a test observe (and, optionally,
// interfere with) every getObject. Everything else passes straight through.
function observedImages(images, {onGetObject}) {
  return new Proxy(images, {
    get(target, property) {
      if (property === 'getObject') {
        return async (imageId, objectId) => {
          const record = await target.getObject(imageId, objectId);
          return onGetObject({imageId, objectId, record}) ?? record;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function seedProject(runtime, imageId = 'img') {
  await runtime.images.createImage({id: imageId});
  const projectId = createProjectId();
  await createProject({images: runtime.images, imageId, projectId, name: 'Demo'});
  return projectId;
}

// Privileged (test-only) look at the backing record's version, to check the
// opaque token against the truth without the lane exposing it.
async function backingVersion(runtime, imageId, projectId) {
  return (await runtime.images.getObject(imageId, projectObjectId(projectId)))._version;
}

test('NO-EXISTENCE-ORACLE: a denied versioned read of an EXISTING and a MISSING Project both surface AuthorityError', async () => {
  await withRuntime(async (runtime) => {
    const existingId = await seedProject(runtime);
    const missingId = createProjectId();
    const denied = requireFor(runtime, []);
    let storageReads = 0;
    const images = observedImages(runtime.images, {onGetObject: () => { storageReads += 1; }});
    await assert.rejects(
      authorizedReadProject({images, imageId: 'img', projectId: existingId, require: denied}),
      (e) => e?.name === 'AuthorityError',
      'denied read of an EXISTING Project -> AuthorityError',
    );
    await assert.rejects(
      authorizedReadProject({images, imageId: 'img', projectId: missingId, require: denied}),
      (e) => e?.name === 'AuthorityError',
      'denied read of a MISSING Project -> AuthorityError (NOT not-found: no existence oracle)',
    );
    // The require fires BEFORE any storage access: a denied caller caused no read at all.
    assert.equal(storageReads, 0, 'a denied caller must not reach storage');
  });
});

test('ONE READ: exactly one Project-object read supplies BOTH the descriptor Project state and the token', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'alpha', role: 'lib', target: objectRef('img', 'obj-a')});
    const projectRecordId = projectObjectId(projectId);
    const reads = [];
    const images = observedImages(runtime.images, {onGetObject: ({objectId}) => { reads.push(objectId); }});

    const result = await authorizedReadProject({images, imageId: 'img', projectId, require: requireFor(runtime, readGrant('img', projectId))});

    assert.equal(reads.filter((id) => id === projectRecordId).length, 1, 'the Project object is read exactly once');
    // Member records are read while assembling (allowed); the Project itself is never reread.
    assert.ok(reads.includes(`${projectRecordId}/member/alpha`), 'member records are read to assemble member-visible state');
    assert.equal(parseObjectVersionToken(result.versionToken, 'img', projectRecordId), await backingVersion(runtime, 'img', projectId));
  });
});

test('COMMON PROVENANCE: when the Project changes right after its one read, descriptor AND token both describe the pre-change record', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    const projectRecordId = projectObjectId(projectId);
    const versionBefore = await backingVersion(runtime, 'img', projectId);
    let bumped = false;
    // A perturbing facade: the moment the ONE Project-object read returns, a
    // competing writer renames the Project in storage. A two-read implementation
    // (descriptor from one read, token from another — or the reverse) would pair
    // state from different records; the one-read implementation cannot.
    const images = observedImages(runtime.images, {
      onGetObject: async ({objectId, record}) => {
        if (objectId !== projectRecordId || bumped) return record;
        bumped = true;
        await runtime.images.putObject('img', {
          id: projectRecordId, shape: record.shape, behavior: null,
          slots: {...record.slots, 'project-name': textValue('Renamed-by-competitor')},
          indexed: record.indexed, metadata: record.metadata,
        }, {expectedVersion: record._version});
        return record;
      },
    });
    const result = await authorizedReadProject({images, imageId: 'img', projectId, require: requireFor(runtime, readGrant('img', projectId))});
    assert.ok(bumped, 'the competing rename happened during the read');
    assert.equal(result.descriptor.name, 'Demo', 'descriptor state is from the record that was read');
    assert.equal(parseObjectVersionToken(result.versionToken, 'img', projectRecordId), versionBefore, 'token is from that SAME record');
    // The bump was real: a fresh read now sees the new name and a different token.
    const after = await authorizedReadProject({images: runtime.images, imageId: 'img', projectId, require: requireFor(runtime, readGrant('img', projectId))});
    assert.equal(after.descriptor.name, 'Renamed-by-competitor');
    assert.notEqual(after.versionToken, result.versionToken);
  });
});

test('SHAPE: frozen {descriptor, versionToken}; the descriptor is the exact canonical ProjectDescriptor; the token is opaque and never raw _version', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'zeta', role: 'lib', target: objectRef('img', 'obj-z')});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'alpha', role: 'app', target: objectRef('img', 'obj-a')});
    const require = requireFor(runtime, readGrant('img', projectId));
    const result = await authorizedReadProject({images: runtime.images, imageId: 'img', projectId, require});

    assert.deepEqual(Object.keys(result).sort(), ['descriptor', 'versionToken']);
    assert.ok(Object.isFrozen(result), 'the result is frozen');
    const {descriptor, versionToken} = result;
    assert.deepEqual(Object.keys(descriptor).sort(), ['format', 'members', 'name', 'namespace', 'projectId']);
    assert.ok(Object.isFrozen(descriptor) && Object.isFrozen(descriptor.members));
    assert.deepEqual(descriptor.members.map((m) => m.key), ['alpha', 'zeta']);
    for (const member of descriptor.members) assert.deepEqual(Object.keys(member).sort(), ['key', 'role', 'target']);

    assert.equal(typeof versionToken, 'string');
    assert.ok(versionToken.startsWith(`${OBJECT_VERSION_TOKEN_V0}:`), 'the existing object-version/v0 convention, no new token representation');
    const version = await backingVersion(runtime, 'img', projectId);
    assert.notEqual(versionToken, String(version), 'not the raw backend version');
    assert.ok(!JSON.stringify(result).includes('_version'), 'backing _version never escapes');
    // Opaque-but-well-formed: it round-trips through the token owner for exactly this Project object.
    assert.equal(parseObjectVersionToken(versionToken, 'img', projectObjectId(projectId)), version);
    // Scoped to the Project object: it is not a token for any other object.
    assert.throws(() => parseObjectVersionToken(versionToken, 'img', 'some-other-object'), /different object/);
  });
});

test('BEHAVIOR-IDENTICAL: the descriptor-only seam returns exactly the versioned seam\'s descriptor and orders authorization the same way', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'lib', target: objectRef('imgB', 'elsewhere')});
    const require = requireFor(runtime, readGrant('img', projectId));
    const versioned = await authorizedReadProject({images: runtime.images, imageId: 'img', projectId, require});
    const descriptorOnly = await authorizedReadProjectDescriptor({images: runtime.images, imageId: 'img', projectId, require});
    assert.deepEqual(descriptorOnly, versioned.descriptor);
    assert.deepEqual(Object.keys(descriptorOnly).sort(), ['format', 'members', 'name', 'namespace', 'projectId']);
    assert.ok(!('versionToken' in descriptorOnly), 'the descriptor-only seam discards the token');
    // Same no-existence-oracle ordering, with zero storage reads for the denied caller.
    let storageReads = 0;
    const images = observedImages(runtime.images, {onGetObject: () => { storageReads += 1; }});
    await assert.rejects(
      authorizedReadProjectDescriptor({images, imageId: 'img', projectId: createProjectId(), require: requireFor(runtime, [])}),
      (e) => e?.name === 'AuthorityError',
    );
    assert.equal(storageReads, 0);
  });
});

test('TOKEN SCOPE: adding a member changes the Project token; retargeting an existing member does NOT', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    const require = requireFor(runtime, readGrant('img', projectId));
    const read = () => authorizedReadProject({images: runtime.images, imageId: 'img', projectId, require});

    const initial = await read();
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'lib', target: objectRef('img', 'one')});
    const afterAdd = await read();
    assert.notEqual(afterAdd.versionToken, initial.versionToken, 'member ADD rewrites the Project object -> new token');
    assert.deepEqual(afterAdd.descriptor.members.map((m) => m.key), ['k']);

    // Retarget: same key + role, different target. Only the member record is
    // rewritten; the Project object is untouched, so its token is unchanged —
    // even though the descriptor now exposes a different target. The token is
    // the version of the Project OBJECT, not of the descriptor's closure.
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'lib', target: objectRef('img', 'two')});
    const afterRetarget = await read();
    assert.equal(afterRetarget.versionToken, afterAdd.versionToken, 'member RETARGET leaves the Project token unchanged');
    assert.deepEqual(afterRetarget.descriptor.members[0].target, objectRef('img', 'two'), 'while the descriptor DID change');
    assert.notDeepEqual(afterRetarget.descriptor, afterAdd.descriptor);

    // A no-op add (same key, role and target) changes nothing at all.
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'lib', target: objectRef('img', 'two')});
    const afterNoop = await read();
    assert.equal(afterNoop.versionToken, afterRetarget.versionToken);
    assert.deepEqual(afterNoop.descriptor, afterRetarget.descriptor);
  });
});

test('VALIDATION: an object occupying project/<id> that is not the expected Project representation is refused, not read as a Project', async () => {
  await withRuntime(async (runtime) => {
    await seedProject(runtime, 'img'); // installs the Project/member Shapes
    // (a) a foreign (member-shaped) object squatting on a Project id.
    const squatterId = createProjectId();
    await runtime.images.putObject('img', {
      id: projectObjectId(squatterId), shape: objectRef('img', PROJECT_MEMBER_SHAPE_ID), behavior: null,
      slots: {'project-member-key': textValue('k'), 'project-member-role': textValue('lib'), 'project-member-target': objectRef('img', 'x')},
      metadata: {},
    });
    await assert.rejects(
      authorizedReadProject({images: runtime.images, imageId: 'img', projectId: squatterId, require: requireFor(runtime, readGrant('img', squatterId))}),
      /not the expected durable Project representation/,
    );
    // (b) the right Shape but the wrong stable project id inside.
    const projectId = await seedProject(runtime, 'img2');
    const record = await runtime.images.getObject('img2', projectObjectId(projectId));
    assert.equal(record.shape.objectId, PROJECT_SHAPE_ID);
    await runtime.images.putObject('img2', {
      id: record.id, shape: record.shape, behavior: null,
      slots: {...record.slots, 'project-id': textValue('some-other-project')},
      indexed: record.indexed, metadata: record.metadata,
    }, {expectedVersion: record._version});
    await assert.rejects(
      authorizedReadProject({images: runtime.images, imageId: 'img2', projectId, require: requireFor(runtime, readGrant('img2', projectId))}),
      /not the expected durable Project representation/,
    );
    // (c) an AUTHORIZED reader of a MISSING Project still learns not-found (the
    // lane is no oracle only to the DENIED).
    const missingId = createProjectId();
    await assert.rejects(
      authorizedReadProject({images: runtime.images, imageId: 'img', projectId: missingId, require: requireFor(runtime, readGrant('img', missingId))}),
      /durable Project not found/,
    );
  });
});

test('REVOCATION: a context revoked before the versioned read fails closed', async () => {
  await withRuntime(async (runtime) => {
    const projectId = await seedProject(runtime);
    const context = runtime.authority.issue({principal: 'alice', grants: readGrant('img', projectId)});
    const require = (demand) => runtime.authority.require(context, demand);
    runtime.authority.revoke(context);
    await assert.rejects(
      authorizedReadProject({images: runtime.images, imageId: 'img', projectId, require}),
      (e) => e?.name === 'AuthorityError',
    );
    await assert.rejects(
      authorizedReadProject({images: runtime.images, imageId: 'img', projectId}),
      /requires a require\(demand\)/,
      'a missing require is a caller error, never an unauthenticated read',
    );
  });
});
