import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
} from '../src/runtime.js';
import {installWasmBlockTree} from '../src/wasm/tree-installer.js';
import {findSmalltalkBlockUnwindProtocol} from '../src/language/smalltalk-conditions.js';

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

async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await runtime.images.createImage({id: imageId});
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
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'handled', '[ :E | [ (E new) signal. 99 ] on: E do: [ :e | 7 ] ]', [conditions.Error]),
      integerValue(7),
      'the handler value is the on:do: answer, and the 99 after the signal never runs',
    );
  });
});

test('an unhandled signal fails explicitly', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'unhandled', '[ :E | (E new) signal ]', [conditions.Error]),
      /unhandled Smalltalk condition/,
    );
  });
});

test('the innermost applicable handler wins, in both nesting orders', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'inner',
        '[ :E | [ [ (E new) signal ] on: E do: [ :e | 1 ] ] on: E do: [ :e | 2 ] ]', [conditions.Error]),
      integerValue(1),
    );
    // The outer one is reached only when the inner does not apply.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'outer',
        '[ :E :I | [ [ (E new) signal ] on: I do: [ :e | 1 ] ] on: E do: [ :e | 2 ] ]',
        [conditions.Error, conditions.IndexOutOfRange]),
      integerValue(2),
      'a handler for a subclass must not catch a superclass condition',
    );
  });
});

test('a handler for a superclass catches a subclass', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'super', '[ :E :I | [ (I new) signal ] on: E do: [ :e | 3 ] ]',
        [conditions.Error, conditions.IndexOutOfRange]),
      integerValue(3),
    );
    // And an unrelated class does not.
    await assert.rejects(
      evaluate(runtime, 'app', 'unrelated', '[ :C :I | [ (I new) signal ] on: C do: [ :e | 3 ] ]',
        [conditions.EmptyCollection, conditions.IndexOutOfRange]),
      /unhandled Smalltalk condition/,
    );
  });
});

test('a re-signal from inside a handler finds only outer handlers', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    // The inner handler re-signals the same class. Without disabling the running handler this is an
    // immediate infinite regress; with it, the outer handler answers.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'resignal', `[ :E |
        [ [ (E new) signal ] on: E do: [ :e | (E new) signal ] ] on: E do: [ :e | 42 ] ]`,
        [conditions.Error]),
      integerValue(42),
    );
  });
});

// --- resumption ----------------------------------------------------------------------------------

test('resume: makes the signalling send answer and computation continues', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'resume', '[ :E | [ ((E new) signal) + 1 ] on: E do: [ :e | e resume: 10 ] ]',
        [conditions.Error]),
      integerValue(11),
      'the signal answered 10 and the surrounding expression continued',
    );
  });
});

test('resume: or return: with no active occurrence fails explicitly', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'no-occurrence', '[ :E | (E new) resume: 1 ]', [conditions.Error]),
      /requires a condition that is currently being handled/,
    );
    await assert.rejects(
      evaluate(runtime, 'app', 'no-occurrence-2', '[ :E | (E new) return: 1 ]', [conditions.Error]),
      /requires a condition that is currently being handled/,
    );
  });
});

// --- the mixed-lane case -------------------------------------------------------------------------

// The architecture proof: neutral `on:do:` -> WASM protected method -> nested send that signals ->
// WASM handler -> `resume:` -> the original WASM locals continue intact. If this works, the handler
// search and transfer really are lane-independent and WASM is contributing only its existing
// suspend/resume behaviour.
test('a WASM handler resumes a WASM protected block, and its locals survive', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app', {lane: 'wasm'});
    const protectedBlock = await wasmBlock(runtime, 'app', 'protected-wasm',
      '[ :E | | a | a := 100. a + ((E new) signal) ]');
    const handler = await wasmBlock(runtime, 'app', 'handler-wasm', '[ :e | e resume: 5 ]');

    assert.deepEqual(
      await evaluate(runtime, 'app', 'mixed', '[ :p :E :h | [ p value: E ] on: E do: h ]',
        [protectedBlock, conditions.Error, handler]),
      integerValue(105),
      'the WASM local a=100 survived the signal and the resumed value completed the expression',
    );
  });
});

test('a WASM handler can also unwind a WASM protected block', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app', {lane: 'wasm'});
    const protectedBlock = await wasmBlock(runtime, 'app', 'protected-unwind',
      '[ :E | | a | a := 100. a + ((E new) signal) ]');
    const handler = await wasmBlock(runtime, 'app', 'handler-unwind', '[ :e | 7 ]');

    assert.deepEqual(
      await evaluate(runtime, 'app', 'mixed-unwind', '[ :p :E :h | [ p value: E ] on: E do: h ]',
        [protectedBlock, conditions.Error, handler]),
      integerValue(7),
      'unwinding abandons the WASM activation and answers the handler value',
    );
  });
});

// --- unwind protection ---------------------------------------------------------------------------

test('ensure: runs on both paths and answers the protected value', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    // Normal path: the cleanup ran (log = 1) and the answer is the protected Block's 3, not the
    // cleanup Block's own value.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'ensure-normal', '[ | log a | log := 0. a := [ 3 ] ensure: [ log := 1. 99 ]. a + log ]'),
      integerValue(4),
    );
    // Unwinding path: the cleanup still ran.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'ensure-unwound',
        '[ :E | | log | log := 0. ([ [ (E new) signal ] ensure: [ log := 1 ] ] on: E do: [ :e | 0 ]) + log ]',
        [conditions.Error]),
      integerValue(1),
    );
  });
});

test('ifCurtailed: runs only on a non-normal exit', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'curtailed-normal',
        '[ | log a | log := 0. a := [ 3 ] ifCurtailed: [ log := 1 ]. a + log ]'),
      integerValue(3),
      'a normal exit must not run the cleanup',
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'curtailed-unwound',
        '[ :E | | log | log := 0. ([ [ (E new) signal ] ifCurtailed: [ log := 1 ] ] on: E do: [ :e | 0 ]) + log ]',
        [conditions.Error]),
      integerValue(1),
    );
  });
});

// Protection that only fired for catchable failures would stop working exactly when something
// unexpected happened.
test('ensure: runs for a host failure that is not a Smalltalk condition', async () => {
  await withRuntime(async (runtime) => {
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

    // Division by zero is a host failure with no condition class, and deliberately not catchable.
    await assert.rejects(
      evaluate(runtime, 'app', 'host-fail', '[ :b | [ 1 // 0 ] ensure: [ b mark ] ]', [instance]),
      /cannot divide by zero/,
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
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    // The protected block signals; the cleanup signals a *different* class that nothing handles.
    const error = await evaluate(runtime, 'app', 'cleanup-fails', `[ :E :C |
      [ [ (E new) signal ] ensure: [ (C new) signal ] ] on: E do: [ :e | 0 ] ]`,
      [conditions.IndexOutOfRange, conditions.EmptyCollection]).catch((caught) => caught);

    assert.ok(error instanceof Error, 'the escaping cleanup failure must travel outward');
    assert.match(error.message, /unhandled Smalltalk condition/);
    // Neither failure is lost: the one that was unwinding is retained on the escaping one.
    assert.ok(error.duringUnwind, 'the original condition must be retained as the cause');
  });
});

test('a cleanup failure handled locally lets the original keep unwinding', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'cleanup-handled', `[ :E :C |
        [ [ (E new) signal ] ensure: [ [ (C new) signal ] on: C do: [ :e | 0 ] ] ]
          on: E do: [ :e | 5 ] ]`,
        [conditions.IndexOutOfRange, conditions.EmptyCollection]),
      integerValue(5),
      'the cleanup completed and the original condition continued unwinding to its handler',
    );
  });
});

// --- what must not have changed --------------------------------------------------------------------

test('the unwind protocol is separate from the loop protocol', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {findSmalltalkBlockProtocol} = await import('../src/language/smalltalk-block-protocol.js');
    const loop = await findSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'});
    const unwind = await findSmalltalkBlockUnwindProtocol({images: runtime.images, imageId: 'app'});
    assert.ok(loop && unwind);
    assert.notEqual(loop.ref.objectId, unwind.ref.objectId);
    // The loop protocol still has exactly its two slots — widening it was the thing to avoid.
    assert.deepEqual(Object.keys(loop.record.slots).sort(), ['block-protocol-while-false', 'block-protocol-while-true']);
  });
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
    const {options} = await seed(runtime, 'app');
    const before = (await runtime.images.listRecords('app')).length;
    await installSmalltalkConditionProtocol(options);
    assert.equal((await runtime.images.listRecords('app')).length, before);
  });
});

test('a condition object is an ordinary durable object', async () => {
  await withRuntime(async (runtime) => {
    const {conditions} = await seed(runtime, 'app');
    // ADR 0054 decision 1a: no second category of object. A condition allocated in Smalltalk is a
    // durable record like any other instance, with no transient identity.
    const condition = await evaluate(runtime, 'app', 'make-condition', '[ :E | E new ]', [conditions.Error]);
    const record = await runtime.images.getObject('app', condition.objectId);
    assert.ok(record, 'a condition object must be an ordinary durable record');
    assert.ok(!condition.objectId.startsWith('~runtime/transient/'));
  });
});
