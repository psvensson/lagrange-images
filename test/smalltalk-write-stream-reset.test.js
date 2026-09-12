import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue, createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, objectRef,
} from '../src/runtime.js';

// The pinned xxm.9 oracle returns the same stream and empty Unicode contents after reset.
// A shorter subsequent write distinguishes reset from retaining the old written suffix.
const CASES = [
  `[ | stream | stream := WriteStream on: 'seed'.
     (stream reset == stream) and: [stream contents = ''] ]`,
  `[ | stream before | stream := WriteStream on: ''.
     stream nextPutAll: 'long λ'; nextPut: $𝄞.
     before := stream contents.
     (stream reset == stream) and: [
       (before = 'long λ𝄞') and: [stream contents = ''] ] ]`,
  `[ | stream before | stream := WriteStream on: ''.
     stream nextPutAll: 'long λ'; nextPut: $𝄞. stream reset.
     stream nextPut: $λ. before := stream contents.
     stream reset; reset; nextPutAll: 'x'.
     (before = 'λ') and: [stream contents = 'x'] ]`,
  `[ | stream input | input := OrderedCollection new. input add: 42.
     stream := WriteStream on: input. stream nextPutAll: input.
     stream reset.
     (stream contents class == OrderedCollection) and: [
       (stream contents size = 0) and: [input size = 1] ] ]`,
];

for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} WriteStream reset preserves identity and clears only its written prefix`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      const imageId = 'stream-reset';
      await runtime.images.createImage({id: imageId});
      await installSymmetricSmalltalkStandardImage({images: runtime.images, compilation: runtime.compilation, imageId, lane});
      for (const [index, source] of CASES.entries()) {
        const {block} = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id: `reset-${index}`, source});
        assert.deepEqual(await runtime.executor.execute(await runtime.invocations.invokeBlock(
          objectRef(imageId, block.id), [],
        )), booleanValue(true), `case ${index}`);
      }
    } finally { await runtime.close(); }
  });
}
