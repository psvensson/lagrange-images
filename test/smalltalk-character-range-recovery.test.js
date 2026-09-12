import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService, createDefaultCodeCompilerRegistry, createDefaultCompilationGroupCompilerRegistry,
  installSymmetricSmalltalkStandardImage, installSmalltalkCharacterRangeProtocol,
  installSymmetricSmalltalkBlock, objectRef, booleanValue, createRuntime,
  installSmalltalkGlobalNamespace, publishSmalltalkClassGlobals, methodBlockRef,
} from '../src/runtime.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write installing native ${lane} Character ranges recovers`, async () => {
    const forks = await forkableRuntime(async runtime => {
      await runtime.images.createImage({id: 'range-recovery'});
      const stop = new Error('stop before the Character range semantic artifact');
      let firstId;
      const images = new Proxy(runtime.images, {get(target, key) {
        const value = target[key];
        if (key === 'putCodeArtifact') return (imageId, input, options) => {
          if (input.metadata?.smalltalk === 'method' && input.metadata.selector === 'to:'
            && input.id.startsWith('smalltalk/class/Character/method/')) {
            firstId = input.id;
            throw stop;
          }
          return value.call(target, imageId, input, options);
        };
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      // The class builder writes the semantic artifact first, before any range environment/code.
      // Use the real composition prefix, preserving all its current prerequisites.
      await assert.rejects(installSymmetricSmalltalkStandardImage({
        images, compilation: runtime.compilation, imageId: 'range-recovery', lane,
      }), error => error === stop);
      assert.ok(firstId);
      assert.equal(await runtime.images.getCodeArtifact('range-recovery', firstId), null);
    });
    const install = async images => installSmalltalkCharacterRangeProtocol({
      images, imageId: 'range-recovery', lane,
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
            const frontier = await runtime.images.frontier('range-recovery');
            await install(runtime.images);
            assert.equal(await runtime.images.frontier('range-recovery'), frontier, `${lane} write ${failAt} replay`);
            const {block} = await installSymmetricSmalltalkBlock({
              images: runtime.images, imageId: 'range-recovery', id: 'recovered-range-proof',
              source: `[ | chars | chars := $0 to: $2.
                (chars size = 3) and: [((chars at: 1) == $0) and: [
                  ((chars at: 2) == $1) and: [(chars at: 3) == $2]]] ]`,
            });
            assert.deepEqual(await runtime.executor.execute(await runtime.invocations.invokeBlock(
              objectRef('range-recovery', block.id), [],
            )), booleanValue(true));
          });
        }
      }
    } finally { await forks.close(); }
  });
}


test('Character range installation requires constructor protocol even when its globals are published', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'range-prerequisite'});
    const stop = new Error('stop before public Character construction');
    const images = new Proxy(runtime.images, {get(target, key) {
      const value = target[key];
      if (key === 'putCodeArtifact') return (imageId, input, options) => {
        if (input.metadata?.smalltalk === 'method' && input.metadata.selector === 'codePoint:'
          && input.id.startsWith('smalltalk/metaclass/Character/method/')) throw stop;
        return value.call(target, imageId, input, options);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    await assert.rejects(installSymmetricSmalltalkStandardImage({
      images, compilation: runtime.compilation, imageId: 'range-prerequisite', lane: 'neutral',
    }), error => error === stop);
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'range-prerequisite'};
    await installSmalltalkGlobalNamespace(options);
    await publishSmalltalkClassGlobals({...options, names: ['Array', 'Character']});
    const frontier = await runtime.images.frontier(options.imageId);
    await assert.rejects(installSmalltalkCharacterRangeProtocol(options), /has no smalltalk\/metaclass\/Character codePoint: method/);
    assert.equal(await runtime.images.frontier(options.imageId), frontier, 'refusal writes no range records');
    assert.equal(await methodBlockRef({...options, classRef: objectRef(options.imageId, 'smalltalk/class/Character'), selector: 'to:'}), null);
  } finally { await runtime.close(); }
});
