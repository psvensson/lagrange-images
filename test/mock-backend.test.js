import test from 'node:test';
import assert from 'node:assert/strict';
import {MockBackend, VersionConflictError} from '../src/backend/index.js';
import {registerBackendConformanceTests} from './support/backend-conformance.js';

registerBackendConformanceTests({
  name: 'mock',
  createBackend: async () => new MockBackend(),
  VersionConflictError,
});

test('mock transaction handles cannot mutate detached state after completion', async () => {
  const backend = new MockBackend();
  await backend.start();
  let escaped;

  try {
    await backend.transaction(async (transaction) => {
      escaped = transaction;
      await transaction.put('things', 'one', {value: 1}, {expectedVersion: 0});
    });

    await assert.rejects(
      escaped.put('things', 'two', {value: 2}, {expectedVersion: 0}),
      /transaction is no longer active/,
    );
    assert.equal(await backend.get('things', 'two'), undefined);
  } finally {
    await backend.stop();
  }
});

// The fork seam the recovery sweeps stand on: a fork is a complete independent copy — versions,
// streams and all — and neither side's writes reach the other.
test('a fork copies the whole state and is isolated in both directions', async () => {
  const backend = new MockBackend();
  await backend.start();
  try {
    await backend.put('things', 'shared', {value: 1}, {expectedVersion: 0});
    await backend.put('things', 'shared', {value: 2}, {expectedVersion: 1});
    await backend.append('events', {happened: 'before-fork'});

    const fork = backend.fork();
    await fork.start();
    try {
      // Versions survive the fork, so optimistic concurrency behaves identically on either side.
      assert.equal((await fork.get('things', 'shared'))._version, 2);
      assert.deepEqual(await fork.readStream('events'), await backend.readStream('events'));

      await fork.put('things', 'fork-only', {value: 3}, {expectedVersion: 0});
      await backend.put('things', 'template-only', {value: 4}, {expectedVersion: 0});
      assert.equal(await backend.get('things', 'fork-only'), undefined);
      assert.equal(await fork.get('things', 'template-only'), undefined);

      // Same key, both sides: each advances its own version history independently.
      await fork.put('things', 'shared', {value: 30}, {expectedVersion: 2});
      assert.equal((await backend.get('things', 'shared')).value, 2);
    } finally {
      await fork.stop();
    }
  } finally {
    await backend.stop();
  }
});
