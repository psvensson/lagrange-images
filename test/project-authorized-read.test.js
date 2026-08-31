import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECT_READ_OPERATION,
  PROJECT_MEMBER_SHAPE_ID,
  addProjectMember,
  authorizedReadProjectDescriptor,
  createProject,
  createProjectId,
  createRuntime,
  objectResource,
  objectRef,
  projectObjectId,
} from '../src/runtime.js';

// The AUTHORIZED semantic ProjectDescriptor read seam (Bead lagrange-images-4nc).
// authorizedReadProjectDescriptor authorizes ONE object/read on the Project
// object BEFORE any existence disclosure (no-existence-oracle), then delegates
// assembly + canonicalization to readProjectDescriptor. The single require on
// the Project object is the authority boundary: backing member records are the
// Project's storage representation (read internally, NO per-member authority, NO
// grants created), and member TARGETS still need their own object/read.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

// Build the caller-side require closure over a freshly-issued LIVE context.
// grants: [{operation, resource}] (object/read on the Project object resource).
function requireFor(runtime, grants) {
  const context = runtime.authority.issue({principal: 'alice', grants});
  return (demand) => runtime.authority.require(context, demand);
}

const projectGrant = (imageId, projectId) => [{
  operation: OBJECT_READ_OPERATION,
  resource: objectResource(imageId, projectObjectId(projectId)),
}];

test('an authorized read returns the canonical descriptor (sorted members, no storage ids, frozen)', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'Demo'});
    // Insert members in NON-canonical storage order (zeta before alpha) so the
    // canonical sort is observable, not a no-op.
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'zeta', role: 'lib', target: objectRef('img', 'obj-z')});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'alpha', role: 'app', target: objectRef('img', 'obj-a')});

    const descriptor = await authorizedReadProjectDescriptor({
      images: runtime.images, imageId: 'img', projectId,
      require: requireFor(runtime, projectGrant('img', projectId)),
    });
    // Canonical descriptor keys only — no backing/Shape/slot ids escape.
    assert.deepEqual(Object.keys(descriptor).sort(), ['format', 'members', 'name', 'namespace', 'projectId']);
    assert.equal(descriptor.format, 'lagrange-project/v1');
    assert.equal(descriptor.projectId, projectId);
    assert.equal(descriptor.name, 'Demo');
    // Canonical order (alpha before zeta), NOT the storage insertion order.
    assert.deepEqual(descriptor.members.map((m) => m.key), ['alpha', 'zeta']);
    // Member carries exactly the canonical {key, role, target} — nothing else.
    for (const member of descriptor.members) {
      assert.deepEqual(Object.keys(member).sort(), ['key', 'role', 'target']);
    }
    // The model returns FROZEN data (a reimplemented read returning mutable
    // plain objects would fail this).
    assert.ok(Object.isFrozen(descriptor), 'descriptor is frozen');
    assert.ok(Object.isFrozen(descriptor.members), 'members array is frozen');
    for (const member of descriptor.members) assert.ok(Object.isFrozen(member), 'member is frozen');
  });
});

test('NO-EXISTENCE-ORACLE: a denied read of an EXISTING and a MISSING Project both surface AuthorityError', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const existingId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId: existingId, name: 'Secret'});
    const missingId = createProjectId();
    // No grants at all -> every object/read demand is denied.
    const denied = requireFor(runtime, []);
    // A denied caller must NOT be able to distinguish "Project exists but
    // unreadable" from "Project does not exist": BOTH are AuthorityError, and a
    // naive impl that reads-then-checks would leak 'not found' for the missing
    // one. This is the proof the require fires BEFORE any existence disclosure.
    await assert.rejects(
      authorizedReadProjectDescriptor({images: runtime.images, imageId: 'img', projectId: existingId, require: denied}),
      (e) => e?.name === 'AuthorityError',
      'denied read of an EXISTING Project -> AuthorityError',
    );
    await assert.rejects(
      authorizedReadProjectDescriptor({images: runtime.images, imageId: 'img', projectId: missingId, require: denied}),
      (e) => e?.name === 'AuthorityError',
      'denied read of a MISSING Project -> AuthorityError (NOT not-found: no existence oracle)',
    );
  });
});

test('an AUTHORIZED read of a MISSING Project surfaces not-found (existence is disclosed only to authorized readers)', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const missingId = createProjectId();
    const require = requireFor(runtime, projectGrant('img', missingId));
    await assert.rejects(
      authorizedReadProjectDescriptor({images: runtime.images, imageId: 'img', projectId: missingId, require}),
      /durable Project not found/,
      'an authorized reader learns the Project is missing (the lane is no oracle only to the DENIED)',
    );
  });
});

test('DELEGATION to the model: duplicate member keys in storage are rejected by normalizeProjectDescriptor', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'Demo'});
    // Bypass addProjectMember's duplicate guard by writing raw duplicate-key
    // member objects directly into storage, then link them into the Project.
    // This proves the read DELEGATES to normalizeProjectDescriptor (which owns
    // dup-key rejection) rather than reimplementing a sort that forgets it.
    const memberShapeRef = objectRef('img', PROJECT_MEMBER_SHAPE_ID);
    const mkMember = async (suffix) => {
      const id = `project/${projectId}/member/dup-${suffix}`;
      await runtime.images.putObject('img', {
        id, shape: memberShapeRef, behavior: null,
        slots: {'project-member-key': {kind: 'text', value: 'dup'}, 'project-member-role': {kind: 'text', value: 'lib'}, 'project-member-target': objectRef('img', `t-${suffix}`)},
        metadata: {},
      });
      return objectRef('img', id);
    };
    const m1 = await mkMember('one');
    const m2 = await mkMember('two');
    const projectIdRef = projectObjectId(projectId);
    const project = await runtime.images.getObject('img', projectIdRef);
    await runtime.images.putObject('img', {
      id: projectIdRef, shape: project.shape, behavior: null, slots: project.slots,
      indexed: [m1, m2], metadata: project.metadata,
    }, {expectedVersion: project._version});

    const require = requireFor(runtime, projectGrant('img', projectId));
    await assert.rejects(
      authorizedReadProjectDescriptor({images: runtime.images, imageId: 'img', projectId, require}),
      /duplicate Project member key/,
      'a duplicate member key is rejected by the model (delegation, not a reimplemented sort)',
    );
  });
});

test('NO PER-MEMBER AUTHORITY: a grant on the Project ALONE (no member grants) authorizes the read', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'Demo'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'alpha', role: 'lib', target: objectRef('img', 'obj-a')});
    // The grant covers ONLY the Project object resource — NOT the member object
    // resource. If the seam added a per-member require, this would fail. It must
    // succeed: the backing members are the Project's own storage, read internally
    // under the single Project read (the unit-level rule).
    const require = requireFor(runtime, projectGrant('img', projectId));
    const descriptor = await authorizedReadProjectDescriptor({images: runtime.images, imageId: 'img', projectId, require});
    assert.deepEqual(descriptor.members.map((m) => m.key), ['alpha']);
  });
});

test('REVOCATION: a context revoked between building require and the read fails closed (AuthorityError)', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'Demo'});
    // Issue a context WITH the Project grant, then revoke it before the read.
    // The require closure is over the LIVE context, so a revoked context must
    // fail closed (not snapshot the grants at closure-creation time).
    const context = runtime.authority.issue({principal: 'alice', grants: projectGrant('img', projectId)});
    const require = (demand) => runtime.authority.require(context, demand);
    runtime.authority.revoke(context);
    await assert.rejects(
      authorizedReadProjectDescriptor({images: runtime.images, imageId: 'img', projectId, require}),
      (e) => e?.name === 'AuthorityError',
      'a revoked context fails closed (the require is over the live context, not a grant snapshot)',
    );
  });
});

test('membership creates NO grants and a target stays a locator (cross-image target returned unchanged)', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'imgA'});
    await runtime.images.createImage({id: 'imgB'});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'imgA', projectId, name: 'Demo'});
    const crossTarget = objectRef('imgB', 'object-in-b');
    await addProjectMember({images: runtime.images, imageId: 'imgA', projectId, key: 'ext', role: 'lib', target: crossTarget});
    const require = requireFor(runtime, projectGrant('imgA', projectId));
    const descriptor = await authorizedReadProjectDescriptor({images: runtime.images, imageId: 'imgA', projectId, require});
    // The cross-image target ref is returned UNCHANGED (the descriptor does not
    // re-home it into the Project's image). Reading its CONTENT would separately
    // require object/read on imgB/object-in-b — the descriptor is a locator only.
    assert.deepEqual(descriptor.members[0].target, crossTarget);
    assert.equal(descriptor.members[0].target.imageId, 'imgB');
  });
});
