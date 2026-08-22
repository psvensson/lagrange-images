import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
  createRuntime,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  objectRef,
  rebindGlobal,
  resolveGlobal,
  SYMMETRIC_SMALLTALK_STANDARD_IMAGE_V1,
} from '../src/runtime.js';

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function evaluate(runtime, imageId, id, source) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), []);
  return await runtime.executor.execute(activation);
}

for (const lane of ['neutral', 'wasm']) {
  test(`the ${lane} standard image is an immediately usable Smalltalk environment`, async () => {
    await withRuntime(async (runtime) => {
      await runtime.images.createImage({id: 'app'});
      const image = await installSymmetricSmalltalkStandardImage({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });

      assert.equal(image.protocol, SYMMETRIC_SMALLTALK_STANDARD_IMAGE_V1);
      assert.equal(image.imageId, 'app');
      assert.equal(image.lane, lane);
      assert.deepEqual(image.classes.Array, objectRef('app', 'smalltalk/class/Array'));
      assert.deepEqual(image.classes.Dictionary, objectRef('app', 'smalltalk/class/Dictionary'));
      assert.deepEqual(image.classes.Association, objectRef('app', 'smalltalk/class/Association'));
      assert.deepEqual(image.classes.OrderedCollection, objectRef('app', 'smalltalk/class/OrderedCollection'));

      // One ordinary source program uses the main pieces the old test seeds had to assemble by hand:
      // globals, allocation, Array, Dictionary, Association, OrderedCollection, higher-order
      // enumeration, booleans and the established Integer `+` method.
      const answer = await evaluate(runtime, 'app', `standard-${lane}`, `[ | collection dictionary array |
        collection := OrderedCollection new.
        collection add: 2.
        collection add: 3.
        dictionary := Dictionary new.
        dictionary at: 'total' put: (collection inject: 1 into: [ :sum :each | sum + each ]).
        array := Array new: 2.
        array at: 1 put: (dictionary at: 'total').
        array at: 2 put: (Association new key: 'ok' value: true).
        (array at: 1) + ((array at: 2) value ifTrue: [ 1 ] ifFalse: [ 0 ]) ]`);
      assert.deepEqual(answer, integerValue(7));

      // GlobalBinding exists because the namespace needs it, but is intentionally implementation
      // machinery rather than a standard global. Class existence still does not imply publication.
      assert.ok(await runtime.images.getObject('app', 'smalltalk/class/GlobalBinding'));
      await assert.rejects(
        installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'app', id: `internal-${lane}`, source: '[ GlobalBinding ]',
        }),
        /unbound Symmetric Smalltalk name: GlobalBinding/,
      );
    });
  });
}

test('the standard installer requires an existing image and does not own image lifecycle', async () => {
  await withRuntime(async (runtime) => {
    await assert.rejects(
      installSymmetricSmalltalkStandardImage({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'missing',
      }),
      /image missing does not exist; create it before installing the standard image/,
    );
  });
});

for (const lane of ['neutral', 'wasm']) {
  test(`reinstalling the ${lane} standard image preserves a deliberate global rebind`, async () => {
    await withRuntime(async (runtime) => {
      await runtime.images.createImage({id: 'app'});
      const first = await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane,
      });
      const arrayBinding = await resolveGlobal({images: runtime.images, imageId: 'app', name: 'Array'});
      assert.ok(arrayBinding);

      await rebindGlobal({
        images: runtime.images,
        imageId: 'app',
        bindingId: arrayBinding.objectId,
        value: first.kernel.objectClass,
      });
      const reboundVersion = (await runtime.images.getObject('app', arrayBinding.objectId))._version;

      const second = await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane,
      });

      // Publication is not rebinding: replaying the installer must not reset live namespace state.
      assert.deepEqual(await evaluate(runtime, 'app', `array-rebound-${lane}`, '[ Array ]'), first.kernel.objectClass);
      assert.equal((await runtime.images.getObject('app', arrayBinding.objectId))._version, reboundVersion);
      // The installation manifest still describes what class was installed, independently of what
      // the live global currently points at.
      assert.deepEqual(second.classes.Array, objectRef('app', 'smalltalk/class/Array'));
    });
  });
}

const WRITE_METHODS = new Set(['putCodeArtifact', 'putBlock', 'putShape', 'putObject', 'putLexicalEnvironment']);

function faultOnRecordId(images, {targetId, commitThenThrow}) {
  let fired = false;
  return new Proxy(images, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (!WRITE_METHODS.has(property)) return value.bind(target);
      return async (...args) => {
        const input = args[1];
        const hit = !fired && input?.id === targetId;
        if (hit && !commitThenThrow) {
          fired = true;
          throw new Error(`injected pre-commit failure at ${targetId}`);
        }
        const result = await value.apply(target, args);
        if (hit && commitThenThrow) {
          fired = true;
          throw new Error(`injected lost acknowledgement at ${targetId}`);
        }
        return result;
      };
    },
  });
}

function compilationFor(images) {
  return new CompilationService({
    images,
    compilers: createDefaultCodeCompilerRegistry(),
    groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
  });
}

// Component installers own their write-by-write recovery sweeps. This proof is deliberately only
// about orchestration: replay the one public operation after representative failures spanning the
// dependency chain, rather than multiplying every component's exhaustive sweep by a full image.
const RECOVERY_TARGETS = Object.freeze([
  'smalltalk-kernel/v1',
  'smalltalk/class/Array',
  'smalltalk-global-namespace/v1',
  'smalltalk/class/OrderedCollection',
]);

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: representative ${lane} standard-image stage failures replay cleanly`, async () => {
    for (const targetId of RECOVERY_TARGETS) {
      for (const commitThenThrow of [false, true]) {
        await withRuntime(async (runtime) => {
          await runtime.images.createImage({id: 'app'});
          const faultingImages = faultOnRecordId(runtime.images, {targetId, commitThenThrow});

          await assert.rejects(
            installSymmetricSmalltalkStandardImage({
              images: faultingImages,
              compilation: compilationFor(faultingImages),
              imageId: 'app',
              lane,
            }),
            /injected/,
            `${targetId} (${commitThenThrow ? 'lost acknowledgement' : 'pre-commit'}) must interrupt installation`,
          );

          // Replay the public operation from the beginning. No caller needs to know which stage
          // completed; every underlying deterministic write either already matches or is completed.
          await installSymmetricSmalltalkStandardImage({
            images: runtime.images,
            compilation: runtime.compilation,
            imageId: 'app',
            lane,
          });
          assert.deepEqual(
            await evaluate(runtime, 'app', `recovered-${lane}-${targetId}-${commitThenThrow}`, '[ 3 + 4 ]'),
            integerValue(7),
          );
        });
      }
    }
  });
}
