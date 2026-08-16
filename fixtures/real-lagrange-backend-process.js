import assert from 'node:assert/strict';
import {createBackend} from '../src/backend/index.js';

const [dataDir] = process.argv.slice(2);
if (!dataDir) {
  throw new TypeError('usage: real-lagrange-backend-process.js <data-dir>');
}

const backend = await createBackend({
  mode: 'lagrange',
  configuration: {
    admin: {websocketPort: 45182},
    logging: {level: 'error', prettyPrint: false},
    messageGroup: {replicaCount: 3},
    node: {
      id: '550e8400-e29b-41d4-a716-446655440036',
      restApiPort: 45180,
      wsPort: 45181,
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
