import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageService, MockBackend} from '../src/index.js';

test('image service builds an object graph with history and snapshots', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({
    backend,
    clock: () => new Date('2026-08-13T18:00:00.000Z'),
  });

  const image = await service.createImage({id: 'demo', name: 'Demo'});
  const root = await service.putObject(image.id, {
    id: 'root',
    classId: 'Workspace',
    slots: {title: 'hello'},
  });
  const rooted = await service.setRoot(image.id, root.id);
  const snapshot = await service.snapshot(image.id, {id: 's1', label: 'first'});
  const history = await service.history(image.id);

  assert.equal(rooted.rootObjectId, 'root');
  assert.equal(snapshot.objects.length, 1);
  assert.deepEqual(history.map(({type}) => type), [
    'image.created',
    'object.put',
    'image.root-set',
  ]);
});
