import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue, createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, objectRef,
} from '../src/runtime.js';

// Measured in the pinned Cuis image, including DEL and the first non-ASCII scalar.
const CASES = [[0, true], [32, true], [110, true], [127, true], [128, false],
  [170, false], [255, false], [955, false], [119070, false], [1114111, false]];
for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Character isAscii preserves the pinned seven-bit boundary`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      const imageId = 'is-ascii';
      await runtime.images.createImage({id: imageId});
      await installSymmetricSmalltalkStandardImage({images: runtime.images, compilation: runtime.compilation, imageId, lane});
      for (const [scalar, expected] of CASES) {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId, id: `scalar-${scalar}`,
          source: `[ $${String.fromCodePoint(scalar)} isAscii ]`,
        });
        assert.deepEqual(await runtime.executor.execute(await runtime.invocations.invokeBlock(
          objectRef(imageId, block.id), [],
        )), booleanValue(expected), `scalar ${scalar}`);
      }
    } finally { await runtime.close(); }
  });
}
