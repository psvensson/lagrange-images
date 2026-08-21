import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WASM_FUNCTION_V1,
  booleanValue,
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkConditionProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkIntegerProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
} from '../src/runtime.js';
import {defineMethodsFromSource} from '../src/language/smalltalk-instance-variables.js';

// ADR 0055. The load-bearing claim is decision 3a: a frame is *borrowed* by the return primitive and
// by every intervening Block, so ownership rather than frame equality decides where a return stops.
// The recursive test is the one that pins both that and object identity.

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
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
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

const method = (selector, source) => ({selector, source});

// --- ownership and identity ------------------------------------------------------------------------

// The proof decision 3a exists for. `descend:` recurses on the same receiver, so several live
// activations share an equal {self, definingBehavior} — and the return must leave exactly the
// innermost one.
//
// The dead `1000` after each `^` is deliberate. A return is a statement, not an expression, so it
// cannot be written in the middle of one — but if the return primitive caught its own transfer, or
// an intervening Block did, the `^` would merely produce a value and the `1000` after it would
// become the answer. That is what makes these fixtures discriminating rather than merely correct.
test('a recursive method returns from its own activation, not an outer one', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [method('descend:', `[ :n |
        (n = 0)
          ifTrue: [ ^ 99. 1000 ]
          ifFalse: [ (self descend: (n - 1)) + 1 ] ]`)],
    });

    // Depth 0 returns from itself. Depth 3 has four live activations with identical
    // {self, definingBehavior}: the innermost returns 99 and each outer one adds 1.
    for (const [depth, expected] of [[0, 99], [1, 100], [3, 102]]) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `descend-${depth}`, `[ 0 descend: ${depth} ]`),
        integerValue(expected),
        `depth ${depth}: a structural frame match would answer 99 at every depth`,
      );
    }
  });
});

test('the return primitive does not catch its own transfer', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      // If the primitive's own activation stopped the transfer, the `^` would merely produce 5 and
      // this method would answer 1000.
      methods: [method('escapesPrimitive', '[ ^ 5. 1000 ]')],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'escapes-primitive', '[ 0 escapesPrimitive ]'),
      integerValue(5),
    );
  });
});

test('an intervening Block does not catch the transfer', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      // The Block borrows the home frame in order to read `self`; it must not stop the return.
      methods: [method('viaBlock', '[ [ ^ 6. 1000 ] value. 2000 ]')],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'via-block', '[ 0 viaBlock ]'),
      integerValue(6),
    );
  });
});

// --- returning -------------------------------------------------------------------------------------

test('a return stops the method, and statements after it do not run', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [
        method('early', '[ ^ 5. 99 ]'),
        method('fromBlock', '[ [ ^ 7 ] value. 99 ]'),
        method('fromNested', '[ [ [ ^ 8 ] value ] value. 99 ]'),
        method('fromLoop', `[ | i |
          i := 0.
          [ i <= 10 ] whileTrue: [ (i = 3) ifTrue: [ ^ i ] ifFalse: [ 1 ]. i := i + 1 ].
          99 ]`),
      ],
    });
    for (const [selector, expected] of [['early', 5], ['fromBlock', 7], ['fromNested', 8], ['fromLoop', 3]]) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `run-${selector}`, `[ 0 ${selector} ]`),
        integerValue(expected),
        selector,
      );
    }
  });
});

// --- the dead-target cases ---------------------------------------------------------------------------

test('a Block whose home already returned fails, and does not answer locally', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [method('escapee', '[ [ ^ 1 ] ]')],
    });
    const escaped = await evaluate(runtime, 'app', 'make-escapee', '[ 0 escapee ]');

    await assert.rejects(
      evaluate(runtime, 'app', 'use-escapee', '[ :b | b value ]', [escaped]),
      (error) => {
        assert.equal(error.name, 'NonLocalReturnHomeError');
        // Crucially not a local return: answering 1 here would be the silent-wrong-answer outcome.
        assert.ok(!/^1$/.test(String(error.value ?? '')), 'must not answer locally');
        return true;
      },
    );
  });
});

test('a standalone Block containing a return is refused at compile time', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await assert.rejects(
      installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app', id: 'standalone-return', source: '[ ^ 1 ]',
      }),
      /non-local return requires a method home/,
    );
    // Distinct from the escaped case above: this one could never have had a home, and nothing was
    // published for it.
    assert.equal(await runtime.images.getBlock('app', 'standalone-return'), null);
  });
});

// --- interaction with ADR 0054 -----------------------------------------------------------------------

test('cleanup runs on the way past, and a transferring cleanup supersedes', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [
        // A cleanup that answers a value: discarded, and the original return continues.
        method('ensureValue', '[ [ ^ 1 ] ensure: [ 2 ] ]'),
        // A cleanup that transfers: supersedes the return already unwinding.
        method('ensureTransfers', '[ [ ^ 1 ] ensure: [ ^ 2 ] ]'),
        // And the cleanup really did run on the unwinding path.
        method('ensureRan', '[ | log | log := 0. [ [ ^ 1 ] ensure: [ log := 9 ] ] value. log ]'),
      ],
    });
    assert.deepEqual(await evaluate(runtime, 'app', 'ev', '[ 0 ensureValue ]'), integerValue(1));
    assert.deepEqual(await evaluate(runtime, 'app', 'et', '[ 0 ensureTransfers ]'), integerValue(2));
  });
});

test('an unrelated on:do: does not intercept a non-local return', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, conditions, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [method('guarded', '[ [ ^ 4 ] on: ErrorClass do: [ :e | 99 ]. 77 ]')],
      // The handler class arrives as an ordinary capture.
    }).catch(async () => {
      await defineMethodsFromSource({
        ...options,
        classRef: kernel.integerClass,
        methods: [{
          selector: 'guarded',
          source: '[ [ ^ 4 ] on: ErrorClass do: [ :e | 99 ]. 77 ]',
          captures: [{name: 'ErrorClass', id: 'test/nlr-error', value: conditions.Error}],
        }],
      });
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'guarded-run', '[ 0 guarded ]'),
      integerValue(4),
      'the handler must not claim a transfer that names an activation',
    );
  });
});

// --- lanes ------------------------------------------------------------------------------------------

test('a non-local return works in the WASM lane and retires the suspended instance', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app', {lane: 'wasm'});
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [method('wasmReturn', '[ [ ^ 6. 1000 ] value. 2000 ]')],
    });

    // Warm, so the deltas below are about this activation rather than first use.
    assert.deepEqual(await evaluate(runtime, 'app', 'wasm-warm', '[ 0 wasmReturn ]'), integerValue(6));
    const pool = () => runtime.codeExecutors.get(WASM_FUNCTION_V1).instancePool.stats();
    const before = pool();

    assert.deepEqual(await evaluate(runtime, 'app', 'wasm-return', '[ 0 wasmReturn ]'), integerValue(6));

    const after = pool();
    assert.ok(after.retired - before.retired >= 1, 'the suspended activation must be retired');
    assert.equal(after.inUse, 0, 'no lease is left outstanding');
  });
});

// --- what must not have changed ---------------------------------------------------------------------

test('the return lowers to an ordinary send and adds no IR op', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [method('lowered', '[ ^ 5 ]')],
    });
    const {methodBlockRef} = await import('../src/language/smalltalk-class-builder.js');
    const ref = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'lowered',
    });
    const block = await runtime.images.getBlock(ref.imageId, ref.objectId);
    const code = await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId);
    const program = JSON.parse(code.content.value);

    // An ordinary send to the reserved capture — no `return` op anywhere.
    assert.ok(!/"op"\s*:\s*"return"/.test(JSON.stringify(program)), 'lagrange-code must gain no return op');
    assert.match(JSON.stringify(program), /nonLocalReturn|non-local-return/);
  });
});

test('the compiler recognizes no new selector', async () => {
  const {readFileSync} = await import('node:fs');
  for (const path of [
    'src/language/symmetric-smalltalk-compiler.js',
    'src/language/symmetric-smalltalk-parser.js',
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.ok(!/'value:'|whileTrue|ifTrue/.test(source), `${path} must recognize no selector`);
  }
  // And the IR gained nothing.
  const ir = readFileSync(new URL('../src/execution/neutral-expression-v0.js', import.meta.url), 'utf8');
  assert.ok(!/case 'return'/.test(ir), 'lagrange-code/v0 must gain no return op');
});

test('a caret is not absorbed into an adjacent binary selector', async () => {
  const {tokenizeSymmetricSmalltalk} = await import('../src/language/symmetric-smalltalk-tokenizer.js');
  const types = tokenizeSymmetricSmalltalk('[ ^ 1 = 2 ]').map(({type, value}) => `${type}:${value}`);
  assert.ok(types.includes('caret:^'), `expected a caret token, saw ${types.join(' ')}`);
  assert.ok(!types.some((entry) => entry.startsWith('binary:^')), 'the caret must not be a binary selector');
  // `x^=y` would otherwise tokenize as one operator; the caret stands alone.
  const adjacent = tokenizeSymmetricSmalltalk('[ ^ 0 - 1 ]').map(({type}) => type);
  assert.ok(adjacent.includes('caret'));
});

test('includes: answers from inside its loop', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const {installSmalltalkIndexedProtocol, installSmalltalkLibrary} = await import('../src/runtime.js');
    await installSmalltalkIndexedProtocol(options);
    const library = await installSmalltalkLibrary(options);

    const collection = await evaluate(runtime, 'app', 'coll',
      '[ :c | | oc | oc := c new. oc add: 1. oc add: 2. oc add: 3. oc ]', [library.orderedCollection]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'has', '[ :oc | oc includes: 2 ]', [collection]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'hasnt', '[ :oc | oc includes: 9 ]', [collection]),
      booleanValue(false),
    );
  });
});
