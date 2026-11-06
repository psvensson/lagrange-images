import test from 'node:test';
import assert from 'node:assert/strict';
import {MockBackend} from '../src/backend/mock-backend.js';
import {ObjectLocator, WHOLE_IMAGE_RESIDENCY} from '../src/graph/locator.js';
import {RemoteRecordResolver} from '../src/graph/remote-resolution.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {objectRef} from '../src/value/scalars.js';
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
