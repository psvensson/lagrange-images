import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {
  addProjectMember,
  captureCurrentGraphProjectRelease,
  createDeploymentProfile,
  createProject,
  createProjectId,
  createRuntime,
  integerValue,
  objectRef,
} from '../src/runtime.js';
import {
  ManagedProjectInstallationConflictError,
  installManagedProjectRelease,
} from '../src/project/managed-installation.js';
import {
  PROJECT_INSTALLATION_HEAD_SHAPE_ID,
  ProjectInstallationStateError,
  ensureInstallationShapes,
  installationHeadObjectId,
  readManagedProjectInstallation,
} from '../src/project/installation-state.js';
import {installProjectRelease} from '../src/project/release-installation.js';
import {planProjectUpgrade} from '../src/project/model.js';
import {getDefaultCryptoProvider} from '../src/support/default-crypto.js';
import {VersionConflictError} from '../src/backend/backend-contract.js';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function captureSimple(runtime, {projectId = createProjectId(), sourceImageId = 'src', value = 7} = {}) {
  await runtime.images.createImage({id: sourceImageId});
  await runtime.images.putShape(sourceImageId, {id: 'shape', slots: [{id: 'v', name: 'v'}]});
  await runtime.images.putObject(sourceImageId, {
    id: 'record', shape: objectRef(sourceImageId, 'shape'), slots: {v: integerValue(value)},
  });
  await createProject({images: runtime.images, imageId: sourceImageId, projectId, name: 'P'});
  await addProjectMember({
    images: runtime.images,
    imageId: sourceImageId,
    projectId,
    key: 'model/record',
    role: 'source',
    target: objectRef(sourceImageId, 'record'),
  });
  const descriptor = await (await import('../src/project/working-state.js')).readProjectDescriptor({
    images: runtime.images, imageId: sourceImageId, projectId,
  });
  const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['model/record']});
  return await captureCurrentGraphProjectRelease({
    images: runtime.images, projectImageId: sourceImageId, projectId, profile,
  });
}

function serviceFacade(images, createRecords = images.createRecords.bind(images)) {
  return {
    getRecord: images.getRecord.bind(images),
    putShape: images.putShape.bind(images),
    createRecords,
  };
}

const durableEvents = async (images, imageId) =>
  (await images.history(imageId)).filter(({type}) => type !== 'image.created');

function prefixedCrypto(prefix) {
  const real = getDefaultCryptoProvider();
  let next = 0;
  return {
    sha256: (bytes) => real.sha256(bytes),
    uuid: () => `${prefix}-${next++}`,
  };
}

test('first managed install commits graph and durable state in exactly one createRecords batch', async () => {
  await withRuntime(async (runtime) => {
    const projectApi = await import('lagrange-images/project');
    assert.equal(projectApi.installManagedProjectRelease, installManagedProjectRelease);
    const captured = await captureSimple(runtime);
    await runtime.images.createImage({id: 'dst'});
    const realCreate = runtime.images.createRecords.bind(runtime.images);
    const calls = [];
    const images = serviceFacade(runtime.images, async (imageId, inputs) => {
      calls.push({imageId, inputs});
      return realCreate(imageId, inputs);
    });

    const installation = await installManagedProjectRelease({
      images, targetImageId: 'dst', release: captured.release, material: captured.material,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].imageId, 'dst');
    assert.equal(calls[0].inputs.at(-1).id, installationHeadObjectId(captured.release.projectId));
    assert.equal(calls[0].inputs.at(-1).shape.objectId, PROJECT_INSTALLATION_HEAD_SHAPE_ID);
    assert.equal(
      calls[0].inputs.length,
      Object.keys(captured.material.bundle.records).length + captured.release.members.length + 2,
    );
    assert.deepEqual(await readManagedProjectInstallation({
      images: runtime.images, targetImageId: 'dst', projectId: captured.release.projectId,
    }), installation);
    assert.ok(await runtime.images.getObject('dst', installation.members[0].target.objectId));
  });
});

test('managed install preserves one shared cyclic graph across Project members', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject('src', {
      id: 'a', shape: objectRef('src', 'shape'), slots: {v: integerValue(0)},
    });
    await runtime.images.putObject('src', {
      id: 'b', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'a')},
    });
    await runtime.images.putObject('src', {
      id: 'a', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'b')},
    }, {expectedVersion: 1});
    const projectId = createProjectId();
    await createProject({images: runtime.images, imageId: 'src', projectId, name: 'P'});
    await addProjectMember({
      images: runtime.images,
      imageId: 'src',
      projectId,
      key: 'a',
      role: 'source',
      target: objectRef('src', 'a'),
    });
    await addProjectMember({
      images: runtime.images,
      imageId: 'src',
      projectId,
      key: 'b',
      role: 'source',
      target: objectRef('src', 'b'),
    });
    const descriptor = await (await import('../src/project/working-state.js')).readProjectDescriptor({
      images: runtime.images, imageId: 'src', projectId,
    });
    const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: ['a', 'b']});
    const {release, material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'src', projectId, profile,
    });
    await runtime.images.createImage({id: 'dst'});

    const installation = await installManagedProjectRelease({
      images: runtime.images, targetImageId: 'dst', release, material,
    });
    const targetA = installation.members.find(({key}) => key === 'a').target;
    const targetB = installation.members.find(({key}) => key === 'b').target;
    const objectA = await runtime.images.getObject('dst', targetA.objectId);
    const objectB = await runtime.images.getObject('dst', objectA.slots.v.objectId);
    assert.equal(objectB.id, targetB.objectId, 'both members share the one imported graph');
    assert.equal(objectB.slots.v.objectId, objectA.id, 'the cycle survives managed installation');
  });
});

test('same-release retry is write-free; different-release request refuses without mutation', async () => {
  await withRuntime(async (runtime) => {
    const first = await captureSimple(runtime);
    const second = await captureSimple(runtime, {
      projectId: first.release.projectId, sourceImageId: 'src-next', value: 8,
    });
    await runtime.images.createImage({id: 'dst'});
    const installed = await installManagedProjectRelease({
      images: runtime.images, targetImageId: 'dst', release: first.release, material: first.material,
    });
    const recordsBefore = await runtime.images.listRecords('dst');
    const eventsBefore = await durableEvents(runtime.images, 'dst');
    let publications = 0;
    const images = serviceFacade(runtime.images, async (...args) => {
      publications += 1;
      return runtime.images.createRecords(...args);
    });

    assert.deepEqual(await installManagedProjectRelease({
      images, targetImageId: 'dst', release: first.release, material: first.material,
    }), installed);
    assert.equal(publications, 0);

    await assert.rejects(
      installManagedProjectRelease({
        images, targetImageId: 'dst', release: second.release, material: second.material,
      }),
      (error) => error instanceof ManagedProjectInstallationConflictError
        && error.currentReleaseId === first.release.releaseId
        && error.desiredReleaseId === second.release.releaseId,
    );
    assert.equal(publications, 0);
    assert.deepEqual(await runtime.images.listRecords('dst'), recordsBefore);
    assert.deepEqual(await durableEvents(runtime.images, 'dst'), eventsBefore);

    const recovered = await readManagedProjectInstallation({
      images: runtime.images, targetImageId: 'dst', projectId: first.release.projectId,
    });
    const historyBeforePlan = await durableEvents(runtime.images, 'dst');
    assert.deepEqual(planProjectUpgrade({installation: recovered, nextRelease: second.release}).actions.map(({kind}) => kind), ['replace']);
    assert.deepEqual(await durableEvents(runtime.images, 'dst'), historyBeforePlan, 'upgrade planning stays pure');
  });
});

test('backend failure inside the one batch leaves Shapes only and no graph or installation state', async () => {
  await withRuntime(async (runtime) => {
    const captured = await captureSimple(runtime);
    await runtime.images.createImage({id: 'dst'});
    await ensureInstallationShapes({images: runtime.images, targetImageId: 'dst'});
    const recordsBefore = await runtime.images.listRecords('dst');
    const eventsBefore = await durableEvents(runtime.images, 'dst');
    const realTransaction = runtime.images.backend.transaction.bind(runtime.images.backend);
    let injected = false;
    runtime.images.backend.transaction = async (work) => realTransaction(async (transaction) => {
      let appends = 0;
      return work({
        ...transaction,
        put: transaction.put.bind(transaction),
        append: async (stream, event) => {
          appends += 1;
          if (appends === 2) { injected = true; throw new Error('injected managed-install failure'); }
          return transaction.append(stream, event);
        },
      });
    });
    await assert.rejects(
      installManagedProjectRelease({
        images: runtime.images, targetImageId: 'dst', release: captured.release, material: captured.material,
      }),
      /injected managed-install failure/,
    );
    assert.ok(injected);
    assert.deepEqual(await runtime.images.listRecords('dst'), recordsBefore);
    assert.deepEqual(await durableEvents(runtime.images, 'dst'), eventsBefore);
    assert.equal(await readManagedProjectInstallation({
      images: runtime.images, targetImageId: 'dst', projectId: captured.release.projectId,
    }), null);
  });
});

test('commit then lost acknowledgement is recovered by a write-free retry with the same target refs', async () => {
  await withRuntime(async (runtime) => {
    const captured = await captureSimple(runtime);
    await runtime.images.createImage({id: 'dst'});
    const realCreate = runtime.images.createRecords.bind(runtime.images);
    let publications = 0;
    const images = serviceFacade(runtime.images, async (...args) => {
      publications += 1;
      const result = await realCreate(...args);
      throw new Error('lost acknowledgement after commit');
    });
    await assert.rejects(
      installManagedProjectRelease({
        images, targetImageId: 'dst', release: captured.release, material: captured.material,
      }),
      /lost acknowledgement/,
    );
    const committed = await readManagedProjectInstallation({
      images: runtime.images, targetImageId: 'dst', projectId: captured.release.projectId,
    });
    const eventsBeforeRetry = await durableEvents(runtime.images, 'dst');
    const retried = await installManagedProjectRelease({
      images, targetImageId: 'dst', release: captured.release, material: captured.material,
    });
    assert.deepEqual(retried, committed);
    assert.equal(publications, 1, 'retry never enters publication');
    assert.deepEqual(await durableEvents(runtime.images, 'dst'), eventsBeforeRetry);
  });
});

async function raceInstall(runtime, requests) {
  await runtime.images.createImage({id: 'dst'});
  await ensureInstallationShapes({images: runtime.images, targetImageId: 'dst'});
  const realCreate = runtime.images.createRecords.bind(runtime.images);
  const attempts = [];
  let arrived = 0;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const run = ({label, captured}) => installManagedProjectRelease({
    images: serviceFacade(runtime.images, async (imageId, inputs) => {
      attempts.push({label, inputs});
      arrived += 1;
      if (arrived === requests.length) releaseGate();
      await gate;
      return realCreate(imageId, inputs);
    }),
    targetImageId: 'dst',
    release: captured.release,
    material: captured.material,
    crypto: prefixedCrypto(label),
  });
  const results = await Promise.allSettled(requests.map(run));
  return {attempts, results};
}

test('concurrent same-release installs converge; the losing prepared ids leave no durable orphan', async () => {
  await withRuntime(async (runtime) => {
    const captured = await captureSimple(runtime);
    const {attempts, results} = await raceInstall(runtime, [
      {label: 'left', captured},
      {label: 'right', captured},
    ]);
    assert.deepEqual(results.map(({status}) => status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(results[0].value, results[1].value);
    assert.equal(attempts.length, 2, 'both contenders prepared and attempted one batch');
    assert.notDeepEqual(attempts[0].inputs.map(({id}) => id), attempts[1].inputs.map(({id}) => id));

    const winnerPrefix = results[0].value.members[0].target.objectId.split('-')[0];
    const loserPrefix = winnerPrefix === 'left' ? 'right' : 'left';
    const durableIds = (await runtime.images.listRecords('dst')).map(({id}) => id);
    assert.equal(durableIds.some((id) => id.startsWith(`${loserPrefix}-`)), false);
  });
});

test('concurrent different releases produce one winner and one explicit conflict with no loser graph', async () => {
  await withRuntime(async (runtime) => {
    const first = await captureSimple(runtime);
    const second = await captureSimple(runtime, {
      projectId: first.release.projectId, sourceImageId: 'src-next', value: 9,
    });
    const {results} = await raceInstall(runtime, [
      {label: 'first', captured: first},
      {label: 'second', captured: second},
    ]);
    const winner = results.find(({status}) => status === 'fulfilled');
    const loser = results.find(({status}) => status === 'rejected');
    assert.ok(winner);
    assert.ok(loser?.reason instanceof ManagedProjectInstallationConflictError);
    assert.equal(loser.reason.currentReleaseId, winner.value.releaseId);
    const winnerPrefix = winner.value.members[0].target.objectId.split('-')[0];
    const loserPrefix = winnerPrefix === 'first' ? 'second' : 'first';
    assert.equal((await runtime.images.listRecords('dst')).some(({id}) => id.startsWith(`${loserPrefix}-`)), false);
  });
});

test('only a VersionConflict on the deterministic head is interpreted as an installation race', async () => {
  await withRuntime(async (runtime) => {
    const captured = await captureSimple(runtime);
    await runtime.images.createImage({id: 'dst'});
    await ensureInstallationShapes({images: runtime.images, targetImageId: 'dst'});
    const collision = new VersionConflictError({collection: 'records/dst', key: 'some-graph-id', expectedVersion: 0, actualVersion: 1});
    await assert.rejects(
      installManagedProjectRelease({
        images: serviceFacade(runtime.images, async () => { throw collision; }),
        targetImageId: 'dst',
        release: captured.release,
        material: captured.material,
      }),
      (error) => error === collision,
    );
  });
});

test('unmanaged graph is not adopted; managed install creates a distinct graph and durable head', async () => {
  await withRuntime(async (runtime) => {
    const captured = await captureSimple(runtime);
    await runtime.images.createImage({id: 'dst'});
    const unmanaged = await installProjectRelease({
      images: runtime.images, targetImageId: 'dst', release: captured.release, material: captured.material,
    });
    assert.equal(await readManagedProjectInstallation({
      images: runtime.images, targetImageId: 'dst', projectId: captured.release.projectId,
    }), null);
    const managed = await installManagedProjectRelease({
      images: runtime.images, targetImageId: 'dst', release: captured.release, material: captured.material,
    });
    assert.notDeepEqual(managed.members[0].target, unmanaged.members[0].target);
    assert.ok(await runtime.images.getObject('dst', installationHeadObjectId(captured.release.projectId)));
  });
});

test('different Projects share one target independently; one Project installs independently in two targets', async () => {
  await withRuntime(async (runtime) => {
    const one = await captureSimple(runtime, {sourceImageId: 'src-one'});
    const two = await captureSimple(runtime, {sourceImageId: 'src-two'});
    await runtime.images.createImage({id: 'target-a'});
    await runtime.images.createImage({id: 'target-b'});
    const oneA = await installManagedProjectRelease({
      images: runtime.images, targetImageId: 'target-a', release: one.release, material: one.material,
    });
    const twoA = await installManagedProjectRelease({
      images: runtime.images, targetImageId: 'target-a', release: two.release, material: two.material,
    });
    const oneB = await installManagedProjectRelease({
      images: runtime.images, targetImageId: 'target-b', release: one.release, material: one.material,
    });
    assert.notEqual(installationHeadObjectId(one.release.projectId), installationHeadObjectId(two.release.projectId));
    assert.notDeepEqual(oneA.members[0].target, oneB.members[0].target);
    assert.equal(twoA.targetImageId, 'target-a');
    assert.equal(oneB.targetImageId, 'target-b');
  });
});

test('corrupt durable state propagates from the translator and is never repaired by retry', async () => {
  await withRuntime(async (runtime) => {
    const captured = await captureSimple(runtime);
    await runtime.images.createImage({id: 'dst'});
    await installManagedProjectRelease({
      images: runtime.images, targetImageId: 'dst', release: captured.release, material: captured.material,
    });
    const headId = installationHeadObjectId(captured.release.projectId);
    const head = await runtime.images.getObject('dst', headId);
    await runtime.images.putObject('dst', {
      id: head.id,
      shape: head.shape,
      slots: {...head.slots, 'installation-snapshot': objectRef('dst', 'missing')},
      metadata: head.metadata,
    }, {expectedVersion: head._version});
    const before = await durableEvents(runtime.images, 'dst');
    await assert.rejects(
      installManagedProjectRelease({
        images: runtime.images, targetImageId: 'dst', release: captured.release, material: captured.material,
      }),
      (error) => error instanceof ProjectInstallationStateError,
    );
    assert.deepEqual(await durableEvents(runtime.images, 'dst'), before);
  });
});

test('same-release retry after real-backend restart returns existing refs with no new history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-managed-install-'));
  const filename = join(directory, 'image.sqlite');
  let captured;
  let installed;
  try {
    const firstBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await firstBackend.start();
    const firstRuntime = {
      images: new ImageService({backend: firstBackend}),
      close: () => firstBackend.stop(),
    };
    captured = await captureSimple(firstRuntime);
    await firstRuntime.images.createImage({id: 'dst'});
    installed = await installManagedProjectRelease({
      images: firstRuntime.images, targetImageId: 'dst', release: captured.release, material: captured.material,
    });
    await firstRuntime.close();

    const secondBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await secondBackend.start();
    try {
      const second = new ImageService({backend: secondBackend});
      const before = await durableEvents(second, 'dst');
      assert.deepEqual(await installManagedProjectRelease({
        images: second, targetImageId: 'dst', release: captured.release, material: captured.material,
      }), installed);
      assert.deepEqual(await durableEvents(second, 'dst'), before);
    } finally {
      await secondBackend.stop();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
