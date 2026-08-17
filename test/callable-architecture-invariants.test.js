import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLABLE_INTERFACE_V1,
  CALLABLE_TYPES,
  FOREIGN_RUNTIME_BINDING_V1,
  VALUE_KIND,
  WASM_COMPONENT_BINDING_V1,
  WASM_COMPONENT_V1,
  WASM_SCALAR_CALL_V0,
  WASM_SCALAR_TYPES,
  bytesValue,
  createRuntime,
  installCallableInterface,
  installWasmComponentBinding,
  installWasmScalarCallable,
  integerValue,
  objectRef,
  parseCallableInterfaceArtifact,
  textValue,
} from '../src/runtime.js';

// A WASM module exporting add(i32, i32) -> i32 and importing nothing.
const I32_ADD_WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

test('ADR 0034 does not change the canonical Value kinds', () => {
  // The whole point of pushing richer types to the interface boundary is that the image
  // model stays this small. If this list ever grows, that decision has been reversed.
  assert.deepEqual(Object.keys(VALUE_KIND).sort(), [
    'BOOLEAN', 'BYTES', 'FLOAT64', 'INTEGER', 'PINNED_REF', 'REF', 'TEXT',
  ]);
  assert.deepEqual(Object.values(VALUE_KIND).sort(), [
    'boolean', 'bytes', 'float64', 'integer', 'pinned-ref', 'ref', 'text',
  ]);
});

test('wasm-scalar-call/v0 is frozen and still refuses rich values', async () => {
  assert.equal(WASM_SCALAR_CALL_V0, 'wasm-scalar-call/v0');
  // The scalar ABI must not have quietly gained the new interface's types.
  assert.deepEqual([...WASM_SCALAR_TYPES], ['boolean', 'i32', 'i64', 'f32', 'f64']);
  for (const richType of ['string', 'list<u8>', 's32', 's64']) {
    assert.ok(!WASM_SCALAR_TYPES.includes(richType), `scalar ABI must not accept ${richType}`);
  }

  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'demo'});
    const module = await runtime.images.putCodeArtifact('demo', {
      id: 'add-module',
      representation: 'wasm-binary/v1',
      content: bytesValue(I32_ADD_WASM),
      languageId: 'wasm',
    });
    const callable = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef('demo', module.id),
      interfaceId: 'add-interface',
      blockId: 'add-block',
      exportName: 'add',
      parameters: ['i32', 'i32'],
      result: 'i32',
    });
    const blockRef = objectRef('demo', callable.block.id);

    // Text and bytes still cannot cross the scalar boundary.
    for (const rich of [textValue('hello'), bytesValue(new Uint8Array([1, 2]))]) {
      const activation = await runtime.invocations.invokeBlock(blockRef, [rich, integerValue(1)]);
      await assert.rejects(runtime.executor.execute(activation), /must be an integer Value/);
    }

    // And a rich type cannot be declared in a scalar interface in the first place.
    await assert.rejects(installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef('demo', module.id),
      interfaceId: 'string-interface',
      blockId: 'string-block',
      exportName: 'add',
      parameters: ['string'],
      result: 'i32',
    }), /must be one of boolean, i32, i64, f32, f64/);
  } finally {
    await runtime.close();
  }
});

test('a callable interface names a shape, never an implementation or a capability', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'demo'});
    const artifact = await installCallableInterface({
      images: runtime.images,
      imageId: 'demo',
      interfaceId: 'shape-only',
      functionName: 'transform',
      parameters: ['string'],
      result: 'string',
    });

    const descriptor = parseCallableInterfaceArtifact(artifact);
    // The descriptor's entire vocabulary: an ABI tag, a name, parameter types, a result type.
    assert.deepEqual(Object.keys(descriptor).sort(), ['abi', 'function', 'parameters', 'result']);
    assert.equal(descriptor.abi, CALLABLE_INTERFACE_V1);

    // Nothing in a serialised interface may mention a lane, a module, a runtime or a provider.
    const serialised = JSON.stringify(descriptor).toLowerCase();
    for (const leak of ['wasm', 'component', 'cuis', 'smalltalk', 'provider', 'runtime', 'capability', 'import']) {
      assert.ok(!serialised.includes(leak), `interface descriptor leaked "${leak}": ${serialised}`);
    }

    // An interface with a dependency would be an implementation in disguise.
    const withDependency = await runtime.images.putCodeArtifact('demo', {
      id: 'bad-interface',
      representation: CALLABLE_INTERFACE_V1,
      content: artifact.content,
      dependencies: [{role: 'implementation', artifact: objectRef('demo', 'shape-only')}],
    });
    assert.throws(() => parseCallableInterfaceArtifact(withDependency), /must not declare dependencies/);
  } finally {
    await runtime.close();
  }
});

test('the interface type language is WIT spelled as WIT, and stays tiny', () => {
  assert.deepEqual([...CALLABLE_TYPES], ['bool', 's32', 's64', 'f32', 'f64', 'string', 'list<u8>']);
  // Structural types are deliberately absent until their relationship to the canonical
  // Value model is decided; their arrival should be a conscious ADR, not a silent addition.
  for (const deferred of ['list<string>', 'record', 'tuple', 'option', 'result', 'ref']) {
    assert.ok(!CALLABLE_TYPES.includes(deferred), `${deferred} must not appear without an ADR`);
  }
});

test('a Component binding installs and type-checks without any Component runtime', async () => {
  // jco is an optional dependency, so the durable artifacts must remain fully valid
  // without it. Only execution should be unavailable, and it should say why.
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'demo'});
    const callableInterface = await installCallableInterface({
      images: runtime.images,
      imageId: 'demo',
      interfaceId: 'normalize-interface',
      functionName: 'normalize',
      parameters: ['string'],
      result: 'string',
    });
    const component = await runtime.images.putCodeArtifact('demo', {
      id: 'component',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d])),
      languageId: 'rust',
    });
    const binding = await installWasmComponentBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', callableInterface.id),
      component: objectRef('demo', component.id),
      bindingId: 'binding',
      blockId: 'block',
    });
    const blockRef = objectRef('demo', binding.block.id);

    // The shared interface is still enforced, before any runtime is consulted.
    const wrongType = await runtime.invocations.invokeBlock(blockRef, [integerValue(1)]);
    await assert.rejects(runtime.executor.execute(wrongType), /must be a text Value for string/);

    const valid = await runtime.invocations.invokeBlock(blockRef, [textValue('x')]);
    await assert.rejects(runtime.executor.execute(valid), /no Component runtime registered/);
  } finally {
    await runtime.close();
  }
});

test('bindings are the only artifacts that know a lane exists', () => {
  // Each lane's identity lives entirely in its binding representation, never in the
  // interface, so adding a third lane cannot require touching either existing one.
  assert.equal(WASM_COMPONENT_BINDING_V1, 'wasm-component-binding/v1');
  assert.equal(FOREIGN_RUNTIME_BINDING_V1, 'foreign-runtime-binding/v1');
  assert.notEqual(WASM_COMPONENT_BINDING_V1, FOREIGN_RUNTIME_BINDING_V1);
  assert.ok(!CALLABLE_INTERFACE_V1.includes('wasm'));
  assert.ok(!CALLABLE_INTERFACE_V1.includes('foreign'));
});
