import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtimeApi from '../src/runtime.js';
import * as languageApi from '../src/language/index.js';
import {MockBackend} from '../src/backend/mock-backend.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {defineClass, ensureNamedClass} from '../src/language/smalltalk-class-builder.js';
import {
  BEHAVIOR_SHAPE_ID, SmalltalkKernelConflictError, installSmalltalkKernel,
  findSmalltalkKernel, ensureEmptyMethodDictionary, ensureEmptyMethodDictionaryAndBehavior,
} from '../src/language/smalltalk-kernel.js';
import {objectRef, textValue} from '../src/value/index.js';
import {METHOD_DICTIONARY_SHAPE_ID} from '../src/language/smalltalk-method-dictionary.js';

const imageId = 'app';
const classId = 'smalltalk/class/Paired';
const metaId = 'smalltalk/metaclass/Paired';
const pairIds = [metaId + '/methods', metaId, classId + '/methods', classId];
const snapshot = async (images) => (await images.listRecords(imageId)).sort((a, b) => a.id.localeCompare(b.id));
function adapted(images, overrides) {
  return new Proxy(images, {get(target, property) {
    if (Object.hasOwn(overrides, property)) return overrides[property];
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}

// API atomicity/recovery on MockBackend is not native crash-durability proof.
async function withKernel(body) {
  const backend = new MockBackend({integration: {selectedBy: 'explicit'}});
  await backend.start();
  const images = new ImageService({backend, clock: () => new Date('2026-10-30T00:00:00Z')});
  try {
    await images.createImage({id: imageId});
    await installSmalltalkKernel({images, imageId});
    return await body(images, backend, await findSmalltalkKernel({images, imageId}));
  } finally { await backend.stop(); }
}

function desiredBehavior(kernel) {
  return {
    id: metaId, shape: objectRef(imageId, BEHAVIOR_SHAPE_ID), behavior: kernel.metaclassClass,
    slots: {
      'behavior-name': textValue('Paired class'), 'behavior-superclass': kernel.classClass,
      'behavior-methods': objectRef(imageId, metaId + '/methods'), 'behavior-instance-shape': kernel.nil,
    },
    metadata: {smalltalk: 'behavior', name: 'Paired class'},
  };
}

test('fresh class uses ordered dictionary/Behavior pairs with the full sequential graph/history oracle', async () => {
  await withKernel(async (images, backend) => {
    const batches = [];
    const transactions = [];
    const transaction = backend.transaction.bind(backend);
    backend.transaction = async (work) => {
      const ids = [];
      const result = await transaction(async (tx) => await work({...tx, put: async (...args) => {
        if (pairIds.includes(args[1])) ids.push(args[1]);
        return await tx.put(...args);
      }}));
      if (ids.length) transactions.push(ids);
      return result;
    };
    const observed = adapted(images, {createRecords: async (id, inputs) => {
      batches.push(inputs.map(({id}) => id));
      return await images.createRecords(id, inputs);
    }});
    const created = await defineClass({images: observed, imageId, name: 'Paired'});
    assert.deepEqual(batches, [pairIds.slice(0, 2), pairIds.slice(2)]);
    assert.deepEqual(transactions, batches, 'the four records commit in two transactions');
    const records = await snapshot(images);
    const history = await images.history(imageId);
    const creationEvents = history.filter((event) => pairIds.includes(event.object?.id));
    assert.deepEqual(creationEvents.map((event) => event.object.id), pairIds);
    await withKernel(async (sequential) => {
      const oracle = adapted(sequential, {createRecords: async (id, inputs) => {
        const result = [];
        for (const {kind, ...input} of inputs) {
          assert.equal(kind, 'object');
          result.push(await sequential.putObject(id, input, {expectedVersion: 0}));
        }
        return result;
      }});
      assert.deepEqual(await defineClass({images: oracle, imageId, name: 'Paired'}), created);
      assert.deepEqual(await snapshot(sequential), records);
      assert.deepEqual(await sequential.history(imageId), history);
    });
    await ensureNamedClass({images: observed, imageId, name: 'Paired'});
    assert.equal(batches.length, 2, 'rediscovery publishes no pair');
    assert.deepEqual(await snapshot(images), records);
    assert.deepEqual(await images.history(imageId), history);
  });
});

test('the named pair export is intentional and the old five-argument helper needs no batch capability', async () => {
  assert.equal(runtimeApi.ensureEmptyMethodDictionaryAndBehavior, ensureEmptyMethodDictionaryAndBehavior);
  assert.equal(languageApi.ensureEmptyMethodDictionaryAndBehavior, ensureEmptyMethodDictionaryAndBehavior);
  assert.equal(runtimeApi.ensureEmptyMethodDictionary, ensureEmptyMethodDictionary);
  assert.equal(languageApi.ensureEmptyMethodDictionary, ensureEmptyMethodDictionary);
  assert.equal(Object.hasOwn(languageApi, 'emptyMethodDictionaryRequest'), false);
  let writes = 0;
  const service = {
    getObject: async () => null,
    putObject: async (id, desired) => { writes += 1; return {...desired, imageId: id, kind: 'object', _version: 1}; },
  };
  const dictionary = await ensureEmptyMethodDictionary(service, imageId, metaId + '/methods', {owner: metaId}, objectRef(imageId, 'smalltalk/nil'));
  assert.equal(dictionary.id, metaId + '/methods');
  assert.equal(dictionary._version, 1);
  assert.equal(writes, 1);
});

test('the paired API returns its durable dictionary/Behavior envelope and replays without writes', async () => {
  await withKernel(async (images, _backend, kernel) => {
    const options = {behavior: desiredBehavior(kernel), nilRef: kernel.nil};
    const result = await ensureEmptyMethodDictionaryAndBehavior(images, imageId, options);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(result.dictionary, await images.getObject(imageId, metaId + '/methods'));
    assert.deepEqual(result.behavior, await images.getObject(imageId, metaId));
    assert.deepEqual(result.dictionary.metadata, {smalltalk: 'method-dictionary', owner: metaId});
    assert.equal(result.dictionary._version, 1);
    assert.equal(result.behavior._version, 1);
    const history = await images.history(imageId);
    assert.deepEqual(await ensureEmptyMethodDictionaryAndBehavior(images, imageId, options), result);
    assert.deepEqual(await images.history(imageId), history);
  });
});

test('the paired API returns both durable records and excludes an adopted legacy dictionary from the missing batch', async () => {
  await withKernel(async (images, _backend, kernel) => {
    await images.putShape(imageId, {id: 'legacy-pair-shape', slots: [{id: 'method:x', name: 'x'}]});
    const code = await images.putCodeArtifact(imageId, {id: 'legacy-code', representation: 'test/v1', content: textValue('x')});
    await images.putBlock(imageId, {id: 'legacy-block', code: objectRef(imageId, code.id), environment: null});
    const legacy = await images.putObject(imageId, {
      id: metaId + '/methods', shape: objectRef(imageId, 'legacy-pair-shape'),
      slots: {'method:x': objectRef(imageId, 'legacy-block')}, metadata: {smalltalk: 'method-dictionary'},
    }, {expectedVersion: 0});
    const before = await images.history(imageId);
    const batches = [];
    const observed = adapted(images, {createRecords: async (id, inputs) => {
      batches.push(inputs.map(({id}) => id));
      return await images.createRecords(id, inputs);
    }});
    const result = await ensureEmptyMethodDictionaryAndBehavior(observed, imageId, {behavior: desiredBehavior(kernel), nilRef: kernel.nil});
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(result.dictionary, legacy);
    assert.deepEqual(result.behavior, await images.getObject(imageId, metaId));
    assert.deepEqual(batches, [[metaId]], 'existing legacy record is outside the newly atomic subset');
    assert.deepEqual(await ensureEmptyMethodDictionary(images, imageId, legacy.id, {owner: metaId}, kernel.nil), legacy);
    assert.deepEqual((await images.history(imageId)).slice(0, before.length), before);
    assert.deepEqual(await images.getObject(imageId, legacy.id), legacy);
  });
});

for (const prefixLength of [1, 2]) {
  test(`old ${prefixLength === 1 ? 'dictionary-only' : 'metaclass-only'} prefix recovers without rewriting committed state`, async () => {
    await withKernel(async (images) => {
      const original = new Error('older interrupted class installer');
      const old = adapted(images, {createRecords: async (id, inputs) => {
        for (const {kind, ...input} of inputs.slice(0, prefixLength)) {
          assert.equal(kind, 'object');
          await images.putObject(id, input, {expectedVersion: 0});
        }
        throw original;
      }});
      await assert.rejects(defineClass({images: old, imageId, name: 'Paired'}), (error) => error === original);
      const before = await snapshot(images);
      const history = await images.history(imageId);
      await ensureNamedClass({images, imageId, name: 'Paired'});
      for (const record of before) assert.deepEqual(await images.getRecord(imageId, record.id), record);
      assert.deepEqual((await images.history(imageId)).slice(0, history.length), history);
      for (const id of pairIds) assert.equal((await images.getObject(imageId, id))._version, 1);
    });
  });
}

for (const phase of [1, 2]) {
  for (const committed of [false, true]) {
    test(`class pair ${phase} ${committed ? 'lost acknowledgment' : 'inner second-event rollback'} preserves error and explicit recovery`, async () => {
      await withKernel(async (images, backend) => {
        const original = new Error('pair failure');
        let calls = 0;
        const fault = adapted(images, {createRecords: async (id, inputs) => {
          assert.equal(inputs.length, 2);
          if (++calls !== phase) return await images.createRecords(id, inputs);
          if (committed) {
            await images.createRecords(id, inputs);
            throw original;
          }
          const transaction = backend.transaction.bind(backend);
          backend.transaction = async (work) => await transaction(async (tx) => {
            let appends = 0;
            return await work({...tx, append: async (...args) => {
              if (++appends === 2) throw original;
              return await tx.append(...args);
            }});
          });
          try { return await images.createRecords(id, inputs); }
          finally { backend.transaction = transaction; }
        }});
        await assert.rejects(defineClass({images: fault, imageId, name: 'Paired'}), (error) => error === original);
        const before = await snapshot(images);
        const history = await images.history(imageId);
        const admitted = 2 * (phase - 1 + Number(committed));
        assert.equal(calls, phase);
        assert.equal(before.length, 52 + admitted);
        assert.equal(history.length, 53 + admitted, 'failed pair leaks no record or event');
        for (const [index, id] of pairIds.entries()) {
          assert.equal(Boolean(await images.getObject(imageId, id)), index < admitted);
        }
        await ensureNamedClass({images, imageId, name: 'Paired'});
        for (const record of before) assert.deepEqual(await images.getRecord(imageId, record.id), record);
        assert.deepEqual((await images.history(imageId)).slice(0, history.length), history);
        for (const id of pairIds) assert.equal((await images.getObject(imageId, id))._version, 1);
      });
    });
  }
}

test('class-pair wrong-kind refusal leaves the committed metaclass pair and winner untouched', async () => {
  await withKernel(async (images) => {
    let calls = 0;
    let before;
    let history;
    const race = adapted(images, {createRecords: async (id, inputs) => {
      assert.equal(++calls, 1, 'class pair must refuse before publishing its missing dictionary');
      const result = await images.createRecords(id, inputs);
      await images.putShape(id, {id: classId, slots: []});
      before = await snapshot(images);
      history = await images.history(id);
      return result;
    }});
    await assert.rejects(defineClass({images: race, imageId, name: 'Paired'}), SmalltalkKernelConflictError);
    assert.equal(calls, 1);
    assert.deepEqual(await snapshot(images), before);
    assert.deepEqual(await images.history(imageId), history);
    assert.equal((await images.getRecord(imageId, classId + '/methods')) ?? null, null);
    assert.equal((await images.getRecord(imageId, classId)).kind, 'shape');
  });
});

for (const defect of ['shape', 'methods-edge']) {
  test(`paired API refuses an invalid local ${defect} before any write`, async () => {
    await withKernel(async (images, _backend, kernel) => {
      const behavior = desiredBehavior(kernel);
      if (defect === 'shape') {
        await images.createImage({id: 'foreign'});
        const shape = await images.getShape(imageId, BEHAVIOR_SHAPE_ID);
        await images.putShape('foreign', {id: BEHAVIOR_SHAPE_ID, slots: shape.slots});
        behavior.shape = objectRef('foreign', BEHAVIOR_SHAPE_ID);
      } else behavior.slots['behavior-methods'] = objectRef(imageId, 'other-dictionary');
      const before = await images.history(imageId);
      await assert.rejects(ensureEmptyMethodDictionaryAndBehavior(images, imageId, {behavior, nilRef: kernel.nil}), TypeError);
      assert.deepEqual(await images.history(imageId), before);
      assert.equal((await images.getRecord(imageId, metaId)) ?? null, null);
    });
  });
}

for (const missing of ['getRecord', 'createRecords']) {
  test(`defineClass checks ${missing} before its first definition write`, async () => {
    await withKernel(async (images, backend) => {
      const transaction = backend.transaction.bind(backend);
      let writes = 0;
      backend.transaction = async (...args) => { writes += 1; return await transaction(...args); };
      const before = await images.history(imageId);
      // Make dictionary-shape admission appear necessary: a misplaced capability guard must not
      // get credit merely because the prepared kernel would otherwise make that ensure a no-op.
      let shapeWrites = 0;
      const overrides = {
        getRecord: async (id, key) => key === METHOD_DICTIONARY_SHAPE_ID ? null : await images.getRecord(id, key),
        getShape: async (id, key) => key === METHOD_DICTIONARY_SHAPE_ID ? null : await images.getShape(id, key),
        putShape: async (...args) => { shapeWrites += 1; return await images.putShape(...args); },
        [missing]: undefined,
      };
      await assert.rejects(defineClass({images: adapted(images, overrides), imageId, name: 'Paired'}), TypeError);
      assert.equal(writes, 0);
      assert.equal(shapeWrites, 0, 'capability refusal precedes even dictionary-shape admission');
      assert.deepEqual(await images.history(imageId), before);
    });
  });
}
