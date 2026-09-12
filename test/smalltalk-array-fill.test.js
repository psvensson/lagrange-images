import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue, createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, objectRef,
} from '../src/runtime.js';

// Pinned Cuis oracle on 7cd: atAllPut: fills existing indices and answers the receiver,
// including an empty receiver. Object values are shared references, never copies.
for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Array atAllPut: preserves identity, size and supplied references`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      await runtime.images.createImage({id: 'fill'});
      await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'fill', lane,
      });
      let sequence = 0;
      const evaluate = async source => {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'fill', id: `fill-${sequence++}`, source,
        });
        return runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef('fill', block.id), []));
      };
      assert.deepEqual(await evaluate(`[ | array answer |
        array := #(1 2 3). answer := array atAllPut: false.
        (answer == array) and: [ (array size = 3) and: [
          ((array at: 1) = false) and: [
            ((array at: 2) = false) and: [ (array at: 3) = false ] ] ] ] ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | empty |
        empty := Array new: 0.
        ((empty atAllPut: 7) == empty) and: [empty size = 0] ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | array marker |
        array := Array new: 2. marker := Dictionary new.
        array atAllPut: marker. marker at: 'value' put: 42.
        ((array at: 1) == marker) and: [ ((array at: 2) == marker) and: [
          (((array at: 1) at: 'value') = 42) and: [ ((array at: 2) at: 'value') = 42 ] ] ] ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | array |
        array := #(1). array atAllPut: 2. array atAllPut: 3.
        (array size = 1) and: [(array at: 1) = 3] ]`), booleanValue(true));
    } finally { await runtime.close(); }
  });
}
