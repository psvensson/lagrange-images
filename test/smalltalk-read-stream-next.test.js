import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime, installSymmetricSmalltalkStandardImage, installSymmetricSmalltalkBlock,
  installSmalltalkReadStreamProtocol, installSmalltalkTextReadStreamProtocol,
  objectRef, textValue, integerValue, booleanValue,
} from '../src/runtime.js';

for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} ReadStream next preserves scalar identity, cursor and EOF`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      const imageId = 'read-next';
      await runtime.images.createImage({id: imageId});
      const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
      const {kernel} = await installSymmetricSmalltalkStandardImage(options);
      const {block} = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id: 'open', source: '[ :text | text readStream ]'});
      const open = async text => runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef(imageId, block.id), [textValue(text)]));
      const send = async (receiver, selector, args = []) => runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: 'symmetric-smalltalk', receiver, message: textValue(selector), arguments: args,
      }, {dispatchImage: imageId}));
      for (const text of ['', 'a', 'λ𝄞z']) {
        const stream = await open(text);
        const independent = await open(text);
        let position = 0;
        assert.deepEqual(await send(stream, 'atEnd'), booleanValue(position >= [...text].length));
        for (const scalar of [...text]) {
          assert.deepEqual(await send(stream, 'next'), await send(textValue(scalar), 'at:', [integerValue(1)]));
          position++;
          assert.deepEqual(await send(stream, 'atEnd'), booleanValue(position >= [...text].length));
          const record = await runtime.images.getObject(stream.imageId, stream.objectId);
          assert.deepEqual(record.slots['read-stream-position'], integerValue(position));
          const frontier = await runtime.images.frontier(imageId);
          await installSmalltalkReadStreamProtocol(options);
          await installSmalltalkTextReadStreamProtocol(options);
          assert.equal(await runtime.images.frontier(imageId), frontier, 'replay does not write');
          assert.deepEqual(await runtime.images.getObject(stream.imageId, stream.objectId), record, 'replay does not reset consumed input');
        }
        const atEnd = await runtime.images.getObject(stream.imageId, stream.objectId);
        assert.deepEqual(await send(stream, 'next'), kernel.nil);
        assert.deepEqual(await send(stream, 'atEnd'), booleanValue(true));
        assert.deepEqual(await send(stream, 'next'), kernel.nil);
        assert.deepEqual(await runtime.images.getObject(stream.imageId, stream.objectId), atEnd, 'EOF does not mutate the cursor or record');
        assert.deepEqual(await send(independent, 'next'), text.length === 0 ? kernel.nil : await send(textValue(text), 'at:', [integerValue(1)]));
      }
    } finally { await runtime.close(); }
  });
}
