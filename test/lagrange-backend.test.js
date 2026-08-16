import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_IMAGE_TABLES,
  LagrangeBackend,
  VersionConflictError,
} from '../src/backend/index.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {registerBackendConformanceTests} from './support/backend-conformance.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

function createBackend(filename = ':memory:') {
  return new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
}

registerBackendConformanceTests({
  name: 'Lagrange SQL adapter',
  createBackend,
  VersionConflictError,
});

test('Lagrange backend creates only its five owned schema tables', async () => {
  const runtime = createSqliteApplicationRuntime();
  const backend = new LagrangeBackend({runtime});
  await backend.start();
  try {
    assert.deepEqual(runtime.listTables(), Object.values(LAGRANGE_IMAGE_TABLES).sort());
  } finally {
    await backend.stop();
  }
});

test('Lagrange backend isolates encoded collections, image IDs and prefixes', async () => {
  const backend = createBackend();
  await backend.start();
  try {
    await backend.put('image:a/b:objects', 'same/key', {value: 1}, {expectedVersion: 0});
    await backend.put('image:a:objects', 'b/same/key', {value: 2}, {expectedVersion: 0});
    await backend.put('odd\' collection ?', 'å/key', {value: 3}, {expectedVersion: 0});
    await backend.put('odd\' collection ?', 'other', {value: 4}, {expectedVersion: 0});
    await backend.put('images', '😀/one', {value: 5}, {expectedVersion: 0});
    await backend.put('images', 'other', {value: 6}, {expectedVersion: 0});

    assert.equal((await backend.get('image:a/b:objects', 'same/key')).value, 1);
    assert.equal((await backend.get('image:a:objects', 'b/same/key')).value, 2);
    assert.deepEqual(
      await backend.scan('odd\' collection ?', {prefix: 'å/'}),
      [{key: 'å/key', value: {value: 3, _version: 1}}],
    );
    assert.deepEqual(
      await backend.scan('images', {prefix: '😀/'}),
      [{key: '😀/one', value: {value: 5, _version: 1}}],
    );
  } finally {
    await backend.stop();
  }
});

test('Lagrange backend persists the neutral graph and history through the image service', async () => {
  const backend = createBackend();
  await backend.start();
  try {
    const images = new ImageService({backend, clock: () => new Date('2026-08-16T00:00:00.000Z')});
    await images.createImage({id: 'durable'});
    await images.putShape('durable', {id: 'shape', slots: []});
    await images.putObject('durable', {
      id: 'root',
      shape: {kind: 'ref', imageId: 'durable', objectId: 'shape'},
      slots: {},
    });
    await images.setRoot('durable', 'root');

    assert.equal((await images.getImage('durable')).rootObjectId, 'root');
    assert.deepEqual(
      (await images.history('durable')).map(({type, revision}) => ({type, revision})),
      [
        {type: 'image.created', revision: 1},
        {type: 'shape.put', revision: 2},
        {type: 'object.put', revision: 3},
        {type: 'image.root-set', revision: 4},
      ],
    );
  } finally {
    await backend.stop();
  }
});

test('Lagrange backend transaction handles expire after callback settlement', async () => {
  const backend = createBackend();
  await backend.start();
  let escaped;
  try {
    await backend.transaction(async (transaction) => {
      escaped = transaction;
      await transaction.put('things', 'one', {value: 1}, {expectedVersion: 0});
    });
    await assert.rejects(
      escaped.put('things', 'two', {value: 2}, {expectedVersion: 0}),
      /transaction is no longer active/,
    );
    assert.equal(await backend.get('things', 'two'), undefined);
  } finally {
    await backend.stop();
  }
});
