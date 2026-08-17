import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  WASM_COMPONENT_V1,
  assertCallableValueType,
  bytesValue,
  createJcoComponentRuntime,
  createRuntime,
  float64Value,
  installCallableInterface,
  installWasmComponentBinding,
  objectRef,
} from '../src/runtime.js';

const COMPONENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'normalize-component', 'normalize.component.wasm',
);

async function componentLane({functionName, parameters, result, id}) {
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    componentRuntime: createJcoComponentRuntime(),
  });
  await runtime.images.createImage({id: 'demo'});
  const component = await runtime.images.putCodeArtifact('demo', {
    id: 'component',
    representation: WASM_COMPONENT_V1,
    content: bytesValue(await readFile(COMPONENT_PATH)),
    languageId: 'rust',
  });
  const callableInterface = await installCallableInterface({
    images: runtime.images,
    imageId: 'demo',
    interfaceId: `${id}-interface`,
    functionName,
    parameters,
    result,
  });
  const binding = await installWasmComponentBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', callableInterface.id),
    component: objectRef('demo', component.id),
    bindingId: `${id}-binding`,
    blockId: `${id}-block`,
  });
  const call = async (args) => await runtime.executor.execute(
    await runtime.invocations.invokeBlock(objectRef('demo', binding.block.id), args),
  );
  return {runtime, call};
}

test('bytes survive the Component canonical ABI byte for byte', async () => {
  const {runtime, call} = await componentLane({
    functionName: 'reverse', parameters: ['list<u8>'], result: 'list<u8>', id: 'reverse',
  });
  try {
    const cases = [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([1, 2, 3]),
      // Every byte value, so no value can be lost, remapped or treated as a terminator.
      new Uint8Array(Array.from({length: 256}, (_, i) => i)),
      // Long enough that any chunking or line-wrapping in a transport would show up.
      new Uint8Array(Array.from({length: 5000}, (_, i) => i % 256)),
    ];
    for (const input of cases) {
      const expected = bytesValue(new Uint8Array([...input].reverse()));
      assert.deepEqual(await call([bytesValue(input)]), expected,
        `reverse disagreed for ${input.length} bytes`);
    }
  } finally {
    await runtime.close();
  }
});

test('float64 survives the Component canonical ABI bit for bit', async () => {
  const {runtime, call} = await componentLane({
    functionName: 'scale', parameters: ['f64', 'f64'], result: 'f64', id: 'scale',
  });
  try {
    const cases = [
      [1.5, 2.25],
      // Inexact on purpose: the product must match IEEE 754 exactly, not approximately.
      [0.1, 3],
      [-0, 1],
      [1e308, 10],          // overflows to Infinity
      [5e-324, 0.5],        // smallest subnormal, underflows to zero
      [Number.MAX_SAFE_INTEGER, 1],
      [NaN, 1],
    ];
    for (const [value, factor] of cases) {
      const expected = float64Value(value * factor);
      assert.deepEqual(await call([float64Value(value), float64Value(factor)]), expected,
        `scale disagreed for ${value} * ${factor}`);
    }
  } finally {
    await runtime.close();
  }
});

// f32 is the one type whose meaning had to be decided rather than merely transported.
test('f32 means a float64 rounded to f32 precision, and the interface does the rounding', async () => {
  // The rule lives in the shared interface, so it applies identically to every lane and
  // is observable without involving one.
  assert.deepEqual(
    assertCallableValueType(float64Value(0.1), 'f32', 'x'),
    float64Value(Math.fround(0.1)),
  );
  assert.deepEqual(assertCallableValueType(float64Value(1.5), 'f32', 'x'), float64Value(1.5));
  assert.deepEqual(
    assertCallableValueType(float64Value(Infinity), 'f32', 'x'),
    float64Value(Infinity),
  );

  const {runtime, call} = await componentLane({
    // Hyphenated, so this also proves the WIT-name to jco-export mapping.
    functionName: 'echo-f32', parameters: ['f32'], result: 'f32', id: 'echo-f32',
  });
  try {
    for (const input of [0.1, 1.5, -0, 3.4028234663852886e38, Infinity]) {
      assert.deepEqual(await call([float64Value(input)]), float64Value(Math.fround(input)),
        `echo-f32 disagreed for ${input}`);
    }
    // The value that comes back is already f32-precise, so re-rounding changes nothing.
    const once = await call([float64Value(0.1)]);
    assert.deepEqual(await call([once]), once, 'f32 rounding must be idempotent');
  } finally {
    await runtime.close();
  }
});
