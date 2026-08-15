import test from 'node:test';
import assert from 'node:assert/strict';

async function withBackend(createBackend, work) {
  const backend = await createBackend();
  await backend.start();
  try {
    await work(backend);
  } finally {
    await backend.stop();
  }
}

function registerBackendConformanceTests({
  name,
  createBackend,
  VersionConflictError,
}) {
  test(`${name} backend provides optimistic versioned records and streams`, async () => {
    await withBackend(createBackend, async (backend) => {
      const first = await backend.put('things', 'one', {value: 1}, {expectedVersion: 0});
      assert.deepEqual(first, {value: 1, _version: 1});

      await assert.rejects(
        backend.put('things', 'one', {value: 2}, {expectedVersion: 0}),
        VersionConflictError,
      );

      const second = await backend.put('things', 'one', {value: 2}, {expectedVersion: 1});
      const event = await backend.append('events', {type: 'thing.updated', version: second._version});
      assert.deepEqual(second, {value: 2, _version: 2});
      assert.deepEqual(event, {type: 'thing.updated', version: 2, revision: 1});
      assert.deepEqual(await backend.get('things', 'one'), second);
      assert.deepEqual(await backend.scan('things'), [{key: 'one', value: second}]);
      assert.deepEqual(await backend.readStream('events'), [event]);
    });
  });

  test(`${name} backend commits transaction state and history together`, async () => {
    await withBackend(createBackend, async (backend) => {
      const result = await backend.transaction(async (transaction) => {
        const stored = await transaction.put(
          'things',
          'one',
          {value: 1},
          {expectedVersion: 0},
        );
        assert.deepEqual(await transaction.get('things', 'one'), stored);
        const event = await transaction.append('events', {
          type: 'thing.created',
          version: stored._version,
        });
        assert.deepEqual(await transaction.readStream('events'), [event]);
        return {stored, event};
      });

      assert.deepEqual(await backend.get('things', 'one'), result.stored);
      assert.deepEqual(await backend.readStream('events'), [result.event]);
    });
  });

  test(`${name} backend rolls back every transaction operation after failure`, async () => {
    await withBackend(createBackend, async (backend) => {
      await assert.rejects(
        backend.transaction(async (transaction) => {
          await transaction.put('things', 'one', {value: 1}, {expectedVersion: 0});
          await transaction.append('events', {type: 'thing.created'});
          throw new Error('abort transaction');
        }),
        /abort transaction/,
      );

      assert.equal(await backend.get('things', 'one'), undefined);
      assert.deepEqual(await backend.readStream('events'), []);
    });
  });

  test(`${name} backend rolls back earlier operations when a version check fails`, async () => {
    await withBackend(createBackend, async (backend) => {
      const original = await backend.put('things', 'one', {value: 1}, {expectedVersion: 0});

      await assert.rejects(
        backend.transaction(async (transaction) => {
          await transaction.append('events', {type: 'must-not-commit'});
          await transaction.put('things', 'one', {value: 2}, {expectedVersion: 0});
        }),
        VersionConflictError,
      );

      assert.deepEqual(await backend.get('things', 'one'), original);
      assert.deepEqual(await backend.readStream('events'), []);
    });
  });
}

export {registerBackendConformanceTests};
