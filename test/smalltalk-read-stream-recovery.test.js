import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService, createDefaultCodeCompilerRegistry, createDefaultCompilationGroupCompilerRegistry,
  installSymmetricSmalltalkStandardImage, installSmalltalkReadStreamProtocol, installSmalltalkTextReadStreamProtocol,
  publishSmalltalkClassGlobals, READ_STREAM_SHAPE_ID, installSymmetricSmalltalkBlock, objectRef, booleanValue,
} from '../src/runtime.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write installing native ${lane} ReadStream recovers and replays cleanly`, async () => {
    const forks = await forkableRuntime(async runtime => {
      await runtime.images.createImage({id: 'read-stream-recovery'});
      const stop = new Error('stop before the first ReadStream record');
      const images = new Proxy(runtime.images, {get(target, key) {
        const value = target[key];
        if (key === 'putShape') return (imageId, input, options) => {
          if (input.id === READ_STREAM_SHAPE_ID) throw stop;
          return value.call(target, imageId, input, options);
        };
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      // Seed the actual composition prefix, avoiding a second hand-maintained standard image.
      await assert.rejects(installSymmetricSmalltalkStandardImage({
        images, compilation: runtime.compilation, imageId: 'read-stream-recovery', lane,
      }), error => error === stop);
      assert.equal(await runtime.images.getShape('read-stream-recovery', READ_STREAM_SHAPE_ID), null);
    });
    const install = async images => {
      const compilation = new CompilationService({
        images, compilers: createDefaultCodeCompilerRegistry(), groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
      });
      const options = {images, compilation, imageId: 'read-stream-recovery', lane};
      await installSmalltalkReadStreamProtocol(options);
      await publishSmalltalkClassGlobals({images, imageId: 'read-stream-recovery', names: ['ReadStream']});
      await installSmalltalkTextReadStreamProtocol(options);
    };
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
            const frontier = await runtime.images.frontier('read-stream-recovery');
            await install(runtime.images);
            assert.equal(await runtime.images.frontier('read-stream-recovery'), frontier, `${lane} write ${failAt} replay`);
            const {block} = await installSymmetricSmalltalkBlock({
              images: runtime.images, imageId: 'read-stream-recovery', id: 'recovered-read-stream-proof',
              source: "[ | stream | stream := 'abc' readStream. (stream class == ReadStream) and: [(stream == 'abc' readStream) not] ]",
            });
            const activation = await runtime.invocations.invokeBlock(objectRef('read-stream-recovery', block.id), []);
            assert.deepEqual(await runtime.executor.execute(activation), booleanValue(true));
          });
        }
      }
    } finally { await forks.close(); }
  });
}

test('ReadStream installers refuse missing construction prerequisites before publication', async () => {
  const {createRuntime, installSmalltalkKernel, installSmalltalkAllocationProtocol} = await import('../src/runtime.js');
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const imageId = 'stream-prerequisites';
    await runtime.images.createImage({id: imageId});
    await installSmalltalkKernel({images: runtime.images, imageId});
    await installSmalltalkAllocationProtocol({images: runtime.images, compilation: runtime.compilation, imageId});
    const frontier = await runtime.images.frontier(imageId);
    await assert.rejects(installSmalltalkReadStreamProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId,
    }), /has no smalltalk\/class\/Text size method/);
    assert.equal(await runtime.images.frontier(imageId), frontier);
    assert.equal(await runtime.images.getShape(imageId, READ_STREAM_SHAPE_ID), null);
    await assert.rejects(installSmalltalkTextReadStreamProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId,
    }), /has not published the global ReadStream/);
    assert.equal(await runtime.images.frontier(imageId), frontier);
  } finally { await runtime.close(); }
});
