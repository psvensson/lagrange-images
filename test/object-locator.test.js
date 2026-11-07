import test from 'node:test';
import assert from 'node:assert/strict';
import {MockBackend} from '../src/backend/mock-backend.js';
import {ObjectLocator, PER_OBJECT_RESIDENCY, WHOLE_IMAGE_RESIDENCY} from '../src/graph/locator.js';
import {PlacementPolicy} from '../src/graph/placement.js';
import {RemoteRecordResolver} from '../src/graph/remote-resolution.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {records} from '../src/image/storage-layout.js';
import {LexicalCellArena, arenaImagesView} from '../src/execution/lexical-cells.js';
import {integerValue, objectRef} from '../src/value/scalars.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';
import {loadSharedLifeFixture, proveSharedLife} from '../fixtures/real-lagrange-m6-scenario.js';

test('whole-image residency is an opaque runtime fact and record resolution consumes it', async () => {
  const backend = new MockBackend();
  await backend.start();
  try {
    const images = new ImageService({backend});
    await images.createImage({id: 'app'});
    const shape = await images.putShape('app', {id: 'shape', slots: []});

    const locator = new ObjectLocator({backend});
    const resolver = new RemoteRecordResolver();
    const ref = objectRef('app', 'shape');
    const residency = await locator.locate(ref);

    assert.equal(residency.kind, WHOLE_IMAGE_RESIDENCY);
    assert.equal(residency.imageId, 'app');
    assert.deepEqual(
      Object.keys(residency).sort(),
      ['imageId', 'kind'],
      'residency exposes no backend, node, partition, replica or address',
    );
    assert.deepEqual(await resolver.resolveAt(ref, residency), shape);
    assert.equal(await locator.locate(objectRef('missing', 'shape')), null);

    let imageReads = 0;
    const origGet = backend.get.bind(backend);
    backend.get = async (collection, key) => {
      if (collection === 'images') imageReads += 1;
      return await origGet(collection, key);
    };
    assert.equal(await locator.locate(objectRef('app', 'another')), residency);
    assert.equal(imageReads, 0, 'confirmed whole-image residency is reused without re-reading the image collection');
    assert.equal(await locator.locate(objectRef('late', 'shape')), null);
    assert.equal(imageReads, 1, 'absent image residency is checked against the backend');
    await images.createImage({id: 'late'});
    imageReads = 0;
    const lateResidency = await locator.locate(objectRef('late', 'shape'));
    assert.equal(lateResidency?.imageId, 'late');
    assert.equal(imageReads, 1, 'absent residency is never cached, so a newly created image resolves immediately');
    assert.equal(await locator.locate(objectRef('late', 'other')), lateResidency);
    assert.equal(imageReads, 1, 'newly confirmed residency is cached Thereafter');
    backend.get = origGet;

    await assert.rejects(
      resolver.resolveAt(objectRef('other', 'shape'), residency),
      /residency does not match the ObjectRef image/,
    );
  } finally {
    await backend.stop();
  }
});

test('ImageService record reads route through the locator and remote-resolution owners', async () => {
  const backend = new MockBackend();
  await backend.start();
  try {
    let located = 0;
    let resolved = 0;
    const ownerLocator = new ObjectLocator({backend});
    const ownerResolver = new RemoteRecordResolver();
    const locator = {
      async locate(ref) {
        located += 1;
        return await ownerLocator.locate(ref);
      },
    };
    const remoteResolution = {
      async resolveAt(ref, residency) {
        resolved += 1;
        return await ownerResolver.resolveAt(ref, residency);
      },
    };
    const images = new ImageService({backend, locator, remoteResolution});
    await images.createImage({id: 'app'});
    await images.putShape('app', {id: 'shape', slots: []});

    assert.equal((await images.getShape('app', 'shape')).id, 'shape');
    assert.equal(located, 1);
    assert.equal(resolved, 1);

    await assert.rejects(
      images.getObject('missing', 'object'),
      {name: 'TypeError', message: 'image not found: missing'},
    );
    assert.equal(located, 2);
    assert.equal(resolved, 1, 'missing residency never reaches record resolution');
  } finally {
    await backend.stop();
  }
});

test('execution-scoped arenaImagesView memoizes durable object reads and invalidates on write or new execution', async () => {
  const backend = new MockBackend();
  await backend.start();
  try {
    const images = new ImageService({backend});
    await images.createImage({id: 'app'});
    const shape = await images.putShape('app', {
      id: 'counter-shape',
      slots: [{id: 'count', name: 'count'}],
    });
    await images.putObject('app', {
      id: 'counter',
      shape: objectRef('app', shape.id),
      slots: {count: integerValue(1)},
    });

    let objectReads = 0;
    const origGet = backend.get.bind(backend);
    backend.get = async (collection, key) => {
      if (collection === records('app') && key === 'counter') objectReads += 1;
      return await origGet(collection, key);
    };

    const arena1 = new LexicalCellArena();
    const view1 = arenaImagesView(images, arena1);
    const first = await view1.getObject('app', 'counter');
    const second = await view1.getObject('app', 'counter');
    assert.equal(first.slots.count.value, '1');
    assert.equal(second.slots.count.value, '1');
    assert.equal(objectReads, 1, 'repeated durable object reads within one execution reuse the arena memo');

    await view1.putObject('app', {
      id: 'counter',
      shape: objectRef('app', shape.id),
      slots: {count: integerValue(2)},
    }, {expectedVersion: first._version});
    const afterInArenaWrite = await view1.getObject('app', 'counter');
    assert.equal(afterInArenaWrite.slots.count.value, '2', 'in-execution putObject immediately updates the arena memo');
    assert.equal(objectReads, 1, 'reading after in-execution putObject uses the saved record without an extra backend get');

    view1.invalidateObject('app', 'counter');
    const afterInvalidate = await view1.getObject('app', 'counter');
    assert.equal(afterInvalidate.slots.count.value, '2');
    assert.equal(objectReads, 2, 'invalidateObject forces the next read in the same execution to re-read from the backend');

    // Simulate an external update (e.g. from another runtime or outside the arena) before the next execution.
    await images.putObject('app', {
      id: 'counter',
      shape: objectRef('app', shape.id),
      slots: {count: integerValue(3)},
    }, {expectedVersion: afterInArenaWrite._version});

    const arena2 = new LexicalCellArena();
    const view2 = arenaImagesView(images, arena2);
    const freshInNextExecution = await view2.getObject('app', 'counter');
    assert.equal(freshInNextExecution.slots.count.value, '3', 'a new execution arena reads fresh durable state from the backend');
    assert.equal(objectReads, 3);
  } finally {
    await backend.stop();
  }
});

test('PlacementPolicy relocates an object across separate backends with per-object residency, routes reads and writes, prevents duplicate live records, and relocates back', async () => {
  const backendB = new MockBackend();
  const backendA = new MockBackend();
  await backendB.start();
  await backendA.start();
  try {
    const imagesB = new ImageService({backend: backendB});
    const imagesA = new ImageService({backend: backendA});
    await imagesB.createImage({id: 'app'});
    const shape = await imagesB.putShape('app', {
      id: 'cell-shape',
      slots: [{id: 'count', name: 'count'}],
    });
    const created = await imagesB.putObject('app', {
      id: 'cell-1',
      shape: objectRef('app', shape.id),
      slots: {count: integerValue(10)},
    });

    const placement = new PlacementPolicy({
      nodes: {
        'node-b': imagesB,
        'node-a': imagesA,
      },
    });
    const ref = objectRef('app', 'cell-1');

    const before = await placement.inspectResidency(ref);
    assert.deepEqual(before, {
      imageId: 'app',
      objectId: 'cell-1',
      node: 'node-b',
      kind: WHOLE_IMAGE_RESIDENCY,
      version: created._version,
    });

    const moved = await placement.relocateObject({
      ref,
      fromNode: 'node-b',
      toNode: 'node-a',
    });
    assert.equal(moved.residencyKind, PER_OBJECT_RESIDENCY);
    assert.equal(moved.fromNode, 'node-b');
    assert.equal(moved.toNode, 'node-a');

    const residencyOnB = await imagesB.locator.locate(ref);
    assert.equal(residencyOnB.kind, PER_OBJECT_RESIDENCY);
    assert.deepEqual(
      Object.keys(residencyOnB).sort(),
      ['imageId', 'kind', 'objectId'],
      'per-object residency remains opaque and exposes no backend or node address',
    );
    const residencyOnA = await imagesA.locator.locate(ref);
    assert.equal(residencyOnA.kind, PER_OBJECT_RESIDENCY);

    const afterMove = await placement.inspectResidency(ref);
    assert.equal(afterMove.node, 'node-a');
    assert.equal(afterMove.kind, PER_OBJECT_RESIDENCY);
    assert.equal(await placement.selectExecutionNode(ref), 'node-a');

    imagesA.remoteResolution.resetStats();
    imagesB.remoteResolution.resetStats();

    // Both nodes resolve the relocated object at its unchanged (imageId, objectId) identity.
    const readFromB = await imagesB.getObject('app', 'cell-1');
    const readFromA = await imagesA.getObject('app', 'cell-1');
    assert.equal(readFromB.slots.count.value, '10');
    assert.equal(readFromA.slots.count.value, '10');
    assert.equal(
      imagesB.remoteResolution.stats().perObjectRecordReads,
      1,
      'reading relocated object from node B requires one per-object remote read',
    );
    assert.equal(
      imagesA.remoteResolution.stats().perObjectRecordReads,
      0,
      'reading relocated object on resident node A requires zero remote per-object reads',
    );
    assert.equal(
      imagesA.remoteResolution.stats().localRecordReads,
      1,
      'reading relocated object on resident node A resolves locally',
    );

    // Mutating the relocated object from node B updates the resident copy on node A.
    const updated = await imagesB.putObject('app', {
      id: 'cell-1',
      shape: objectRef('app', shape.id),
      slots: {count: integerValue(25)},
    }, {expectedVersion: readFromB._version});
    assert.equal(updated.slots.count.value, '25');
    assert.equal(imagesB.remoteResolution.stats().perObjectRecordWrites, 1);
    assert.equal((await imagesA.getObject('app', 'cell-1')).slots.count.value, '25');
    assert.equal((await imagesB.getObject('app', 'cell-1')).slots.count.value, '25');

    // Relocating back to node B restores whole-image residency on node B without identity loss.
    const [movedBack] = await placement.relocateObjects({
      refs: [ref],
      fromNode: 'node-a',
      toNode: 'node-b',
    });
    assert.equal(movedBack.residencyKind, WHOLE_IMAGE_RESIDENCY);
    const afterBack = await placement.inspectResidency(ref);
    assert.equal(afterBack.node, 'node-b');
    assert.equal(afterBack.kind, WHOLE_IMAGE_RESIDENCY);
    assert.equal(await placement.selectExecutionNode(ref), 'node-b');
    assert.equal((await imagesB.getObject('app', 'cell-1')).slots.count.value, '25');
    assert.equal((await imagesA.getObject('app', 'cell-1')).slots.count.value, '25');
  } finally {
    await backendA.stop();
    await backendB.stop();
  }
});

test('two independent Images runtimes execute unchanged Life across one shared SQL application server through the locator and remote-resolution owners', async () => {
  const server = createSqliteApplicationRuntime();
  await server.start();
  try {
    const fixture = await loadSharedLifeFixture();
    await proveSharedLife(server, fixture);
  } finally {
    await server.stop();
  }
});
