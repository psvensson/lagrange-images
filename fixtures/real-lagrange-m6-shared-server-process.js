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

await sharedServer.start();
try {
  runtimeA = await createRuntime({
    backend: {
      instance: new LagrangeBackend({
        runtime: sharedServer,
        ownsRuntime: false,
        namespace: 'lagrange-images-m6',
      }),
    },
  });
  runtimeB = await createRuntime({
    backend: {
      instance: new LagrangeBackend({
        runtime: sharedServer,
        ownsRuntime: false,
        namespace: 'lagrange-images-m6',
      }),
    },
  });

  assert.notEqual(runtimeA.images, runtimeB.images, 'the proof uses two independent Images runtimes');
  assert.notEqual(runtimeA.backend, runtimeB.backend, 'each Images runtime owns a distinct application session adapter');
  assertProviderAbsence(runtimeA, 'M6 runtime A');
  assertProviderAbsence(runtimeB, 'M6 runtime B');

  const {lifeModelClass} = await installRecoveredLife({runtime: runtimeB, imageId, fixture});
  const sendB = senderFor(runtimeB, imageId);
  const sendA = senderFor(runtimeA, imageId);
  const nativeGlobals = await nativeGlobalsFor(runtimeB.images, imageId);
  const {model, stateString} = await buildBlinkerModel(sendB, lifeModelClass, nativeGlobals);

  assert.equal(await stateString(), FROZEN_STATES[0], 'runtime B creates the unchanged M5 S0 state');
  const cellsB = await sendB(model, 'cells');
  const cellsA = await sendA(model, 'cells');
  assert.deepEqual(cellsA, cellsB, 'runtime A resolves the same durable ObjectRef through its own session');

  await sendA(model, 'nextState');
  assert.equal(
    await stateString(),
    FROZEN_STATES[1],
    'unchanged Life nextState executed by runtime A mutates the graph runtime B observes',
  );

  await runtimeA.close();
  runtimeA = null;
  await sendB(model, 'nextState');
  assert.equal(
    await stateString(),
    FROZEN_STATES[2],
    'closing one attached Images runtime does not stop the caller-owned shared Lagrange server',
  );

  assertProviderAbsence(runtimeB, 'M6 runtime B after cross-runtime execution');
} finally {
  if (runtimeA) await runtimeA.close();
  if (runtimeB) await runtimeB.close();
  await sharedServer.stop();
}
