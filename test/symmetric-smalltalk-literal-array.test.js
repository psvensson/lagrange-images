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
  parseSymmetricSmalltalkBlock,
  compileSymmetricSmalltalkBlock,
  textValue,
} from '../src/runtime.js';

// The empty literal Array `#()` — a general Smalltalk literal facility, demanded
// by the authentic upstream MessagePack RED (`MpDecoder>>createArray:` =
// `^#()`; the only `#(...)` in the pinned MessagePack-Core closure). It lowers
// to the ordinary `Array new: 0` send, composing the existing Array allocation
// machinery — no new lagrange-code op, no generic Value array-literal kind, no
// literal carrying nested Smalltalk objects, and no baked image-local ref
// (`Array` resolves through the ordinary global namespace at install time).
//
// YAXO's unchanged XMLTokenizer class>>initialize now demands literal elements (x4i).
// They compose this same allocation with ordered native at:put: sends.

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

test('literal Arrays accept literal elements and never evaluate expression syntax', () => {
  const parsed = parseSymmetricSmalltalkBlock(`[ #( $& $" $' $> $< ) ]`);
  assert.deepEqual(parsed.body.elements, ['&', '"', "'", '>', '<'].map(value => ({kind: 'character', value})));
  assert.deepEqual(parseSymmetricSmalltalkBlock('[ #(9 10 12 13 32 61 "comment" 62 47) ]').body.elements.map(x => x.value), ['9', '10', '12', '13', '32', '61', '62', '47']);
  assert.deepEqual(parseSymmetricSmalltalkBlock('[ #(unboundName) ]').body.elements, [{kind: 'symbol', value: 'unboundName'}]);
  for (const expression of ['[ #( ]', '[ #(1', '[ #( [1] ) ]', '[ #(x := 1) ]', '[ #(1 + 2) ]']) {
    assert.throws(() => parseSymmetricSmalltalkBlock(expression), /literal Array elements must be literals/);
  }
  assert.throws(() => parseSymmetricSmalltalkBlock('[ #[1 2] ]'), /byte-array literal syntax/);
});

test('nonempty literal Arrays use existing v1 operations with distinct temporary identities', () => {
  const {program} = compileSymmetricSmalltalkBlock('[ #(1 #(2)) size + #(3) size ]');
  assert.equal(program.temporaries.length, 3);
  assert.equal(new Set(program.temporaries.map(x => x.id)).size, 3);
  assert.doesNotMatch(JSON.stringify(program), /"kind":"ref"|"op":"array/);
  assert.equal(compileSymmetricSmalltalkBlock('[ #() ]').program.body.op, 'send');
});

test('literal elements preserve order, type, nesting and separate evaluations in both lanes', async () => {
  await withRuntime(async runtime => {
    await seed(runtime, 'elements', {lane: 'wasm'});
    let serial = 0;
    for (const lane of ['neutral', 'wasm']) {
      const run = async source => {
        const id = `elements-${serial++}`;
        const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId: 'elements', id, source});
        const block = lane === 'neutral' ? installed.block : (await installWasmBlockTree({
          images: runtime.images, compilation: runtime.compilation,
          semanticRef: objectRef('elements', installed.semanticArtifact.id), id: `${id}:wasm`, environment: installed.block.environment,
        })).block;
        return runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef('elements', block.id), []));
      };
      for (const [source, expected] of [
        [`[ #( $& $" $' $> $< ) size ]`, integerValue(5)],
        [`[ (#( $& $" $' $> $< ) at: 5) = $< ]`, booleanValue(true)],
        ['[ #(9 10 12 13 32 61 62 47) at: 8 ]', integerValue(47)],
        ['[ #(-1 0 16rFF) at: 1 ]', integerValue(-1)],
        ["[ #(true false nil 'text' name) at: 4 ]", textValue('text')],
        ['[ (#(unknownName) at: 1) == #unknownName ]', booleanValue(true)],
        ['[ (#(1 #(2 3)) at: 2) at: 1 ]', integerValue(2)],
        ['[ #(1) == #(1) ]', booleanValue(false)],
        ['[ [ #(1 2) at: 2 ] value ]', integerValue(2)],
      ]) assert.deepEqual(await run(source), expected, `${lane}: ${source}`);
    }
  });
});
