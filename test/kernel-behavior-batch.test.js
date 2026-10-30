import test from 'node:test';
import assert from 'node:assert/strict';
import {MockBackend} from '../src/backend/mock-backend.js';
import {VersionConflictError} from '../src/backend/backend-contract.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {ensureObjects, RecordConflictError} from '../src/graph/ensure-records.js';
import {installSmalltalkKernel, findSmalltalkKernel, SMALLTALK_KERNEL_OBJECT_ID, SmalltalkKernelConflictError} from '../src/language/smalltalk-kernel.js';
import {objectRef} from '../src/value/index.js';

// Mock storage proves API atomicity/convergence, not native crash durability.
async function withImage(body) {
  const backend = new MockBackend({integration: {selectedBy: 'explicit'}});
  await backend.start();
  const images = new ImageService({backend, clock: () => new Date('2026-10-30T00:00:00Z')});
  try {
    await images.createImage({id: 'boot'});
    return await body(images, backend);
  } finally {
    await backend.stop();
  }
}

function adapted(images, overrides) {
  return new Proxy(images, {get(target, property) {
    if (Object.hasOwn(overrides, property)) return overrides[property];
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}

const records = async (images) => (await images.listRecords('boot')).sort((a, b) => a.id.localeCompare(b.id));
const conflict = () => new VersionConflictError({collection: 'records', key: 'a', expectedVersion: 0, actualVersion: 1});
async function pair(images) {
  await images.putShape('boot', {id: 's', slots: []});
  return ['a', 'b'].map((id) => ({id, shape: objectRef('boot', 's'), slots: {}, metadata: {owner: 'test'}}));
}

test('fresh kernel uses two 22-record phases: same graph/history as sequential publication, ten transactions', async () => {
  await withImage(async (images, backend) => {
    let transactions = 0;
    const transaction = backend.transaction.bind(backend);
    backend.transaction = async (...args) => { transactions += 1; return await transaction(...args); };
    const batches = [];
    const observed = adapted(images, {createRecords: async (imageId, inputs) => {
      batches.push(inputs.map(({id}) => id));
      return await images.createRecords(imageId, inputs);
    }});
    await installSmalltalkKernel({images: observed, imageId: 'boot'});
    assert.equal(transactions, 10);
    assert.deepEqual(batches.map((ids) => ids.length), [22, 22]);
    assert.ok(batches[0].every((id) => id.startsWith('smalltalk/metaclass/')));
    assert.ok(batches[1].every((id) => id.startsWith('smalltalk/class/')));
    const actual = await records(images);
    assert.equal(actual.length, 52);
    assert.ok(actual.every((record) => record._version === 1));
    const history = await images.history('boot');
    assert.equal(history.length, 53, 'image.created plus 52 kernel record events');
    await withImage(async (sequential, sequentialBackend) => {
      let oracleTransactions = 0;
      const oracleTransaction = sequentialBackend.transaction.bind(sequentialBackend);
      sequentialBackend.transaction = async (...args) => { oracleTransactions += 1; return await oracleTransaction(...args); };
      const oracle = adapted(sequential, {createRecords: async (imageId, inputs) => {
        const stored = [];
        for (const {kind, ...input} of inputs) {
          assert.equal(kind, 'object');
          stored.push(await sequential.putObject(imageId, input, {expectedVersion: 0}));
        }
        return stored;
      }});
      await installSmalltalkKernel({images: oracle, imageId: 'boot'});
      assert.equal(oracleTransactions, 52);
      assert.deepEqual(await records(sequential), actual);
      assert.deepEqual(await sequential.history('boot'), history);
    });
    const after = transactions;
    await installSmalltalkKernel({images, imageId: 'boot'});
    assert.equal(transactions, after, 'exact replay publishes no transaction');
    assert.deepEqual(await records(images), actual);
    assert.deepEqual(await images.history('boot'), history);
    assert.ok(await findSmalltalkKernel({images, imageId: 'boot'}));
  });
});

test('old partial Behavior graph and valid legacy dictionary survive explicit retry unchanged', async () => {
  await withImage(async (images) => {
    const failure = new Error('old partial installation');
    const old = adapted(images, {createRecords: async (imageId, inputs) => {
      for (const {kind, ...input} of inputs.slice(0, 2)) {
        assert.equal(kind, 'object');
        await images.putObject(imageId, input, {expectedVersion: 0});
      }
      const dictionary = inputs.find((input, index) => index > 1 && input.id.endsWith('/methods'));
      assert.ok(dictionary);
      await images.putObject(imageId, {
        id: dictionary.id, shape: objectRef(imageId, 'smalltalk/empty-shape/v1'),
        slots: {}, metadata: {smalltalk: 'method-dictionary'},
      }, {expectedVersion: 0});
      throw failure;
    }});
    await assert.rejects(installSmalltalkKernel({images: old, imageId: 'boot'}), (error) => error === failure);
    assert.equal(await images.getObject('boot', SMALLTALK_KERNEL_OBJECT_ID), null);
    const before = await records(images);
    const history = await images.history('boot');
    await installSmalltalkKernel({images, imageId: 'boot'});
    for (const record of before) assert.deepEqual(await images.getRecord('boot', record.id), record);
    assert.deepEqual((await images.history('boot')).slice(0, history.length), history);
    assert.equal((await records(images)).length, 52);
    assert.ok(await findSmalltalkKernel({images, imageId: 'boot'}));
  });
});

test('object batch rejects duplicate ids before reading or publishing', async () => {
  let effects = 0;
  const images = {getRecord: async () => { effects += 1; }, createRecords: async () => { effects += 1; }};
  await assert.rejects(ensureObjects(images, 'boot', [{id: 'a'}, {id: 'a'}]), TypeError);
  assert.equal(effects, 0);
});

for (const occupant of ['wrong-kind', 'divergent']) {
  test(`object batch refuses ${occupant} before writing any missing member`, async () => {
    await withImage(async (images) => {
      const desired = await pair(images);
      if (occupant === 'wrong-kind') await images.putShape('boot', {id: 'b', slots: []});
      else await images.putObject('boot', {...desired[1], metadata: {intruder: true}}, {expectedVersion: 0});
      const before = await records(images);
      const history = await images.history('boot');
      await assert.rejects(ensureObjects(images, 'boot', desired), RecordConflictError);
      assert.deepEqual(await records(images), before);
      assert.deepEqual(await images.history('boot'), history);
      assert.equal((await images.getRecord('boot', 'a')) ?? null, null);
    });
  });
}

test('foreign named CAS with a strictly smaller missing set retries only the remaining members', async () => {
  await withImage(async (images) => {
    const desired = await pair(images);
    const calls = [];
    const race = adapted(images, {createRecords: async (imageId, inputs) => {
      calls.push(inputs.map(({id}) => id));
      if (calls.length === 1) {
        await images.createRecords(imageId, [inputs[0]]);
        throw Object.assign(new Error('foreign backend CAS'), {name: 'VersionConflictError'});
      }
      return await images.createRecords(imageId, inputs);
    }});
    const result = await ensureObjects(race, 'boot', desired);
    assert.deepEqual(calls, [['a', 'b'], ['b']]);
    assert.deepEqual(result.map(({id, _version}) => [id, _version]), [['a', 1], ['b', 1]]);
    const history = await images.history('boot');
    await ensureObjects(images, 'boot', desired);
    assert.deepEqual(await images.history('boot'), history);
  });
});

test('typed CAS without authoritative progress rethrows the original error without spinning', async () => {
  await withImage(async (images) => {
    const desired = await pair(images);
    const original = conflict();
    let calls = 0;
    const race = adapted(images, {createRecords: async () => { calls += 1; throw original; }});
    await assert.rejects(ensureObjects(race, 'boot', desired), (error) => error === original);
    assert.equal(calls, 1);
    assert.equal((await images.getRecord('boot', 'a')) ?? null, null);
  });
});

test('typed CAS rereads a divergent winner and refuses it without writing another member', async () => {
  await withImage(async (images) => {
    const desired = await pair(images);
    let calls = 0;
    const race = adapted(images, {createRecords: async () => {
      calls += 1;
      await images.putObject('boot', {...desired[0], metadata: {intruder: true}}, {expectedVersion: 0});
      throw conflict();
    }});
    await assert.rejects(ensureObjects(race, 'boot', desired), RecordConflictError);
    assert.equal(calls, 1);
    assert.equal((await images.getObject('boot', 'a')).metadata.intruder, true);
    assert.equal((await images.getRecord('boot', 'b')) ?? null, null);
  });
});

for (const phase of [1, 2]) {
  for (const committed of [false, true]) {
    test(`kernel phase ${phase} ${committed ? 'lost acknowledgment' : 'rollback'} preserves original error and recovers on explicit retry`, async () => {
      await withImage(async (images, backend) => {
        const original = new Error(committed ? 'lost acknowledgment' : 'failed scoped append');
        let prefix;
        let calls = 0;
        const fault = adapted(images, {createRecords: async (imageId, inputs) => {
          assert.equal(inputs.length, 22);
          if (++calls !== phase) return await images.createRecords(imageId, inputs);
          prefix = await images.history(imageId);
          if (committed) {
            await images.createRecords(imageId, inputs);
            throw original;
          }
          const transaction = backend.transaction.bind(backend);
          backend.transaction = async (work) => await transaction(async (tx) => {
            let appends = 0;
            const scoped = {...tx, append: async (...args) => {
              if (++appends === 2) throw original;
              return await tx.append(...args);
            }};
            return await work(scoped);
          });
          try { return await images.createRecords(imageId, inputs); }
          finally { backend.transaction = transaction; }
        }});
        await assert.rejects(installSmalltalkKernel({images: fault, imageId: 'boot'}), (error) => error === original);
        assert.equal(calls, phase);
        assert.equal((await images.getRecord('boot', SMALLTALK_KERNEL_OBJECT_ID)) ?? null, null);
        const expectedRecords = 7 + 22 * (phase - 1 + Number(committed));
        assert.equal((await records(images)).length, expectedRecords);
        if (!committed) assert.deepEqual(await images.history('boot'), prefix, 'failed phase records and events roll back together');
        const before = await records(images);
        const beforeHistory = await images.history('boot');
        assert.equal(beforeHistory.length, expectedRecords + 1);
        await installSmalltalkKernel({images, imageId: 'boot'});
        assert.equal((await records(images)).length, 52);
        for (const record of before) assert.deepEqual(await images.getRecord('boot', record.id), record);
        const afterHistory = await images.history('boot');
        assert.deepEqual(afterHistory.slice(0, beforeHistory.length), beforeHistory, 'all committed phase history is preserved');
        assert.equal(afterHistory.length, 53);
        assert.ok(await findSmalltalkKernel({images, imageId: 'boot'}));
      });
    });
  }
}

test('class-phase divergent occupant preserves the committed metaclass phase and refuses remaining class writes', async () => {
  await withImage(async (images) => {
    let batches = 0;
    let metaclasses;
    let history;
    const race = adapted(images, {createRecords: async (imageId, inputs) => {
      batches += 1;
      assert.equal(batches, 1, 'class preflight must refuse before a second batch');
      const result = await images.createRecords(imageId, inputs);
      metaclasses = await records(images);
      assert.equal(metaclasses.length, 29);
      const {shape, behavior, slots} = await images.getObject(imageId, 'smalltalk/metaclass/Object');
      await images.putObject(imageId, {shape, behavior, slots, id: 'smalltalk/class/Object', metadata: {intruder: true}}, {expectedVersion: 0});
      history = await images.history(imageId);
      return result;
    }});
    await assert.rejects(installSmalltalkKernel({images: race, imageId: 'boot'}), SmalltalkKernelConflictError);
    assert.equal(batches, 1);
    for (const record of metaclasses) assert.deepEqual(await images.getRecord('boot', record.id), record);
    assert.deepEqual(await images.history('boot'), history);
    assert.equal((await records(images)).length, 30);
    assert.equal((await images.getObject('boot', 'smalltalk/class/Object')).metadata.intruder, true);
    assert.equal((await images.getRecord('boot', 'smalltalk/class/Object/methods')) ?? null, null);
    assert.equal((await images.getRecord('boot', SMALLTALK_KERNEL_OBJECT_ID)) ?? null, null);
  });
});

for (const missing of ['getRecord', 'createRecords']) {
  test(`kernel requires ${missing} before its first write`, async () => {
    await withImage(async (images, backend) => {
      const transaction = backend.transaction.bind(backend);
      let writes = 0;
      backend.transaction = async (...args) => { writes += 1; return await transaction(...args); };
      await assert.rejects(installSmalltalkKernel({images: adapted(images, {[missing]: undefined}), imageId: 'boot'}), TypeError);
      assert.equal(writes, 0);
      assert.equal((await records(images)).length, 0);
    });
  });
}

test('foreign named CAS without missing-set progress preserves the original error', async () => {
  await withImage(async (images) => {
    const desired = await pair(images);
    const original = Object.assign(new Error('transport failure'), {name: 'VersionConflictError'});
    let calls = 0;
    const broken = adapted(images, {createRecords: async () => { calls += 1; throw original; }});
    await assert.rejects(ensureObjects(broken, 'boot', desired), (error) => error === original);
    assert.equal(calls, 1);
  });
});
