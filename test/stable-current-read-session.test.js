import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addProjectMember,
  captureCurrentProjectRelease,
  createDeploymentProfile,
  createProject,
  createProjectId,
  createRuntime,
  createStableCurrentReadSession,
  integerValue,
  objectRef,
  ProjectCaptureConflictError,
  textValue,
} from '../src/runtime.js';

// ADR 0075 first prerequisite proofs: ONE stable-current read session owned by the
// Project release-capture coordinator, with the existing direct-record capture
// routed through it. The session is the ONLY bracket owner — reading brackets an
// Image; no eager frontier pre-computation remains.

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

const recordMaterializer = ({record}) => ({
  representation: 'lagrange-test-record/v1',
  contentIdentity: `record:${record.id}:${record._version}`,
});

// An images wrapper recording every frontier/getRecord/getObject call in order.
function instrumented(images) {
  const calls = [];
  return {
    calls,
    facade: {
      ...images,
      frontier: async (imageId) => { calls.push(['frontier', imageId]); return images.frontier(imageId); },
      getRecord: async (imageId, objectId) => { calls.push(['getRecord', imageId, objectId]); return images.getRecord(imageId, objectId); },
      getObject: async (imageId, objectId) => { calls.push(['getObject', imageId, objectId]); return images.getObject(imageId, objectId); },
    },
  };
}

async function seedProject(runtime, hostId, projectId, members) {
  await createProject({images: runtime.images, imageId: hostId, projectId, name: 'P'});
  for (const {key, role, target} of members) {
    await addProjectMember({images: runtime.images, imageId: hostId, projectId, key, role, target});
  }
  return {
    format: 'lagrange-project/v1', projectId, name: 'P', namespace: null,
    members: members.map(({key, role, target}) => ({key, role, target})),
  };
}

test('HOST FIRST-READ ORDER: frontier(host) completes before the first host read, INCLUDING the descriptor read', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: sources.rec}]);
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m']});
    const probe = instrumented(runtime.images);
    await captureCurrentProjectRelease({
      images: probe.facade, projectImageId: 'img', projectId, profile, materializeRecord: recordMaterializer,
    });
    const firstHostRead = probe.calls.findIndex(([op, imageId]) => (op === 'getRecord' || op === 'getObject') && imageId === 'img');
    const firstHostFrontier = probe.calls.findIndex(([op, imageId]) => op === 'frontier' && imageId === 'img');
    assert.ok(firstHostRead > 0, 'a host record read happened');
    assert.ok(firstHostFrontier >= 0, 'a host frontier read happened');
    assert.ok(firstHostFrontier < firstHostRead, 'frontier(host) precedes the FIRST host read (the descriptor itself is bracketed)');
    // No raw getObject call may escape the session at all.
    assert.deepEqual(probe.calls.filter(([op]) => op === 'getObject'), [], 'no raw images.getObject — session.getObject derives through getRecord');
  });
});

test('SOURCE FIRST-READ ORDER: for every member source Image, frontier(X) precedes the first record read from X', async () => {
  await withRuntime(async (runtime) => {
    const a = await seedSource(runtime, 'a', 'shape', {recA: integerValue(1)});
    const b = await seedSource(runtime, 'b', 'shape', {recB: integerValue(2)});
    await runtime.images.createImage({id: 'host'});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'host', projectId, [
      {key: 'm/a', role: 'source', target: a.recA},
      {key: 'm/b', role: 'source', target: b.recB},
    ]);
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m/a', 'm/b']});
    const probe = instrumented(runtime.images);
    await captureCurrentProjectRelease({
      images: probe.facade, projectImageId: 'host', projectId, profile, materializeRecord: recordMaterializer,
    });
    for (const imageId of ['a', 'b']) {
      const firstRead = probe.calls.findIndex(([op, id]) => op === 'getRecord' && id === imageId);
      const firstFrontier = probe.calls.findIndex(([op, id]) => op === 'frontier' && id === imageId);
      assert.ok(firstFrontier >= 0 && firstRead > 0 && firstFrontier < firstRead,
        `frontier(${imageId}) precedes its first record read`);
    }
  });
});

test('ONE BEFORE PER IMAGE: several reads from one Image perform exactly one initial frontier read', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {r1: integerValue(1), r2: integerValue(2)});
    const projectId = createProjectId();
    // Host + two sources in the SAME image: descriptor read (multiple getObjects)
    // plus two source reads -> still ONE initial frontier('img') before reads.
    const descriptor = await seedProject(runtime, 'img', projectId, [
      {key: 'm1', role: 'source', target: sources.r1},
      {key: 'm2', role: 'source', target: sources.r2},
    ]);
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m1', 'm2']});
    const probe = instrumented(runtime.images);
    await captureCurrentProjectRelease({
      images: probe.facade, projectImageId: 'img', projectId, profile, materializeRecord: recordMaterializer,
    });
    const frontierCalls = probe.calls.filter(([op, imageId]) => op === 'frontier' && imageId === 'img');
    // exactly two: one BEFORE (first read) + one AFTER (assertStable)
    assert.equal(frontierCalls.length, 2, 'one BEFORE + one AFTER frontier read for the single Image');
    const recordReads = probe.calls.filter(([op, imageId]) => op === 'getRecord' && imageId === 'img').length;
    assert.ok(recordReads >= 4, `descriptor + members + sources all read (${recordReads} reads)`);
  });
});

test('HOST DESCRIPTOR MUTATION: retargeting a member after descriptor read -> ProjectCaptureConflictError(host)', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7), other: integerValue(9)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: sources.rec}]);
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m']});
    let mutated = false;
    const materializer = (input) => {
      if (!mutated) {
        mutated = true;
        // Mutate the Project working state AFTER the descriptor read but BEFORE assertStable.
        return addProjectMember({images: runtime.images, imageId: 'img', projectId, key: 'm2', role: 'source', target: sources.other})
          .then(() => recordMaterializer(input));
      }
      return recordMaterializer(input);
    };
    await assert.rejects(
      captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: materializer}),
      (error) => {
        assert.ok(error instanceof ProjectCaptureConflictError);
        assert.equal(error.imageId, 'img', 'conflict names the HOST image (the descriptor bracket caught it)');
        assert.ok('before' in error && 'after' in error);
        return true;
      },
    );
  });
});

test('DYNAMIC IMAGE SET: frontierMap contains exactly the Images actually read — nothing merely because it exists', async () => {
  await withRuntime(async (runtime) => {
    const a = await seedSource(runtime, 'a', 'shape', {recA: integerValue(1)});
    await seedSource(runtime, 'unrelated', 'shape', {recU: integerValue(0)});
    await runtime.images.createImage({id: 'host'});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'host', projectId, [{key: 'm/a', role: 'source', target: a.recA}]);
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m/a']});
    const {provenance} = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'host', projectId, profile, materializeRecord: recordMaterializer,
    });
    assert.deepEqual(Object.keys(provenance.sourceFrontiers).sort(), ['a', 'host'],
      'exactly the read Images; the unrelated existing Image is not bracketed');
  });
});

test('UNSELECTED MEMBER: its target Image remains unread and unbracketed', async () => {
  await withRuntime(async (runtime) => {
    const a = await seedSource(runtime, 'a', 'shape', {recA: integerValue(1)});
    const b = await seedSource(runtime, 'b', 'shape', {recB: integerValue(2)});
    await runtime.images.createImage({id: 'host'});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'host', projectId, [
      {key: 'm/a', role: 'source', target: a.recA},
      {key: 'm/b', role: 'source', target: b.recB},
    ]);
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m/a']});
    const probe = instrumented(runtime.images);
    const {provenance} = await captureCurrentProjectRelease({
      images: probe.facade, projectImageId: 'host', projectId, profile, materializeRecord: recordMaterializer,
    });
    assert.deepEqual(Object.keys(provenance.sourceFrontiers).sort(), ['a', 'host']);
    assert.deepEqual(probe.calls.filter(([op, imageId]) => imageId === 'b' && (op === 'getRecord' || op === 'frontier')), [],
      'Image b (unselected member only) was never read or bracketed');
  });
});

test('ERROR STRUCTURE: ProjectCaptureConflictError name + imageId/before/after unchanged through the session', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: sources.rec}]);
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m']});
    let bumped = false;
    const materializer = async (input) => {
      if (!bumped) {
        bumped = true;
        await runtime.images.putObject('img', {id: 'rec', shape: objectRef('img', 'shape'), slots: {v: integerValue(8)}}, {expectedVersion: 1});
      }
      return recordMaterializer(input);
    };
    await assert.rejects(
      captureCurrentProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: materializer}),
      (error) => {
        assert.equal(error.name, 'ProjectCaptureConflictError');
        assert.equal(error.imageId, 'img');
        assert.ok(error.before !== error.after);
        return true;
      },
    );
  });
});

test('DIRECT CALLBACK ISOLATION: materializeRecord receives no session/images/frontier methods', async () => {
  await withRuntime(async (runtime) => {
    const sources = await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: sources.rec}]);
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['m']});
    let seen;
    const materializer = (input) => { seen = input; return recordMaterializer(input); };
    await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile, materializeRecord: materializer,
    });
    assert.deepEqual(Object.keys(seen).sort(), ['member', 'record', 'source']);
    for (const forbidden of ['images', 'session', 'frontier', 'frontierMap', 'assertStable', 'getRecord']) {
      assert.ok(!(forbidden in seen), `callback must not receive ${forbidden}`);
    }
  });
});

test('SESSION UNIT: getObject derives through getRecord; one BEFORE per Image; frontierMap gated on stability', async () => {
  await withRuntime(async (runtime) => {
    await seedSource(runtime, 'img', 'shape', {rec: integerValue(7)});
    const probe = instrumented(runtime.images);
    const session = createStableCurrentReadSession({images: probe.facade});

    // frontierMap before stability is a misuse -> explicit refusal
    assert.throws(() => session.frontierMap(), /only after assertStable/);

    const object = await session.getObject('img', 'rec');
    assert.equal(object.kind, 'object');
    await session.getRecord('img', 'shape');
    await session.getRecord('img', 'rec');
    const befores = probe.calls.filter(([op, imageId]) => op === 'frontier' && imageId === 'img');
    assert.equal(befores.length, 1, 'exactly one BEFORE frontier read across several reads');
    // the first frontier read precedes the first record read
    assert.ok(probe.calls.findIndex(([op]) => op === 'frontier') < probe.calls.findIndex(([op]) => op === 'getRecord'));
    // no raw getObject escaped
    assert.deepEqual(probe.calls.filter(([op]) => op === 'getObject'), []);

    // kind filter: getObject on a shape returns null (same contract as images.getObject)
    assert.equal(await session.getObject('img', 'shape'), null);

    await session.assertStable();
    assert.deepEqual(Object.keys(session.frontierMap()), ['img']);
  });
});

test('SESSION UNIT: conflict thrown in canonical image-id order (deterministic choice)', async () => {
  await withRuntime(async (runtime) => {
    await seedSource(runtime, 'aaa', 'shape', {recA: integerValue(1)});
    await seedSource(runtime, 'bbb', 'shape', {recB: integerValue(2)});
    const session = createStableCurrentReadSession({images: runtime.images});
    await session.getRecord('bbb', 'recB');
    await session.getRecord('aaa', 'recA');
    // Move BOTH images; the conflict must name the canonically-first one.
    await runtime.images.putObject('aaa', {id: 'recA', shape: objectRef('aaa', 'shape'), slots: {v: integerValue(9)}}, {expectedVersion: 1});
    await runtime.images.putObject('bbb', {id: 'recB', shape: objectRef('bbb', 'shape'), slots: {v: integerValue(9)}}, {expectedVersion: 1});
    await assert.rejects(session.assertStable(), (error) => {
      assert.equal(error.name, 'ProjectCaptureConflictError');
      assert.equal(error.imageId, 'aaa', 'canonical image-id order -> deterministic conflict choice');
      return true;
    });
  });
});
