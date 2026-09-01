import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addProjectMember,
  captureCurrentProjectRelease,
  createDeploymentProfile,
  createProject,
  createProjectId,
  createRuntime,
  integerValue,
  objectRef,
  ProjectCaptureConflictError,
  ProjectCaptureSourceError,
  textValue,
} from '../src/runtime.js';

// First truthful current Project release capture (ADR 0073): the coordinator
// composes durable working Project + DeploymentProfile + current member records +
// stable Image frontiers into the existing ProjectReleaseManifest +
// ProjectReleaseProvenance. The Project model owns all release/provenance
// semantics; the coordinator owns only sequencing/stability.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seedSource(runtime, imageId, shapeId, records) {
  await runtime.images.createImage({id: imageId});
  await runtime.images.putShape(imageId, {id: shapeId, slots: [{id: 'v', name: 'v'}]});
  const refs = {};
  for (const [objectId, value] of Object.entries(records)) {
    await runtime.images.putObject(imageId, {
      id: objectId, shape: objectRef(imageId, shapeId), slots: {v: value},
    });
    refs[objectId] = objectRef(imageId, objectId);
  }
  return refs;
}

// A truthful direct-record materializer: representation + a content identity
// derived ONLY from the frozen record snapshot it is handed (no graph traversal).
const recordMaterializer = ({record}) => ({
  representation: 'lagrange-test-record/v1',
  contentIdentity: `record:${record.id}:${record._version}`,
});

test('single-Image Project: durable Project -> selected member record -> release + provenance', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'model/customer', role: 'source', target: sources.rec});

    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'model/customer', role: 'source', target: sources.rec}]},
      profileId: 'deploy', members: ['model/customer'],
    });
    const {release, provenance} = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: recordMaterializer,
    });

    assert.equal(release.projectId, projectId);
    assert.equal(release.members.length, 1);
    assert.equal(release.members[0].key, 'model/customer');
    assert.equal(release.members[0].contentIdentity, 'record:rec:1');
    assert.equal(provenance.releaseId, release.releaseId);
    assert.deepEqual(Object.keys(provenance.sourceFrontiers), ['img']);
    assert.ok(provenance.sourceFrontiers.img >= 1);
  });
});

test('cross-Image Project: {A -> Fa, B -> Fb} plus host frontier, never one scalar', async () => {
  await withRuntime(async (runtime) => {
    const a = await seedSource(runtime, 'a', 'shape', {recA: integerValue(1)});
    const b = await seedSource(runtime, 'b', 'shape', {recB: integerValue(2)});
    const projectId = createProjectId();
    // Host the Project in a THIRD image so the host frontier is distinct.
    await runtime.images.createImage({id: 'host'});
    await createProject({images: runtime.images, imageId: 'host', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'host', projectId, key: 'm/a', role: 'source', target: a.recA});
    await addProjectMember({images: runtime.images, imageId: 'host', projectId, key: 'm/b', role: 'source', target: b.recB});

    const descriptor = {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [
      {key: 'm/a', role: 'source', target: a.recA},
      {key: 'm/b', role: 'source', target: b.recB},
    ]};
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m/a', 'm/b']});
    const {release, provenance} = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'host', projectId, profile, materializeRecord: recordMaterializer,
    });

    // A map of independently stable Image positions — never one synthetic revision.
    // (Provenance canonicalizes revisions to decimal strings, per the model.)
    assert.deepEqual(Object.keys(provenance.sourceFrontiers).sort(), ['a', 'b', 'host']);
    assert.equal(provenance.sourceFrontiers.a, String(await runtime.images.frontier('a')));
    assert.equal(provenance.sourceFrontiers.b, String(await runtime.images.frontier('b')));
    assert.equal(provenance.sourceFrontiers.host, String(await runtime.images.frontier('host')));
    assert.equal(release.members.length, 2);
  });
});

test('Project-host stability: retargeting a member during capture REFUSES', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: sources.rec});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: sources.rec}]},
      profileId: 'deploy', members: ['k'],
    });

    // Mutate Project working state (retarget) DURING capture, after the descriptor read.
    const sabotage = async ({record}) => {
      await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: objectRef('img', 'other')});
      return recordMaterializer({record});
    };
    await assert.rejects(
      captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: sabotage}),
      ProjectCaptureConflictError,
    );
  });
});

test('member-source stability: mutating a selected source during materializeRecord REFUSES', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: sources.rec});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: sources.rec}]},
      profileId: 'deploy', members: ['k'],
    });

    const sabotage = async ({record}) => {
      // Mutate the source record -> the host Image frontier advances -> detected.
      await runtime.images.putObject('img', {
        id: 'rec', shape: objectRef('img', 'shape'), slots: {v: integerValue(99)},
      }, {expectedVersion: 1});
      return recordMaterializer({record});
    };
    await assert.rejects(
      captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: sabotage}),
      ProjectCaptureConflictError,
    );
  });
});

test('no partial result: on instability neither release nor provenance is returned', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: sources.rec});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: sources.rec}]},
      profileId: 'deploy', members: ['k'],
    });
    const sabotage = async ({record}) => {
      await runtime.images.putShape('img', {id: 'unrelated-shape', slots: []});
      return recordMaterializer({record});
    };
    let result = null;
    try {
      result = await captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: sabotage});
    } catch (error) {
      assert.ok(error instanceof ProjectCaptureConflictError);
    }
    assert.equal(result, null);
  });
});

test('unselected member: excluded by profile, its record unread, its Image mutation irrelevant', async () => {
  await withRuntime(async (runtime) => {
    const a = await seedSource(runtime, 'a', 'shape', {recA: integerValue(1)});
    const b = await seedSource(runtime, 'b', 'shape', {recB: integerValue(2)});
    const projectId = createProjectId();
    await runtime.images.createImage({id: 'host'});
    await createProject({images: runtime.images, imageId: 'host', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'host', projectId, key: 'm/a', role: 'source', target: a.recA});
    await addProjectMember({images: runtime.images, imageId: 'host', projectId, key: 'm/b', role: 'source', target: b.recB});

    const descriptor = {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [
      {key: 'm/a', role: 'source', target: a.recA},
      {key: 'm/b', role: 'source', target: b.recB},
    ]};
    // Profile selects ONLY m/a; m/b and its Image b are not part of the capture.
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m/a']});

    let readCount = 0;
    const counting = async ({record}) => { readCount += 1; return recordMaterializer({record}); };
    // Mutate Image b during capture: NOT a participant, so it must not invalidate.
    const sabotageB = async (args) => {
      await runtime.images.putShape('b', {id: 'b-shape-2', slots: []});
      return counting(args);
    };
    const {release, provenance} = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'host', projectId, profile, materializeRecord: sabotageB,
    });
    assert.equal(release.members.length, 1);
    assert.equal(release.members[0].key, 'm/a');
    assert.equal(readCount, 1, 'only the selected member was materialized');
    // Image b is NOT in the frontier map (only a + host).
    assert.deepEqual(Object.keys(provenance.sourceFrontiers).sort(), ['a', 'host']);
  });
});

test('missing selected source is an explicit failure, never omitted', async () => {
  await withRuntime(async (runtime) => {
    await seedSource(runtime, 'img', 'shape', {});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    const dangling = objectRef('img', 'does-not-exist');
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: dangling});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: dangling}]},
      profileId: 'deploy', members: ['k'],
    });
    await assert.rejects(
      captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: recordMaterializer}),
      ProjectCaptureSourceError,
    );
  });
});

test('identity != provenance: same content at different stable frontiers -> same releaseId, different provenance', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: sources.rec});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: sources.rec}]},
      profileId: 'deploy', members: ['k'],
    });
    // A materializer whose contentIdentity is stable across an unrelated write.
    const stableMaterializer = () => ({representation: 'r/v1', contentIdentity: 'content:fixed'});

    const first = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: stableMaterializer,
    });
    // An unrelated write advances the source Image frontier between captures.
    await runtime.images.putShape('img', {id: 'another', slots: []});
    const second = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: stableMaterializer,
    });

    // SAME releaseId (content + semantics unchanged); DIFFERENT provenance frontier.
    assert.equal(first.release.releaseId, second.release.releaseId);
    assert.notEqual(first.provenance.sourceFrontiers.img, second.provenance.sourceFrontiers.img);
  });
});

test('material change: changed contentIdentity changes releaseId', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: sources.rec});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: sources.rec}]},
      profileId: 'deploy', members: ['k'],
    });
    const a = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile,
      materializeRecord: () => ({representation: 'r/v1', contentIdentity: 'content:v1'}),
    });
    const b = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile,
      materializeRecord: () => ({representation: 'r/v1', contentIdentity: 'content:v2'}),
    });
    assert.notEqual(a.release.releaseId, b.release.releaseId);
  });
});

test('member semantics: role change affects release identity through the model, not the coordinator', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    // Two Projects identical except the member's stored role. The durable member role
    // is part of release semantics (the model's rule), not something the coordinator sets.
    const capture = async (role) => {
      const projectId = createProjectId();
      await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
      await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role, target: sources.rec});
      const profile = createDeploymentProfile({
        project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role, target: sources.rec}]},
        profileId: 'deploy', members: ['k'],
      });
      return await captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: recordMaterializer});
    };
    const asSource = await capture('source');
    const asTest = await capture('test');
    // projectId differs (two Projects), so releaseIds differ for that reason too; the
    // role itself is also part of the hashed member semantics. Assert the role made it
    // into the release members, proving the model carried it (not coordinator logic).
    assert.equal(asSource.release.members[0].role, 'source');
    assert.equal(asTest.release.members[0].role, 'test');
    assert.notEqual(asSource.release.releaseId, asTest.release.releaseId);
  });
});

test('frontier is the history position, never a record _version', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: sources.rec});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: sources.rec}]},
      profileId: 'deploy', members: ['k'],
    });
    const {provenance} = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: recordMaterializer,
    });
    // The recorded frontier equals the Image history head, not the record _version (1).
    // (Provenance canonicalizes revisions to decimal strings.)
    assert.equal(provenance.sourceFrontiers.img, String(await runtime.images.frontier('img')));
    assert.ok(Number(provenance.sourceFrontiers.img) > 1, 'history position, not the single record _version');
  });
});

test('materializer isolation: it receives only member/source + an immutable record snapshot', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: sources.rec});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: sources.rec}]},
      profileId: 'deploy', members: ['k'],
    });
    let seen = null;
    const spy = async (args) => { seen = args; return recordMaterializer(args); };
    await captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: spy});
    // Exactly {member, source, record}; no images/backend/runtime leaks in.
    assert.deepEqual(Object.keys(seen).sort(), ['member', 'record', 'source']);
    assert.equal(seen.member.key, 'k');
    assert.deepEqual(seen.source, sources.rec);
    assert.equal(seen.record.id, 'rec');
    assert.ok(!('images' in seen) && !('backend' in seen) && !('runtime' in seen), 'no service leaks to the materializer');
  });
});

// --- non-object record kinds + immutable snapshot (repair of the direct-record materializer contract) ---

// A Project member target is a GENERIC ObjectRef (ADR 0073): it may reference any
// durable record kind the graph owner can return, not only generic objects. The
// coordinator reads through images.getRecord and passes the record to the
// representation-specific materializer WITHOUT learning CodeArtifact/Shape/Block
// semantics. A member materializer here asserts on the frozen record snapshot.

test('CodeArtifact member: captured with record.kind === code-artifact, no generic-object adaptation', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putCodeArtifact('img', {id: 'code', representation: 'neutral-expression/v0', content: textValue('1+1')});
    const codeRef = objectRef('img', 'code');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: codeRef});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: codeRef}]},
      profileId: 'deploy', members: ['k'],
    });
    let seen = null;
    const materializer = async (args) => { seen = args.record; return recordMaterializer(args); };
    const {release} = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: materializer,
    });
    // The coordinator handed the real CodeArtifact record through, unchanged.
    assert.equal(seen.kind, 'code-artifact');
    assert.equal(seen.id, 'code');
    assert.equal(release.members[0].contentIdentity, 'record:code:1');
  });
});

test('Shape member: another non-object record kind is accepted (no CodeArtifact special-casing)', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putShape('img', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    const shapeRef = objectRef('img', 'shape');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: shapeRef});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: shapeRef}]},
      profileId: 'deploy', members: ['k'],
    });
    let seen = null;
    const materializer = async (args) => { seen = args.record; return recordMaterializer(args); };
    const {release} = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: materializer,
    });
    assert.equal(seen.kind, 'shape');
    assert.equal(release.members[0].contentIdentity, 'record:shape:1');
  });
});

test('materializer record snapshot is deeply frozen: top-level and nested mutation fail, stored graph state unchanged', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    // A CodeArtifact has a NESTED content value — ideal for proving recursive freeze.
    await runtime.images.putCodeArtifact('img', {id: 'code', representation: 'neutral-expression/v0', content: textValue('1+1')});
    const codeRef = objectRef('img', 'code');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: codeRef});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: codeRef}]},
      profileId: 'deploy', members: ['k'],
    });
    let seen = null;
    const materializer = async (args) => { seen = args.record; return recordMaterializer(args); };
    await captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: materializer});

    // Top-level: frozen (strict-mode assignment to a frozen object throws).
    assert.ok(Object.isFrozen(seen), 'record snapshot frozen');
    assert.throws(() => { seen.id = 'rewritten'; }, TypeError);
    // Nested: the content value object is also frozen (recursive).
    assert.ok(Object.isFrozen(seen.content), 'nested content value frozen');
    assert.throws(() => { seen.content.value = 'HACKED'; }, TypeError);
    // The stored graph record is NOT frozen/mutated by the capture.
    const stored = await runtime.images.getRecord('img', 'code');
    assert.equal(stored.content.value, '1+1', 'stored graph record untouched');
    assert.ok(!Object.isFrozen(stored), 'stored graph record is not frozen by the capture');
  });
});

test('non-object member stability: replacing the selected CodeArtifact during materialization REFUSES', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putCodeArtifact('img', {id: 'code', representation: 'neutral-expression/v0', content: textValue('1+1')});
    const codeRef = objectRef('img', 'code');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: codeRef});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: codeRef}]},
      profileId: 'deploy', members: ['k'],
    });
    const sabotage = async (args) => {
      // Commit ANY new record in the source Image during capture -> the Image
      // frontier advances -> detected, refuse. (putCodeArtifact is create-only;
      // a fresh Shape commit advances the same Image history the member lives in.)
      await runtime.images.putShape('img', {id: 'concurrent-shape', slots: []});
      return recordMaterializer(args);
    };
    await assert.rejects(
      captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: sabotage}),
      ProjectCaptureConflictError,
    );
  });
});

// --- falsification ---------------------------------------------------------------------------------

test('FALSIFIABLE: reverting getRecord -> getObject turns the non-object-kind proofs red', async () => {
  // This proof exists to be pointed at by the mutation check: if the coordinator
  // reverts to images.getObject (generic-object-only), the CodeArtifact member is
  // wrongly treated as missing. The GREEN assertion below is the correct behavior;
  // the mutation (getRecord->getObject) makes it go red by raising
  // ProjectCaptureSourceError instead of capturing the CodeArtifact.
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putCodeArtifact('img', {id: 'code', representation: 'neutral-expression/v0', content: textValue('1+1')});
    const codeRef = objectRef('img', 'code');
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: codeRef});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: codeRef}]},
      profileId: 'deploy', members: ['k'],
    });
    // Correct behavior: capture succeeds for a non-object record.
    const {release} = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: recordMaterializer,
    });
    assert.equal(release.members[0].contentIdentity, 'record:code:1');
  });
});



test('FALSIFIABLE: removing the final frontier comparison turns the concurrent-mutation proof red', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'img', projectId, name: 'P'});
    await addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'k', role: 'source', target: sources.rec});
    const profile = createDeploymentProfile({
      project: {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'k', role: 'source', target: sources.rec}]},
      profileId: 'deploy', members: ['k'],
    });
    // This is the same concurrent-mutation scenario; the real coordinator MUST refuse.
    const sabotage = async ({record}) => {
      await runtime.images.putShape('img', {id: 'concurrent', slots: []});
      return recordMaterializer({record});
    };
    await assert.rejects(
      captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: sabotage}),
      ProjectCaptureConflictError,
    );
  });
});
