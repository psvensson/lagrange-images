import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V1,
  NEUTRAL_EXPRESSION_V0,
  WASM_FUNCTION_V1,
  createRuntime,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

// The differential proof for ADR 0043 decision 10. Each case compiles ONE Symmetric Smalltalk
// source to ONE lagrange-code/v1 semantic artifact and then runs it two ways from that same
// artifact: through the neutral executor, and through the WASM Block tree — which itself picks the
// simple v1 backend where every effect is in tail position and the resumable v2 backend where it is
// not. The assertion is that the lanes agree, not that each matches a hardcoded constant.
//
// Arithmetic arrives as a message send to a neutral Block, because `integer-add` is an op no front
// end emits and making `+` a primitive would prejudge Integer objects.
const NEUTRAL_HELPERS = Object.freeze({
  add: {
    parameters: 2,
    body: {op: 'integer-add', left: {op: 'argument', index: 0}, right: {op: 'argument', index: 1}},
  },
  bump: {
    parameters: 1,
    body: {
      op: 'integer-add',
      left: {op: 'argument', index: 0},
      right: {op: 'literal', value: integerValue(1)},
    },
  },
  identity: {parameters: 1, body: {op: 'argument', index: 0}},
});

async function installHelpers(runtime, imageId) {
  const refs = {};
  for (const [name, program] of Object.entries(NEUTRAL_HELPERS)) {
    const code = await runtime.images.putCodeArtifact(imageId, {
      id: `${name}:code`,
      representation: NEUTRAL_EXPRESSION_V0,
      content: textValue(JSON.stringify(program)),
    });
    const block = await runtime.images.putBlock(imageId, {id: name, code: objectRef(imageId, code.id)});
    refs[name] = objectRef(imageId, block.id);
  }
  return refs;
}

async function runNeutral(runtime, imageId, id, source, args) {
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    imageId,
    id: `${id}:neutral`,
    source,
  });
  assert.equal(installed.representation, LAGRANGE_CODE_V1, `${id} must need lagrange-code/v1`);
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return {result: await runtime.executor.execute(activation), semanticRef: objectRef(imageId, installed.semanticArtifact.id)};
}

async function runWasm(runtime, imageId, id, semanticRef, args) {
  const tree = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef,
    id: `${id}:wasm`,
  });
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, tree.block.id), args);
  return {result: await runtime.executor.execute(activation), abi: tree.functionArtifact.metadata.abi};
}

// Runs both lanes from one semantic artifact and asserts they agree.
async function differential(runtime, imageId, id, source, args = []) {
  const neutral = await runNeutral(runtime, imageId, id, source, args);
  const wasm = await runWasm(runtime, imageId, id, neutral.semanticRef, args);
  assert.deepEqual(
    wasm.result,
    neutral.result,
    `${id}: WASM (${wasm.abi}) disagreed with the neutral lane`,
  );
  return {value: neutral.result, abi: wasm.abi};
}

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'diff'});
    return await body(runtime, await installHelpers(runtime, 'diff'));
  } finally {
    await runtime.close();
  }
}

test('temporaries, sequences and assignment agree across lanes', async () => {
  await withRuntime(async (runtime, helpers) => {
    const {value} = await differential(runtime, 'diff', 'basic', `
      [ :add |
        | total n |
        total := 0.
        n := 3.
        total := add value: total value: n.
        total ]
    `, [helpers.add]);
    assert.deepEqual(value, integerValue(3));
  });
});

test('a chained assignment agrees across lanes', async () => {
  await withRuntime(async (runtime, helpers) => {
    const {value} = await differential(runtime, 'diff', 'chain', `
      [ :add | | a b | a := b := 7. add value: a value: b ]
    `, [helpers.add]);
    assert.deepEqual(value, integerValue(14));
  });
});

test('capture before assignment agrees across lanes', async () => {
  await withRuntime(async (runtime) => {
    const {value} = await differential(runtime, 'diff', 'capture-first', `
      [ | x reader | reader := [ x ]. x := 42. reader value ]
    `);
    assert.deepEqual(value, integerValue(42));
  });
});

// The counter. A WASM local would return 0 or 1 here; only a shared host cell returns 2.
test('the closure counter returns 2 in both lanes', async () => {
  await withRuntime(async (runtime, helpers) => {
    const {value} = await differential(runtime, 'diff', 'counter', `
      [ :bump |
        | n increment |
        n := 0.
        increment := [ n := bump value: n ].
        increment value.
        increment value.
        n ]
    `, [helpers.bump]);
    assert.deepEqual(value, integerValue(2));
  });
});

test('two closures over one frame share, and separate frames do not, in both lanes', async () => {
  await withRuntime(async (runtime, helpers) => {
    const shared = await differential(runtime, 'diff', 'shared', `
      [ :bump | | n up read | n := 0. up := [ n := bump value: n ]. read := [ n ]. up value. read value ]
    `, [helpers.bump]);
    assert.deepEqual(shared.value, integerValue(1));

    const isolated = await differential(runtime, 'diff', 'isolated', `
      [ :bump :add |
        | make first second |
        make := [ | n counter | n := 0. counter := [ n := bump value: n ]. counter value. counter value. n ].
        first := make value.
        second := make value.
        add value: first value: second ]
    `, [helpers.bump, helpers.add]);
    assert.deepEqual(isolated.value, integerValue(4));
  });
});

test('a returned closure keeps counting within one execution in both lanes', async () => {
  await withRuntime(async (runtime, helpers) => {
    const {value} = await differential(runtime, 'diff', 'returned', `
      [ :bump |
        | make counter |
        make := [ | n | n := 0. [ n := bump value: n ] ].
        counter := make value.
        counter value.
        counter value ]
    `, [helpers.bump]);
    assert.deepEqual(value, integerValue(2));
  });
});

test('recursion keeps live activations isolated in both lanes', async () => {
  await withRuntime(async (runtime) => {
    const {value} = await differential(runtime, 'diff', 'recursion', `
      [ | rec |
        rec := [ :inner :mark | | n | n := mark. inner value. n ].
        rec value: [ rec value: [ 0 ] value: 2 ] value: 1 ]
    `);
    assert.deepEqual(value, integerValue(1));
  });
});

// Failure semantics must match too: an unassigned read raises in both lanes, with the same error.
test('reading an unassigned temporary fails equivalently in both lanes', async () => {
  await withRuntime(async (runtime) => {
    const neutralInstalled = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'diff',
      id: 'unbound:neutral',
      source: '[ | x | x ]',
    });
    const semanticRef = objectRef('diff', neutralInstalled.semanticArtifact.id);
    const neutralActivation = await runtime.invocations.invokeBlock(
      objectRef('diff', neutralInstalled.block.id), [],
    );
    await assert.rejects(
      runtime.executor.execute(neutralActivation),
      (error) => error.name === 'UnboundBindingError',
    );

    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef,
      id: 'unbound:wasm',
    });
    const wasmActivation = await runtime.invocations.invokeBlock(objectRef('diff', tree.block.id), []);
    await assert.rejects(
      runtime.executor.execute(wasmActivation),
      (error) => error.name === 'UnboundBindingError',
    );
  });
});

// A closure holding both a cell capture and a snapshot capture, created after a suspension so the
// resumable backend is forced. The WASM closure site must record two semantic captures but pass
// only one Value handle, which is what keeps snapshot handle indexing correct.
test('a mixed cell/snapshot closure agrees across lanes under resumption', async () => {
  await withRuntime(async (runtime, helpers) => {
    const {value, abi} = await differential(runtime, 'diff', 'mixed', `
      [ :snapshot :identity :add |
        | n f |
        n := 1.
        f := [ add value: snapshot value: n ].
        identity value: 0.
        n := 2.
        f value ]
    `, [integerValue(10), helpers.identity, helpers.add]);
    assert.deepEqual(value, integerValue(12));
    assert.equal(abi, 'lagrange-value-handle-resumable/v2', 'this program must force the resumable lane');
  });
});

test('the mixed closure site passes one handle for two semantic captures', async () => {
  await withRuntime(async (runtime, helpers) => {
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'diff',
      id: 'arity',
      source: `
        [ :snapshot :identity :add |
          | n f |
          n := 1.
          f := [ add value: snapshot value: n ].
          identity value: 0.
          n := 2.
          f value ]
      `,
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('diff', installed.semanticArtifact.id),
      id: 'arity:wasm',
    });
    const closureSites = tree.moduleArtifact.metadata.closureSites;
    const site = closureSites.find((candidate) => candidate.captures.some(({mode}) => mode === 'cell'));
    assert.ok(site, 'expected a closure site with a cell capture');
    const modes = site.captures.map(({mode}) => mode).sort();
    assert.deepEqual(modes, ['cell', 'snapshot', 'snapshot']);
    const effect = tree.moduleArtifact.metadata.effectSites
      .find(({kind, siteIndex}) => kind === 'closure' && closureSites[siteIndex] === site);
    assert.equal(effect.requestArity, 2, 'only the snapshot captures occupy handle positions');
  });
});

test('pooled WASM instances stay isolated while running v1 trees', async () => {
  await withRuntime(async (runtime, helpers) => {
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'diff',
      id: 'pooled',
      source: '[ :seed | | n | n := seed. n ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('diff', installed.semanticArtifact.id),
      id: 'pooled:wasm',
    });
    const blockRef = objectRef('diff', tree.block.id);
    for (const seed of [5, 6, 7]) {
      const activation = await runtime.invocations.invokeBlock(blockRef, [integerValue(seed)]);
      assert.deepEqual(await runtime.executor.execute(activation), integerValue(seed));
    }
    const stats = runtime.executor.executors.get(WASM_FUNCTION_V1).instancePool.stats();
    assert.equal(stats.created, 1, 'three activations must share one pooled instance');
  });
});
