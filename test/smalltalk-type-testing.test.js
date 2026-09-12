import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime, installSymmetricSmalltalkStandardImage, installSymmetricSmalltalkBlock,
  booleanValue, objectRef, textValue, ensureNamedClass, ensureSmalltalkShape, defineMethodsFromSource,
} from '../src/runtime.js';

// Pinned Cuis Object default and CharacterSequence overrides, measured by the real M4 consumer.
const CASES = [
  ['$e', false], ['$λ', false], ["'en'", true], ["''", true], ["'λ'", true],
  ['#en', true], ['1', false], ['nil', false], ['true', false],
  ['#()', false],
];
for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} isString preserves ordinary defaults and overrides`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      const imageId = 'type-testing';
      await runtime.images.createImage({id: imageId});
      const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
      const {kernel} = await installSymmetricSmalltalkStandardImage(options);
      for (const [index, [source, expected]] of CASES.entries()) {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId, id: `query-${index}`, source: `[ (${source}) isString ]`,
        });
        assert.deepEqual(await runtime.executor.execute(await runtime.invocations.invokeBlock(
          objectRef(imageId, block.id), [],
        )), booleanValue(expected), source);
      }
      const instanceShape = await ensureSmalltalkShape(runtime.images, imageId, {id: 'string-like-shape', slots: []});
      const {classRef} = await ensureNamedClass({
        images: runtime.images, imageId, name: 'StringLike', superclassRef: kernel.objectClass,
        instanceShapeRef: instanceShape,
      });
      const send = async (receiver, selector) => runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: 'symmetric-smalltalk', receiver, message: textValue(selector), arguments: [],
      }));
      const instance = await send(classRef, 'new');
      assert.deepEqual(await send(instance, 'isString'), booleanValue(false), 'Object default is inherited');
      await defineMethodsFromSource({...options, classRef, methods: [{selector: 'isString', source: '[ ^ true ]'}]});
      assert.deepEqual(await send(instance, 'isString'), booleanValue(true), 'ordinary subclass override decides');
      const frontier = await runtime.images.frontier(imageId);
      await installSymmetricSmalltalkStandardImage(options);
      assert.equal(await runtime.images.frontier(imageId), frontier, 'replay is write-free');
      assert.deepEqual(await send(instance, 'isString'), booleanValue(true), 'replay preserves subclass policy');
    } finally { await runtime.close(); }
  });
}
