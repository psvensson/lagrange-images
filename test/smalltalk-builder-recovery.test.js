import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService,
  createDefaultCodeCompilerRegistry,
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  reconcileMethods,
} from '../src/runtime.js';
import {SmalltalkMethodRedefinitionError} from '../src/language/smalltalk-class-builder.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

// Three retry defects in this one publication sequence were each found only because some unrelated
// test happened to cross a different boundary. Targeted probes cannot settle the question, so this
// enumerates it: interrupt at *every* write, retry the identical operation, and require the method
// to become callable.
//
// The faulting service also backs the CompilationService, or writes made inside compileArtifact
// escape the injector entirely — which is exactly how one of the three defects survived.

const PLUS = {
  selector: '+',
  program: {
    parameters: [{id: 'plus:arg', name: 'aNumber'}],
    captures: [],
    body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}},
  },
};

const revisedPlus = (answer) => ({
  selector: '+',
  program: {
    parameters: [{id: 'plus:arg', name: 'aNumber'}],
    captures: [],
    body: {op: 'literal', value: integerValue(answer)},
  },
});

// A capture-bearing method, per ADR 0045 decision 6: the nil arm of a one-arm conditional names
// `nil` through a lexical environment, which adds a write to this publication sequence. A sequence
// is proven recoverable by enumerating its writes, so the new write is enumerated too.
const NIL_CAPTURE = Object.freeze({id: 'smalltalk/control-flow/nil', name: 'nil'});

const capturing = (imageId) => ({
  selector: 'answerNil',
  program: {
    parameters: [],
    captures: [{...NIL_CAPTURE}],
    body: {op: 'binding', id: NIL_CAPTURE.id},
  },
  captures: [{...NIL_CAPTURE, value: objectRef(imageId, 'smalltalk/nil')}],
});

function servicesFor(images) {
  return new CompilationService({images, compilers: createDefaultCodeCompilerRegistry()});
}

async function freshImage(runtime, imageId) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

async function callPlus(runtime, imageId, id) {
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId, id, source: '[ :a :b | a + b ]',
  });
  const activation = await runtime.invocations.invokeBlock(
    objectRef(imageId, installed.block.id), [integerValue(3), integerValue(4)],
  );
  return await runtime.executor.execute(activation);
}

// How many writes one clean `defineMethods` performs, so a test can target the final write.
async function writeCountFor(lane, methodsFor = () => [PLUS]) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const kernel = await freshImage(runtime, 'count');
    const {images, writeCount} = faultingImages(runtime.images);
    await defineMethods({
      images, compilation: servicesFor(images), imageId: 'count',
      classRef: kernel.integerClass, methods: methodsFor('count'), lane,
    });
    return writeCount();
  } finally {
    await runtime.close();
  }
}

// `+` is the plain case; `answerNil` is the capture-bearing one, so the sweep covers the
// lexical-environment write and the Block that points at it as well as the artifacts.
const RECOVERY_CASES = [
  {label: 'plain', methods: () => [PLUS], call: callPlus, expected: integerValue(7)},
  {
    label: 'capturing',
    methods: (imageId) => [PLUS, capturing(imageId)],
    call: async (runtime, imageId, id) => {
      const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
      const installed = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId, id, source: '[ :n | n answerNil ]',
      });
      const activation = await runtime.invocations.invokeBlock(
        objectRef(imageId, installed.block.id), [integerValue(1)],
      );
      const result = await runtime.executor.execute(activation);
      assert.deepEqual(result, kernel.nil);
      return result;
    },
    expected: null,
  },
];

for (const lane of ['neutral', 'wasm']) {
  for (const {label, methods, call, expected} of RECOVERY_CASES) {
    test(`every write in a ${label} ${lane} defineMethods is recoverable by an identical retry`, async () => {
      // The bare kernel image is prepared once and forked per iteration; only the defineMethods
      // under test repeats.
      const base = await forkableRuntime(async (runtime) => await freshImage(runtime, 'app'));
      try {
        const total = await base.withFork(async (runtime, kernel) => {
          const {images, writeCount} = faultingImages(runtime.images);
          await defineMethods({
            images, compilation: servicesFor(images), imageId: 'app',
            classRef: kernel.integerClass, methods: methods('app'), lane,
          });
          return writeCount();
        });
        assert.ok(total > 3, `expected several writes in the ${lane} lane, saw ${total}`);

        for (let failAt = 1; failAt <= total; failAt += 1) {
          for (const commitThenThrow of [false, true]) {
            await base.withFork(async (runtime, kernel) => {
              const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});

              await assert.rejects(
                defineMethods({
                  images, compilation: servicesFor(images), imageId: 'app',
                  classRef: kernel.integerClass, methods: methods('app'), lane,
                }),
                /injected/,
                `${lane} lane: write ${failAt} (commitThenThrow=${commitThenThrow}) should have failed`,
              );

              // The identical operation, retried against a clean service, must complete.
              await defineMethods({
                images: runtime.images, compilation: runtime.compilation, imageId: 'app',
                classRef: kernel.integerClass, methods: methods('app'), lane,
              });
              const result = await call(runtime, 'app', `retry-${label}-${lane}-${failAt}-${commitThenThrow}`);
              if (expected !== null) {
                assert.deepEqual(
                  result,
                  expected,
                  `${lane} lane: not callable after retrying past write ${failAt} (commitThenThrow=${commitThenThrow})`,
                );
              }
            });
          }
        }
      } finally {
        await base.close();
      }
    });
  }
}

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write publishing a ${lane} native method revision`, async () => {
    // Prepare A once. Every fork then starts from the same authoritative selector binding and the
    // sweep enumerates only the immutable-B publication plus the one MethodDictionary CAS.
    const base = await forkableRuntime(async (runtime) => {
      const kernel = await freshImage(runtime, 'app');
      await defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [PLUS], lane,
      });
      return kernel;
    });
    try {
      const total = await base.withFork(async (runtime, kernel) => {
        const {images, writeCount} = faultingImages(runtime.images);
        await reconcileMethods({
          images, compilation: servicesFor(images), imageId: 'app',
          classRef: kernel.integerClass, methods: [revisedPlus(8)], lane,
        });
        return writeCount();
      });
      assert.ok(total > 3, `expected immutable B material plus dictionary CAS, saw ${total} writes`);

      for (let failAt = 1; failAt <= total; failAt += 1) {
        for (const commitThenThrow of [false, true]) {
          await base.withFork(async (runtime, kernel) => {
            const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});
            await assert.rejects(
              reconcileMethods({
                images, compilation: servicesFor(images), imageId: 'app',
                classRef: kernel.integerClass, methods: [revisedPlus(8)], lane,
              }),
              /injected/,
            );
            await reconcileMethods({
              images: runtime.images, compilation: runtime.compilation, imageId: 'app',
              classRef: kernel.integerClass, methods: [revisedPlus(8)], lane,
            });
            const installed = await installSymmetricSmalltalkBlock({
              images: runtime.images,
              imageId: 'app',
              id: `revision-retry-${lane}-${failAt}-${commitThenThrow}`,
              source: '[ :n | n + 1 ]',
            });
            const result = await runtime.executor.execute(await runtime.invocations.invokeBlock(
              objectRef('app', installed.block.id), [integerValue(99)],
            ));
            assert.deepEqual(result, integerValue(8),
              `${lane}: B was not current after write ${failAt}, postCommit=${commitThenThrow}`);
          });
        }
      }
    } finally {
      await base.close();
    }
  });
}

// A lost acknowledgement on the final dictionary swap is the case where the caller believes it
// failed but the image already has the method. An identical definition must then be an idempotent
// success rather than a redefinition error.
test('an identical definition after a committed dictionary swap is idempotent', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const kernel = await freshImage(runtime, 'app');
    const total = await writeCountFor('neutral');
    const {images} = faultingImages(runtime.images, {failAt: total, commitThenThrow: true});

    await assert.rejects(
      defineMethods({
        images, compilation: servicesFor(images), imageId: 'app',
        classRef: kernel.integerClass, methods: [PLUS], lane: 'neutral',
      }),
      /injected post-commit/,
    );
    // The swap did land, so the method is already callable.
    assert.deepEqual(await callPlus(runtime, 'app', 'after-lost-ack'), integerValue(7));

    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [PLUS], lane: 'neutral',
    });
    assert.deepEqual(await callPlus(runtime, 'app', 'after-idempotent-retry'), integerValue(7));
  } finally {
    await runtime.close();
  }
});

// Only a *different* program or lane for an existing selector is replacement, which stays refused.
test('a different program for an existing selector is refused as replacement', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const kernel = await freshImage(runtime, 'app');
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [PLUS], lane: 'neutral',
    });

    const different = {
      selector: '+',
      program: {
        parameters: [{id: 'plus:arg', name: 'aNumber'}],
        captures: [],
        body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'receiver'}},
      },
    };
    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [different], lane: 'neutral',
      }),
      (error) => error instanceof SmalltalkMethodRedefinitionError,
    );
    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [PLUS], lane: 'wasm',
      }),
      (error) => error instanceof SmalltalkMethodRedefinitionError,
    );
  } finally {
    await runtime.close();
  }
});

// Plan before publish: a bad program must not occupy its selector's deterministic semantic id, or
// correcting it and retrying becomes a permanent conflict.
test('a rejected method body leaves no artifact behind', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const kernel = await freshImage(runtime, 'app');
    const bad = {
      selector: '+',
      program: {parameters: [{id: 'plus:arg', name: 'aNumber'}], captures: [], body: {op: 'not-an-op'}},
    };
    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [bad], lane: 'neutral',
      }),
      /not-an-op|unknown/,
    );
    assert.equal(
      await runtime.images.getCodeArtifact('app', `${kernel.integerClass.objectId}/method/Kw:semantic`),
      null,
      'a rejected body must not occupy the selector semantic id',
    );

    // Corrected, the same selector installs cleanly.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [PLUS], lane: 'neutral',
    });
    assert.deepEqual(await callPlus(runtime, 'app', 'after-correction'), integerValue(7));
  } finally {
    await runtime.close();
  }
});
