import test from 'node:test';
import assert from 'node:assert/strict';
import {MockBackend, VersionConflictError} from '../src/backend/index.js';

test('mock backend provides optimistic versions', async () => {
  const backend = new MockBackend();
  await backend.start();

  const first = await backend.put('things', 'one', {value: 1}, {expectedVersion: 0});
  assert.equal(first._version, 1);

  await assert.rejects(
    backend.put('things', 'one', {value: 2}, {expectedVersion: 0}),
    VersionConflictError,
  );

  const second = await backend.put('things', 'one', {value: 2}, {expectedVersion: 1});
  assert.equal(second._version, 2);
  assert.equal((await backend.get('things', 'one')).value, 2);
});
