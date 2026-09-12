import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService, createDefaultCodeCompilerRegistry, createDefaultCompilationGroupCompilerRegistry,
  installSymmetricSmalltalkStandardImage, installSmalltalkSetProtocol, installSmalltalkArraySetConversion,
  publishSmalltalkClassGlobals, SET_SHAPE_ID, installSymmetricSmalltalkBlock, objectRef, integerValue,
} from '../src/runtime.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write installing native ${lane} Set recovers and replays cleanly`, async () => {
    const forks = await forkableRuntime(async runtime => {
      await runtime.images.createImage({id: 'set-recovery'});
      const stop = new Error('stop before the first Set record');
      const images = new Proxy(runtime.images, {get(target, key) {
        const value = target[key];
        if (key === 'putShape') return (imageId, input, options) => {
          if (input.id === SET_SHAPE_ID) throw stop;
          return value.call(target, imageId, input, options);
        };
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      // Seed the actual composition prefix, avoiding a second hand-maintained standard image.
      await assert.rejects(installSymmetricSmalltalkStandardImage({
        images, compilation: runtime.compilation, imageId: 'set-recovery', lane,
      }), error => error === stop);
      assert.equal(await runtime.images.getShape('set-recovery', SET_SHAPE_ID), null);
    });
    const install = async images => {
      const compilation = new CompilationService({
        images, compilers: createDefaultCodeCompilerRegistry(), groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
      });
      const options = {images, compilation, imageId: 'set-recovery', lane};
      await installSmalltalkSetProtocol(options);
      await publishSmalltalkClassGlobals({images, imageId: 'set-recovery', names: ['Set']});
      await installSmalltalkArraySetConversion(options);
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
            const frontier = await runtime.images.frontier('set-recovery');
            await install(runtime.images);
            assert.equal(await runtime.images.frontier('set-recovery'), frontier, `${lane} write ${failAt} replay`);
            const {block} = await installSymmetricSmalltalkBlock({
              images: runtime.images, imageId: 'set-recovery', id: 'recovered-set-proof',
              source: '[ #(1 1 2) asSet size ]',
            });
            const activation = await runtime.invocations.invokeBlock(objectRef('set-recovery', block.id), []);
            assert.deepEqual(await runtime.executor.execute(activation), integerValue(2));
          });
        }
      }
    } finally { await forks.close(); }
  });
}
