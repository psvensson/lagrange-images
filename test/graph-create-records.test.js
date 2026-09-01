import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {createRuntime} from '../src/runtime.js';
import {LagrangeBackend} from '../src/backend/index.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';
import {
  integerValue,
  objectRef,
  pinnedRef,
  textValue,
} from '../src/value/index.js';

// Atomic heterogeneous durable-record creation (bead lagrange-images-595):
// images.createRecords — ONE GraphImageService operation creating an insert-only
// batch of the existing record kinds in ONE image and ONE backend transaction,
// every record + its correct per-kind history event committing or none.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

// History EXCLUDING the image.created bootstrap event: the batch's own effect.
const historyOf = async (runtime, imageId) =>
  (await runtime.images.history(imageId)).filter((e) => e.type !== 'image.created');

test('MIXED BATCH: Shape + Object + CodeArtifact + LexicalEnvironment + Block in one call, all visible', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const stored = await runtime.images.createRecords('img', [
      {kind: 'shape', id: 'shape', slots: [{id: 'v', name: 'v'}]},
      {kind: 'object', id: 'obj', shape: objectRef('img', 'shape'), slots: {v: integerValue(1)}},
      {kind: 'code-artifact', id: 'code', representation: 'neutral-expression/v0', content: textValue('1')},
      {kind: 'lexical-environment', id: 'env', bindings: {}},
      {kind: 'block', id: 'block', code: objectRef('img', 'code'), environment: objectRef('img', 'env')},
    ]);
    assert.equal(stored.length, 5);
    assert.equal((await runtime.images.getShape('img', 'shape')).kind, 'shape');
    assert.equal((await runtime.images.getObject('img', 'obj')).kind, 'object');
    assert.equal((await runtime.images.getCodeArtifact('img', 'code')).kind, 'code-artifact');
    assert.equal((await runtime.images.getLexicalEnvironment('img', 'env')).kind, 'lexical-environment');
    assert.equal((await runtime.images.getBlock('img', 'block')).kind, 'block');
  });
});

test('FRESH SHAPE: Object references a Shape created in the SAME batch', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    // Existing-only resolution cannot see the fresh shape -> must succeed only via the overlay.
    const stored = await runtime.images.createRecords('img', [
      {kind: 'object', id: 'obj', shape: objectRef('img', 'fresh-shape'), slots: {v: integerValue(7)}},
      {kind: 'shape', id: 'fresh-shape', slots: [{id: 'v', name: 'v'}]},
    ]);
    assert.equal(stored.length, 2, 'object + its fresh-in-batch shape both committed');
    assert.equal((await runtime.images.getObject('img', 'obj')).shape.objectId, 'fresh-shape');
  });
});

test('FRESH BLOCK DEPENDENCIES: Block references CodeArtifact + LexicalEnvironment from the SAME batch', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const stored = await runtime.images.createRecords('img', [
      {kind: 'block', id: 'block', code: objectRef('img', 'code'), environment: objectRef('img', 'env')},
      {kind: 'code-artifact', id: 'code', representation: 'neutral-expression/v0', content: textValue('1')},
      {kind: 'lexical-environment', id: 'env', bindings: {}},
    ]);
    assert.equal(stored.length, 3);
    const block = await runtime.images.getBlock('img', 'block');
    assert.equal(block.code.objectId, 'code');
    assert.equal(block.environment.objectId, 'env');
  });
});

test('FRESH CODE DEPENDENCY: CodeArtifact dependency references another CodeArtifact from the SAME batch', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const stored = await runtime.images.createRecords('img', [
      {kind: 'code-artifact', id: 'top', representation: 'neutral-expression/v0', content: textValue('2'),
        dependencies: [{role: 'import', artifact: objectRef('img', 'base')}]},
      {kind: 'code-artifact', id: 'base', representation: 'neutral-expression/v0', content: textValue('1')},
    ]);
    assert.equal(stored.length, 2);
    assert.equal((await runtime.images.getCodeArtifact('img', 'top')).dependencies[0].artifact.objectId, 'base');
  });
});

test('ORDINARY OBJECT CYCLE: two fresh Objects reference one another', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const stored = await runtime.images.createRecords('img', [
      {kind: 'shape', id: 'shape', slots: [{id: 'v', name: 'v'}]},
      {kind: 'object', id: 'a', shape: objectRef('img', 'shape'), slots: {v: objectRef('img', 'b')}},
      {kind: 'object', id: 'b', shape: objectRef('img', 'shape'), slots: {v: objectRef('img', 'a')}},
    ]);
    assert.equal(stored.length, 3);
    assert.equal((await runtime.images.getObject('img', 'a')).slots.v.objectId, 'b');
    assert.equal((await runtime.images.getObject('img', 'b')).slots.v.objectId, 'a');
  });
});

test('WRONG KIND — OBJECT SHAPE: object shape resolves to a fresh non-Shape -> whole batch refused, zero state/history', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await assert.rejects(
      runtime.images.createRecords('img', [
        {kind: 'object', id: 'obj', shape: objectRef('img', 'not-a-shape'), slots: {}},
        {kind: 'code-artifact', id: 'not-a-shape', representation: 'neutral-expression/v0', content: textValue('1')},
      ]),
      /shape not found/,
    );
    assert.deepEqual(await runtime.images.listRecords('img'), [], 'zero records after refusal');
    assert.deepEqual(await historyOf(runtime, 'img'), [], 'zero history after refusal');
  });
});

test('WRONG KIND — BLOCK CODE: block code resolves to a Shape -> zero effect', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await assert.rejects(
      runtime.images.createRecords('img', [
        {kind: 'block', id: 'block', code: objectRef('img', 'shape'), environment: null},
        {kind: 'shape', id: 'shape', slots: []},
      ]),
      /block code must reference a code-artifact/,
    );
    assert.deepEqual(await runtime.images.listRecords('img'), []);
    assert.deepEqual(await historyOf(runtime, 'img'), []);
  });
});

test('WRONG KIND — LEXICAL PARENT: parent resolves to non-LexicalEnvironment -> zero effect', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await assert.rejects(
      runtime.images.createRecords('img', [
        {kind: 'lexical-environment', id: 'env', parent: objectRef('img', 'shape'), bindings: {}},
        {kind: 'shape', id: 'shape', slots: []},
      ]),
      /lexical environment parent must reference a lexical-environment/,
    );
    assert.deepEqual(await runtime.images.listRecords('img'), []);
    assert.deepEqual(await historyOf(runtime, 'img'), []);
  });
});

test('WRONG KIND — CODE DEPENDENCY: dependency resolves to non-CodeArtifact -> zero effect', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await assert.rejects(
      runtime.images.createRecords('img', [
        {kind: 'code-artifact', id: 'top', representation: 'neutral-expression/v0', content: textValue('1'),
          dependencies: [{role: 'import', artifact: objectRef('img', 'shape')}]},
        {kind: 'shape', id: 'shape', slots: []},
      ]),
      /must reference a code-artifact/,
    );
    assert.deepEqual(await runtime.images.listRecords('img'), []);
    assert.deepEqual(await historyOf(runtime, 'img'), []);
  });
});

test('MISSING REFERENCED RECORD: explicit failure before commit', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await assert.rejects(
      runtime.images.createRecords('img', [
        {kind: 'object', id: 'obj', shape: objectRef('img', 'ghost'), slots: {}},
      ]),
      /shape not found/,
    );
    assert.deepEqual(await runtime.images.listRecords('img'), []);
  });
});

test('DUPLICATE CANDIDATE ID: explicit failure before commit', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await assert.rejects(
      runtime.images.createRecords('img', [
        {kind: 'shape', id: 'dup', slots: []},
        {kind: 'shape', id: 'dup', slots: []},
      ]),
      /duplicate candidate id/,
    );
    assert.deepEqual(await runtime.images.listRecords('img'), []);
  });
});

test('PREEXISTING-ID COLLISION: expectedVersion:0 conflict aborts the WHOLE batch', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putShape('img', {id: 'existing', slots: []});
    const historyBefore = (await historyOf(runtime, 'img')).length;
    await assert.rejects(
      runtime.images.createRecords('img', [
        {kind: 'shape', id: 'fresh-ok', slots: []},
        {kind: 'shape', id: 'existing', slots: []}, // collides with the pre-existing record
      ]),
    );
    // no earlier members/history remain from the aborted batch
    const records = await runtime.images.listRecords('img');
    assert.equal(records.length, 1, 'only the pre-existing record remains');
    assert.equal(records[0].id, 'existing');
    assert.equal((await historyOf(runtime, 'img')).length, historyBefore, 'no new history events');
  });
});

test('INJECTED BACKEND FAILURE: fail after a transaction-local put -> zero new records/events outside the tx', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    // Wrap the backend so the SECOND transaction-local append throws, aborting the tx.
    const realTransaction = runtime.images.backend.transaction.bind(runtime.images.backend);
    let injected = false;
    runtime.images.backend.transaction = async (work) => await realTransaction(async (candidate) => {
      const realAppend = candidate.append.bind(candidate);
      let appends = 0;
      const wrapped = {
        ...candidate,
        put: candidate.put.bind(candidate),
        append: async (stream, event) => {
          appends += 1;
          if (appends === 2 && !injected) { injected = true; throw new Error('injected mid-batch failure'); }
          return realAppend(stream, event);
        },
      };
      return work(wrapped);
    });
    await assert.rejects(
      runtime.images.createRecords('img', [
        {kind: 'shape', id: 's1', slots: []},
        {kind: 'shape', id: 's2', slots: []},
        {kind: 'shape', id: 's3', slots: []},
      ]),
      /injected mid-batch failure/,
    );
    assert.deepEqual(await runtime.images.listRecords('img'), [], 'zero records after abort');
    assert.deepEqual(await historyOf(runtime, 'img'), [], 'zero events after abort');
  });
});

test('CORRECT HISTORY: mixed batch emits the existing per-kind event types, no generic record.put', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.createRecords('img', [
      {kind: 'shape', id: 'shape', slots: [{id: 'v', name: 'v'}]},
      {kind: 'object', id: 'obj', shape: objectRef('img', 'shape'), slots: {v: integerValue(1)}},
      {kind: 'code-artifact', id: 'code', representation: 'neutral-expression/v0', content: textValue('1')},
      {kind: 'lexical-environment', id: 'env', bindings: {}},
      {kind: 'block', id: 'block', code: objectRef('img', 'code'), environment: objectRef('img', 'env')},
    ]);
    const events = await historyOf(runtime, 'img');
    const types = events.map((e) => e.type);
    assert.ok(types.includes('shape.put'));
    assert.ok(types.includes('object.put'));
    assert.ok(types.includes('code-artifact.put'));
    assert.ok(types.includes('lexical-environment.put'));
    assert.ok(types.includes('block.put'));
    assert.ok(!types.includes('record.put'), 'no generic record.put event invented');
    // correct per-kind payload identity fields
    const byType = Object.fromEntries(events.map((e) => [e.type, e]));
    assert.equal(byType['shape.put'].shapeId, 'shape');
    assert.equal(byType['object.put'].objectId, 'obj');
    assert.equal(byType['code-artifact.put'].artifactId, 'code');
    assert.equal(byType['lexical-environment.put'].environmentId, 'env');
    assert.equal(byType['block.put'].blockId, 'block');
  });
});

test('FRONTIER: successful N-record batch advances Image frontier exactly N revisions', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const before = await runtime.images.frontier('img');
    await runtime.images.createRecords('img', [
      {kind: 'shape', id: 'shape', slots: [{id: 'v', name: 'v'}]},
      {kind: 'object', id: 'obj', shape: objectRef('img', 'shape'), slots: {v: integerValue(1)}},
      {kind: 'code-artifact', id: 'code', representation: 'neutral-expression/v0', content: textValue('1')},
    ]);
    const after = await runtime.images.frontier('img');
    assert.equal(Number(after) - Number(before), 3, 'one revision per record event');
  });
});

test('TRANSIENT REF: any transient ref in any record kind refuses the WHOLE batch', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putShape('img', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    // A transient id (reserved namespace) in a slot ref must refuse the whole batch.
    const transientId = '~runtime/transient/abc';
    await assert.rejects(
      runtime.images.createRecords('img', [
        {kind: 'shape', id: 's2', slots: []},
        {kind: 'object', id: 'obj', shape: objectRef('img', 'shape'), slots: {v: objectRef('img', transientId)}},
      ]),
    );
    assert.equal((await runtime.images.listRecords('img')).length, 1, 'only the pre-existing shape remains');
  });
});

test('NO AUTHORITY: createRecords issues/checks no grants and creates no authority state', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    // The substrate operation takes no authority/context argument and touches no authority service.
    const stored = await runtime.images.createRecords('img', [
      {kind: 'shape', id: 'shape', slots: []},
    ]);
    assert.equal(stored.length, 1);
    assert.equal(typeof runtime.images.createRecords, 'function');
    // signature takes (imageId, inputs) only — no authority parameter
    assert.ok(runtime.images.createRecords.length <= 2);
  });
});

test('putObjects COMPATIBILITY: generic-object batch remains atomic and semantically equivalent', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putShape('img', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    const stored = await runtime.images.putObjects('img', [
      {id: 'o1', shape: objectRef('img', 'shape'), slots: {v: integerValue(1)}},
      {id: 'o2', shape: objectRef('img', 'shape'), slots: {v: integerValue(2)}},
    ]);
    assert.equal(stored.length, 2);
    const events = (await historyOf(runtime, 'img')).filter((e) => e.type === 'object.put');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.objectId).sort(), ['o1', 'o2']);
  });
});

test('SINGLE-PUT COMPATIBILITY: per-kind single puts keep behavior + event contracts', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putShape('img', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject('img', {id: 'obj', shape: objectRef('img', 'shape'), slots: {v: integerValue(1)}});
    await runtime.images.putCodeArtifact('img', {id: 'code', representation: 'neutral-expression/v0', content: textValue('1')});
    await runtime.images.putLexicalEnvironment('img', {id: 'env', bindings: {}});
    await runtime.images.putBlock('img', {id: 'block', code: objectRef('img', 'code'), environment: objectRef('img', 'env')});
    const types = (await historyOf(runtime, 'img')).map((e) => e.type);
    for (const expected of ['shape.put', 'object.put', 'code-artifact.put', 'lexical-environment.put', 'block.put']) {
      assert.ok(types.includes(expected), `single put emits ${expected}`);
    }
  });
});

test('RESTART: real Lagrange backend restart preserves the complete mixed batch and all graph edges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-create-records-'));
  const filename = join(directory, 'image.sqlite');
  try {
    const firstBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await firstBackend.start();
    const first = new ImageService({backend: firstBackend, clock: () => new Date('2026-09-01T00:00:00.000Z')});
    await first.createImage({id: 'img'});
    await first.createRecords('img', [
      {kind: 'shape', id: 'shape', slots: [{id: 'v', name: 'v'}]},
      {kind: 'object', id: 'obj', shape: objectRef('img', 'shape'), slots: {v: objectRef('img', 'child')}},
      {kind: 'object', id: 'child', shape: objectRef('img', 'shape'), slots: {v: integerValue(7)}},
      {kind: 'code-artifact', id: 'code', representation: 'neutral-expression/v0', content: textValue('1')},
      {kind: 'lexical-environment', id: 'env', bindings: {}},
      {kind: 'block', id: 'block', code: objectRef('img', 'code'), environment: objectRef('img', 'env')},
    ]);
    await firstBackend.stop();

    const secondBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await secondBackend.start();
    try {
      const second = new ImageService({backend: secondBackend});
      assert.equal((await second.getShape('img', 'shape')).kind, 'shape');
      assert.equal((await second.getObject('img', 'obj')).slots.v.objectId, 'child');
      assert.equal((await second.getObject('img', 'child')).slots.v.value, '7');
      assert.equal((await second.getBlock('img', 'block')).code.objectId, 'code');
      assert.equal((await second.getBlock('img', 'block')).environment.objectId, 'env');
      const types = (await second.history('img')).map((e) => e.type);
      for (const expected of ['shape.put', 'object.put', 'code-artifact.put', 'lexical-environment.put', 'block.put']) {
        assert.ok(types.includes(expected), `restart preserves ${expected}`);
      }
    } finally {
      await secondBackend.stop();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
