import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, integerValue, objectRef,
} from '../src/runtime.js';

// Pinned Cuis Character>>asciiValue answers nil outside the 128-character ASCII set.
for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Character asciiValue preserves the ASCII boundary`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      await runtime.images.createImage({id: 'ascii'});
      await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'ascii', lane,
      });
      let sequence = 0;
      const evaluate = async source => {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'ascii', id: `ascii-${sequence++}`, source,
        });
        return runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef('ascii', block.id), []));
      };
      const nil = await evaluate('[ nil ]');
      for (const scalar of [0, 58, 127, 128, 255, 256, 955, 119070, 1114111]) {
        const answer = await evaluate(`[ $${String.fromCodePoint(scalar)} asciiValue ]`);
        assert.deepEqual(answer, scalar < 128 ? integerValue(scalar) : nil, `scalar ${scalar}`);
      }
    } finally { await runtime.close(); }
  });
}
