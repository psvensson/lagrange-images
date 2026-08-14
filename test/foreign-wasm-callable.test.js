import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ForeignWasmModuleCache,
  WASM_BINARY_V1,
  WASM_CALLABLE_INTERFACE_V1,
  WASM_SCALAR_CALL_V0,
  booleanValue,
  bytesValue,
  createRuntime,
  decodeForeignWasmScalar,
  encodeForeignWasmScalar,
  float64Value,
  installWasmScalarCallable,
  integerValue,
  objectRef,
} from '../src/runtime.js';

const I32_ADD_WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

const IMPORT_ONLY_WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x02, 0x09, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x78, 0x00, 0x00,
]);

test('raw WASM becomes callable only through an explicit scalar interface artifact', async () => {
  let compilations = 0;
  const foreignWasmModuleCache = new ForeignWasmModuleCache({
    async compile(bytes) {
      compilations += 1;
      return await WebAssembly.compile(bytes);
    },
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignWasmModuleCache,
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const wasm = await runtime.images.putCodeArtifact('demo', {
      id: 'rust-wasm',
      languageId: 'rust',
      representation: WASM_BINARY_V1,
      content: bytesValue(I32_ADD_WASM),
    });
    const installed = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef('demo', wasm.id),
      interfaceId: 'add-interface',
      blockId: 'add-block',
      exportName: 'add',
      parameters: ['i32', 'i32'],
      result: 'i32',
    });

    assert.equal(installed.interfaceArtifact.representation, WASM_CALLABLE_INTERFACE_V1);
    assert.deepEqual(installed.interfaceArtifact.dependencies, [
      {role: 'implementation', artifact: objectRef('demo', 'rust-wasm')},
    ]);
    assert.deepEqual(JSON.parse(installed.interfaceArtifact.content.value), {
      abi: WASM_SCALAR_CALL_V0,
      export: 'add',
      parameters: ['i32', 'i32'],
      result: 'i32',
    });

    const blockRef = objectRef('demo', installed.block.id);
    const firstActivation = await runtime.invocations.invokeBlock(blockRef, [integerValue(7), integerValue(5)]);
    assert.deepEqual(await runtime.executor.execute(firstActivation), integerValue(12));
    const secondActivation = await runtime.invocations.invokeBlock(blockRef, [integerValue(-4), integerValue(9)]);
    assert.deepEqual(await runtime.executor.execute(secondActivation), integerValue(5));
    assert.equal(compilations, 1);
  } finally {
    await runtime.close();
  }
});

test('foreign scalar mapping covers boolean, signed integers and floats explicitly', () => {
  assert.equal(encodeForeignWasmScalar(booleanValue(true), 'boolean', 'bool'), 1);
  assert.equal(encodeForeignWasmScalar(booleanValue(false), 'boolean', 'bool'), 0);
  assert.equal(encodeForeignWasmScalar(integerValue(-17), 'i32', 'i32'), -17);
  assert.equal(encodeForeignWasmScalar(integerValue('9223372036854775807'), 'i64', 'i64'), 9223372036854775807n);
  assert.equal(encodeForeignWasmScalar(float64Value(1.25), 'f32', 'f32'), Math.fround(1.25));
  assert.equal(encodeForeignWasmScalar(float64Value(-2.5), 'f64', 'f64'), -2.5);

  assert.deepEqual(decodeForeignWasmScalar(1, 'boolean'), booleanValue(true));
  assert.deepEqual(decodeForeignWasmScalar(-19, 'i32'), integerValue(-19));
  assert.deepEqual(decodeForeignWasmScalar(-20n, 'i64'), integerValue(-20));
  assert.deepEqual(decodeForeignWasmScalar(Math.fround(1.25), 'f32'), float64Value(Math.fround(1.25)));
  assert.deepEqual(decodeForeignWasmScalar(-2.5, 'f64'), float64Value(-2.5));
});

test('scalar callable ABI validates arity, Value types and integer range before guest execution', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  try {
    const wasm = await runtime.images.putCodeArtifact('demo', {
      id: 'wasm',
      representation: WASM_BINARY_V1,
      content: bytesValue(I32_ADD_WASM),
    });
    const {block} = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef('demo', wasm.id),
      exportName: 'add',
      parameters: ['i32', 'i32'],
      result: 'i32',
    });
    const blockRef = objectRef('demo', block.id);

    const wrongArity = await runtime.invocations.invokeBlock(blockRef, [integerValue(1)]);
    await assert.rejects(runtime.executor.execute(wrongArity), /expected 2 arguments/);

    const wrongType = await runtime.invocations.invokeBlock(blockRef, [
      booleanValue(true),
      integerValue(1),
    ]);
    await assert.rejects(runtime.executor.execute(wrongType), /must be an integer Value/);

    const outOfRange = await runtime.invocations.invokeBlock(blockRef, [integerValue(2147483648n), integerValue(1)]);
    await assert.rejects(runtime.executor.execute(outOfRange), /outside the declared WASM scalar range/);
  } finally {
    await runtime.close();
  }
});

test('wasm-scalar-call/v0 rejects imported host dependencies and missing exports', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  try {
    const imported = await runtime.images.putCodeArtifact('demo', {
      id: 'imported-wasm',
      representation: WASM_BINARY_V1,
      content: bytesValue(IMPORT_ONLY_WASM),
    });
    const importedCallable = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef('demo', imported.id),
      exportName: 'x',
      parameters: [],
      result: 'i32',
    });
    const importedActivation = await runtime.invocations.invokeBlock(objectRef('demo', importedCallable.block.id), []);
    await assert.rejects(runtime.executor.execute(importedActivation), /requires a WebAssembly module with no imports/);

    const plain = await runtime.images.putCodeArtifact('demo', {
      id: 'plain-wasm',
      representation: WASM_BINARY_V1,
      content: bytesValue(I32_ADD_WASM),
    });
    const missing = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef('demo', plain.id),
      exportName: 'missing',
      parameters: ['i32', 'i32'],
      result: 'i32',
    });
    const missingActivation = await runtime.invocations.invokeBlock(objectRef('demo', missing.block.id), [integerValue(1), integerValue(2)]);
    await assert.rejects(runtime.executor.execute(missingActivation), /export not found or not a function/);
  } finally {
    await runtime.close();
  }
});
