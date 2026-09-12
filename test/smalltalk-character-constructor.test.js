import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue, createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, objectRef,
} from '../src/runtime.js';

for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Character codePoint: shares canonical literal and Text identities`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      await runtime.images.createImage({id: 'constructor'});
      await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'constructor', lane,
      });
      let sequence = 0;
      const evaluate = async source => {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'constructor', id: `constructor-${sequence++}`, source,
        });
        return runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef('constructor', block.id), []));
      };
      for (const scalar of [0, 58, 127, 128, 955, 119070, 1114111]) {
        const character = String.fromCodePoint(scalar);
        assert.deepEqual(await evaluate(`[ | first |
          first := Character codePoint: ${scalar}.
          (first == (Character codePoint: ${scalar})) and: [
            (first == $${character}) and: [(first == ('${character}' at: 1)) and: [first codePoint = ${scalar}]] ] ]`), booleanValue(true));
      }
      for (const scalar of [-1, 55296, 57343, 1114112]) {
        await assert.rejects(evaluate(`[ Character codePoint: ${scalar} ]`), /not a Unicode scalar value/);
      }
      await assert.rejects(evaluate("[ Character codePoint: '65' ]"), /must be an Integer Value/);
    } finally { await runtime.close(); }
  });
}
