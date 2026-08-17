import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V0,
  LAGRANGE_CODE_V1,
  NEUTRAL_EXPRESSION_V0,
  compileSymmetricSmalltalkBlock,
  createRuntime,
  evaluateSymmetricSmalltalkBlock,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {NEUTRAL_EXPRESSION_V1} from '../src/execution/executor.js';

// Symmetric Smalltalk has no arithmetic of its own: `integer-add` is a neutral-expression op that
// no front end emits, because making `+` a primitive would prejudge Integer objects. So the
// counting proofs below take their arithmetic as an ordinary message send to a Block installed
// directly against the neutral lane — which keeps ADR 0043's proofs about lexical state rather
// than about arithmetic.
const ADD_PROGRAM = Object.freeze({
  parameters: 2,
  body: {
    op: 'integer-add',
    left: {op: 'argument', index: 0},
    right: {op: 'argument', index: 1},
  },
});

const BUMP_PROGRAM = Object.freeze({
  parameters: 1,
  body: {
    op: 'integer-add',
    left: {op: 'argument', index: 0},
    right: {op: 'literal', value: integerValue(1)},
  },
});

async function installNeutralBlock(runtime, imageId, id, program) {
  const code = await runtime.images.putCodeArtifact(imageId, {
    id: `${id}:code`,
    representation: NEUTRAL_EXPRESSION_V0,
    content: textValue(JSON.stringify(program)),
  });
  const block = await runtime.images.putBlock(imageId, {id, code: objectRef(imageId, code.id)});
  return objectRef(imageId, block.id);
}

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'lexical'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function evaluate(runtime, source, args = [], id = undefined) {
  return await evaluateSymmetricSmalltalkBlock({
    runtime,
    imageId: 'lexical',
    source,
    arguments: args,
    ...(id === undefined ? {} : {id}),
  });
}

test('temporaries, sequences and assignment evaluate in order', async () => {
  await withRuntime(async (runtime) => {
    const add = await installNeutralBlock(runtime, 'lexical', 'add', ADD_PROGRAM);
    const result = await evaluate(runtime, `
      [ :add |
        | total n |
        total := 0.
        n := 3.
        total := add value: total value: n.
        total ]
    `, [add]);
    assert.deepEqual(result, integerValue(3));
  });
});

test('assignment is an expression, so a chained assignment binds both names', async () => {
  await withRuntime(async (runtime) => {
    const add = await installNeutralBlock(runtime, 'lexical', 'add', ADD_PROGRAM);
    const result = await evaluate(runtime, `
      [ :add |
        | a b |
        a := b := 7.
        add value: a value: b ]
    `, [add]);
    assert.deepEqual(result, integerValue(14));
  });
});

test('a sequence yields its last expression, not its last assignment', async () => {
  await withRuntime(async (runtime) => {
    assert.deepEqual(await evaluate(runtime, '[ | a | a := 1. 9 ]'), integerValue(9));
  });
});

// The load-bearing proof of ADR 0043. 0 means captures are still snapshots; 1 means the cell is
// being re-materialized per invocation; 2 means the closure and its creating activation share one
// cell.
test('a closure over a temporary observes its own writes across invocations', async () => {
  await withRuntime(async (runtime) => {
    const bump = await installNeutralBlock(runtime, 'lexical', 'bump', BUMP_PROGRAM);
    const result = await evaluate(runtime, `
      [ :bump |
        | n increment |
        n := 0.
        increment := [ n := bump value: n ].
        increment value.
        increment value.
        n ]
    `, [bump]);
    assert.deepEqual(result, integerValue(2));
  });
});

test('a closure captures the cell, so it sees a value assigned after it was created', async () => {
  await withRuntime(async (runtime) => {
    const result = await evaluate(runtime, `
      [ | x reader |
        reader := [ x ].
        x := 42.
        reader value ]
    `);
    assert.deepEqual(result, integerValue(42));
  });
});

test('two closures created in one activation share the captured cell', async () => {
  await withRuntime(async (runtime) => {
    const bump = await installNeutralBlock(runtime, 'lexical', 'bump', BUMP_PROGRAM);
    const result = await evaluate(runtime, `
      [ :bump |
        | n up read |
        n := 0.
        up := [ n := bump value: n ].
        read := [ n ].
        up value.
        read value ]
    `, [bump]);
    assert.deepEqual(result, integerValue(1));
  });
});

// Frame identity: two activations of the same code get distinct cells despite sharing every static
// binding id. If cells were keyed by binding id alone, the second factory call would resume the
// first one's counter and this would be 6 rather than 4.
test('closures created by different activations of one Block do not share cells', async () => {
  await withRuntime(async (runtime) => {
    const bump = await installNeutralBlock(runtime, 'lexical', 'bump', BUMP_PROGRAM);
    const add = await installNeutralBlock(runtime, 'lexical', 'add', ADD_PROGRAM);
    const result = await evaluate(runtime, `
      [ :bump :add |
        | make first second |
        make := [
          | n counter |
          n := 0.
          counter := [ n := bump value: n ].
          counter value.
          counter value.
          n ].
        first := make value.
        second := make value.
        add value: first value: second ]
    `, [bump, add]);
    assert.deepEqual(result, integerValue(4));
  });
});

// Frame lifetime, which is a different thing from frame identity: the declaring activation has
// returned, but the execution that owns the arena has not, so the escaped closure still works.
test('a closure returned by a factory keeps counting within the same execution', async () => {
  await withRuntime(async (runtime) => {
    const bump = await installNeutralBlock(runtime, 'lexical', 'bump', BUMP_PROGRAM);
    const result = await evaluate(runtime, `
      [ :bump |
        | make counter |
        make := [ | n | n := 0. [ n := bump value: n ] ].
        counter := make value.
        counter value.
        counter value ]
    `, [bump]);
    assert.deepEqual(result, integerValue(2));
  });
});

// Nested activations of the same code, live at the same time. The outer activation assigns 1, the
// inner assigns 2 while the outer's cell is still alive, and the outer must still read 1.
test('recursion does not share temporaries between live activations', async () => {
  await withRuntime(async (runtime) => {
    const result = await evaluate(runtime, `
      [ | rec |
        rec := [ :inner :mark |
          | n |
          n := mark.
          inner value.
          n ].
        rec value: [ rec value: [ 0 ] value: 2 ] value: 1 ]
    `);
    assert.deepEqual(result, integerValue(1));
  });
});

// Every compilation unit starts its binding ids at `root:`, so two unrelated artifacts both name a
// slot `root:temporary:0`. Keying cells by binding id alone would make them the same variable.
test('separately compiled units with identical binding ids do not collide', async () => {
  await withRuntime(async (runtime) => {
    const other = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'lexical',
      id: 'other-unit',
      source: '[ | n | n := 9. n ]',
    });
    const {semanticProgram} = compileSymmetricSmalltalkBlock('[ | n | n := 9. n ]');
    assert.deepEqual(semanticProgram.temporaries, [{id: 'root:temporary:0', name: 'n'}]);

    const result = await evaluate(runtime, `
      [ :other |
        | n |
        n := 3.
        other value.
        n ]
    `, [objectRef('lexical', other.block.id)]);
    assert.deepEqual(result, integerValue(3));
  });
});

test('reading an unassigned temporary fails explicitly rather than defaulting', async () => {
  await withRuntime(async (runtime) => {
    await assert.rejects(
      evaluate(runtime, '[ | x | x ]'),
      (error) => error.name === 'UnboundBindingError' && /unbound/.test(error.message),
    );
  });
});

// ADR 0043 decision 2: assignment is activation state. If it wrote through to the lexical
// environment graph, more assignments would mean more history events.
test('assignment writes no lexical environment and appends no history event', async () => {
  await withRuntime(async (runtime) => {
    const counts = [];
    for (const [id, source] of [
      ['few', '[ | a | a := 1. a ]'],
      ['many', '[ | a | a := 1. a := 2. a := 3. a := 4. a := 5. a ]'],
    ]) {
      const before = (await runtime.images.history('lexical')).length;
      await evaluate(runtime, source, [], id);
      counts.push((await runtime.images.history('lexical')).length - before);
    }
    assert.equal(counts[0], counts[1]);
  });
});

// ADR 0043 decision 5: unsupported, not silently reset. The closure escapes the execution that
// owned its cell, and the durable record deliberately holds no value to restart from.
test('a mutable closure invoked in a later execution fails instead of resetting', async () => {
  await withRuntime(async (runtime) => {
    const bump = await installNeutralBlock(runtime, 'lexical', 'bump', BUMP_PROGRAM);
    const closure = await evaluate(runtime, `
      [ :bump |
        | n increment |
        n := 0.
        increment := [ n := bump value: n ].
        increment value.
        increment ]
    `, [bump]);

    const closureBlock = await runtime.images.getBlock(closure.imageId, closure.objectId);
    const environment = await runtime.images.getLexicalEnvironment(
      closureBlock.environment.imageId,
      closureBlock.environment.objectId,
    );
    const record = environment.bindings['root:temporary:0'];
    assert.deepEqual(record, {name: 'n', cell: true});
    assert.equal(Object.hasOwn(record, 'value'), false);

    const activation = await runtime.invocations.invokeBlock(closure, []);
    await assert.rejects(
      runtime.executor.execute(activation),
      (error) => error.name === 'EscapingMutableClosureError',
    );
  });
});

test('a mutable capture is a cell mode capture, and an immutable one stays a snapshot', () => {
  const {semanticProgram, representation} = compileSymmetricSmalltalkBlock(`
    [ :arg |
      | n both |
      n := 0.
      both := [ n := arg ].
      both ]
  `);
  assert.equal(representation, LAGRANGE_CODE_V1);
  const block = semanticProgram.body.statements[1].value;
  assert.equal(block.op, 'block');
  assert.deepEqual(block.captures, [
    {id: 'root:temporary:0', mode: 'cell', name: 'n'},
    {id: 'root:parameter:0', mode: 'snapshot', name: 'arg', value: {op: 'argument', index: 0}},
  ]);
  assert.deepEqual(block.program.captures, [
    {id: 'root:temporary:0', mode: 'cell', name: 'n'},
    {id: 'root:parameter:0', mode: 'snapshot', name: 'arg'},
  ]);
});

test('parameters and self are not assignable', () => {
  assert.throws(
    () => compileSymmetricSmalltalkBlock('[ :x | | a | a := 1. x := 2. a ]'),
    /cannot assign to parameter x/,
  );
  assert.throws(() => compileSymmetricSmalltalkBlock('[ self := 1 ]'), /cannot assign to self/);
  assert.throws(
    () => compileSymmetricSmalltalkBlock('[ | a | a := 1. captured := 2. a ]', {captures: {captured: 'b'}}),
    /cannot assign to captured binding captured/,
  );
});

// Source needing none of ADR 0043's semantics must still produce exactly the artifact it always
// did, byte for byte — the whole reason lagrange-code/v0 was versioned rather than extended.
test('source that needs no mutable lexical state still compiles to lagrange-code/v0', async () => {
  const {semanticProgram, representation} = compileSymmetricSmalltalkBlock(
    '[ :target | target echo: captured ]',
    {captures: {captured: 'binding-captured'}},
  );
  assert.equal(representation, LAGRANGE_CODE_V0);
  assert.equal(
    JSON.stringify(semanticProgram),
    '{"parameters":[{"id":"root:parameter:0","name":"target"}],"captures":[{"id":"binding-captured","name":"captured"}],'
    + '"body":{"op":"send","languageId":"symmetric-smalltalk","receiver":{"op":"argument","index":0},'
    + '"message":{"kind":"text","value":"echo:"},"arguments":[{"op":"binding","id":"binding-captured"}]}}',
  );
  assert.equal(Object.hasOwn(semanticProgram, 'temporaries'), false);

  await withRuntime(async (runtime) => {
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'lexical',
      id: 'stable',
      source: '[ :x | [ :y | x echo: y ] ]',
    });
    assert.equal(installed.representation, LAGRANGE_CODE_V0);
    assert.equal(installed.semanticArtifact.representation, LAGRANGE_CODE_V0);
    assert.equal(installed.codeArtifact.representation, NEUTRAL_EXPRESSION_V0);
  });
});

test('mutable lexical source installs against the neutral v1 lane throughout its tree', async () => {
  await withRuntime(async (runtime) => {
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'lexical',
      id: 'v1-tree',
      source: '[ | n f | n := 1. f := [ n ]. f ]',
    });
    assert.equal(installed.representation, LAGRANGE_CODE_V1);
    assert.equal(installed.semanticArtifact.representation, LAGRANGE_CODE_V1);
    assert.equal(installed.codeArtifact.representation, NEUTRAL_EXPRESSION_V1);

    // The nested Block is the right-hand side of an assignment; its prototype must still exist.
    const prototypeRefs = Object.values(installed.blockPrototypes);
    assert.equal(prototypeRefs.length, 1);
    const nestedSemantic = await runtime.images.getCodeArtifact('lexical', 'v1-tree:semantic:root_block_0');
    assert.equal(nestedSemantic.representation, LAGRANGE_CODE_V1);
    const nestedCode = await runtime.images.getCodeArtifact('lexical', 'v1-tree:code:root_block_0');
    assert.equal(nestedCode.representation, NEUTRAL_EXPRESSION_V1);
  });
});

// ADR 0043 decision 10 says both lanes agree or it is not implemented. The neutral substrate landed
// first, so the WASM lane must refuse rather than diverge — and refuse before writing anything.
test('the WASM lane refuses lagrange-code/v1 during preflight and writes nothing', async () => {
  await withRuntime(async (runtime) => {
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'lexical',
      id: 'wasm-reject',
      source: '[ | a | a := 1. a ]',
    });
    const semanticRef = objectRef('lexical', installed.semanticArtifact.id);

    await assert.rejects(
      installWasmBlockTree({
        images: runtime.images,
        compilation: runtime.compilation,
        semanticRef,
        id: 'wasm-tree',
      }),
      (error) => error.name === 'WasmMutableLexicalStateUnsupportedError'
        && /lagrange-value-handle\/v1/.test(error.message),
    );

    assert.equal(await runtime.images.getCodeArtifact('lexical', 'wasm-tree:wasm:module'), null);
    assert.equal(await runtime.images.getCodeArtifact('lexical', 'wasm-tree:wasm:function'), null);
    assert.equal(await runtime.images.getBlock('lexical', 'wasm-tree'), null);
  });
});
