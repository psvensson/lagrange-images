import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageService, MockBackend, VersionConflictError, objectRef, textValue} from '../src/runtime.js';

test('graph service stores typed records with history and snapshots', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({backend, clock: () => new Date('2026-08-13T18:00:00.000Z')});
  const image = await service.createImage({id: 'demo', name: 'Demo'});
  const shape = await service.putShape(image.id, {
    id: 'workspace-shape-v1',
    slots: [{id: 'slot-title', name: 'title'}],
  });
  const root = await service.putObject(image.id, {
    id: 'root',
    shape: objectRef(image.id, shape.id),
    slots: {'slot-title': textValue('hello')},
  });
  await service.setRoot(image.id, root.id);
  const snapshot = await service.snapshot(image.id, {id: 's1'});
  assert.equal(snapshot.records.length, 2);
  assert.deepEqual((await service.history(image.id)).map(({type}) => type), [
    'image.created', 'shape.put', 'object.put', 'image.root-set',
  ]);
});

test('shape identities are immutable', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({backend});
  await service.createImage({id: 'demo'});
  await service.putShape('demo', {id: 'shape-v1', slots: []});
  const history = await service.history('demo');
  await assert.rejects(service.putShape('demo', {id: 'shape-v1', slots: []}), VersionConflictError);
  assert.deepEqual(await service.history('demo'), history);
});

test('generic objects reject language-specific shortcut fields', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({backend});
  await service.createImage({id: 'demo'});
  await service.putShape('demo', {id: 'shape', slots: []});
  await assert.rejects(
    service.putObject('demo', {id: 'bad', classId: 'Thing', shape: objectRef('demo', 'shape'), slots: {}}),
    /unknown generic object fields: classId/,
  );
  await assert.rejects(
    service.putObject('demo', {id: 'bad2', source: '...', shape: objectRef('demo', 'shape'), slots: {}}),
    /unknown generic object fields: source/,
  );
});

// ADR 0047 made this asymmetry consequential: `indexed` is optional, so a typo does not merely get
// dropped — it stores a *different layout* than the caller wrote, and the failure surfaces later, on
// an object write, naming neither the typo nor the call that made it.
test('shapes reject unknown input fields rather than silently dropping them', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({backend});
  await service.createImage({id: 'demo'});

  await assert.rejects(
    service.putShape('demo', {id: 'typo', slots: [], indexd: 'values'}),
    /unknown shape fields: indexd/,
  );
  await assert.rejects(
    service.putShape('demo', {id: 'shortcut', slots: [], classId: 'Thing'}),
    /unknown shape fields: classId/,
  );
});

test('a rejected shape write leaves neither a record nor a history event', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({backend});
  await service.createImage({id: 'demo'});
  const history = await service.history('demo');

  await assert.rejects(service.putShape('demo', {id: 'typo', slots: [], indexd: 'values'}), /unknown shape fields/);
  assert.equal(await service.getShape('demo', 'typo'), null);
  assert.deepEqual(await service.history('demo'), history);
});

test('a valid indexed declaration still round-trips', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({backend});
  await service.createImage({id: 'demo'});

  await service.putShape('demo', {id: 'array-shape', slots: [], indexed: 'values'});
  assert.equal((await service.getShape('demo', 'array-shape')).indexed, 'values');

  // Absence still means `none`, and must not be materialized into the stored record.
  await service.putShape('demo', {id: 'plain-shape', slots: []});
  assert.equal(Object.hasOwn(await service.getShape('demo', 'plain-shape'), 'indexed'), false);
});

test('cycles use references rather than nested records', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({backend});
  await service.createImage({id: 'cycle'});
  await service.putShape('cycle', {id: 'node-shape', slots: [{id: 'peer', name: 'peer'}]});
  await service.putObject('cycle', {id: 'a', shape: objectRef('cycle', 'node-shape'), slots: {peer: objectRef('cycle', 'b')}});
  await service.putObject('cycle', {id: 'b', shape: objectRef('cycle', 'node-shape'), slots: {peer: objectRef('cycle', 'a')}});
  assert.equal((await service.getObject('cycle', 'a')).slots.peer.objectId, 'b');
  assert.equal((await service.getObject('cycle', 'b')).slots.peer.objectId, 'a');
});

test('graph service rolls state back when its history append fails', async () => {
  class RejectingHistoryBackend extends MockBackend {
    async transaction(work) {
      return await super.transaction(async (transaction) => {
        return await work(Object.freeze({
          ...transaction,
          async append() {
            throw new Error('history unavailable');
          },
        }));
      });
    }
  }

  const backend = new RejectingHistoryBackend();
  await backend.start();
  const service = new ImageService({backend});

  await assert.rejects(
    service.createImage({id: 'atomic'}),
    /history unavailable/,
  );
  assert.equal(await backend.get('images', 'atomic'), undefined);
  assert.deepEqual(await backend.readStream('image:atomic:history'), []);
  await backend.stop();
});
