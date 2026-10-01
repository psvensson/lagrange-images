import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {readFile} from 'node:fs/promises';
import {createEmbeddedLagrange} from 'lagrange-server';
import {LagrangeBackend, createRuntime} from '../src/runtime.js';
import {
  FROZEN_STATES,
  assertProviderAbsence,
  buildBlinkerModel,
  installRecoveredLife,
  nativeGlobalsFor,
  senderFor,
} from '../test/support/life-m5-witness.js';

const [dataDir] = process.argv.slice(2);
if (!dataDir) throw new TypeError('usage: real-lagrange-m6-shared-server-process.js <data-dir>');

const WRITE_READINESS = Object.freeze({
  APPLICATION_ID: 'lagrange-images-m6-readiness',
  BUDGET_MS: 120_000,
  POLL_MS: 250,
  TABLE: 'lagrange_images_m6_readiness',
});

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const {port} = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const [restApiPort, wsPort, websocketPort] = [await freePort(), await freePort(), await freePort()];
const sharedServer = createEmbeddedLagrange({
  configuration: {
    admin: {websocketPort},
    logging: {level: 'error', prettyPrint: false},
    messageGroup: {replicaCount: 3},
    node: {
      id: '550e8400-e29b-41d4-a716-446655440037',
      restApiPort,
      wsPort,
    },
    partition: {defaultReplicaCount: 3},
    storage: {dataDir},
    worker: {maxThreads: 2, minThreads: 2},
  },
});

const fixture = JSON.parse(
  await readFile(new URL('../test/fixtures/life-m5-release.json', import.meta.url), 'utf8'),
);
const imageId = 'life-native-m6';
let runtimeA = null;
let runtimeB = null;

function stage(label) {
  process.stderr.write(`[m6.3] ${label}\n`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApplicationWrites() {
  const database = sharedServer.openApplicationDatabase({
    applicationId: WRITE_READINESS.APPLICATION_ID,
  });
  const deadline = Date.now() + WRITE_READINESS.BUDGET_MS;
  let attempts = 0;
  let lastError = null;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      await database.query(
        `CREATE TABLE IF NOT EXISTS ${WRITE_READINESS.TABLE} (id TEXT PRIMARY KEY, observed_at INTEGER)`,
      );
      await database.query(
        `INSERT INTO ${WRITE_READINESS.TABLE} (id, observed_at) VALUES (?, ?)`,
        [`ready:${attempts}:${Date.now()}`, Date.now()],
      );
      stage(`application writes served after ${attempts} readiness attempts`);
      return;
    } catch (error) {
      lastError = error;
      await sleep(WRITE_READINESS.POLL_MS);
    }
  }
  const code = typeof lastError?.code === 'string' ? lastError.code : 'unknown';
  const message = typeof lastError?.message === 'string' ? lastError.message : 'unknown';
  throw new Error(
    `application writes not served within ${WRITE_READINESS.BUDGET_MS} ms; last=${code}: ${message}`,
  );
}

stage('starting shared Lagrange server');
await sharedServer.start();
stage('shared Lagrange server started');
stage('waiting for public application-write readiness');
await waitForApplicationWrites();
try {
  stage('attaching Images runtime A');
  runtimeA = await createRuntime({
    backend: {
      instance: new LagrangeBackend({
        runtime: sharedServer,
        ownsRuntime: false,
        namespace: 'lagrange-images-m6',
      }),
    },
  });
  stage('Images runtime A attached');
  stage('attaching Images runtime B');
  runtimeB = await createRuntime({
    backend: {
      instance: new LagrangeBackend({
        runtime: sharedServer,
        ownsRuntime: false,
        namespace: 'lagrange-images-m6',
      }),
    },
  });

  stage('Images runtime B attached');
  assert.notEqual(runtimeA.images, runtimeB.images, 'the proof uses two independent Images runtimes');
  assert.notEqual(runtimeA.backend, runtimeB.backend, 'each Images runtime owns a distinct application session adapter');
  assertProviderAbsence(runtimeA, 'M6 runtime A');
  assertProviderAbsence(runtimeB, 'M6 runtime B');

  stage('installing recovered Life on runtime B');
  const {lifeModelClass} = await installRecoveredLife({runtime: runtimeB, imageId, fixture});
  stage('recovered Life installed on runtime B');
  const sendB = senderFor(runtimeB, imageId);
  const sendA = senderFor(runtimeA, imageId);
  const nativeGlobals = await nativeGlobalsFor(runtimeB.images, imageId);
  stage('building frozen blinker model on runtime B');
  const {model, stateString} = await buildBlinkerModel(sendB, lifeModelClass, nativeGlobals);
  stage('frozen blinker model built');

  assert.equal(await stateString(), FROZEN_STATES[0], 'runtime B creates the unchanged M5 S0 state');
  stage('resolving same model from runtime A');
  const cellsB = await sendB(model, 'cells');
  const cellsA = await sendA(model, 'cells');
  assert.deepEqual(cellsA, cellsB, 'runtime A resolves the same durable ObjectRef through its own session');

  stage('executing unchanged nextState from runtime A');
  await sendA(model, 'nextState');
  stage('runtime A nextState completed');
  assert.equal(
    await stateString(),
    FROZEN_STATES[1],
    'unchanged Life nextState executed by runtime A mutates the graph runtime B observes',
  );

  stage('closing runtime A');
  await runtimeA.close();
  runtimeA = null;
  stage('executing second nextState from runtime B');
  await sendB(model, 'nextState');
  stage('runtime B second nextState completed');
  assert.equal(
    await stateString(),
    FROZEN_STATES[2],
    'closing one attached Images runtime does not stop the caller-owned shared Lagrange server',
  );

  assertProviderAbsence(runtimeB, 'M6 runtime B after cross-runtime execution');
  stage('M6.3 shared-server witness complete');
} finally {
  if (runtimeA) await runtimeA.close();
  if (runtimeB) await runtimeB.close();
  await sharedServer.stop();
}
