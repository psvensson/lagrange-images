import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime, installSymmetricSmalltalkBlock, installSymmetricSmalltalkStandardImage,
  integerValue, objectRef, textValue,
} from '../src/runtime.js';

for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Text readStream constructs fresh ordinary scalar streams`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      const imageId = 'read-stream';
      await runtime.images.createImage({id: imageId});
      await installSymmetricSmalltalkStandardImage({images: runtime.images, compilation: runtime.compilation, imageId, lane});
      const {block} = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId, id: 'construct-stream', source: '[ :text | text readStream ]',
      });
      const construct = async text => runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef(imageId, block.id), [textValue(text)],
      ));
      for (const text of ['', 'abc', 'λ𝄞z']) {
        const ref = await construct(text);
        const other = await construct(text);
        assert.notDeepEqual(ref, other, 'each constructor allocates a distinct stream');
        const record = await runtime.images.getObject(ref.imageId, ref.objectId);
        assert.deepEqual(record.behavior, objectRef(imageId, 'smalltalk/class/ReadStream'));
        const shape = await runtime.images.getShape(record.shape.imageId, record.shape.objectId);
        const state = Object.fromEntries(shape.slots.map(slot => [slot.name, record.slots[slot.id]]));
        assert.deepEqual(state, {collection: textValue(text), position: integerValue(0), readLimit: integerValue([...text].length)});
        const before = await runtime.images.frontier(imageId);
        await installSymmetricSmalltalkStandardImage({images: runtime.images, compilation: runtime.compilation, imageId, lane});
        assert.equal(await runtime.images.frontier(imageId), before, 'replay is write-free');
        assert.deepEqual(await runtime.images.getObject(ref.imageId, ref.objectId), record, 'replay preserves the live stream');
      }
    } finally { await runtime.close(); }
  });
}
