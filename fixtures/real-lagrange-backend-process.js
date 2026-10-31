import {createServer} from 'node:net';
import {createBackend} from '../src/backend/index.js';
import {assertKernelResult, assertTransactionResult, proveKernel, proveTransaction} from './real-lagrange-backend-scenarios.js';
import {loadSharedLifeFixture, proveSharedLife} from './real-lagrange-m6-scenario.js';
import {
  REAL_LAGRANGE_BUDGETS,
  REAL_LAGRANGE_REPORT_PREFIX,
  runRealLagrangeSuite,
} from './real-lagrange-suite.js';

const [dataDir, proof = 'transaction'] = process.argv.slice(2);
if (!dataDir) throw new TypeError('usage: real-lagrange-backend-process.js <data-dir> [warm|transaction|kernel]');
if (!['warm', 'transaction', 'kernel'].includes(proof)) throw new TypeError('unknown real Lagrange proof');
const mark = (stage, detail = {}) => {
  console.error(JSON.stringify({proof, stage, at: new Date().toISOString(), ...detail}));
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

async function startBackend() {
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
  return backend;
}

// Cold modes retain the original first-write/admission reproductions. The CI
// warm mode shares only the running backend, never installed image contents.
const lifeFixture = proof === 'warm' ? await loadSharedLifeFixture() : null;
let kernelResult = null;
const cases = {
  transaction: {name: 'transaction', timeoutMs: REAL_LAGRANGE_BUDGETS.transaction, run: proveTransaction},
  kernel: {name: 'kernel', timeoutMs: REAL_LAGRANGE_BUDGETS.kernel, run: async (backend) => {
    kernelResult = await proveKernel(backend, mark);
    if (proof === 'warm') await assertTransactionResult(backend);
  }},
  life: {name: 'life', timeoutMs: REAL_LAGRANGE_BUDGETS.life, run: async (backend) => {
    await proveSharedLife(backend.runtime, lifeFixture);
    await assertTransactionResult(backend);
    await assertKernelResult(backend, kernelResult);
  }},
};
const report = await runRealLagrangeSuite({
  start: startBackend,
  stop: (backend) => backend.stop(),
  scenarios: (proof === 'warm' ? ['transaction', 'kernel', 'life'] : [proof]).map((name) => cases[name]),
  observe: (record) => mark('phase', record),
});
console.log(REAL_LAGRANGE_REPORT_PREFIX + JSON.stringify(report));
