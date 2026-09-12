import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService, createDefaultCodeCompilerRegistry, createDefaultCompilationGroupCompilerRegistry,
  installSymmetricSmalltalkStandardImage, installSmalltalkWriteStreamProtocol,
  installSymmetricSmalltalkBlock, objectRef, booleanValue,
} from '../src/runtime.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write publishing native ${lane} WriteStream reset recovers`, async () => {
    const imageId = 'stream-reset-recovery';
    const forks = await forkableRuntime(async runtime => {
      await runtime.images.createImage({id: imageId});
      const stop = new Error('stop before the reset semantic artifact');
      let firstId;
      const images = new Proxy(runtime.images, {get(target, key) {
        const value = target[key];
        if (key === 'putCodeArtifact') return (image, input, options) => {
          if (input.metadata?.smalltalk === 'method' && input.metadata.selector === 'reset'
            && input.id.startsWith('smalltalk/class/WriteStream/method/')) {
            firstId = input.id;
            throw stop;
          }
          return value.call(target, image, input, options);
        };
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      await assert.rejects(installSymmetricSmalltalkStandardImage({
        images, compilation: runtime.compilation, imageId, lane,
      }), error => error === stop);
      assert.ok(firstId);
      assert.equal(await runtime.images.getCodeArtifact(imageId, firstId), null);
    });
    const install = images => installSmalltalkWriteStreamProtocol({
      images, imageId, lane,
      compilation: new CompilationService({
        images, compilers: createDefaultCodeCompilerRegistry(), groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
      }),
    });
    try {
      let total;
      await forks.withFork(async runtime => {
        const counting = faultingImages(runtime.images);
        await install(counting.images);
        total = counting.writeCount();
      });
      assert.ok(total > 0);
      for (const commitThenThrow of [false, true]) {
        for (let failAt = 1; failAt <= total; failAt++) {
          await forks.withFork(async runtime => {
            const fault = faultingImages(runtime.images, {failAt, commitThenThrow});
            await assert.rejects(install(fault.images), /injected (post-commit )?failure at write/);
            await install(runtime.images);
            const frontier = await runtime.images.frontier(imageId);
            await install(runtime.images);
            assert.equal(await runtime.images.frontier(imageId), frontier, `${lane} write ${failAt} replay`);
            const {block} = await installSymmetricSmalltalkBlock({
              images: runtime.images, imageId, id: 'recovered-reset-proof',
              source: `[ | same result | same := false.
                result := Text streamContents: [ :stream |
                  stream nextPutAll: 'stale'; nextPut: $𝄞.
                  same := stream reset == stream.
                  stream nextPut: $λ ].
                same and: [result = 'λ'] ]`,
            });
            assert.deepEqual(await runtime.executor.execute(await runtime.invocations.invokeBlock(
              objectRef(imageId, block.id), [],
            )), booleanValue(true));
          });
        }
      }
    } finally { await forks.close(); }
  });
}
