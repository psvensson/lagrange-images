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

// A transaction draft copies the committed state's STRUCTURE (buckets, event arrays) and shares
// its stored values, which are never mutated in place: `put`/`append` store freshly built objects
// and every read answers a clone. These are the two proofs that make the sharing legal — a
// rolled-back draft leaves the committed state exactly as it was, and a value read inside a
// transaction is a detached copy whose mutation reaches neither the draft nor the base.
test('a rolled-back draft leaves committed records, versions and streams untouched, and reads are detached copies', async () => {
  const backend = new MockBackend();
  await backend.start();
  try {
    await backend.put('things', 'one', {value: {nested: 1}}, {expectedVersion: 0});
    await backend.append('events', {happened: 'first'});
    const recordBefore = await backend.get('things', 'one');
    const streamBefore = await backend.readStream('events');

    await assert.rejects(backend.transaction(async (transaction) => {
      const read = await transaction.get('things', 'one');
      read.value.nested = 99;
      assert.deepEqual(await transaction.get('things', 'one'), recordBefore, 'a read is a detached copy');
      await transaction.put('things', 'one', {value: {nested: 2}}, {expectedVersion: 1});
      await transaction.put('things', 'two', {value: 2}, {expectedVersion: 0});
      await transaction.append('events', {happened: 'second'});
      assert.equal((await transaction.get('things', 'one'))._version, 2, 'the draft sees its own write');
      assert.equal(await transaction.streamHead('events'), 2, 'the draft sees its own append');
      throw new Error('abandon this draft');
    }), /abandon this draft/);

    assert.deepEqual(await backend.get('things', 'one'), recordBefore, 'the committed record is untouched');
    assert.equal(await backend.get('things', 'two'), undefined, 'the draft-only record never landed');
    assert.deepEqual(await backend.scan('things'), [{key: 'one', value: recordBefore}]);
    assert.deepEqual(await backend.readStream('events'), streamBefore, 'the committed stream is untouched');
    assert.equal(await backend.streamHead('events'), 1);

    // The base still commits normally afterwards, from the untouched version.
    await backend.put('things', 'one', {value: {nested: 3}}, {expectedVersion: 1});
    assert.equal((await backend.get('things', 'one'))._version, 2);
  } finally {
    await backend.stop();
  }
});
