import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  WASM_COMPONENT_V1,
  installCallableInterfaceV2,
  normalizeTypeDeclarations,
  packCompositeValue,
  unpackCompositeValue,
  assertCallableValueType,
  bytesValue,
  createJcoComponentRuntime,
  createRuntime,
  float64Value,
  installCallableInterface,
  installWasmComponentBinding,
  integerValue,
  textValue,
  objectRef,
} from '../src/runtime.js';

const COMPONENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'normalize-component', 'normalize.component.wasm',
);

async function componentLane({functionName, parameters, result, id, types = null}) {
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
  const install = types === null ? installCallableInterface : installCallableInterfaceV2;
  const callableInterface = await install({
    images: runtime.images,
    imageId: 'demo',
    interfaceId: `${id}-interface`,
    functionName,
    parameters,
    result,
    ...(types === null ? {} : {types}),
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

// The first composite through the Component lane. list<string> rather than list<s32>
// because it exercises the codec — variable-length elements, Unicode, empty strings, empty
// lists — instead of mostly testing array iteration.
test('list<string> survives the Component lane as an interface-composite/v0 envelope', async () => {
  const type = {kind: 'list', element: 'string'};
  const {runtime, call} = await componentLane({
    functionName: 'normalize-all', parameters: [type], result: type, id: 'normalize-all', types: {},
  });
  try {
    const spec = (text) => text.toLowerCase().replace(/[\t\n\v\f\r ]+/g, ' ').trim();
    const cases = [
      [],
      [''],
      ['  Hello   World  '],
      ['a', 'B', '  c  '],
      ['', '', ''],
      ['  HÄLLO   Wörld  ', '  世界  \u{1f600} '],
      // Content that looks like the Cuis line protocol must be inert inside an envelope.
      ['d:looks-like-a-token', 'e:%20also', 'OK\tERR', 'a\nb'],
      Array.from({length: 500}, (_, i) => `  Item ${i}  `),
    ];
    for (const input of cases) {
      const packed = await call([packCompositeValue(input, type)]);
      // The Block edge really does carry bytes, not a list.
      assert.equal(packed.kind, 'bytes');
      assert.deepEqual(unpackCompositeValue(packed, type), input.map(spec),
        `normalize-all disagreed for ${JSON.stringify(input).slice(0, 60)}`);
    }

    // An envelope for the wrong type must be refused before the Component is reached.
    await assert.rejects(call([packCompositeValue([1n, 2n], {kind: 'list', element: 's64'})]),
      /encoded against a different interface type/);
  } finally {
    await runtime.close();
  }
});

const ITEM_TYPES = normalizeTypeDeclarations({
  item: {
    kind: 'record',
    fields: [
      {name: 'name', type: 'string'},
      {name: 'quantity', type: 's64'},
      {name: 'enabled', type: 'bool'},
    ],
  },
});

test('named records survive the Component lane in both directions', async () => {
  const spec = (text) => text.toLowerCase().replace(/[\t\n\v\f\r ]+/g, ' ').trim();

  const relabel = await componentLane({
    functionName: 'relabel', parameters: ['item'], result: 'item', id: 'relabel', types: ITEM_TYPES,
  });
  try {
    const cases = [
      {name: '  HÄLLO  x ', quantity: 0n, enabled: true},
      // s64 extremes pass through untouched, so the record proves integer fidelity too.
      {name: '', quantity: 9223372036854775807n, enabled: false},
      {name: '世界 \u{1f600}', quantity: -9223372036854775808n, enabled: true},
      {name: 'a\tb', quantity: -1n, enabled: false},
    ];
    for (const input of cases) {
      const packed = await relabel.call([packCompositeValue(input, 'item', ITEM_TYPES)]);
      assert.equal(packed.kind, 'bytes');
      assert.deepEqual(unpackCompositeValue(packed, 'item', ITEM_TYPES), {
        name: spec(input.name), quantity: input.quantity, enabled: !input.enabled,
      });
    }
  } finally {
    await relabel.runtime.close();
  }

  // A record result with no record argument: the lane must produce a valid envelope from
  // scalars alone.
  const make = await componentLane({
    functionName: 'make-item', parameters: ['string', 's64'], result: 'item', id: 'make-item', types: ITEM_TYPES,
  });
  try {
    for (const [name, quantity] of [['  Some  Name ', 3n], ['', 0n], ['X', -7n]]) {
      const packed = await make.call([textValue(name), integerValue(quantity)]);
      assert.deepEqual(unpackCompositeValue(packed, 'item', ITEM_TYPES), {
        name: spec(name), quantity, enabled: quantity > 0n,
      });
    }
  } finally {
    await make.runtime.close();
  }
});

// The first composite whose element type is itself a composite: the codec has to recurse
// rather than special-case, on both sides.
test('list<item> composes a list and a record through the Component lane', async () => {
  const spec = (text) => text.toLowerCase().replace(/[\t\n\v\f\r ]+/g, ' ').trim();
  const type = {kind: 'list', element: 'item'};
  const {runtime, call} = await componentLane({
    functionName: 'relabel-all', parameters: [type], result: type, id: 'relabel-all', types: ITEM_TYPES,
  });
  try {
    const cases = [
      [],
      [{name: '  A  b ', quantity: 1n, enabled: true}],
      [
        {name: '', quantity: 9223372036854775807n, enabled: false},
        {name: '世界 \u{1f600}', quantity: -9223372036854775808n, enabled: true},
      ],
      Array.from({length: 300}, (_, i) => ({
        name: `  Item ${i}  `, quantity: BigInt(i) - 150n, enabled: i % 2 === 0,
      })),
    ];
    for (const input of cases) {
      const packed = await call([packCompositeValue(input, type, ITEM_TYPES)]);
      assert.equal(packed.kind, 'bytes');
      assert.deepEqual(unpackCompositeValue(packed, type, ITEM_TYPES),
        input.map((item) => ({name: spec(item.name), quantity: item.quantity, enabled: !item.enabled})),
        `relabel-all disagreed for ${input.length} items`);
    }

    // A list<item> envelope is not an item envelope, even though item is its element type.
    await assert.rejects(call([packCompositeValue({name: 'x', quantity: 0n, enabled: true}, 'item', ITEM_TYPES)]),
      /encoded against a different interface type/);
  } finally {
    await runtime.close();
  }
});
