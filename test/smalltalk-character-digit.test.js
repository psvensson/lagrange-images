import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue, createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, objectRef,
} from '../src/runtime.js';

// Character>>isDigit in pinned Cuis recognizes ASCII 0 through 9 only.
for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Character isDigit preserves the pinned ASCII predicate`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      await runtime.images.createImage({id: 'digit'});
      await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'digit', lane,
      });
      for (const scalar of [0, 47, 48, 49, 56, 57, 58, 178, 1632, 1776, 65296, 1114111]) {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'digit', id: `digit-${scalar}`,
          source: `[ $${String.fromCodePoint(scalar)} isDigit ]`,
        });
        const actual = await runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef('digit', block.id), []));
        assert.deepEqual(actual, booleanValue(scalar >= 48 && scalar <= 57), `scalar ${scalar}`);
      }
    } finally { await runtime.close(); }
  });
}
