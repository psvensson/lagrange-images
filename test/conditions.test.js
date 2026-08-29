import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthorityError,
  CompilationService,
  WASM_FUNCTION_V1,
  createAuthorityService,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkConditionProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkIntegerProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {installWasmBlockTree} from '../src/wasm/tree-installer.js';
import {findSmalltalkBlockUnwindProtocol} from '../src/language/smalltalk-conditions.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';
import {sharedFixture} from './support/shared-fixture.js';

// ADR 0054. The architecture claim is that there is ONE condition runtime and one handler search,
// with WASM contributing only the suspend/resume/retire behaviour it already had — so the tests that
// matter most are the ones that cross lanes and the ones about who the handler runs as.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

// Most tests here only signal/handle conditions and never mutate shared durable state, so they
// share one installed image per lane (the kernel+condition install runs once) via
// test/support/shared-fixture.js. Tests that count records, corrupt the image, measure WASM pool
// stats, need a pristine/custom/two-image setup, or run the exhaustive-recovery sweep keep their
// own runtime via `withRuntime`. `evaluate`/`wasmBlock` mint ids through `unique` on shared tests.
async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkControlFlow(options);
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  await installSmalltalkIntegerProtocol(options);
  const conditions = await installSmalltalkConditionProtocol(options);
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({
    ...options,
    classRef: kernel.integerClass,
    methods: [{
      selector: '+',
      program: {
        parameters: [{id: 'plus:arg', name: 'n'}],
        captures: [],
        body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}},
      },
    }],
  });
  return {kernel, conditions, options};
}

// One installed image per lane, seeded once via `seed` above. `shared(lane)` answers
// `{runtime, imageId, kernel, conditions, options, unique}`.
const shared = async (lane = 'neutral') => await sharedFixture('conditions', lane, seed);

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

async function wasmBlock(runtime, imageId, id, source) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const tree = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef(imageId, installed.semanticArtifact.id),
    id: `${id}-tree`,
  });
  return objectRef(imageId, tree.block.id);
}

// --- signalling and handling ---------------------------------------------------------------------

test('a handler ordinary value acts as return:, and the protected block is abandoned', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('handled'), '[ :E | [ (E new) signal. 99 ] on: E do: [ :e | 7 ] ]', [conditions.Error]),
    integerValue(7),
    'the handler value is the on:do: answer, and the 99 after the signal never runs',
  );
});

test('an unhandled signal fails explicitly', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  await assert.rejects(
    evaluate(runtime, imageId, unique('unhandled'), '[ :E | (E new) signal ]', [conditions.Error]),
    /unhandled Smalltalk condition/,
  );
});

test('the innermost applicable handler wins, in both nesting orders', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('inner'),
      '[ :E | [ [ (E new) signal ] on: E do: [ :e | 1 ] ] on: E do: [ :e | 2 ] ]', [conditions.Error]),
    integerValue(1),
  );
  // The outer one is reached only when the inner does not apply.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('outer'),
      '[ :E :I | [ [ (E new) signal ] on: I do: [ :e | 1 ] ] on: E do: [ :e | 2 ] ]',
      [conditions.Error, conditions.IndexOutOfRange]),
    integerValue(2),
    'a handler for a subclass must not catch a superclass condition',
  );
});

test('a handler for a superclass catches a subclass', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('super'), '[ :E :I | [ (I new) signal ] on: E do: [ :e | 3 ] ]',
      [conditions.Error, conditions.IndexOutOfRange]),
    integerValue(3),
  );
  // And an unrelated class does not.
  await assert.rejects(
    evaluate(runtime, imageId, unique('unrelated'), '[ :C :I | [ (I new) signal ] on: C do: [ :e | 3 ] ]',
      [conditions.EmptyCollection, conditions.IndexOutOfRange]),
    /unhandled Smalltalk condition/,
  );
});

test('a re-signal from inside a handler finds only outer handlers', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  // The inner handler re-signals the same class. Without disabling the running handler this is an
  // immediate infinite regress; with it, the outer handler answers.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('resignal'), `[ :E |
      [ [ (E new) signal ] on: E do: [ :e | (E new) signal ] ] on: E do: [ :e | 42 ] ]`,
      [conditions.Error]),
    integerValue(42),
  );
});

// --- resumption ----------------------------------------------------------------------------------

test('resume: makes the signalling send answer and computation continues', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('resume'), '[ :E | [ ((E new) signal) + 1 ] on: E do: [ :e | e resume: 10 ] ]',
      [conditions.Error]),
    integerValue(11),
    'the signal answered 10 and the surrounding expression continued',
  );
});

test('resume: or return: with no active occurrence fails explicitly', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  await assert.rejects(
    evaluate(runtime, imageId, unique('no-occurrence'), '[ :E | (E new) resume: 1 ]', [conditions.Error]),
    /requires a condition that is currently being handled/,
  );
  await assert.rejects(
    evaluate(runtime, imageId, unique('no-occurrence-2'), '[ :E | (E new) return: 1 ]', [conditions.Error]),
    /requires a condition that is currently being handled/,
  );
});

// --- the mixed-lane case -------------------------------------------------------------------------

// The architecture proof: neutral `on:do:` -> WASM protected method -> nested send that signals ->
// WASM handler -> `resume:` -> the original WASM locals continue intact. If this works, the handler
// search and transfer really are lane-independent and WASM is contributing only its existing
// suspend/resume behaviour.
test('a WASM handler resumes a WASM protected block, and its locals survive', async () => {
  const {runtime, imageId, conditions, unique} = await shared('wasm');
  const protectedBlock = await wasmBlock(runtime, imageId, unique('protected-wasm'),
    '[ :E | | a | a := 100. a + ((E new) signal) ]');
  const handler = await wasmBlock(runtime, imageId, unique('handler-wasm'), '[ :e | e resume: 5 ]');

  assert.deepEqual(
    await evaluate(runtime, imageId, unique('mixed'), '[ :p :E :h | [ p value: E ] on: E do: h ]',
      [protectedBlock, conditions.Error, handler]),
    integerValue(105),
    'the WASM local a=100 survived the signal and the resumed value completed the expression',
  );
});

test('a WASM handler can also unwind a WASM protected block', async () => {
  const {runtime, imageId, conditions, unique} = await shared('wasm');
  const protectedBlock = await wasmBlock(runtime, imageId, unique('protected-unwind'),
    '[ :E | | a | a := 100. a + ((E new) signal) ]');
  const handler = await wasmBlock(runtime, imageId, unique('handler-unwind'), '[ :e | 7 ]');

  assert.deepEqual(
    await evaluate(runtime, imageId, unique('mixed-unwind'), '[ :p :E :h | [ p value: E ] on: E do: h ]',
      [protectedBlock, conditions.Error, handler]),
    integerValue(7),
    'unwinding abandons the WASM activation and answers the handler value',
  );
});

// --- unwind protection ---------------------------------------------------------------------------

test('ensure: runs on both paths and answers the protected value', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  // Normal path: the cleanup ran (log = 1) and the answer is the protected Block's 3, not the
  // cleanup Block's own value.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('ensure-normal'), '[ | log a | log := 0. a := [ 3 ] ensure: [ log := 1. 99 ]. a + log ]'),
    integerValue(4),
  );
  // Unwinding path: the cleanup still ran.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('ensure-unwound'),
      '[ :E | | log | log := 0. ([ [ (E new) signal ] ensure: [ log := 1 ] ] on: E do: [ :e | 0 ]) + log ]',
      [conditions.Error]),
    integerValue(1),
  );
});

test('ifCurtailed: runs only on a non-normal exit', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('curtailed-normal'),
      '[ | log a | log := 0. a := [ 3 ] ifCurtailed: [ log := 1 ]. a + log ]'),
    integerValue(3),
    'a normal exit must not run the cleanup',
  );
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('curtailed-unwound'),
      '[ :E | | log | log := 0. ([ [ (E new) signal ] ifCurtailed: [ log := 1 ] ] on: E do: [ :e | 0 ]) + log ]',
      [conditions.Error]),
    integerValue(1),
  );
});

// Protection that only fired for catchable failures would stop working exactly when something
// unexpected happened.
test('ensure: runs for a host failure that is not a Smalltalk condition', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const {options} = await seed(runtime, 'app');
    const {installSmalltalkInstanceVariableProtocol, defineClass} = await import('../src/runtime.js');
    const {defineMethodsFromSource} = await import('../src/language/smalltalk-instance-variables.js');
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
    const shape = objectRef('app', (await runtime.images.putShape('app', {
      id: 'box-shape', slots: [{id: 'seen-slot', name: 'seen'}],
    })).id);
    const box = await defineClass({images: runtime.images, imageId: 'app', name: 'Box', instanceShapeRef: shape});
    await defineMethodsFromSource({
      ...options,
      classRef: box.classRef,
      methods: [
        {selector: 'init', source: '[ seen := 0 ]'},
        {selector: 'mark', source: '[ seen := 1 ]'},
        {selector: 'seen', source: '[ seen ]'},
      ],
    });
    const instance = await evaluate(runtime, 'app', 'box', '[ :c | | b | b := c new. b init. b ]', [box.classRef]);

    // Message-not-understood has no condition class — ADR 0054 decision 8 defers it as a
    // metaobject-protocol question — so it is a genuinely non-catchable host failure.
    await assert.rejects(
      evaluate(runtime, 'app', 'host-fail', '[ :b | [ 1 noSuchSelector ] ensure: [ b mark ] ]', [instance]),
      /message not understood/,
      'a non-catchable host failure still travels outward',
    );
    // But the cleanup ran on the way past — which is the whole point of protecting for *every*
    // non-normal exit rather than only for conditions.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'box-read', '[ :b | b seen ]', [instance]),
      integerValue(1),
      'the cleanup must run for a failure it cannot catch',
    );
  });
});

test('a cleanup failure becomes the outward failure and retains the original', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  // The protected block signals; the cleanup signals a *different* class that nothing handles.
  const error = await evaluate(runtime, imageId, unique('cleanup-fails'), `[ :E :C |
    [ [ (E new) signal ] ensure: [ (C new) signal ] ] on: E do: [ :e | 0 ] ]`,
    [conditions.IndexOutOfRange, conditions.EmptyCollection]).catch((caught) => caught);

  assert.ok(error instanceof Error, 'the escaping cleanup failure must travel outward');
  assert.match(error.message, /unhandled Smalltalk condition/);
  // Neither failure is lost: the one that was unwinding is retained on the escaping one.
  assert.ok(error.duringUnwind, 'the original condition must be retained as the cause');
});

test('a cleanup failure handled locally lets the original keep unwinding', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('cleanup-handled'), `[ :E :C |
      [ [ (E new) signal ] ensure: [ [ (C new) signal ] on: C do: [ :e | 0 ] ] ]
        on: E do: [ :e | 5 ] ]`,
      [conditions.IndexOutOfRange, conditions.EmptyCollection]),
    integerValue(5),
    'the cleanup completed and the original condition continued unwinding to its handler',
  );
});

// --- what must not have changed --------------------------------------------------------------------

test('the unwind protocol is separate from the loop protocol', async () => {
  const {runtime, imageId} = await shared();
  const {findSmalltalkBlockProtocol} = await import('../src/language/smalltalk-block-protocol.js');
  const loop = await findSmalltalkBlockProtocol({images: runtime.images, imageId});
  const unwind = await findSmalltalkBlockUnwindProtocol({images: runtime.images, imageId});
  assert.ok(loop && unwind);
  assert.notEqual(loop.ref.objectId, unwind.ref.objectId);
  // The loop protocol still has exactly its two slots — widening it was the thing to avoid.
  assert.deepEqual(Object.keys(loop.record.slots).sort(), ['block-protocol-while-false', 'block-protocol-while-true']);
});

test('an image with loops but no unwind protocol is coherent', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'plain'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'plain'});
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'plain', lane: 'neutral'};
    await installSmalltalkAllocationProtocol(options);
    await installSmalltalkEqualityProtocol(options);
    await installSmalltalkControlFlow(options);
    await installSmalltalkBlockProtocol({images: runtime.images, imageId: 'plain'});

    assert.equal(await findSmalltalkBlockUnwindProtocol({images: runtime.images, imageId: 'plain'}), null);
    // Loops still work, and the unwind selectors are an ordinary does-not-understand.
    await assert.rejects(
      evaluate(runtime, 'plain', 'no-unwind', '[ [ 1 ] ensure: [ 2 ] ]'),
      /Block does not understand: ensure:/,
    );
  });
});

test('installing the condition protocol twice changes nothing', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const {options} = await seed(runtime, 'app');
    const before = (await runtime.images.listRecords('app')).length;
    await installSmalltalkConditionProtocol(options);
    assert.equal((await runtime.images.listRecords('app')).length, before);
  });
});

test('a condition object is an ordinary durable object', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  // ADR 0054 decision 1a: no second category of object. A condition allocated in Smalltalk is a
  // durable record like any other instance, with no transient identity.
  const condition = await evaluate(runtime, imageId, unique('make-condition'), '[ :E | E new ]', [conditions.Error]);
  const record = await runtime.images.getObject(imageId, condition.objectId);
  assert.ok(record, 'a condition object must be an ordinary durable record');
  assert.ok(!condition.objectId.startsWith('~runtime/transient/'));
});

// --- ADR 0054 decision 8: existing host failures become catchable ---------------------------------

test('divide by zero is a catchable ZeroDivide, and resumable', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('zd-caught'), '[ :Z | [ 7 // 0 ] on: Z do: [ :e | 42 ] ]',
      [conditions.ZeroDivide]),
    integerValue(42),
  );
  // Resuming answers the division itself, so the surrounding expression continues.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('zd-resumed'), '[ :Z | [ (7 // 0) + 1 ] on: Z do: [ :e | e resume: 10 ] ]',
      [conditions.ZeroDivide]),
    integerValue(11),
  );
  // A handler for Error catches it too, since ZeroDivide is an Error.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('zd-error'), '[ :E | [ 7 // 0 ] on: E do: [ :e | 1 ] ]', [conditions.Error]),
    integerValue(1),
  );
  // Unhandled, it still fails.
  await assert.rejects(
    evaluate(runtime, imageId, unique('zd-unhandled'), '[ 7 // 0 ]'),
    /unhandled Smalltalk condition/,
  );
});

test('an Array bounds failure is a catchable IndexBounds, and resumable', async () => {
  const {runtime, imageId, conditions, options, unique} = await shared();
  const {installSmalltalkIndexedProtocol} = await import('../src/runtime.js');
  await installSmalltalkIndexedProtocol(options);
  const arrayClass = objectRef(imageId, 'smalltalk/class/Array');

  assert.deepEqual(
    await evaluate(runtime, imageId, unique('ib-caught'),
      '[ :c :B | [ (c new: 2) at: 9 ] on: B do: [ :e | 5 ] ]', [arrayClass, conditions.IndexBounds]),
    integerValue(5),
  );
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('ib-resumed'),
      '[ :c :B | [ ((c new: 2) at: 9) ] on: B do: [ :e | e resume: 8 ] ]', [arrayClass, conditions.IndexBounds]),
    integerValue(8),
    'a resumed bounds signal answers the access',
  );
});

test('a missing Dictionary key is a catchable KeyNotFound', async () => {
  const {runtime, imageId, conditions, options, unique} = await shared();
  const {installSmalltalkDictionaryProtocol} = await import('../src/runtime.js');
  await installSmalltalkDictionaryProtocol(options);
  const dictionaryClass = objectRef(imageId, 'smalltalk/class/Dictionary');

  assert.deepEqual(
    await evaluate(runtime, imageId, unique('kn-caught'),
      "[ :c :K | [ (c new) at: 'missing' ] on: K do: [ :e | 0 ] ]", [dictionaryClass, conditions.KeyNotFound]),
    integerValue(0),
  );
  // Which is what makes a Dictionary `at:ifAbsent:` writable in Smalltalk for the same reason
  // OrderedCollection's is.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('kn-ifabsent'),
      "[ :c :K | | d | d := c new. d at: 'k' put: 3. [ d at: 'nope' ] on: K do: [ :e | 77 ] ]",
      [dictionaryClass, conditions.KeyNotFound]),
    integerValue(77),
  );
});

test('an image without the condition protocol keeps the original host errors', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'plain'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'plain'});
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'plain', lane: 'neutral'};
    await installSmalltalkAllocationProtocol(options);
    await installSmalltalkEqualityProtocol(options);
    await installSmalltalkControlFlow(options);
    await installSmalltalkBlockProtocol({images: runtime.images, imageId: 'plain'});
    await installSmalltalkIntegerProtocol(options);

    // No condition classes, so the primitive falls back to the host error it always raised. An
    // image that never installed ADR 0054 must not acquire a dependency on it.
    await assert.rejects(
      evaluate(runtime, 'plain', 'plain-zd', '[ 7 // 0 ]'),
      /cannot divide by zero/,
    );
  });
});

// --- publication recovery --------------------------------------------------------------------------

// Six primitive CodeArtifact/Block pairs, a Shape, the protocol object, seven classes and four
// methods. Both `images` and `compilation` are bound to the same faulting service, because wrapping
// only `images` lets the compiler publish its artifacts through the unwrapped one — the sweep would
// then look exhaustive while skipping exactly the artifacts each method depends on.
const servicesFor = (images) => new CompilationService({
  images,
  compilers: createDefaultCodeCompilerRegistry(),
  groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
});

async function baseImage(runtime, imageId, lane) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkControlFlow(options);
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  await installSmalltalkIntegerProtocol(options);
  return options;
}

const faultingServices = (images, options, fault) => {
  const wrapped = faultingImages(images, fault);
  return {
    services: {...options, images: wrapped.images, compilation: servicesFor(wrapped.images)},
    writeCount: wrapped.writeCount,
  };
};

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write publishing the ${lane} condition protocol`, async () => {
    const base = await forkableRuntime(async (runtime) => { await baseImage(runtime, 'app', lane); });
    try {
      const total = await base.withFork(async (runtime) => {
        const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane};
        const {services, writeCount} = faultingServices(runtime.images, options, {});
        await installSmalltalkConditionProtocol(services);
        return writeCount();
      });
      assert.ok(total > 20, `expected many writes across primitives, classes and methods, saw ${total}`);

      for (let failAt = 1; failAt <= total; failAt += 1) {
        for (const commitThenThrow of [false, true]) {
          await base.withFork(async (runtime) => {
            const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane};
            const {services} = faultingServices(runtime.images, options, {failAt, commitThenThrow});

            await assert.rejects(
              installSmalltalkConditionProtocol(services),
              /injected/,
              `${lane} write ${failAt} (${commitThenThrow ? 'lost ack' : 'pre-commit'}) should have failed`,
            );

            // The retry converges, and the protocol is then exercised rather than inspected:
            // converging on records is not the claim, signalling and handling working is.
            const conditions = await installSmalltalkConditionProtocol(options);
            assert.deepEqual(
              await evaluate(runtime, 'app', `recovered-${lane}-${failAt}-${commitThenThrow}`,
                '[ :E | [ (E new) signal ] on: E do: [ :e | 4 ] ]', [conditions.Error]),
              integerValue(4),
            );
          });
        }
      }
    } finally {
      await base.close();
    }
  });
}

// --- the remaining load-bearing proofs -------------------------------------------------------------

const poolStats = (runtime) => runtime.codeExecutors.get(WASM_FUNCTION_V1).instancePool.stats();

test('unwinding past a suspended WASM activation retires the instance', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const {conditions} = await seed(runtime, 'app', {lane: 'wasm'});
    // The signal happens at a *non-tail* send, so the guest is genuinely suspended when the unwind
    // passes it and its instance holds mid-computation state.
    const protectedBlock = await wasmBlock(runtime, 'app', 'retire-me',
      '[ :E | | a | a := 1. a + ((E new) signal) ]');

    // Warm the pool so `created` and `retired` deltas are about this activation, not about first use.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'retire-warm', '[ :p :E | [ p value: E ] on: E do: [ :e | 9 ] ]',
        [protectedBlock, conditions.Error]),
      integerValue(9),
    );
    const before = poolStats(runtime);

    assert.deepEqual(
      await evaluate(runtime, 'app', 'retire', '[ :p :E | [ p value: E ] on: E do: [ :e | 9 ] ]',
        [protectedBlock, conditions.Error]),
      integerValue(9),
    );
    const after = poolStats(runtime);

    // Measured, not inferred: the unwind retired an instance and had to create a fresh one, rather
    // than returning a mid-computation instance to the pool.
    assert.equal(after.retired - before.retired, 1, 'the suspended instance must be retired');
    assert.equal(after.created - before.created, 1, 'and a fresh instance created for this run');
    assert.equal(after.inUse, 0, 'no lease is left outstanding');
  });
});

// The distinction ADR 0054 decision 4 draws: a tail effect's lease is already released *normally*
// before the effect runs, so a signal there retires nothing and must not release the lease twice.
test('a signal out of a tail effect retires nothing and releases nothing twice', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const {conditions} = await seed(runtime, 'app', {lane: 'wasm'});
    // The signal *is* the activation's last act, so it compiles as a tail effect: nothing follows
    // it in the guest, and the guest has already returned when the host runs it.
    const tailBlock = await wasmBlock(runtime, 'app', 'tail-signal', '[ :E | (E new) signal ]');

    assert.deepEqual(
      await evaluate(runtime, 'app', 'tail-warm', '[ :p :E | [ p value: E ] on: E do: [ :e | 3 ] ]',
        [tailBlock, conditions.Error]),
      integerValue(3),
    );
    const before = poolStats(runtime);

    assert.deepEqual(
      await evaluate(runtime, 'app', 'tail-unwind', '[ :p :E | [ p value: E ] on: E do: [ :e | 3 ] ]',
        [tailBlock, conditions.Error]),
      integerValue(3),
    );
    const after = poolStats(runtime);

    assert.equal(after.retired - before.retired, 0,
      'a tail effect has no live instance to retire, because its lease was already released');
    assert.equal(after.discarded - before.discarded, 0, 'and nothing was discarded');
    assert.equal(after.inUse, 0, 'no lease is left outstanding, and none was released twice');
  });
});

test('a signal resumed out of a tail effect answers the activation', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const {conditions} = await seed(runtime, 'app', {lane: 'wasm'});
    const tailBlock = await wasmBlock(runtime, 'app', 'tail-resume', '[ :E | (E new) signal ]');
    const before = poolStats(runtime);

    // Resuming a tail effect does not re-enter a guest — there is none left — so the handler's
    // value simply becomes the activation's result.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'tail-resumed', '[ :p :E | [ p value: E ] on: E do: [ :e | e resume: 6 ] ]',
        [tailBlock, conditions.Error]),
      integerValue(6),
    );
    assert.equal(poolStats(runtime).retired - before.retired, 0, 'a resumed tail effect retires nothing');
  });
});

// MAX_WASM_RESUMPTIONS is 256. Each of these signals is a *sequential* send in one activation, so
// they all charge against the same counter — 129 correct charges pass, while double-charging would
// book 258 and exceed the limit. Putting them in a loop body would defeat the test, since each
// iteration gets a fresh activation and a fresh counter.
test('a resumed signal charges no extra WASM resumption', async () => {
  const {runtime, imageId, conditions, unique} = await shared('wasm');
  // Bare statements, so each one is a single `signal` send. Combining them with `+` would add a
  // send per term and blow the budget for a reason that has nothing to do with signalling.
  const signals = Array.from({length: 129}, () => 'c signal.').join(' ');
  const straightLine = await wasmBlock(runtime, imageId, unique('sequential-signals'),
    `[ :E | | c | c := E new. ${signals} 7 ]`);

  assert.deepEqual(
    await evaluate(runtime, imageId, unique('budget'),
      '[ :p :E | [ p value: E ] on: E do: [ :e | e resume: 1 ] ]', [straightLine, conditions.Error]),
    integerValue(7),
    '129 sequential handled-and-resumed signals in one activation must stay within the budget; '
    + 'double-charging them would book 258 and exceed 256',
  );
});

test('a handler runs with its establisher self, not the signaller', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const {conditions, options} = await seed(runtime, 'app');
    const {installSmalltalkInstanceVariableProtocol, defineClass} = await import('../src/runtime.js');
    const {defineMethodsFromSource} = await import('../src/language/smalltalk-instance-variables.js');
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
    const shape = objectRef('app', (await runtime.images.putShape('app', {
      id: 'tagged-shape', slots: [{id: 'tag-slot', name: 'tag'}],
    })).id);
    const tagged = await defineClass({images: runtime.images, imageId: 'app', name: 'Tagged', instanceShapeRef: shape});
    await defineMethodsFromSource({
      ...options,
      classRef: tagged.classRef,
      methods: [
        {selector: 'tag:', source: '[ :t | tag := t. self ]'},
        // Establishes a handler whose Block reads *this* instance's ivar.
        {selector: 'guard:', source: '[ :aBlock | [ aBlock value ] on: ErrorClass do: [ :e | tag ] ]',
          captures: [{name: 'ErrorClass', id: 'test/error-class', value: conditions.Error}]},
        // Signals from an instance with a different tag.
        {selector: 'raise', source: '[ (ErrorClass new) signal ]',
          captures: [{name: 'ErrorClass', id: 'test/error-class', value: conditions.Error}]},
      ],
    });

    const establisher = await evaluate(runtime, 'app', 'establisher', '[ :c | (c new) tag: 1 ]', [tagged.classRef]);
    const signaller = await evaluate(runtime, 'app', 'signaller', '[ :c | (c new) tag: 2 ]', [tagged.classRef]);

    // The signalling code belongs to a *different* instance. The handler must read its own tag.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'establisher-self',
        '[ :e :s | e guard: [ s raise ] ]', [establisher, signaller]),
      integerValue(1),
      'the handler saw the signaller self instead of its own',
    );
  });
});

test('the handler runtime does not outlive its execution', async () => {
  const {runtime, imageId, conditions, unique} = await shared();
  // A Block that signals, handed out of the execution that established a handler. Invoked later,
  // it must find no handler at all — the runtime died with its arena, exactly as frames do.
  const escaped = await evaluate(runtime, imageId, unique('escape-signaller'),
    '[ :E | [ (E new) signal ] ]', [conditions.Error]);
  // Established and immediately abandoned: this execution's handler must not be visible later.
  await evaluate(runtime, imageId, unique('establish-and-return'),
    '[ :E :b | [ 1 ] on: E do: [ :e | 0 ] ]', [conditions.Error, escaped]);

  await assert.rejects(
    evaluate(runtime, imageId, unique('later-signal'), '[ :b | b value ]', [escaped]),
    /unhandled Smalltalk condition/,
    'a handler from a finished execution must not be found',
  );
});

// --- authority: the security proof ----------------------------------------------------------------

// ADR 0054 decision 6. `self` comes free from ADR 0050, but authority propagates *dynamically*, so a
// handler invoked naively would inherit the signaller's. This is the adversarial shape: a richly
// authorized establisher, a signalling path that has been attenuated down, and a handler that needs
// the grant the establisher held. If the handler ran with the signaller's authority it would be
// refused.
const CONDITION_PROBE = 'condition-authority-probe/v0';
const READ = 'host-value/read';

function createConditionProbeExecutor() {
  return Object.freeze({
    async execute({activation, code}, context) {
      const plan = JSON.parse(code.content.value);
      if (plan.attenuateAndSend) {
        // Narrows authority, then invokes an ordinary Smalltalk Block. The executor never receives
        // the resulting context and cannot observe what it became.
        return await context.sendMessage({
          languageId: 'symmetric-smalltalk',
          receiver: objectRef('app', plan.attenuateAndSend.block),
          message: textValue('value'),
          arguments: [],
        }, {attenuate: plan.attenuateAndSend.grants});
      }
      context.require({operation: READ, resource: plan.resource});
      return textValue(`read:${plan.resource}`);
    },
  });
}

test('a handler runs with its establisher authority, not the signaller', async () => {
  const authority = createAuthorityService();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    codeExecutors: {[CONDITION_PROBE]: createConditionProbeExecutor()},
  });
  try {
    await runtime.images.createImage({id: 'app'});
    const {conditions} = await seed(runtime, 'app');

    const installProbe = async (id, plan) => {
      const code = await runtime.images.putCodeArtifact('app', {
        id: `${id}-code`, representation: CONDITION_PROBE, content: textValue(JSON.stringify(plan)),
      });
      await runtime.images.putBlock('app', {id, code: objectRef('app', code.id), environment: null});
      return objectRef('app', id);
    };

    // The Smalltalk Block that signals, reached only through the attenuating probe.
    const signaller = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'attenuated-signaller',
      source: '[ :E | (E new) signal ]',
      captures: {},
    });
    // `value` with no arguments, so the signaller closes over the class instead of taking it.
    const signalNoArgs = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'signal-no-args',
      source: '[ (ErrorClass new) signal ]',
      captures: {ErrorClass: 'test/authority-error-class'},
      environment: objectRef('app', (await runtime.images.putLexicalEnvironment('app', {
        id: 'authority-env',
        bindings: {'test/authority-error-class': {name: 'ErrorClass', value: conditions.Error}},
      })).id),
    });
    void signaller;

    // Drops the private grant on the way to the signal.
    const attenuator = await installProbe('attenuating-caller', {
      attenuateAndSend: {
        block: signalNoArgs.block.id,
        grants: [{operation: READ, resource: 'public-message'}],
      },
    });
    // The handler needs the grant the *establisher* held and the signaller no longer has.
    const handler = await installProbe('privileged-handler', {resource: 'private-message'});

    const driver = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'authority-driver',
      source: '[ :att :E :h | [ att value ] on: E do: h ]',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', driver.block.id), [
      attenuator, conditions.Error, handler,
    ]);
    const context = authority.issue({
      principal: 'alice',
      grants: [
        {operation: READ, resource: 'private-message'},
        {operation: READ, resource: 'public-message'},
      ],
    });

    assert.deepEqual(
      await runtime.executor.execute(activation, {authority: context}),
      textValue('read:private-message'),
      'the handler must run with the rights held where on:do: was written, not where the signal was raised',
    );

    // The control: the same handler invoked from *inside* the attenuated path is refused, so the
    // assertion above is about who the handler runs as and not about the grant being ambient.
    const insideAttenuated = await installProbe('inside-attenuated', {
      attenuateAndSend: {
        block: (await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'app', id: 'call-handler-directly',
          source: '[ HandlerBlock value: 1 ]',
          captures: {HandlerBlock: 'test/handler-block'},
          environment: objectRef('app', (await runtime.images.putLexicalEnvironment('app', {
            id: 'handler-env', bindings: {'test/handler-block': {name: 'HandlerBlock', value: handler}},
          })).id),
        })).block.id,
        grants: [{operation: READ, resource: 'public-message'}],
      },
    });
    await assert.rejects(
      runtime.executor.execute(
        await runtime.invocations.invokeBlock(insideAttenuated, []),
        {authority: context},
      ),
      AuthorityError,
      'the attenuated path really has lost the private grant',
    );
  } finally {
    await runtime.close();
  }
});

// --- cross-image handler ---------------------------------------------------------------------------

// Pins the defect just fixed: the invoker must not freeze the establisher's dispatch image, because
// a Block executes in its own image. A handler from image B must use B's immediate-value protocol.
test('a handler Block from another image uses its own image protocol', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'home'});
    const home = await seed(runtime, 'home');
    await runtime.images.createImage({id: 'away'});
    const away = await seed(runtime, 'away');

    // The same selector, different answers per image.
    for (const [imageId, value] of [['home', 1], ['away', 7]]) {
      const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
      await defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId, lane: 'neutral',
        classRef: kernel.integerClass,
        methods: [{selector: 'tag', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(value)}}}],
      });
    }

    // The handler lives in `away` and sends `tag` to an immediate Integer, which resolves through
    // whichever image the handler is dispatched in.
    const handler = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'away', id: 'away-handler', source: '[ :e | 0 tag ]',
    });

    assert.deepEqual(
      await evaluate(runtime, 'home', 'cross-image-handler',
        '[ :E :h | [ (E new) signal ] on: E do: h ]',
        [home.conditions.Error, objectRef('away', handler.block.id)]),
      integerValue(7),
      'the handler used away tag, not home tag — a Block executes in its own image',
    );
    void away;
  });
});

// --- consumer readiness ---------------------------------------------------------------------------

// The unwind protocol object is published before the classes and methods, so a Block-existence check
// would pass on a half-installed protocol. The recovery sweep proves convergence, not this.
test('a half-installed condition protocol is refused by the library', async () => {
  await withRuntime(async (runtime) => {
    const options = await baseImage(runtime, 'app', 'neutral');
    const {installSmalltalkIndexedProtocol, installSmalltalkLibrary} = await import('../src/runtime.js');
    await installSmalltalkIndexedProtocol(options);

    // Fail on the first *method* write, after the protocol object and classes exist.
    const faulting = Object.create(runtime.images);
    let protocolObjectWritten = false;
    faulting.putObject = async (imageId, input, opts) => {
      const stored = await runtime.images.putObject(imageId, input, opts);
      if (input.id === 'smalltalk-block-unwind-protocol/v1') protocolObjectWritten = true;
      return stored;
    };
    faulting.putCodeArtifact = async (imageId, input) => {
      if (protocolObjectWritten && !input.id?.startsWith('smalltalk/primitive/')) {
        throw new Error('injected failure before the Exception methods');
      }
      return await runtime.images.putCodeArtifact(imageId, input);
    };
    await assert.rejects(
      installSmalltalkConditionProtocol({...options, images: faulting}),
      /injected/,
    );

    // The protocol object discovers cleanly...
    assert.ok(await findSmalltalkBlockUnwindProtocol({images: runtime.images, imageId: 'app'}));
    // ...but `Exception >> signal` does not exist, which is exactly what a protocol-object check
    // would miss.
    const {methodBlockRef} = await import('../src/language/smalltalk-class-builder.js');
    assert.equal(
      await methodBlockRef({
        images: runtime.images, imageId: 'app',
        classRef: objectRef('app', 'smalltalk/class/Exception'), selector: 'signal',
      }),
      null,
      'the fixture must leave signal absent for this test to mean anything',
    );

    await assert.rejects(
      installSmalltalkLibrary(options),
      /has no Exception signal method/,
      'the library must check for the installed method, not the protocol object',
    );
  });
});
