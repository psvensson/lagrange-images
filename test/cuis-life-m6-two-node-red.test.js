// The M6.2 two-node RED witness (bead lagrange-images-0pxf.3, epic lagrange-images-0pxf).
//
// THE QUESTION: can the exact M5 Life application — the same recovered release, the same
// provider-free installation path, the same unchanged upstream source, the same frozen blinker
// oracle — run correctly when ONE ordinary application object the real `nextState` path needs on
// every send lives on a different Images node? Nothing in Life, the Cuis importer or the Cuis
// personality may know the answer; only generic owners may. M6.2 is the MEASUREMENT: it inspects
// the real object graph, chooses the split from that graph, attempts the placement through the
// owners that exist today, and pins the refusal each owner actually raises. M6.3 flips this
// witness to the distributed-green oracle at the generic owner the refusals name.
//
// WHAT THIS FILE PROVES, AND DOES NOT:
//
// - Two nodes are two independently composed Images runtimes over two independent durable
//   backends (the M4/M5 lifecycle cut, applied twice). Node B holds the whole installed
//   application; node A is an independent node that holds nothing of it. Neither composes a
//   toolchain or foreign-runtime provider.
// - The split is chosen FROM the observed graph: after S0, the model's `cells` slot names the
//   LifeArray instance every `nextState` reads and writes. Its identity is (imageId, objectId),
//   which is also exactly what must NOT change when it moves.
// - "Attempt the placement through existing owners only" is taken literally: the image service is
//   asked to hold the record on node A, and the backend contract is asked to release it from
//   node B. Each refusal is asserted with the owner's own error, and the census prediction
//   (bead 0pxf.2: "resolution today refuses/misreads, because image reads converse only with the
//   composed backend") is checked against what actually happens.
// - The relocation that no sanctioned owner offers is then performed as EVIDENCE through the raw
//   backend seam: the record is copied to A at its unchanged identity and B's copy is replaced by
//   a marker no reader accepts, so B genuinely no longer holds it. The unchanged oracle step is
//   then run on B and MUST fail at the graph layer — the anti-local guard: if it passed, the
//   computation never crossed the boundary and this witness is worthless. The same send on A must
//   fail too, for the complementary reason (A holds the record but nothing it depends on).
// - No repair lives here. No routing, locating or placing happens in src/language, in the
//   importer or in this file. The only new code M6.2 introduces is this measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {isObjectRef, objectRef} from '../src/value/index.js';
import {
  CUIS_LIFE_BLOB,
  FROZEN_STATES,
  GAMES_COMMIT,
  assertProviderAbsence,
  buildBlinkerModel,
  composeFreshRuntime,
  installRecoveredLife,
  nativeGlobalsFor,
  senderFor,
} from './support/life-m5-witness.js';

// The image service's private collection naming, spelled here ONLY for the raw-backend evidence
// write; no product code and no other test reaches the backend this way.
const objectsOf = (imageId) => `image:${imageId}:objects`;

function withoutVersion(record) {
  const {_version, ...rest} = record;
  return rest;
}

// The object owner's INPUT form of a stored record: its identity, layout edge, behavior edge and
// state, without the stored-only bookkeeping (`kind`, `imageId`, `updatedAt`, `_version`).
function asObjectInput(record) {
  const input = {};
  for (const field of ['id', 'shape', 'behavior', 'slots', 'indexed', 'metadata']) {
    if (record[field] !== undefined) input[field] = record[field];
  }
  return input;
}

test('M6.2: the cells object the real nextState path needs cannot be placed on a second node through any existing owner, and the unchanged oracle fails at the graph layer once it is gone', {timeout: 600_000}, async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/life-m5-release.json', import.meta.url), 'utf8'));
  assert.equal(fixture.recorded.upstream, `Cuis-Smalltalk/Games@${GAMES_COMMIT}`);
  assert.equal(fixture.recorded.packageBlob, CUIS_LIFE_BLOB);

  const directory = await mkdtemp(join(tmpdir(), 'lagrange-life-m6-'));
  const NODE_B_IMAGE = 'life-native';
  const nodeB = await composeFreshRuntime(join(directory, 'node-b.sqlite'));
  const nodeA = await composeFreshRuntime(join(directory, 'node-a.sqlite'));
  try {
    // --- 1. Node B: the M5 path, EXACTLY, up to S0.
    const {lifeModelClass} = await installRecoveredLife({runtime: nodeB, imageId: NODE_B_IMAGE, fixture});
    const sendB = senderFor(nodeB, NODE_B_IMAGE);
    const nativeGlobals = await nativeGlobalsFor(nodeB.images, NODE_B_IMAGE);
    const {model, pointAt, stateString} = await buildBlinkerModel(sendB, lifeModelClass, nativeGlobals);
    assert.equal(await stateString(), FROZEN_STATES[0], 'S0 on node B, before any split');

    // --- 2. Inspect the real graph and choose the split from it.
    const cellsRef = await sendB(model, 'cells');
    assert.ok(isObjectRef(cellsRef), 'the model answers its cells as an ordinary ObjectRef');
    assert.equal(cellsRef.imageId, NODE_B_IMAGE);
    const cellsRecord = await nodeB.images.getObject(NODE_B_IMAGE, cellsRef.objectId);
    assert.equal(cellsRecord.kind, 'object');
    assert.deepEqual(cellsRecord.behavior, await (async () => {
      // The cells object IS a LifeArray, the imported class the release installed.
      const behavior = await nodeB.images.getObject(cellsRecord.behavior.imageId, cellsRecord.behavior.objectId);
      assert.ok(behavior, 'the cells object has a Behavior on node B');
      return cellsRecord.behavior;
    })());
    // Residency ledger, before: node B's composed backend holds the record; node A holds nothing.
    assert.ok(await nodeB.backend.get(objectsOf(NODE_B_IMAGE), cellsRef.objectId), 'residency before: node B');
    assert.equal(await nodeA.backend.get(objectsOf(NODE_B_IMAGE), cellsRef.objectId), undefined, 'residency before: not node A');
    // The model reaches its cells by an ordinary slot holding that very ref.
    const modelRecord = await nodeB.images.getObject(NODE_B_IMAGE, model.objectId);
    assert.ok(Object.values(modelRecord.slots).some((value) => isObjectRef(value) && value.objectId === cellsRef.objectId),
      'the model names the cells object through an ordinary slot ref');

    // --- 3. Attempt the placement through existing owners only.
    // 3a. Node A knows no image of that identity: the image service refuses before any record.
    await assert.rejects(
      nodeA.images.getObject(NODE_B_IMAGE, cellsRef.objectId),
      {name: 'TypeError', message: `image not found: ${NODE_B_IMAGE}`},
      'refusal 1: a ref whose image scope node A does not hold is unreadable there (no cross-backend resolution owner)',
    );
    // 3b. Even with the image scope present, node A's object owner validates the record's Shape
    // edge against ITS composed backend, and the Shape lives on node B.
    await nodeA.images.createImage({id: NODE_B_IMAGE});
    await assert.rejects(
      nodeA.images.putObject(NODE_B_IMAGE, asObjectInput(cellsRecord)),
      {name: 'TypeError', message: `shape not found: ${cellsRecord.shape.imageId}/${cellsRecord.shape.objectId}`},
      'refusal 2: the object owner cannot admit a record whose layout edge points at another node (no residency/locator owner)',
    );
    // 3c. Nothing can release the record from node B: the backend contract has no delete and the
    // image service has no relocation or detach operation. A "move" through existing owners is
    // therefore a COPY, which duplicates identity — the exact thing the M6 prohibition ledger
    // forbids a repair to do.
    for (const name of ['delete', 'remove', 'detach', 'relocate', 'move']) {
      assert.equal(typeof nodeB.backend[name], 'undefined', `refusal 3: the backend contract has no ${name}`);
      assert.equal(typeof nodeB.images[name], 'undefined', `refusal 3: the image service has no ${name}`);
    }

    // --- 4. The relocation no owner offers, as EVIDENCE through the raw backend seam: the record
    // moves to node A at its UNCHANGED identity and node B's copy becomes a marker no reader
    // accepts, so node B genuinely no longer holds the object.
    await nodeA.backend.put(objectsOf(NODE_B_IMAGE), cellsRef.objectId, withoutVersion(cellsRecord), {expectedVersion: 0});
    await nodeB.backend.put(objectsOf(NODE_B_IMAGE), cellsRef.objectId, {kind: 'relocated', node: 'node-a'}, {expectedVersion: cellsRecord._version});
    // Residency ledger, after: identity unchanged, residency moved.
    const relocated = await nodeA.images.getObject(NODE_B_IMAGE, cellsRef.objectId);
    assert.ok(relocated, 'residency after: node A holds the record');
    assert.deepEqual(withoutVersion(relocated), withoutVersion(cellsRecord), 'the record bytes are the same record at the same (imageId, objectId)');
    assert.equal(await nodeB.images.getObject(NODE_B_IMAGE, cellsRef.objectId), null, 'residency after: node B no longer holds an object there');

    // --- 5. The unchanged oracle step, on node B. It MUST fail, at the graph layer, on the first
    // send that reaches the cells object; if it passes, the computation never crossed the boundary.
    await assert.rejects(
      sendB(model, 'nextState'),
      {name: 'TypeError', message: `Symmetric Smalltalk receiver not found: ${NODE_B_IMAGE}/${cellsRef.objectId}`},
      'the RED: the unchanged nextState reaches the relocated cells object and node B cannot resolve it (anti-local guard: a pass here would mean the computation stayed local)',
    );
    // The direct reading protocol fails the same way: this is the receiver, not the method.
    await assert.rejects(
      sendB(cellsRef, 'at:', [await pointAt(2, 2)]),
      {name: 'TypeError', message: `Symmetric Smalltalk receiver not found: ${NODE_B_IMAGE}/${cellsRef.objectId}`},
    );

    // --- 6. The complementary failure on node A: it holds the record and nothing the record
    // depends on — no Behavior, no Shape, no kernel — because residency of one object is not
    // residency of its graph. Same generic gap, seen from the other side.
    const sendA = senderFor(nodeA, NODE_B_IMAGE);
    await assert.rejects(
      sendA(cellsRef, 'at:', [objectRef(NODE_B_IMAGE, 'unused')]),
      {name: 'TypeError', message: `Symmetric Smalltalk behavior not found: ${cellsRecord.behavior.imageId}/${cellsRecord.behavior.objectId}`},
      'node A holds the object but not its Behavior: placement of one record is not placement of the graph it needs',
    );

    // --- 7. Nothing in this witness taught Life, the importer or the personality anything: both
    // nodes are still provider-free, and the only writes outside ordinary owners were the two raw
    // evidence puts above.
    assertProviderAbsence(nodeA, 'node A after the split');
    assertProviderAbsence(nodeB, 'node B after the split');
  } finally {
    await nodeA.close();
    await nodeB.close();
    await rm(directory, {recursive: true, force: true});
  }
});
