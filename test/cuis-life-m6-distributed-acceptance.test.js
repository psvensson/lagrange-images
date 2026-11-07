// M6 distributed execution acceptance witness (bead lagrange-images-0pxf.12, epic lagrange-images-0pxf, ADR 0092).
//
// Proves Roadmap §4 M6:
// - M6.3: Unchanged LifeModel>>nextState executes across two independent Images runtimes over two
//   separate durable SQLite backends when `cells` (LifeArray) is placed on node A while `model`
//   (LifeModel), its classes, shapes, and WASM method artifacts remain on node B.
// - M6.4: Source and importer neutrality — the exact same installed Life image runs all-local and
//   split across two nodes without rebuilding, reimporting, or modifying any Cuis source/importer.
// - M6.5: Restart / recovery — stopping both runtimes and starting fresh runtimes over the two
//   SQLite files preserves per-object residency, identity, and cross-node execution from durable
//   state alone.
// - M6.6: Relocation / placement policy — `PlacementPolicy` relocates `cells` from node B to node A
//   and back from node A to node B without changing `(imageId, objectId)` or creating duplicate
//   live object records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {
  PER_OBJECT_RESIDENCY,
  PlacementPolicy,
  RELOCATED_RECORD_KIND,
  WHOLE_IMAGE_RESIDENCY,
} from '../src/graph/index.js';
import {records} from '../src/image/storage-layout.js';
import {integerValue, isObjectRef} from '../src/value/index.js';
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

test('M6.3-M6.6: PlacementPolicy and ObjectLocator execute unchanged Life across two separate SQLite nodes, survive full two-node restart, and relocate back without identity loss', {timeout: 600_000}, async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/life-m5-release.json', import.meta.url), 'utf8'));
  assert.equal(fixture.recorded.upstream, `Cuis-Smalltalk/Games@${GAMES_COMMIT}`);
  assert.equal(fixture.recorded.packageBlob, CUIS_LIFE_BLOB);

  const directory = await mkdtemp(join(tmpdir(), 'lagrange-life-m6-green-'));
  const dbPathB = join(directory, 'node-b.sqlite');
  const dbPathA = join(directory, 'node-a.sqlite');
  const IMAGE_ID = 'life-native';

  let nodeB = await composeFreshRuntime(dbPathB);
  let nodeA = await composeFreshRuntime(dbPathA);
  try {
    // --- 1. M6.4 (Part 1): Install recovered Life on node B and run all-local (S0 -> S1 -> S0).
    const {lifeModelClass} = await installRecoveredLife({runtime: nodeB, imageId: IMAGE_ID, fixture});
    const sendB = senderFor(nodeB, IMAGE_ID);
    const nativeGlobals = await nativeGlobalsFor(nodeB.images, IMAGE_ID);
    const {model, stateString} = await buildBlinkerModel(sendB, lifeModelClass, nativeGlobals);
    assert.equal(await stateString(), FROZEN_STATES[0], 'S0 on node B before local step');

    await sendB(model, 'nextState');
    assert.equal(await stateString(), FROZEN_STATES[1], 'M6.4 all-local S0 -> S1 on node B');
    await sendB(model, 'nextState');
    assert.equal(await stateString(), FROZEN_STATES[2], 'M6.4 all-local S1 -> S2 (S0) on node B');

    // --- 2. M6.3 & M6.6 (Move B -> A): Register nodes with PlacementPolicy and relocate `cells` to node A.
    const cellsRef = await sendB(model, 'cells');
    assert.ok(isObjectRef(cellsRef));
    assert.equal(cellsRef.imageId, IMAGE_ID);

    const placement = new PlacementPolicy({
      nodes: {
        'node-b': nodeB,
        'node-a': nodeA,
      },
    });

    const initialResidency = await placement.inspectResidency(cellsRef);
    assert.equal(initialResidency.node, 'node-b');
    assert.equal(initialResidency.kind, WHOLE_IMAGE_RESIDENCY);

    const relocatedToA = await placement.relocateObject({
      ref: cellsRef,
      fromNode: 'node-b',
      toNode: 'node-a',
    });
    assert.deepEqual(relocatedToA.ref, cellsRef, 'relocation preserves exact (imageId, objectId) identity');
    assert.equal(relocatedToA.residencyKind, PER_OBJECT_RESIDENCY);

    // Verify no duplicate live object record exists: node B holds only a relocated marker, node A holds the live object.
    const rawOnB = await nodeB.backend.get(records(IMAGE_ID), cellsRef.objectId);
    const rawOnA = await nodeA.backend.get(records(IMAGE_ID), cellsRef.objectId);
    assert.equal(rawOnB?.kind, RELOCATED_RECORD_KIND);
    assert.equal(rawOnB?.node, 'node-a');
    assert.equal(rawOnA?.kind, 'object');
    assert.equal((await placement.inspectResidency(cellsRef)).node, 'node-a');
    assert.equal((await nodeB.images.locator.locate(cellsRef)).kind, PER_OBJECT_RESIDENCY);

    // --- 3. M6.3 & M6.4 (Part 2): Execute unchanged `nextState` across the two nodes without reimport/rebuild.
    const versionBeforeStep1 = rawOnA._version;
    await sendB(model, 'nextState');
    assert.equal(await stateString(), FROZEN_STATES[1], 'M6.3 cross-node S0 -> S1 from node B with cells on node A');
    const rawOnAAfterStep1 = await nodeA.backend.get(records(IMAGE_ID), cellsRef.objectId);
    assert.ok(
      rawOnAAfterStep1._version > versionBeforeStep1,
      'mutating cells during nextState writes through to the resident record on node A',
    );

    // Execute `nextState` from node A's runtime as well (where `model` and classes live on node B and `cells` lives on node A).
    const sendA = senderFor(nodeA, IMAGE_ID);
    await sendA(model, 'nextState');
    assert.equal(await stateString(), FROZEN_STATES[2], 'M6.3 cross-node S1 -> S2 (S0) from node A with model on node B');

    assertProviderAbsence(nodeB, 'node B during distributed execution');
    assertProviderAbsence(nodeA, 'node A during distributed execution');

    // --- 4. M6.5: Full two-node restart over the durable SQLite files.
    await nodeA.close();
    await nodeB.close();

    nodeB = await composeFreshRuntime(dbPathB);
    nodeA = await composeFreshRuntime(dbPathA);
    const restartedPlacement = new PlacementPolicy({
      nodes: {
        'node-b': nodeB,
        'node-a': nodeA,
      },
    });

    const residencyAfterRestart = await restartedPlacement.inspectResidency(cellsRef);
    assert.equal(residencyAfterRestart.node, 'node-a', 'M6.5: per-object placement on node A survives full runtime restart');
    assert.equal(residencyAfterRestart.kind, PER_OBJECT_RESIDENCY);
    assert.equal((await nodeB.images.locator.locate(cellsRef)).kind, PER_OBJECT_RESIDENCY);

    const sendBAfterRestart = senderFor(nodeB, IMAGE_ID);
    const pointClass = nativeGlobals.get('Point');
    const pointAtAfterRestart = (x, y) => sendBAfterRestart(pointClass, 'x:y:', [integerValue(x), integerValue(y)]);
    const readStateAfterRestart = async () => {
      const cells = await sendBAfterRestart(model, 'cells');
      let parts = '';
      for (let r = 1; r <= 4; r += 1) {
        for (let c = 1; c <= 5; c += 1) {
          const v = await sendBAfterRestart(cells, 'at:', [await pointAtAfterRestart(r, c)]);
          parts += v.value === '1' ? '1' : '0';
        }
      }
      return `|${parts.slice(0, 5)}|${parts.slice(5, 10)}|${parts.slice(10, 15)}|${parts.slice(15, 20)}|`;
    };
    assert.equal(await readStateAfterRestart(), FROZEN_STATES[0], 'M6.5: state before post-restart step is S0');
    await sendBAfterRestart(model, 'nextState');
    assert.equal(await readStateAfterRestart(), FROZEN_STATES[1], 'M6.5: post-restart cross-node nextState advances S0 -> S1');

    // --- 5. M6.6 (Move A -> B): Relocate `cells` back from node A to node B without identity loss.
    const relocatedBackToB = await restartedPlacement.relocateObject({
      ref: cellsRef,
      fromNode: 'node-a',
      toNode: 'node-b',
    });
    assert.deepEqual(relocatedBackToB.ref, cellsRef);
    assert.equal(relocatedBackToB.residencyKind, WHOLE_IMAGE_RESIDENCY);
    assert.equal((await restartedPlacement.inspectResidency(cellsRef)).node, 'node-b');
    assert.equal((await nodeB.images.locator.locate(cellsRef)).kind, WHOLE_IMAGE_RESIDENCY);
    assert.equal((await nodeA.backend.get(records(IMAGE_ID), cellsRef.objectId))?.kind, RELOCATED_RECORD_KIND);
    assert.equal((await nodeB.backend.get(records(IMAGE_ID), cellsRef.objectId))?.kind, 'object');

    await sendBAfterRestart(model, 'nextState');
    assert.equal(await readStateAfterRestart(), FROZEN_STATES[2], 'M6.6: after relocating cells back to node B, nextState advances S1 -> S2 (S0)');
  } finally {
    await nodeA.close().catch(() => {});
    await nodeB.close().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  }
});
