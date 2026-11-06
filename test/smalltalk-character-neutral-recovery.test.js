import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService,
  booleanValue,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
  installSmalltalkCharacterProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkIntegerProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  objectRef,
} from '../src/runtime.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId, id, source,
  });
  const activation = await runtime.invocations.invokeBlock(
    objectRef(imageId, installed.block.id), args,
  );
  return await runtime.executor.execute(activation);
}

const compilationFor = (images) => new CompilationService({
  images,
  compilers: createDefaultCodeCompilerRegistry(),
  groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
});

test('exhaustive-recovery: every write publishing the neutral Character personality', async () => {
  const lane = 'neutral';
  const base = await forkableRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'character-recovery'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'character-recovery'});
    await installSmalltalkEqualityProtocol({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'character-recovery',
      lane,
    });
    await installSmalltalkControlFlow({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'character-recovery',
      lane,
    });
    await installSmalltalkIntegerProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'character-recovery', lane,
    });
    await installSmalltalkInstanceVariableProtocol({
      images: runtime.images,
      imageId: 'character-recovery',
    });
  });
  try {
    const total = await base.withFork(async (runtime) => {
      const wrapped = faultingImages(runtime.images, {});
      await installSmalltalkCharacterProtocol({
        images: wrapped.images,
        compilation: compilationFor(wrapped.images),
        imageId: 'character-recovery',
        lane,
      });
      return wrapped.writeCount();
    });
    assert.ok(total > 8, `expected Character records, primitives and Text method writes, saw ${total}`);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      for (const commitThenThrow of [false, true]) {
        await base.withFork(async (runtime) => {
          const wrapped = faultingImages(runtime.images, {failAt, commitThenThrow});
          await assert.rejects(
            installSmalltalkCharacterProtocol({
              images: wrapped.images,
              compilation: compilationFor(wrapped.images),
              imageId: 'character-recovery',
              lane,
            }),
            /injected/,
          );

          await installSmalltalkCharacterProtocol({
            images: runtime.images,
            compilation: runtime.compilation,
            imageId: 'character-recovery',
            lane,
          });
          assert.deepEqual(
            await evaluate(
              runtime,
              'character-recovery',
              `recovered-character-${lane}-${failAt}-${commitThenThrow}`,
              "[ :characterClass | ((characterClass codePoint: 127) isAscii) and: [((characterClass codePoint: 128) isAscii not) and: [((characterClass codePoint: 955) == $λ) and: [ ('λ😀' size = 2) and: [ ($λ == ('λ' at: 1)) and: [ ($λ codePoint = 955) and: [ ($λ asciiValue == nil) and: [ ($: asciiValue = 58) and: [ ($0 isDigit) and: [ ($λ isDigit not) and: [ ($ª isLetter) and: [ ($× isLetter not) and: [ ($Z digitValue = 35) and: [ ($z digitValue = -1) and: [$\u200b isSeparator] ] ] ] ] ] ] ] ] ] ] ]]] ]",
              [objectRef('character-recovery', 'smalltalk/class/Character')],
            ),
            booleanValue(true),
            'recovery preserves Character identity, its owned scalar and classification',
          );
        });
      }
    }
  } finally {
    await base.close();
  }
});
