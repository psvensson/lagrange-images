import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue, createRuntime, installSymmetricSmalltalkBlock,
  installSmalltalkSetProtocol, installSmalltalkArraySetConversion, publishSmalltalkClassGlobals, textValue,
  installSymmetricSmalltalkStandardImage, integerValue, objectRef,
} from '../src/runtime.js';

// Pinned Cuis measurement on bead 23y: asSet removes equal duplicates; add: answers the
// supplied argument, including an equal-but-distinct duplicate. No enumeration order is promised.
for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Array asSet preserves source and uses Set equality membership`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      await runtime.images.createImage({id: 'set-test'});
      await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'set-test', lane,
      });
      let sequence = 0;
      const evaluate = async source => {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'set-test', id: `set-eval-${sequence++}`, source,
        });
        return runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef('set-test', block.id), []));
      };
      assert.deepEqual(await evaluate('[ #($& $& $<) asSet size ]'), integerValue(2));
      assert.deepEqual(await evaluate('[ #() asSet size ]'), integerValue(0));
      assert.deepEqual(await evaluate('[ #($&) asSet class == Set ]'), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | source result |
        source := #($& $& $<). result := source asSet.
        (source size = 3) and: [ (result includes: $&) and: [ (result includes: $>) not ] ] ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | source |
        source := #(1 2). (source asSet == source asSet) not ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | original equal collision source result |
        original := Association new key: 1 value: 2.
        equal := Association new key: 1 value: 2.
        collision := Association new key: 1 value: 3.
        source := Array new: 3.
        source at: 1 put: original; at: 2 put: equal; at: 3 put: collision.
        result := source asSet.
        (result size = 2) and: [
          ((result add: equal) == equal) and: [
            (result size = 2) and: [
              (result includes: equal) and: [
                (result includes: (Association new key: 1 value: 4)) not ] ] ] ] ]`), booleanValue(true));
      assert.deepEqual(await evaluate('[ #(1 1 2) asSet inject: 0 into: [:sum :each | sum + each] ]'), integerValue(3));
      const live = await evaluate('[ #(1) asSet ]');
      const send = async (selector, args = []) => runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: 'symmetric-smalltalk', receiver: live, message: textValue(selector), arguments: args,
      }));
      await send('add:', [integerValue(2)]);
      const beforeReplay = await runtime.images.frontier('set-test');
      const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'set-test', lane};
      await installSmalltalkSetProtocol(options);
      await publishSmalltalkClassGlobals({images: runtime.images, imageId: 'set-test', names: ['Set']});
      await installSmalltalkArraySetConversion(options);
      assert.equal(await runtime.images.frontier('set-test'), beforeReplay, 'installer replay writes nothing');
      assert.deepEqual(await send('size'), integerValue(2), 'replay preserves a live mutated Set');
    } finally { await runtime.close(); }
  });
}
