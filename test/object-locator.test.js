import test from 'node:test';
import assert from 'node:assert/strict';
import {MockBackend} from '../src/backend/mock-backend.js';
import {ObjectLocator, WHOLE_IMAGE_RESIDENCY} from '../src/graph/locator.js';
import {RemoteRecordResolver} from '../src/graph/remote-resolution.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {objectRef} from '../src/value/scalars.js';

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
