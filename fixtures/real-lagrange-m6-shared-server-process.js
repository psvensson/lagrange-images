import {createServer} from 'node:net';
import {loadLagrangeModule} from '../src/backend/index.js';
import {loadSharedLifeFixture, proveSharedLife} from './real-lagrange-m6-scenario.js';

const [dataDir] = process.argv.slice(2);
if (!dataDir) {
  throw new TypeError('usage: real-lagrange-m6-shared-server-process.js <data-dir>');
}

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

const [{createEmbeddedLagrange}, fixture, restApiPort, wsPort, websocketPort] = await Promise.all([
  loadLagrangeModule(),
  loadSharedLifeFixture(),
  freePort(),
  freePort(),
  freePort(),
]);

const server = createEmbeddedLagrange({
  configuration: {
    admin: {websocketPort},
    logging: {level: 'error', prettyPrint: false},
    messageGroup: {replicaCount: 3},
    node: {
      id: '550e8400-e29b-41d4-a716-446655440063',
      restApiPort,
      wsPort,
    },
    partition: {defaultReplicaCount: 3},
    storage: {dataDir},
    worker: {maxThreads: 2, minThreads: 2},
  },
});

await server.start();
try {
  await proveSharedLife(server, fixture);
} finally {
  await server.stop();
}
