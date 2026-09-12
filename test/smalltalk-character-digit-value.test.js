import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, integerValue, objectRef,
} from '../src/runtime.js';

// Pinned Character>>digitValue accepts ASCII decimal digits and uppercase A-Z only.
const CASES = [[0,-1],[47,-1],[48,0],[49,1],[57,9],[58,-1],[64,-1],[65,10],[70,15],
  [90,35],[91,-1],[96,-1],[97,-1],[102,-1],[122,-1],[123,-1],[255,-1],[955,-1],[1632,-1],[1114111,-1]];
for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Character digitValue preserves uppercase-only conversion and invalid results`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      await runtime.images.createImage({id: 'digit-value'});
      await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'digit-value', lane,
      });
      for (const [scalar, expected] of CASES) {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'digit-value', id: `value-${scalar}`,
          source: `[ $${String.fromCodePoint(scalar)} digitValue ]`,
        });
        assert.deepEqual(await runtime.executor.execute(await runtime.invocations.invokeBlock(
          objectRef('digit-value', block.id), [],
        )), integerValue(expected), `scalar ${scalar}`);
      }
    } finally { await runtime.close(); }
  });
}
