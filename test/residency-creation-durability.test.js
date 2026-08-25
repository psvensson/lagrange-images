import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createRuntime,
  installCallableInterfaceV2,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  packCompositeValue,
  pinnedRef,
  textValue,
} from '../src/runtime.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {LagrangeBackend} from '../src/backend/index.js';
import {LexicalCellArena, arenaImagesView} from '../src/execution/lexical-cells.js';
import {ClosurePromoter} from '../src/execution/closure-promotion.js';
import {findTransientRefs, transientObjectId} from '../src/value/transient-ref.js';
import {referencesOfRecord} from '../src/graph/references.js';
import {objectVersionToken} from '../src/object/version-token.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

// ADR 0060 (residency/promotion), ADR 0062 (creation lane) and ADR 0032 (transaction) are each
// proven in isolation. What is proven HERE is that they compose — the seams where an object that
// begins transient in an arena meets the two durable writers (the promotion path and the authorized
// creation lane) and the durability backend. Each group names the seam it pins.

async function withRuntime(body, options = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, ...options});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

// A two-slot node Shape/Behavior, so objects can hold each other and form cycles. `behavior` is
// null: promotion copies it, and the object record permits a null behavior (createObjectRecord).
async function nodeShape(images, imageId) {
  const shape = await images.putShape(imageId, {
    id: 'durability/node-shape',
    slots: [
      {id: 'durability/node-link', name: 'link'},
      {id: 'durability/node-val', name: 'val'},
    ],
  });
  return objectRef(imageId, shape.id);
}

const objectIds = async (runtime, imageId) =>
  (await runtime.images.listRecords(imageId))
    .filter((record) => record.kind === 'object')
    .map((record) => record.id);

// --- A: object-promotion publication is recoverable by an identical retry -------------------------
//
// The closure side already sweeps publication failure (closure-promotion.test.js); the OBJECT side
// did not, and ADR 0060's proof list demands it: a promotion retried after a commit-then-lost-ack
// converges on one durable identity. The mechanism is ensureObject (exact-or-create) plus the
// memo's three states plus durableIdFor. A stale in-progress reservation would live in THIS arena's
// memo, so the retry must share the arena — that is the case that would answer a ref with no record.

// A cyclic graph, so the sweep covers a cycle meeting its own preassigned ref mid-publication.
function cyclicPair(arena, imageId, shapeRef) {
  const nil = objectRef(imageId, 'smalltalk/nil');
  const a = arena.mintObject(imageId, {shape: shapeRef, slots: {'durability/node-link': nil, 'durability/node-val': integerValue(1)}});
  const b = arena.mintObject(imageId, {shape: shapeRef, slots: {'durability/node-link': nil, 'durability/node-val': integerValue(2)}});
  arena.mutateTransientObject(imageId, a.objectId, {slots: {'durability/node-link': b, 'durability/node-val': integerValue(1)}});
  arena.mutateTransientObject(imageId, b.objectId, {slots: {'durability/node-link': a, 'durability/node-val': integerValue(2)}});
  return {a, b};
}

// How many object writes one clean promotion performs, so the sweep knows where to stop.
async function promotionWriteCount() {
  return await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'count'});
    const shapeRef = await nodeShape(runtime.images, 'count');
    const arena = new LexicalCellArena();
    const {a} = cyclicPair(arena, 'count', shapeRef);
    let writes = 0;
    const counting = Object.create(runtime.images);
    counting.putObject = async (...args) => { writes += 1; return await runtime.images.putObject(...args); };
    await new ClosurePromoter(counting, arena).promoteValue(a);
    assert.ok(writes > 0, 'a cyclic pair promotion must publish at least one object');
    return writes;
  });
}

test('exhaustive-recovery: every write publishing a promoted object graph is recoverable by an identical retry', async () => {
  const total = await promotionWriteCount();
  for (let failAt = 1; failAt <= total; failAt += 1) {
    for (const commitThenThrow of [false, true]) {
      await withRuntime(async (runtime) => {
        await runtime.images.createImage({id: 'app'});
        const shapeRef = await nodeShape(runtime.images, 'app');
        const arena = new LexicalCellArena();
        const {a, b} = cyclicPair(arena, 'app', shapeRef);

        // Fail the Nth object write: pre-commit (nothing written) or post-commit (lost ack).
        let armed = true;
        const faulting = Object.create(runtime.images);
        faulting.putObject = async (imageId, input, options) => {
          if (armed && !commitThenThrow) {
            armed = false;
            throw new Error(`injected pre-commit failure (${input.id})`);
          }
          const stored = await runtime.images.putObject(imageId, input, options);
          if (armed) {
            armed = false;
            throw new Error(`injected post-commit failure (${input.id})`);
          }
          return stored;
        };

        await assert.rejects(
          new ClosurePromoter(faulting, arena).promoteValue(a),
          /injected (pre|post)-commit failure/,
          `write ${failAt} (commitThenThrow=${commitThenThrow}) should have failed`,
        );

        // Retry against the SAME arena, where a stale in-progress reservation would be consulted.
        // It must re-run publication and converge, not answer a ref with no record behind it.
        const promoted = await new ClosurePromoter(runtime.images, arena).promoteValue(a);
        assert.ok(promoted.objectId.startsWith('object/'), 'the answer is a durable id');

        const aRecord = await runtime.images.getObject('app', promoted.objectId);
        assert.ok(aRecord, `retry answered ${promoted.objectId}, which does not exist`);
        assert.deepEqual(findTransientRefs(aRecord), [], 'a promoted record holds no transient ref');

        // The cycle survived: a.link.link resolves back to a, and both nodes are durable.
        const bRef = aRecord.slots['durability/node-link'];
        const bRecord = await runtime.images.getObject('app', bRef.objectId);
        assert.ok(bRecord, 'the linked node was not published');
        assert.equal(bRecord.slots['durability/node-link'].objectId, aRecord.id, 'the cycle must terminate back at a');

        // One durable identity per transient object — a lost ack must not mint a second.
        const ids = await objectIds(runtime, 'app');
        assert.equal(ids.length, 2, `expected exactly the two promoted objects, saw ${ids.length}`);
        assert.ok(ids.includes(aRecord.id) && ids.includes(bRecord.id));
      });
    }
  }
});

// The distinction the three memo states exist for, stated for an object: a failed promotion must
// not leave a reservation that a later promoter answers as success.
test('a failed object promotion leaves no memo entry that answers as success', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const shapeRef = await nodeShape(runtime.images, 'app');
    const arena = new LexicalCellArena();
    const {a} = cyclicPair(arena, 'app', shapeRef);

    const failing = Object.create(runtime.images);
    failing.putObject = async () => { throw new Error('injected failure'); };
    await assert.rejects(new ClosurePromoter(failing, arena).promoteValue(a), /injected failure/);

    // Sharing the arena's memo, this must re-publish, not answer from the abandoned reservation.
    const promoted = await new ClosurePromoter(runtime.images, arena).promoteValue(a);
    assert.ok(await runtime.images.getObject('app', promoted.objectId));
  });
});

// --- B: the creation lane and the arena are disjoint ----------------------------------------------
//
// The creation lane is a foreign callable whose executor context is exactly {images, require}
// (image-creation-binding.js:244) — no arena and no promoter. A LIVE transient arena ref therefore
// cannot reach its putObject through any execution; only a caller-supplied STRING can name an edge
// target, and the lane refuses a transient-looking string before any grant check or write. The
// write-seam guard (graph-image-service.js assertNoTransientIdentity) is the independent backstop.

const CREATE_TYPES = normalizeTypeDeclarations({
  item: {kind: 'record', fields: [
    {name: 'name', type: 'string'},
    {name: 'note', type: 'string'},
    {name: 'subject', type: 'string'},
  ]},
});
const CREATE_FIELDS = [
  {name: 'name', slot: 'slot-name'},
  {name: 'note', slot: 'slot-note'},
  {name: 'subject', slot: 'slot-subject', edge: true},
];

// Build a raw ImageService (no full runtime) and drive the binding executor directly with the
// minimal context the lane destructures — {images, require}. Production hands the executor a
// superset (an arena view, promote, mintObject, ...), but image-creation-binding.js destructures
// only {images, require}, so the lane's own code cannot reach an arena through its context.
async function creationFixture() {
  const {createBackend} = await import('../src/backend/index.js');
  const backend = await createBackend({mode: 'mock'});
  await backend.start();
  const images = new ImageService({backend});
  await images.createImage({id: 'demo'});
  const {installSmalltalkKernel, defineClass} = await import('../src/runtime.js');
  await installSmalltalkKernel({images, imageId: 'demo'});
  const shape = await images.putShape('demo', {
    id: 'item-shape',
    slots: [
      {id: 'slot-name', name: 'name'},
      {id: 'slot-note', name: 'note'},
      {id: 'slot-subject', name: 'subject'},
    ],
  });
  const {classRef} = await defineClass({images, imageId: 'demo', name: 'Item', instanceShapeRef: objectRef('demo', shape.id)});
  const {installImageCreationBinding} = await import('../src/callable/image-creation-binding.js');
  const callableInterface = await installCallableInterfaceV2({
    images, imageId: 'demo', interfaceId: 'create-item',
    functionName: 'create-item', parameters: ['string', 'item'], result: 'string', types: CREATE_TYPES,
  });
  const binding = await installImageCreationBinding({
    images, callableInterface: objectRef('demo', callableInterface.id),
    fields: CREATE_FIELDS, bindingId: 'creation', blockId: 'creation-block',
  });
  const {createImageCreationBindingV1Executor, IMAGE_CREATION_BINDING_V1, OBJECT_CREATE_OPERATION, OBJECT_EDGE_WRITE_OPERATION} =
    await import('../src/callable/image-creation-binding.js');
  const {objectResource} = await import('../src/authority/object-resource.js');
  const block = await images.getBlock('demo', 'creation-block');
  const code = await images.getCodeArtifact('demo', block.code.objectId);
  const executor = createImageCreationBindingV1Executor();
  const require = () => {};
  // The runtime executor resolves the Block's code artifact and calls execute({activation, code});
  // mirror that shape here, since this fixture drives the binding executor directly.
  const create = (classId, value) => executor.execute(
    {
      activation: {block: objectRef('demo', 'creation-block'), receiver: null, environment: null, arguments: [textValue(classId), packCompositeValue(value, 'item', CREATE_TYPES)]},
      code,
    },
    {images, require},
  );
  return {backend, images, classRef, create, objectResource, OBJECT_CREATE_OPERATION, OBJECT_EDGE_WRITE_OPERATION};
}

test('a transient-looking edge-target spelling is refused by the creation lane before any write', async () => {
  const {backend, images, classRef, create} = await creationFixture();
  try {
    // The ONLY way to name an edge target to the lane is a string (the callable type language has no
    // ref type, ADR 0042 §7). A transient-looking string is refused before the write — for a plain
    // and a pinned spelling alike. The lane's spellings are bare ids (the kind segment belongs to
    // the arena, not the edge string), so use transientObjectId.
    // A refused create must write no new instance. Count durable records of the Item shape (the
    // only thing a successful create would produce) around the refusals.
    const itemInstances = async () =>
      (await images.listRecords('demo'))
        .filter((r) => r.kind === 'object' && r.shape?.objectId === 'item-shape').length;
    const before = await itemInstances();
    for (const spelling of [transientObjectId('target'), `pin:${transientObjectId('target')}@1`]) {
      await assert.rejects(
        create(classRef.objectId, {name: 'x', note: 'n', subject: spelling}),
        (error) => error.name === 'ObjectCreationConflictError' && /transient/.test(error.message),
        `the lane must refuse the transient spelling ${spelling}`,
      );
    }
    assert.equal(await itemInstances(), before, 'a refused create must publish no new instance');
  } finally {
    await backend.stop();
  }
});

test('the write-seam guard is the independent backstop for a transient ref in a durable record', async () => {
  const {backend, images} = await creationFixture();
  try {
    // Bypassing the lane entirely, a durable record embedding an unpromoted transient ref is
    // refused at the seam. The lane's refusal and this guard are pinned independently.
    const id = transientObjectId('backstop-target');
    const shape = await images.putShape('demo', {id: 'backstop-shape', slots: [{id: 's', name: 's'}]});
    await assert.rejects(
      images.putObject('demo', {
        id: 'backstop-record', shape: objectRef('demo', shape.id),
        slots: {s: objectRef('demo', id)}, metadata: {},
      }, {expectedVersion: 0}),
      /unpromoted transient reference/,
    );
  } finally {
    await backend.stop();
  }
});

// --- C: write-through publishes a post-escape transient, and never dangles -------------------------
//
// lexical-cells.js:401: a value written into an escaped object may itself be transient — a backing
// Array allocated AFTER its OrderedCollection escaped — and writing that ref unpromoted would
// dangle. The arena view promotes it through the same central operation before the durable rewrite.
// The `if (current)` at :407 is the other interleaving: a durable write is skipped only when the
// durable record does not yet exist, and the arena is updated either way, so the eventual promotion
// publishes the latest.

test('a slot write of a post-escape transient value promotes it rather than dangling', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const shapeRef = await nodeShape(runtime.images, 'app');
    const arena = new LexicalCellArena();

    // The holder escapes first; then a NEW transient object is written into its slot — the
    // backing-Array-after-escape case. The view must promote the new value and write a real edge.
    const nil = objectRef('app', 'smalltalk/nil');
    const holder = arena.mintObject('app', {shape: shapeRef, slots: {'durability/node-link': nil, 'durability/node-val': integerValue(9)}});
    const promotedHolder = await new ClosurePromoter(runtime.images, arena).promoteValue(holder);

    // A promoter registered so the view's write-through can promote the freshly-written value.
    arena.postPromotionPromoter = (v) => new ClosurePromoter(runtime.images, arena).promoteValue(v);
    const view = arenaImagesView(runtime.images, arena);

    const late = arena.mintObject('app', {shape: shapeRef, slots: {'durability/node-link': nil, 'durability/node-val': integerValue(7)}});
    await view.putObject('app', {
      id: holder.objectId, // the ARENA id: the view derives the durable id from the memo
      shape: shapeRef,
      behavior: null,
      slots: {'durability/node-link': late, 'durability/node-val': integerValue(9)},
      metadata: {},
    });

    // The durable holder now points at a DURABLE published record for the late value, not a
    // transient ref that would dangle.
    const durableHolder = await runtime.images.getObject('app', promotedHolder.objectId);
    assert.deepEqual(findTransientRefs(durableHolder), [], 'the write-through left no transient ref');
    const linkRef = durableHolder.slots['durability/node-link'];
    assert.ok(linkRef.objectId.startsWith('object/'), 'the late value was promoted, not written transient');
    assert.deepEqual(await runtime.images.getObject('app', linkRef.objectId).then((r) => r?.slots['durability/node-val']), integerValue(7));
  });
});

// The `if (current)` interleaving (lexical-cells.js:407): while an object's own promotion is still
// in-progress — a cyclic graph suspends mid-publish — its durable record does not exist yet. A slot
// write then must NOT write durable (there is nothing to CAS against), but MUST update the arena, so
// the eventual #promoteObjectRecord re-read publishes the latest. Driving that interleaving: hand-
// mark the memo in-progress, write through the view, then complete the promotion.
test('a write during an in-progress promotion updates the arena and is published by the eventual promotion', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const shapeRef = await nodeShape(runtime.images, 'app');
    const arena = new LexicalCellArena();
    const nil = objectRef('app', 'smalltalk/nil');
    const node = arena.mintObject('app', {shape: shapeRef, slots: {'durability/node-link': nil, 'durability/node-val': integerValue(1)}});

    // Mark the object in-progress in the memo, as its own promotion would have — its durable record
    // does not exist yet. The derived durable id is what promotion will use.
    const {durableIdFor} = await import('../src/execution/closure-promotion.js');
    const durableId = durableIdFor(node.objectId);
    arena.promotionMemo().set(['app', node.objectId], {ref: objectRef('app', durableId), status: 'in-progress'});

    arena.postPromotionPromoter = (v) => new ClosurePromoter(runtime.images, arena).promoteValue(v);
    const view = arenaImagesView(runtime.images, arena);

    // Write through the view: the durable record is absent (current === null), so the durable write
    // is skipped — but the arena must be updated.
    await view.putObject('app', {
      id: node.objectId, shape: shapeRef, behavior: null,
      slots: {'durability/node-link': nil, 'durability/node-val': integerValue(99)},
      metadata: {},
    });
    assert.ok(!(await runtime.images.getObject('app', durableId)), 'no durable record may appear before promotion completes');
    assert.deepEqual(arena.transientRecord('app', node.objectId).slots['durability/node-val'], integerValue(99), 'the arena was updated even though the durable write was skipped');

    // The eventual promotion re-reads the arena and must publish the LATEST value, not the stale
    // snapshot from reservation time.
    arena.promotionMemo().delete(['app', node.objectId]); // release the reservation, as a completed step would
    const promoted = await new ClosurePromoter(runtime.images, arena).promoteValue(node);
    const record = await runtime.images.getObject('app', promoted.objectId);
    assert.deepEqual(record.slots['durability/node-val'], integerValue(99), 'the promotion published the post-reservation mutation, not the stale snapshot');
  });
});

// --- D: a promoted graph and a created object survive a real process restart -----------------------
//
// The only restart test today exercises raw backend collections. This is the image graph: promote a
// cycle and create an object through the lane, then a SECOND backend lifetime on the SAME SQLite
// file must resolve both — and their history — byte-for-byte. That is ADR 0032's durability made
// real, and the §7 process-restart proof, for the promotion + creation writes specifically.

test('a promoted graph and a created object survive a real backend restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-durability-'));
  const filename = join(directory, 'image.sqlite');
  try {
    const ids = {};
    {
      const backend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
      await backend.start();
      const images = new ImageService({backend});
      await images.createImage({id: 'app'});
      const shapeRef = await nodeShape(images, 'app');
      const arena = new LexicalCellArena();
      const {a} = cyclicPair(arena, 'app', shapeRef);
      const promoted = await new ClosurePromoter(images, arena).promoteValue(a);
      ids.a = promoted.objectId;
      // A creation-lane object written against the same backend.
      const created = await images.putObject('app', {
        id: 'created-item', shape: shapeRef, behavior: null,
        slots: {'durability/node-link': objectRef('app', ids.a), 'durability/node-val': integerValue(3)},
        metadata: {},
      }, {expectedVersion: 0});
      ids.createdVersion = created._version;
      await backend.stop();
    }
    {
      const backend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
      await backend.start();
      try {
        const images = new ImageService({backend});
        // The promoted cycle resolved, intact, with no transient residue.
        const aRecord = await images.getObject('app', ids.a);
        assert.ok(aRecord, 'the promoted object did not survive the restart');
        assert.deepEqual(findTransientRefs(aRecord), []);
        const bRecord = await images.getObject('app', aRecord.slots['durability/node-link'].objectId);
        assert.equal(bRecord.slots['durability/node-link'].objectId, aRecord.id, 'the cycle did not survive intact');
        // The created object resolved with its edge to the promoted object and its version.
        const created = await images.getObject('app', 'created-item');
        assert.equal(created.slots['durability/node-link'].objectId, ids.a);
        assert.equal(created._version, ids.createdVersion);
        // History survived too: every put is replayable after the restart.
        const history = await images.history('app');
        assert.ok(history.some((e) => e.type === 'object.put' && e.objectId === ids.a), 'the promotion write is in history');
        assert.ok(history.some((e) => e.type === 'object.put' && e.objectId === 'created-item'), 'the creation write is in history');
      } finally {
        await backend.stop();
      }
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// ADR 0064 §7: the indexed-part creation write is insert-only `putWithHistory`, so it is durable and
// restart-safe like any creation. Prove it end-to-end: create an object with an ordered indexed part
// of refs through the lane against a real backend, restart, and the indexed refs resolve in order,
// walk-visible, with no transient residue.
test('an object created with an indexed ref-list survives a real backend restart, walk-visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-indexed-'));
  const filename = join(directory, 'image.sqlite');
  const INDEXED_TYPES = normalizeTypeDeclarations({
    perspective: {kind: 'record', fields: [
      {name: 'subject', type: 'string'},
      {name: 'presentations', type: {kind: 'list', element: 'string'}},
    ]},
  });
  try {
    let createdId;
    {
      const backend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
      await backend.start();
      const images = new ImageService({backend});
      await images.createImage({id: 'app'});
      const shapeRef = await images.putShape('app', {
        id: 'perspective-shape', slots: [{id: 'slot-subject', name: 'subject'}], indexed: 'values',
      });
      // Durable targets for the subject slot and the indexed elements.
      const targetShape = await images.putShape('app', {id: 'target-shape', slots: []});
      for (const id of ['subject-1', 'pres-1', 'pres-2']) {
        await images.putObject('app', {id, shape: objectRef('app', targetShape.id), slots: {}, metadata: {}}, {expectedVersion: 0});
      }
      // Drive the lane directly with the {images, require} context, mirroring group B.
      const {installImageCreationBinding, createImageCreationBindingV1Executor} = await import('../src/callable/image-creation-binding.js');
      const {installCallableInterfaceV2, defineClass, installSmalltalkKernel} = await import('../src/runtime.js');
      await installSmalltalkKernel({images, imageId: 'app'});
      const {classRef} = await defineClass({images, imageId: 'app', name: 'Perspective', instanceShapeRef: objectRef('app', shapeRef.id)});
      const ci = await installCallableInterfaceV2({
        images, imageId: 'app', interfaceId: 'create-perspective',
        functionName: 'create-perspective', parameters: ['string', 'perspective'], result: 'string', types: INDEXED_TYPES,
      });
      await installImageCreationBinding({
        images, callableInterface: objectRef('app', ci.id),
        fields: [{name: 'subject', slot: 'slot-subject', edge: true}, {name: 'presentations', indexed: true, edge: true}],
        bindingId: 'creation', blockId: 'creation-block',
      });
      const block = await images.getBlock('app', 'creation-block');
      const code = await images.getCodeArtifact('app', block.code.objectId);
      const executor = createImageCreationBindingV1Executor();
      const token = await executor.execute(
        {
          activation: {block: objectRef('app', 'creation-block'), receiver: null, environment: null, arguments: [textValue(classRef.objectId), packCompositeValue({subject: 'subject-1', presentations: ['pres-1', 'pres-2']}, 'perspective', INDEXED_TYPES)]},
          code,
        },
        {images, require: () => {}},
      );
      createdId = (await images.history('app')).filter((e) => e.type === 'object.put' && e.object?.shape?.objectId === shapeRef.id).pop().objectId;
      assert.ok(token.kind === 'text' && createdId, 'the lane created the indexed object');
      await backend.stop();
    }
    {
      const backend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
      await backend.start();
      try {
        const images = new ImageService({backend});
        const object = await images.getObject('app', createdId);
        assert.ok(object, 'the indexed object did not survive the restart');
        // The ordered indexed refs resolved, in order, with no transient residue.
        assert.deepEqual(object.indexed, [objectRef('app', 'pres-1'), objectRef('app', 'pres-2')]);
        assert.deepEqual(findTransientRefs(object), []);
        assert.deepEqual(object.slots['slot-subject'], objectRef('app', 'subject-1'));
        // And they are walk-visible as graph edges after the restart.
        const refs = referencesOfRecord(object).map((r) => r.objectId);
        for (const id of ['subject-1', 'pres-1', 'pres-2']) assert.ok(refs.includes(id), `referencesOfRecord must reach ${id} after restart`);
      } finally {
        await backend.stop();
      }
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
