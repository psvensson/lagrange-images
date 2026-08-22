import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  installSymmetricSmalltalkStandardImage,
} from '../src/runtime.js';

test('standard-image caller errors are refused before the kernel is written', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});

    await assert.rejects(
      installSymmetricSmalltalkStandardImage({images: runtime.images, imageId: 'app'}),
      /compilation service with compileArtifact is required/,
    );
    assert.equal(
      await runtime.images.getObject('app', 'smalltalk-kernel/v1'),
      null,
      'a missing required service must not leave a partial kernel behind',
    );

    await assert.rejects(
      installSymmetricSmalltalkStandardImage({
        images: {},
        compilation: runtime.compilation,
        imageId: 'app',
      }),
      /images service with getImage\/getObject is required/,
    );
  } finally {
    await runtime.close();
  }
});
