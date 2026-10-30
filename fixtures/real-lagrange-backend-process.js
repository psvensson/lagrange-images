import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {createBackend} from '../src/backend/index.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {findSmalltalkKernel, installSmalltalkKernel} from '../src/language/smalltalk-kernel.js';

const [dataDir, proof = 'transaction'] = process.argv.slice(2);
if (!dataDir) {
  throw new TypeError('usage: real-lagrange-backend-process.js <data-dir>');
}
if (!['transaction', 'kernel'].includes(proof)) throw new TypeError('unknown real Lagrange proof');
const mark = (stage, detail = {}) => {
  if (proof === 'kernel') console.error(JSON.stringify({proof, stage, at: new Date().toISOString(), ...detail}));
};

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

mark('backend-starting');
await backend.start();
mark('backend-ready');
try {
  if (proof === 'kernel') {
    const images = new ImageService({backend});
    const createRecords = images.createRecords.bind(images);
    const batches = [];
    images.createRecords = async (imageId, inputs) => {
      const phase = batches.length + 1;
      mark('object-batch-starting', {phase, count: inputs.length});
      const stored = await createRecords(imageId, inputs);
      batches.push(stored.length);
      mark('object-batch-committed', {phase, count: stored.length});
      return stored;
    };
    await images.createImage({id: 'real-kernel'});
    mark('kernel-installing');
    await installSmalltalkKernel({images, imageId: 'real-kernel'});
    mark('kernel-installed');
    assert.deepEqual(batches, [22, 22]);
    const records = await images.listRecords('real-kernel');
    const events = await images.history('real-kernel');
    assert.equal(records.length, 52);
    assert.equal(events.length, 53, 'image.created plus 52 kernel record events');
    assert.ok(await findSmalltalkKernel({images, imageId: 'real-kernel'}));
    await installSmalltalkKernel({images, imageId: 'real-kernel'});
    assert.deepEqual(batches, [22, 22], 'reinstall publishes no batch');
    assert.deepEqual(await images.listRecords('real-kernel'), records);
    assert.deepEqual(await images.history('real-kernel'), events);
    mark('kernel-reused');
  } else {
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
  }
} finally {
  mark('backend-stopping');
  await backend.stop();
  mark('backend-stopped');
}
