import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  createRuntime,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  installWasmBlockTree,
  integerValue,
  objectRef,
} from '../src/runtime.js';

// The empty literal Array `#()` — a general Smalltalk literal facility, demanded
// by the authentic upstream MessagePack RED (`MpDecoder>>createArray:` =
// `^#()`; the only `#(...)` in the pinned MessagePack-Core closure). It lowers
// to the ordinary `Array new: 0` send, composing the existing Array allocation
// machinery — no new lagrange-code op, no generic Value array-literal kind, no
// literal carrying nested Smalltalk objects, and no baked image-local ref
// (`Array` resolves through the ordinary global namespace at install time).
//
// Element forms `#( 1 2 3 )` are a separate general facility the upstream RED
// does not demand; the parser rejects them deterministically until one is.

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
  return await installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId, lane,
  });
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

test('#() evaluates to an empty Array', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'lit');
    assert.deepEqual(await evaluate(runtime, 'lit', 'size', '[ #() size ]'), integerValue(0));
    assert.deepEqual(
      await evaluate(runtime, 'lit', 'class', '[ #() class == Array ]'), booleanValue(true),
    );
  });
});

test('two evaluations of #() are equal empty Arrays with no baked ref', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'lit2');
    // Each evaluation allocates a fresh Array — they are distinct objects but
    // equal in size, and neither is a pre-baked image-local reference.
    assert.deepEqual(await evaluate(runtime, 'lit2', 'eq', '[ #() size = #() size ]'), booleanValue(true));
    assert.deepEqual(
      await evaluate(runtime, 'lit2', 'not-identical', '[ #() == #() ]'), booleanValue(false),
    );
  });
});

test('#() works after re-entering the executor over the same image', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'lit3');
    assert.deepEqual(await evaluate(runtime, 'lit3', 'first', '[ #() size ]'), integerValue(0));
    // A fresh executor entry over the same durable image compiles and runs the
    // same literal identically.
    assert.deepEqual(await evaluate(runtime, 'lit3', 'second', '[ #() class == Array ]'), booleanValue(true));
  });
});

test('#() agrees across neutral and WASM lanes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'lit-w', {lane: 'wasm'});
    const run = async (id, source, args = []) => {
      const installed = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'lit-w', id, source,
      });
      const tree = await installWasmBlockTree({
        images: runtime.images, compilation: runtime.compilation,
        semanticRef: objectRef('lit-w', installed.semanticArtifact.id),
        id: `${id}:tree`, environment: installed.block.environment,
      });
      const activation = await runtime.invocations.invokeBlock(objectRef('lit-w', tree.block.id), args);
      return await runtime.executor.execute(activation);
    };
    const wasmSize = await run('w-size', '[ #() size ]');
    const neutralSize = await evaluate(runtime, 'lit-w', 'n-size', '[ #() size ]');
    assert.deepEqual(wasmSize, integerValue(0));
    assert.deepEqual(wasmSize, neutralSize);
  });
});

test('malformed/unsupported literal-Array syntax is rejected deterministically', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'lit4');
    // Element syntax is not the demanded facility — refused at compile time.
    await assert.rejects(
      evaluate(runtime, 'lit4', 'elem', '[ #( 1 2 ) ]'),
      /literal Array element syntax is not supported/,
    );
    // Byte-array literal `#[...]` is a separate classification, not this facility.
    await assert.rejects(
      evaluate(runtime, 'lit4', 'bytes', '[ #[ 1 2 ] ]'),
      /byte-array literal syntax/,
    );
    // An unterminated literal is rejected deterministically, never silently
    // mis-parsed — the parser refuses the non-`)` token it finds next.
    await assert.rejects(
      evaluate(runtime, 'lit4', 'unclosed', '[ #( ]'), /literal Array element syntax is not supported/,
    );
  });
});
