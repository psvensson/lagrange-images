import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime, installSmalltalkKernel, installSmalltalkAllocationProtocol,
  installSmalltalkEqualityProtocol, installSmalltalkDictionaryProtocol,
  installSmalltalkInstanceVariableProtocol, installSmalltalkSymbolProtocol,
  installSymmetricSmalltalkBlock, objectRef, textValue,
} from '../src/runtime.js';

async function seed(runtime, imageId, lane) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkDictionaryProtocol(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  await installSmalltalkSymbolProtocol(options);
  return options;
}

for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Text asSymbol preserves spelling and canonical image identity`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      const refs = [];
      for (const imageId of ['symbols-a', 'symbols-b']) {
        const options = await seed(runtime, imageId, lane);
        const send = async (receiver, selector) => runtime.executor.execute(await runtime.invocations.sendMessage({
          languageId: 'symmetric-smalltalk', receiver, message: textValue(selector), arguments: [],
        }, {dispatchImage: imageId}));
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId, id: 'literal-note', source: '[ #note ]',
        });
        const literal = await runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef(imageId, block.id), []));
        for (const spelling of ['', 'note', 'note:', 'λ', '𝄞', 'a b', 'é', 'e\u0301']) {
          const symbol = await send(textValue(spelling), 'asSymbol');
          assert.equal(symbol.kind, 'ref', 'conversion returns a Symbol object, not its Text spelling');
          assert.deepEqual(await send(symbol, 'class'), objectRef(imageId, 'smalltalk/class/Symbol'));
          assert.deepEqual(await send(symbol, 'asString'), textValue(spelling), 'exact spelling');
          assert.deepEqual(await send(textValue(spelling), 'asSymbol'), symbol, 'repeated conversion is the same object');
          if (spelling === 'note') assert.deepEqual(symbol, literal, 'conversion and literal share the existing interner');
        }
        const note = await send(textValue('note'), 'asSymbol');
        const record = await runtime.images.getObject(note.imageId, note.objectId);
        const frontier = await runtime.images.frontier(imageId);
        await installSmalltalkSymbolProtocol(options);
        assert.equal(await runtime.images.frontier(imageId), frontier, 'protocol replay is write-free');
        assert.deepEqual(await runtime.images.getObject(note.imageId, note.objectId), record);
        assert.deepEqual(await send(textValue('note'), 'asSymbol'), note);
        assert.notDeepEqual(await send(textValue('é'), 'asSymbol'), await send(textValue('e\u0301'), 'asSymbol'), 'no Unicode normalization');
        refs.push(note);
      }
      assert.notDeepEqual(refs[0], refs[1], 'different images never share Symbol identity');
    } finally { await runtime.close(); }
  });
}
