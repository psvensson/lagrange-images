import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  findSmalltalkKernel,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

// ADR 0044 decision 8, which supersedes ADR 0043 decision 9 for bootstrapped Symmetric Smalltalk
// execution only. The compatibility boundary is the whole point:
//
//   bootstrapped image        a declared temporary starts at that image's nil ref
//   unbootstrapped image      a declared temporary starts UNBOUND, exactly as before
//   old durable {unbound}     stays unbound, stays an error, never reinterpreted
//   new capture after boot    captures nil like any other value
//
// Reinterpreting a stored record would be migration by interpretation, which this substrate forbids
// everywhere else.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return {result: await runtime.executor.execute(activation), installed};
}

async function bootstrapped(runtime, imageId) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

test('a temporary in a bootstrapped image reads nil instead of raising', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await bootstrapped(runtime, 'app');
    const {result} = await evaluate(runtime, 'app', 'unassigned', '[ | x | x ]');
    assert.deepEqual(result, kernel.nil, 'the temporary must hold that image nil ref');
  });
});

test('a temporary in an unbootstrapped image still raises, exactly as ADR 0043 decided', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'bare'});
    await assert.rejects(
      evaluate(runtime, 'bare', 'unassigned', '[ | x | x ]'),
      (error) => error.name === 'UnboundBindingError',
    );
  });
});

// Two images, one bootstrapped and one not, in the same runtime — so this is per-image policy
// rather than a global switch.
test('nil initialization follows the image, not the process', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await bootstrapped(runtime, 'booted');
    await runtime.images.createImage({id: 'bare'});

    assert.deepEqual((await evaluate(runtime, 'booted', 'a', '[ | x | x ]')).result, kernel.nil);
    await assert.rejects(
      evaluate(runtime, 'bare', 'b', '[ | x | x ]'),
      (error) => error.name === 'UnboundBindingError',
    );
  });
});

test('assignment still works over a nil-initialized cell', async () => {
  await withRuntime(async (runtime) => {
    await bootstrapped(runtime, 'app');
    const {result} = await evaluate(runtime, 'app', 'assigned', '[ | x | x := 7. x ]');
    assert.deepEqual(result, integerValue(7));
  });
});

// A snapshot capture of a nil-initialized temporary captures the nil ref like any other value.
test('a snapshot capture after bootstrap captures nil as an ordinary ref', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await bootstrapped(runtime, 'app');
    // `reader` captures `x` as a live cell; reading it before assignment now yields nil rather than
    // raising, which is the observable consequence of decision 8 for captures.
    const {result} = await evaluate(runtime, 'app', 'capture-nil', '[ | x reader | reader := [ x ]. reader value ]');
    assert.deepEqual(result, kernel.nil);
  });
});

test('a mutable capture begins containing nil and still observes later writes', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await bootstrapped(runtime, 'app');
    const before = await evaluate(runtime, 'app', 'cell-before', '[ | n read | read := [ n ]. read value ]');
    assert.deepEqual(before.result, kernel.nil);

    const after = await evaluate(runtime, 'app', 'cell-after', '[ | n read | read := [ n ]. n := 5. read value ]');
    assert.deepEqual(after.result, integerValue(5), 'the cell must still be shared, not snapshotted');
  });
});

// The compatibility boundary that matters most: a durable record written before the bootstrap keeps
// meaning what it meant. Reinterpreting it as nil would be migration by interpretation.
test('an existing durable unbound capture stays unbound after the kernel is installed', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    // A lexical environment recording an unbound capture, written before any kernel exists.
    const environment = await runtime.images.putLexicalEnvironment('app', {
      id: 'legacy-env',
      bindings: {'root:temporary:0': {name: 'n', unbound: true}},
    });
    const code = await runtime.images.putCodeArtifact('app', {
      id: 'reader-code',
      representation: 'neutral-expression/v0',
      content: textValue(JSON.stringify({parameters: 0, body: {op: 'binding', id: 'root:temporary:0'}})),
    });
    const block = await runtime.images.putBlock('app', {
      id: 'reader',
      code: objectRef('app', code.id),
      environment: objectRef('app', environment.id),
    });

    const invoke = async () => {
      const activation = await runtime.invocations.invokeBlock(objectRef('app', block.id), []);
      return await runtime.executor.execute(activation);
    };
    await assert.rejects(invoke(), (error) => error.name === 'UnboundBindingError');

    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});

    await assert.rejects(
      invoke(),
      (error) => error.name === 'UnboundBindingError',
      'a stored unbound record must never be reinterpreted as nil',
    );
  });
});

// Initialization lands once in the common activation layer, so the WASM lane inherits it without
// learning anything about nil — which is also why this needs no new WASM ABI.
test('the WASM lane sees the same nil-initialized temporary', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await bootstrapped(runtime, 'app');
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'wasm-nil', source: '[ | x | x ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'wasm-nil-tree',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), []);
    assert.deepEqual(await runtime.executor.execute(activation), kernel.nil);
  });
});

test('the WASM lane still raises in an unbootstrapped image', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'bare'});
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'bare', id: 'wasm-unbound', source: '[ | x | x ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('bare', installed.semanticArtifact.id),
      id: 'wasm-unbound-tree',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('bare', tree.block.id), []);
    await assert.rejects(
      runtime.executor.execute(activation),
      (error) => error.name === 'UnboundBindingError',
    );
  });
});
