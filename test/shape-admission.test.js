// Shape admission (bead lagrange-images-ea8). The lower creation owner, ImageService.putShape, is
// insert-only inside one backend transaction, so a Shape can never be overwritten or half-written.
// The race lives above it: an ensure-style caller reads "absent" then inserts, and two such callers
// on a fresh image both insert — one wins the CAS, the other must CONVERGE on the winner's record
// rather than fail or diverge. This file is the deterministic falsifier: with the mock backend both
// contenders complete their existence read before either insert.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECT_SHAPE_ID, createProject, createProjectId, createRuntime, readProjectDescriptor} from '../src/runtime.js';

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'img'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

test('SYMPTOM: two concurrent first createProject calls on a fresh image both succeed and converge on one Shape set', async () => {
  await withRuntime(async (runtime) => {
    const a = createProjectId();
    const b = createProjectId();
    const [refA, refB] = await Promise.all([
      createProject({images: runtime.images, imageId: 'img', projectId: a, name: 'A'}),
      createProject({images: runtime.images, imageId: 'img', projectId: b, name: 'B'}),
    ]);
    assert.equal(refA.objectId, `project/${a}`);
    assert.equal(refB.objectId, `project/${b}`);
    const shapes = await runtime.images.listShapes('img');
    const projectShapes = shapes.filter((s) => s.id === PROJECT_SHAPE_ID);
    assert.equal(projectShapes.length, 1, 'exactly one Project Shape');
    assert.equal(projectShapes[0]._version, 1, 'the Shape was inserted exactly once (no overwrite, no second version)');
    assert.equal((await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId: a})).name, 'A');
    assert.equal((await readProjectDescriptor({images: runtime.images, imageId: 'img', projectId: b})).name, 'B');
  });
});

// ---- The owner-level falsifiers (graph/ensure-records.js ensureShape / ensureRecord) -----------
import {ensureObject, ensureShape, RecordConflictError} from '../src/graph/ensure-records.js';
import {SHAPE_INDEXED, objectRef, textValue} from '../src/runtime.js';

const LAYOUT = Object.freeze({id: 'shape/ea8', slots: [{id: 'a', name: 'a'}, {id: 'b', name: 'b'}], indexed: SHAPE_INDEXED.VALUES});

// Two contenders whose existence reads both complete before either insert. `holdRead` lets a test
// choose which contender's insert goes second, so scheduling order is under the test's control.
function contender(runtime, {holdRead = null} = {}) {
  return {
    getRecord: async (imageId, id) => {
      const record = await runtime.images.getRecord(imageId, id);
      if (holdRead) await holdRead;
      return record;
    },
    putShape: (imageId, input) => runtime.images.putShape(imageId, input),
  };
}

async function shapeVersion(runtime, id) {
  return (await runtime.images.getRecord('img', id))?._version ?? null;
}

test('OWNER: two concurrent ensures of the same missing Shape converge on ONE valid Shape (loser adopts the winner)', async () => {
  await withRuntime(async (runtime) => {
    const [x, y] = await Promise.all([
      ensureShape(contender(runtime), 'img', LAYOUT),
      ensureShape(contender(runtime), 'img', LAYOUT),
    ]);
    assert.deepEqual(x, y, 'both contenders return the same durable record');
    assert.equal(x._version, 1, 'inserted exactly once');
    assert.equal((await runtime.images.listShapes('img')).filter((s) => s.id === LAYOUT.id).length, 1);
  });
});

test('OWNER: an existing valid Shape is never overwritten; retry after the winner commits is idempotent', async () => {
  await withRuntime(async (runtime) => {
    const first = await ensureShape(runtime.images, 'img', LAYOUT);
    assert.equal(first._version, 1);
    for (let i = 0; i < 3; i += 1) {
      const again = await ensureShape(runtime.images, 'img', {...LAYOUT, metadata: {note: `retry ${i}`}});
      assert.equal(again._version, 1, 'no version bump: nothing was written');
      assert.deepEqual(again, first);
    }
    assert.equal(await shapeVersion(runtime, LAYOUT.id), 1);
  });
});

test('OWNER: a conflicting occupant is rejected, never normalized into correctness (different layout, different indexed kind, non-Shape record)', async () => {
  await withRuntime(async (runtime) => {
    await ensureShape(runtime.images, 'img', LAYOUT);
    await assert.rejects(ensureShape(runtime.images, 'img', {...LAYOUT, slots: [{id: 'a', name: 'a'}]}), RecordConflictError, 'different slots');
    await assert.rejects(ensureShape(runtime.images, 'img', {id: LAYOUT.id, slots: LAYOUT.slots}), RecordConflictError, 'values Shape never equals a no-indexed Shape (ADR 0047)');
    assert.equal(await shapeVersion(runtime, LAYOUT.id), 1, 'the occupant is untouched');
    // A non-Shape record occupying the id: also a conflict, reported by the read, never inserted over.
    await runtime.images.putCodeArtifact('img', {id: 'taken', representation: 'x/v1', content: textValue('x')});
    await assert.rejects(ensureShape(runtime.images, 'img', {id: 'taken', slots: []}), RecordConflictError);
    // And a race whose winner wrote a DIFFERENT layout: the loser conflicts instead of adopting.
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = ensureShape(contender(runtime, {holdRead: gate}), 'img', {id: 'raced', slots: [{id: 'p', name: 'p'}]});
    await ensureShape(runtime.images, 'img', {id: 'raced', slots: [{id: 'q', name: 'q'}]});
    release();
    await assert.rejects(slow, RecordConflictError, 'the loser of the race must not adopt a divergent winner');
    assert.deepEqual((await runtime.images.getRecord('img', 'raced')).slots, [{id: 'q', name: 'q'}]);
  });
});

test('OWNER: no caller can observe a half-created Shape during the race', async () => {
  await withRuntime(async (runtime) => {
    const observed = [];
    const observer = {
      getRecord: async (imageId, id) => {
        const record = await runtime.images.getRecord(imageId, id);
        observed.push(record);
        return record;
      },
      putShape: (imageId, input) => runtime.images.putShape(imageId, input),
    };
    await Promise.all([ensureShape(observer, 'img', LAYOUT), ensureShape(observer, 'img', LAYOUT), ensureShape(observer, 'img', LAYOUT)]);
    assert.ok(observed.length >= 4, 'at least the three initial reads plus one loser re-read');
    for (const record of observed) {
      if (record == null) continue;
      // Every non-null observation is the COMPLETE committed Shape (single-record atomic insert).
      assert.equal(record.kind, 'shape');
      assert.deepEqual(record.slots, LAYOUT.slots);
      assert.equal(record.indexed, SHAPE_INDEXED.VALUES);
      assert.equal(record._version, 1);
    }
  });
});

test('OWNER: the outcome does not depend on which contender loses, nor on when the loser re-reads', async () => {
  // Either contender may be the one whose insert loses; and the loser may re-read immediately after
  // the winner's commit or only later. Every combination converges on the same version-1 record.
  for (const heldIndex of [0, 1]) {
    for (const releaseBeforeWinnerAwaited of [false, true]) {
      await withRuntime(async (runtime) => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const contenders = [contender(runtime), contender(runtime)];
        contenders[heldIndex] = contender(runtime, {holdRead: gate});
        const pending = contenders.map((images) => ensureShape(images, 'img', LAYOUT));
        if (releaseBeforeWinnerAwaited) release();
        const winner = await pending[1 - heldIndex];
        release();
        const loser = await pending[heldIndex];
        assert.deepEqual(loser, winner, `held=${heldIndex} early=${releaseBeforeWinnerAwaited}`);
        assert.equal(winner._version, 1);
        assert.equal(await shapeVersion(runtime, LAYOUT.id), 1);
        assert.equal((await runtime.images.listShapes('img')).filter((x) => x.id === LAYOUT.id).length, 1);
      });
    }
  }
});

test('OWNER: the same convergence covers the ensure core for objects (insert-only, no overwrite on a lost race)', async () => {
  await withRuntime(async (runtime) => {
    await ensureShape(runtime.images, 'img', {id: 'empty', slots: []});
    const desired = {id: 'marker', shape: objectRef('img', 'empty'), behavior: null, slots: {}, metadata: {m: 1}};
    const images = {
      getObject: (imageId, id) => runtime.images.getObject(imageId, id),
      putObject: (imageId, input, options) => runtime.images.putObject(imageId, input, options),
    };
    const [x, y] = await Promise.all([ensureObject(images, 'img', desired), ensureObject(images, 'img', desired)]);
    assert.deepEqual(x, y);
    assert.equal(x._version, 1, 'the loser did not overwrite the winner (no second version)');
    await assert.rejects(ensureObject(images, 'img', {...desired, metadata: {m: 2}}), RecordConflictError);
  });
});

test('PROJECT: concurrent first creates also leave the none-marker object at version 1 (no last-writer-wins)', async () => {
  await withRuntime(async (runtime) => {
    await Promise.all([
      createProject({images: runtime.images, imageId: 'img', projectId: createProjectId(), name: 'A'}),
      createProject({images: runtime.images, imageId: 'img', projectId: createProjectId(), name: 'B'}),
      createProject({images: runtime.images, imageId: 'img', projectId: createProjectId(), name: 'C'}),
    ]);
    assert.equal((await runtime.images.getObject('img', 'lagrange-project/none/v1'))._version, 1);
    for (const id of ['lagrange-project/none-shape/v1', 'lagrange-project/project/v1', 'lagrange-project/member/v1']) {
      assert.equal(await shapeVersion(runtime, id), 1, `${id} inserted exactly once`);
    }
  });
});
