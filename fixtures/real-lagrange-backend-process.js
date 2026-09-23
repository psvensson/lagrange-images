import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {createBackend} from '../src/backend/index.js';

const [dataDir] = process.argv.slice(2);
if (!dataDir) {
  throw new TypeError('usage: real-lagrange-backend-process.js <data-dir>');
}

// The embedded Lagrange node listens on three ports. They used to be fixed (45180-45182), which
// made this lane fail with EADDRINUSE whenever anything else on the host held one of them — a
// concurrent run of the same lane, a leftover process from an aborted run — for a reason unrelated
// to the code under test (bead lagrange-images-90o). Each run now asks the OS for three currently
// free ports and hands exactly those to the node; only the fixture's port choice changes, never the
// backend's configuration contract.
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

const backend = await createBackend({
  mode: 'lagrange',
  configuration: {
    admin: {websocketPort},
    logging: {level: 'error', prettyPrint: false},
    messageGroup: {replicaCount: 3},
    node: {
      id: '550e8400-e29b-41d4-a716-446655440036',
      restApiPort,
      wsPort,
    },
    partition: {defaultReplicaCount: 3},
    storage: {dataDir},
    worker: {maxThreads: 2, minThreads: 2},
  },
});

await backend.start();
try {
  await backend.transaction(async (transaction) => {
    const stored = await transaction.put(
      'things',
      'one',
      {value: 'committed'},
      {expectedVersion: 0},
    );
    await transaction.append('events', {
      type: 'thing.created',
      version: stored._version,
    });
  });
  assert.deepEqual(
    await backend.get('things', 'one'),
    {value: 'committed', _version: 1},
  );
  assert.deepEqual(
    await backend.readStream('events'),
    [{type: 'thing.created', version: 1, revision: 1}],
  );
} finally {
  await backend.stop();
}
