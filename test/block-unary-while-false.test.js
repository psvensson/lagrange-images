import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime, installSymmetricSmalltalkStandardImage, installSymmetricSmalltalkBlock,
  installWasmBlockTree, integerValue, objectRef, textValue, findSmalltalkBlockProtocol,
  defineMethodsFromSource,
} from '../src/runtime.js';

for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} unary whileFalse repeats ordinary conditions and answers nil`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      const imageId = 'unary-loop';
      await runtime.images.createImage({id: imageId});
      const standard = await installSymmetricSmalltalkStandardImage({images: runtime.images, compilation: runtime.compilation, imageId, lane});
      let sequence = 0;
      const evaluate = async source => {
        const id = `loop-${sequence++}`;
        const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
        const tree = lane === 'wasm' ? await installWasmBlockTree({
          images: runtime.images, compilation: runtime.compilation,
          semanticRef: objectRef(imageId, installed.semanticArtifact.id), id: `${id}-wasm`,
          environment: installed.block.environment,
        }) : installed;
        return runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef(imageId, tree.block.id), []));
      };
      assert.deepEqual(await evaluate('[ | n | n := 0. [n := n + 1. n = 3] whileFalse. n ]'), integerValue(3));
      assert.deepEqual(await evaluate('[ | n | n := 0. [n := n + 1. true] whileFalse. n ]'), integerValue(1));
      assert.deepEqual(await evaluate('[ [true] whileFalse ]'), standard.kernel.nil);
      assert.deepEqual(await evaluate('[ | n | n := 0. [n := n + 1. n = 3] whileFalse ]'), standard.kernel.nil);
      await assert.rejects(evaluate('[ [7] whileFalse ]'), /condition answered a integer Value; a Boolean is required/);
      await assert.rejects(evaluate('[ [nil missingUnaryLoopCondition] whileFalse ]'), /missingUnaryLoopCondition/);
      await defineMethodsFromSource({
        images: runtime.images, compilation: runtime.compilation, imageId, lane,
        classRef: standard.kernel.integerClass,
        methods: [{selector: 'unaryLoopReturn', source: '[ [^ 41] whileFalse. ^ 99 ]'}],
      });
      assert.deepEqual(await evaluate('[ 0 unaryLoopReturn ]'), integerValue(41), 'non-local return escapes the loop through ordinary invocation');
      const {block} = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id: 'condition', source: '[true]'});
      const protocol = await findSmalltalkBlockProtocol({images: runtime.images, imageId});
      const send = async (receiver, selector, args) => runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: 'symmetric-smalltalk', receiver, message: textValue(selector), arguments: args,
      }));
      await assert.rejects(send(objectRef(imageId, block.id), 'whileFalse', [integerValue(1)]), /Block does not understand: whileFalse/);
      await assert.rejects(send(protocol.whileFalse, 'whileFalse', []), /kernel-primitive Block as the condition/);
      await assert.rejects(runtime.executor.execute(await runtime.invocations.invokeBlock(protocol.whileFalse, [])), /no condition/);
    } finally { await runtime.close(); }
  });
}
