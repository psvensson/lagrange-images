import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installSmalltalkGlobalNamespace,
  publishSmalltalkClassGlobals,
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
  textValue,
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

// The recursive test above proves owner-versus-borrower, but its target is the innermost owner
// anyway — so a structural match would happen to agree. This is the discriminating case: a Block
// whose home is the OUTER activation, invoked underneath structurally identical inner ones. A
// structural match would stop at the innermost owner, which has an equal {self, definingBehavior}
// and is the wrong home.
test('a return targets its own home even under structurally identical inner activations', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [
        // `outer` makes a Block homed in ITS activation, then recurses twice on the same receiver
        // before running it. When the Block finally returns, three activations of `deeper:` and one
        // of `outer` are live, all with the same self.
        method('outer', '[ | escape | escape := [ ^ 42. 1000 ]. (self deeper: 3 with: escape) + 500 ]'),
        method('deeper:with:', `[ :n :aBlock |
          (n = 0)
            ifTrue: [ aBlock value. 2000 ]
            ifFalse: [ (self deeper: (n - 1) with: aBlock) + 1 ] ]`),
      ],
    });

    assert.deepEqual(
      await evaluate(runtime, 'app', 'outer-home', '[ 0 outer ]'),
      integerValue(42),
      'a structural frame match would stop at the innermost deeper: and answer 2000-ish instead',
    );
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

// Distinct from the test above, which spans two executions. Here the home method returns and the
// Block is invoked *within the same execution*, so its frame is still reachable — which is the case
// the liveness registry's dead state exists to report precisely.
test('a Block whose home returned in this same execution reports that, not "no home"', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [
        method('makeEscapee', '[ [ ^ 1 ] ]'),
        // Obtains the Block from a method that has already returned, then runs it — all inside one
        // execution, so the arena is alive and the frame is still reachable.
        method('runAfterReturn', '[ | b | b := self makeEscapee. b value. 99 ]'),
      ],
    });

    await assert.rejects(
      evaluate(runtime, 'app', 'same-execution-dead', '[ 0 runAfterReturn ]'),
      (error) => {
        assert.equal(error.name, 'NonLocalReturnHomeError');
        assert.match(error.message, /already returned/,
          'a reachable-but-finished home must be reported as returned, not as absent');
        // ADR 0055 says the diagnosis names the *method*. `definingBehavior` alone names only the
        // class, so the selector has to be recorded alongside liveness for this to be sayable.
        assert.match(error.message, />> makeEscapee/,
          `the failure must name the method, saw: ${error.message}`);
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
      ],
    });
    assert.deepEqual(await evaluate(runtime, 'app', 'ev', '[ 0 ensureValue ]'), integerValue(1));
    assert.deepEqual(await evaluate(runtime, 'app', 'et', '[ 0 ensureTransfers ]'), integerValue(2));
  });
});

// The cleanup must actually run on the unwinding path, not merely fail to change the answer. Read
// through an object, since a temporary of the returning method is unreachable once it has returned.
test('cleanup observably runs while a non-local return unwinds past it', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const {defineClass} = await import('../src/runtime.js');
    const shape = objectRef('app', (await runtime.images.putShape('app', {
      id: 'nlr-log-shape', slots: [{id: 'log-slot', name: 'log'}],
    })).id);
    const logger = await defineClass({images: runtime.images, imageId: 'app', name: 'NlrLog', instanceShapeRef: shape});
    await defineMethodsFromSource({
      ...options,
      classRef: logger.classRef,
      methods: [
        method('init', '[ log := 0 ]'),
        method('log', '[ log ]'),
        method('mark', '[ log := 9 ]'),
        method('returnsThroughEnsure', '[ [ ^ 1 ] ensure: [ self mark ]. 99 ]'),
        method('returnsThroughCurtailed', '[ [ ^ 2 ] ifCurtailed: [ self mark ]. 99 ]'),
        // A normal exit must NOT run ifCurtailed:.
        method('normalThroughCurtailed', '[ [ 3 ] ifCurtailed: [ self mark ] ]'),
      ],
    });

    for (const [selector, answer] of [['returnsThroughEnsure', 1], ['returnsThroughCurtailed', 2]]) {
      const instance = await evaluate(runtime, 'app', `mk-${selector}`,
        '[ :c | | o | o := c new. o init. o ]', [logger.classRef]);
      assert.deepEqual(
        await evaluate(runtime, 'app', `run-${selector}`, `[ :o | o ${selector} ]`, [instance]),
        integerValue(answer),
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `log-${selector}`, '[ :o | o log ]', [instance]),
        integerValue(9),
        `${selector}: the cleanup must run while the return unwinds past it`,
      );
    }

    const normal = await evaluate(runtime, 'app', 'mk-normal',
      '[ :c | | o | o := c new. o init. o ]', [logger.classRef]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'run-normal', '[ :o | o normalThroughCurtailed ]', [normal]),
      integerValue(3),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'log-normal', '[ :o | o log ]', [normal]),
      integerValue(0),
      'ifCurtailed: must not run on a normal exit',
    );
  });
});

// ADR 0055 decision 6: a `^` inside a handler returns from the handler Block's *home method*, not to
// the `on:do:` that invoked it.
test('a return from inside a condition handler leaves the handler home method', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, conditions, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [{
        selector: 'handlerReturns',
        source: '[ [ (ErrorClass new) signal. 50 ] on: ErrorClass do: [ :e | ^ 11. 1000 ]. 99 ]',
        captures: [{name: 'ErrorClass', id: 'test/handler-return-error', value: conditions.Error}],
      }],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'handler-returns', '[ 0 handlerReturns ]'),
      integerValue(11),
      'the return must leave the method, not merely answer the on:do:',
    );
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

// ADR 0055's library obligation: a search over a thousand elements, with early stopping *counted*
// rather than inferred from the answer.
//
// Two things are deliberately cheap here, because the search is what is under test and not the
// scaffolding. The Array is built in a single durable write rather than by a thousand `at:put:`
// sends — the mock backend clones the whole database per transaction, so building it in Smalltalk
// costs minutes. And the counter is a *temporary*, which is a transient cell: counting in an
// instance variable would make every iteration a durable write and reintroduce the same cost.
test('a search over a thousand elements stops early', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const {installSmalltalkIndexedProtocol, defineClass} = await import('../src/runtime.js');
    await installSmalltalkIndexedProtocol(options);

    const items = objectRef('app', (await runtime.images.putObject('app', {
      id: 'thousand-items',
      shape: objectRef('app', 'smalltalk/array-instance-shape/v1'),
      behavior: objectRef('app', 'smalltalk/class/Array'),
      slots: {},
      indexed: Array.from({length: 1000}, (unused, index) => integerValue(index + 1)),
      metadata: {},
    }, {expectedVersion: 0})).id);

    const shape = objectRef('app', (await runtime.images.putShape('app', {
      id: 'scan-shape', slots: [{id: 'scan-items', name: 'items'}],
    })).id);
    const scanner = await defineClass({images: runtime.images, imageId: 'app', name: 'Scanner', instanceShapeRef: shape});
    await defineMethodsFromSource({
      ...options,
      classRef: scanner.classRef,
      methods: [
        method('items:', '[ :a | items := a. self ]'),
        // Answers how many elements it examined: the index on a hit, and 1000 on a miss. Counting
        // and answering in one value is what makes early stopping observable rather than inferred.
        method('scanFor:', `[ :target | | i seen |
          i := 1. seen := 0.
          [ i <= 1000 ] whileTrue: [
            seen := seen + 1.
            ((items at: i) = target) ifTrue: [ ^ seen ] ifFalse: [ 1 ].
            i := i + 1 ].
          seen ]`),
      ],
    });

    const scan = await evaluate(runtime, 'app', 'scan',
      '[ :c :a | (c new) items: a ]', [scanner.classRef, items]);

    assert.deepEqual(
      await evaluate(runtime, 'app', 'scan-early', '[ :s | s scanFor: 5 ]', [scan]),
      integerValue(5),
      'a hit at index 5 must examine exactly five of a thousand elements',
    );
    // And the loop really can traverse the whole thousand, so stopping at 5 is early stopping and
    // not a bound the search could never have exceeded.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'scan-miss', '[ :s | s scanFor: 4321 ]', [scan]),
      integerValue(1000),
    );
  });
});

test('includes: answers from inside its loop', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const {installSmalltalkIndexedProtocol, installSmalltalkLibrary} = await import('../src/runtime.js');
    await installSmalltalkIndexedProtocol(options);
    await installSmalltalkGlobalNamespace(options);
    await publishSmalltalkClassGlobals({
      images: runtime.images, imageId: 'app', names: ['Array', 'IndexOutOfRange', 'EmptyCollection'],
    });
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

// --- the three defects this pass fixed --------------------------------------------------------------

// `needsMutableLexicalState` must recurse through a return node, or v1 features hidden under `^`
// classify as v0 and the artifact is rejected against the closed v0 grammar.
test('v1 features under a return are classified as v1', async () => {
  const {parseSymmetricSmalltalkBlock} = await import('../src/language/symmetric-smalltalk-parser.js');
  const {selectSemanticRepresentation} = await import('../src/language/symmetric-smalltalk-semantic.js');
  assert.equal(selectSemanticRepresentation(parseSymmetricSmalltalkBlock('[ ^ 1 ]')), 'lagrange-code/v0');
  assert.equal(
    selectSemanticRepresentation(parseSymmetricSmalltalkBlock('[ ^ [ :x | | t | t := x. t ] ]')),
    'lagrange-code/v1',
    'an assignment under a return still needs v1',
  );
  assert.equal(
    selectSemanticRepresentation(parseSymmetricSmalltalkBlock('[ ^ [ 1. 2 ] ]')),
    'lagrange-code/v1',
  );
});

test('a method returning a v1 Block compiles and runs', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [method('returnsCounter', '[ ^ [ :n | | t | t := n + 1. t ]. 99 ]')],
    });
    const block = await evaluate(runtime, 'app', 'get-counter', '[ 0 returnsCounter ]');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'use-counter', '[ :b | b value: 1 ]', [block]),
      integerValue(2),
    );
  });
});

// ADR 0052 decision 6: a root execution promotes the value it answers, and a non-local return is
// still a root answer. Returning it unpromoted would hand a caller a transient ref its arena is gone.
test('a returned closure is promoted when it leaves a root execution', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [method('returnsBlock', '[ ^ [ 7 ]. 99 ]')],
    });

    // Dispatched as the ROOT activation, not through a wrapper Block. That is the case the defect
    // lived in: when the method that catches the return is itself the root, nothing above it runs
    // the ordinary promotion, so the caught value has to go through it here.
    const dispatched = await runtime.invocations.prepareDispatch({
      languageId: 'symmetric-smalltalk',
      receiver: integerValue(0),
      message: (await import('../src/runtime.js')).textValue('returnsBlock'),
      arguments: [],
    }, {dispatchImage: 'app'});
    const returned = await runtime.executor.execute(dispatched.activation, {
      dispatchImage: 'app', invocationFrame: dispatched.frame,
    });
    const {isTransientRef} = await import('../src/value/transient-ref.js');
    assert.ok(!isTransientRef(returned), 'a non-local return must not answer a transient closure');
    assert.ok(
      await runtime.images.getBlock(returned.imageId, returned.objectId),
      'the returned closure must be a published Block',
    );
    // And it still works in a later execution, which is what promotion is for.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'use-returned', '[ :b | b value ]', [returned]),
      integerValue(7),
    );
  });
});

// The liveness registry is per executor and has three states. A frame this executor never ran as a
// home is "absent", which must not be reported as "already returned".
// The live mark must sit inside the protected region. Marking before the `try` leaves a frame
// permanently live when anything between the two throws — temporary initialization, for instance —
// and a later `^` naming that frame would be told its home is still running.
test('a failure before the body runs does not leave a frame falsely live', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [method('boom', '[ ^ 1 ]')],
    });

    // Dispatched here so the frame is in hand and can be inspected after the failure.
    const dispatched = await runtime.invocations.prepareDispatch({
      languageId: 'symmetric-smalltalk',
      receiver: integerValue(0),
      message: textValue('boom'),
      arguments: [],
    }, {dispatchImage: 'app'});
    assert.ok(dispatched.frame, 'a method dispatch must supply a frame');

    const executor = runtime.executor;
    const previous = executor.temporaryInitializer;
    executor.temporaryInitializer = async () => { throw new Error('injected initializer failure'); };
    try {
      await assert.rejects(
        executor.execute(dispatched.activation, {dispatchImage: 'app', invocationFrame: dispatched.frame}),
        /injected initializer failure/,
      );
    } finally {
      executor.temporaryInitializer = previous;
    }

    assert.notEqual(
      executor.homeActivationState(dispatched.frame), 'live',
      'a frame whose activation never ran its body must not be left live',
    );
  });
});

test('the liveness registry is executor-owned and distinguishes absent from dead', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const frame = Object.freeze({self: objectRef('app', 'nobody'), definingBehavior: objectRef('app', 'nothing')});
    assert.equal(runtime.executor.homeActivationState(frame), 'absent');
    // The mutator is private: outside code must not be able to forge liveness (ADR 0055).
    assert.equal(typeof runtime.executor.markHomeActivation, 'undefined');

    // A second runtime must not see the first one's homes.
    const other = await createRuntime({backend: {mode: 'mock'}});
    try {
      assert.equal(other.executor.homeActivationState(frame), 'absent');
    } finally {
      await other.close();
    }
  });
});
