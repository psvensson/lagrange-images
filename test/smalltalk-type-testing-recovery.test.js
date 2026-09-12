import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService, createDefaultCodeCompilerRegistry, createDefaultCompilationGroupCompilerRegistry,
  installSymmetricSmalltalkStandardImage, installSmalltalkStringTestingProtocol, installSmalltalkCharacterProtocol,
  installSymmetricSmalltalkBlock, objectRef, booleanValue,
  createRuntime, installSmalltalkKernel, ensureNamedClass, findSmalltalkKernel,
} from '../src/runtime.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write publishing native ${lane} isString recovers`, async () => {
    const imageId = 'type-testing-recovery';
    const forks = await forkableRuntime(async runtime => {
      await runtime.images.createImage({id: imageId});
      const stop = new Error('stop before Object isString publication');
      let firstId;
      const images = new Proxy(runtime.images, {get(target, key) {
        const value = target[key];
        if (key === 'putCodeArtifact') return (image, input, options) => {
          if (input.metadata?.smalltalk === 'method' && input.metadata.selector === 'isString'
            && input.id.startsWith('smalltalk/class/Object/method/')) {
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
      // The consumer's Character personality is independent of type-query publication. Seed it
      // once so every recovered query exercises the same inherited Object default as M4.
      await installSmalltalkCharacterProtocol({images: runtime.images, compilation: runtime.compilation, imageId, lane});
    });
    const install = images => installSmalltalkStringTestingProtocol({
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
              images: runtime.images, imageId, id: 'recovered-type-query',
              source: "[ $e isString not and: ['en' isString and: [#en isString]] ]",
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

test('string testing refuses incomplete Symbol protocol before publishing any query', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const imageId = 'type-testing-prerequisite';
    await runtime.images.createImage({id: imageId});
    await installSmalltalkKernel({images: runtime.images, imageId});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
    await ensureNamedClass({images: runtime.images, imageId, name: 'Symbol', superclassRef: kernel.objectClass});
    const frontier = await runtime.images.frontier(imageId);
    await assert.rejects(installSmalltalkStringTestingProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId,
    }), /has no Symbol asString method/);
    assert.equal(await runtime.images.frontier(imageId), frontier);
  } finally { await runtime.close(); }
});
