import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WASM_COMPONENT_V1,
  WASM_WIT_CALLABLE_INTERFACE_V1,
  booleanValue,
  bytesValue,
  createRuntime,
  decodeWitValue,
  encodeWitValue,
  float64Value,
  installWasmWitCallable,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

test('WIT callable interface artifact separates interface identity from component implementation', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  try {
    const component = await runtime.images.putCodeArtifact('demo', {
      id: 'normalize-component',
      languageId: 'rust',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d])),
    });
    const installed = await installWasmWitCallable({
      images: runtime.images,
      component: objectRef('demo', component.id),
      interfaceId: 'normalize-interface',
      blockId: 'normalize-block',
      functionName: 'normalize',
      parameters: ['string'],
      result: 'string',
    });

    assert.equal(installed.interfaceArtifact.representation, WASM_WIT_CALLABLE_INTERFACE_V1);
    assert.deepEqual(installed.interfaceArtifact.dependencies, [
      {role: 'implementation', artifact: objectRef('demo', 'normalize-component')},
    ]);
    assert.deepEqual(JSON.parse(installed.interfaceArtifact.content.value), {
      abi: 'wit-canonical-call/v0',
      function: 'normalize',
      parameters: ['string'],
      result: 'string',
    });
    assert.equal(installed.block.environment, null);
  } finally {
    await runtime.close();
  }
});

test('WIT callable executor invokes through a Component runtime and returns canonical Values', async () => {
  const normalizeRuntime = {
    async invoke(_component, functionName, args) {
      if (functionName === 'normalize') {
        const text = args[0];
        return text.toLowerCase().replace(/\s+/g, ' ').trim();
      }
      if (functionName === 'add-bytes') {
        return new Uint8Array(args[0].map((b, i) => (b + args[1][i]) & 0xff));
      }
      throw new Error(`unknown function: ${functionName}`);
    },
  };
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    componentRuntime: normalizeRuntime,
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const component = await runtime.images.putCodeArtifact('demo', {
      id: 'text-component',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(new Uint8Array([0x00])),
    });

    const normalize = await installWasmWitCallable({
      images: runtime.images,
      component: objectRef('demo', component.id),
      functionName: 'normalize',
      parameters: ['string'],
      result: 'string',
    });
    const normalizeRef = objectRef('demo', normalize.block.id);
    const a1 = await runtime.invocations.invokeBlock(normalizeRef, [textValue('  Hello   World  ')]);
    assert.deepEqual(await runtime.executor.execute(a1), textValue('hello world'));
    const a2 = await runtime.invocations.invokeBlock(normalizeRef, [textValue('ALREADY lower')]);
    assert.deepEqual(await runtime.executor.execute(a2), textValue('already lower'));

    const addBytes = await installWasmWitCallable({
      images: runtime.images,
      component: objectRef('demo', component.id),
      functionName: 'add-bytes',
      parameters: ['list<u8>', 'list<u8>'],
      result: 'list<u8>',
    });
    const addRef = objectRef('demo', addBytes.block.id);
    const b1 = await runtime.invocations.invokeBlock(addRef, [
      bytesValue(new Uint8Array([1, 2, 3])),
      bytesValue(new Uint8Array([10, 20, 30])),
    ]);
    assert.deepEqual(await runtime.executor.execute(b1), bytesValue(new Uint8Array([11, 22, 33])));
  } finally {
    await runtime.close();
  }
});

test('WIT callable executor validates arity, types and rejects without a Component runtime', async () => {
  const runtimeNoRuntime = await createRuntime({backend: {mode: 'mock'}});
  await runtimeNoRuntime.images.createImage({id: 'demo'});
  try {
    const comp = await runtimeNoRuntime.images.putCodeArtifact('demo', {
      id: 'c', representation: WASM_COMPONENT_V1, content: bytesValue(new Uint8Array([0x00])),
    });
    const {block} = await installWasmWitCallable({
      images: runtimeNoRuntime.images,
      component: objectRef('demo', comp.id),
      functionName: 'f', parameters: ['string'], result: 'string',
    });
    const act = await runtimeNoRuntime.invocations.invokeBlock(objectRef('demo', block.id), [textValue('x')]);
    await assert.rejects(runtimeNoRuntime.executor.execute(act), /no Component runtime registered/);
  } finally {
    await runtimeNoRuntime.close();
  }

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    componentRuntime: {async invoke() { return 'ok'; }},
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const comp = await runtime.images.putCodeArtifact('demo', {
      id: 'c', representation: WASM_COMPONENT_V1, content: bytesValue(new Uint8Array([0x00])),
    });
    const {block} = await installWasmWitCallable({
      images: runtime.images,
      component: objectRef('demo', comp.id),
      functionName: 'f', parameters: ['string', 'string'], result: 'string',
    });
    const blockRef = objectRef('demo', block.id);

    const wrongArity = await runtime.invocations.invokeBlock(blockRef, [textValue('x')]);
    await assert.rejects(runtime.executor.execute(wrongArity), /expected 2 arguments/);

    const wrongType = await runtime.invocations.invokeBlock(blockRef, [integerValue(1), textValue('y')]);
    await assert.rejects(runtime.executor.execute(wrongType), /must be a text Value/);
  } finally {
    await runtime.close();
  }
});

test('WIT Value encoding covers all supported types', () => {
  assert.equal(encodeWitValue(booleanValue(true), 'bool', 'b'), true);
  assert.equal(encodeWitValue(booleanValue(false), 'bool', 'b'), false);
  assert.equal(encodeWitValue(integerValue(42), 's32', 'i'), 42);
  assert.equal(encodeWitValue(integerValue('-9223372036854775808'), 's64', 'i'), -9223372036854775808n);
  assert.equal(encodeWitValue(float64Value(1.5), 'f32', 'f'), Math.fround(1.5));
  assert.equal(encodeWitValue(float64Value(-2.5), 'f64', 'f'), -2.5);
  assert.equal(encodeWitValue(textValue('hello'), 'string', 's'), 'hello');
  assert.deepEqual([...encodeWitValue(bytesValue(new Uint8Array([1, 2])), 'list<u8>', 'b')], [1, 2]);

  assert.deepEqual(decodeWitValue(true, 'bool'), booleanValue(true));
  assert.deepEqual(decodeWitValue(42, 's32'), integerValue(42));
  assert.deepEqual(decodeWitValue(-1n, 's64'), integerValue(-1));
  assert.deepEqual(decodeWitValue(1.5, 'f64'), float64Value(1.5));
  assert.deepEqual(decodeWitValue('text', 'string'), textValue('text'));
  assert.deepEqual(decodeWitValue(new Uint8Array([1, 2]), 'list<u8>'), bytesValue(new Uint8Array([1, 2])));

  assert.throws(() => encodeWitValue(integerValue(1), 'bool', 'x'), /must be a boolean/);
  assert.throws(() => encodeWitValue(textValue('x'), 's32', 'x'), /must be an integer/);
  assert.throws(() => encodeWitValue(integerValue(2147483648n), 's32', 'x'), /outside s32/);
  assert.throws(() => encodeWitValue(booleanValue(true), 'string', 'x'), /must be a text/);
  assert.throws(() => encodeWitValue(textValue('x'), 'list<u8>', 'x'), /must be a bytes/);
});
