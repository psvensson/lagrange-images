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
