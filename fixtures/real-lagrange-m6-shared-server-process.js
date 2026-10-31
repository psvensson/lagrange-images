import {createServer} from 'node:net';
import {createEmbeddedLagrange} from 'lagrange-server';
import {loadSharedLifeFixture, proveSharedLife} from './real-lagrange-m6-scenario.js';

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

const [restApiPort, wsPort, websocketPort] = [
  await freePort(),
  await freePort(),
  await freePort(),
];
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

const fixture = await loadSharedLifeFixture();
process.stderr.write('[m6.3] starting shared Lagrange server\n');
await sharedServer.start();
process.stderr.write('[m6.3] shared Lagrange server started\n');
try {
  await proveSharedLife(sharedServer, fixture);
} finally {
  await sharedServer.stop();
}
