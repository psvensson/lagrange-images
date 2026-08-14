import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WASM_FUNCTION_V1,
  WASM_MODULE_V1,
  WASM_VALUE_HANDLE_ABI_V0,
  assertWasmFunctionArtifact,
  assertWasmModuleArtifact,
  bytesValue,
  createRuntime,
  objectRef,
} from '../src/runtime.js';

test('WASM module artifacts are bytecode plus explicit ABI-derived metadata', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const module = await runtime.images.putCodeArtifact('demo', {
    id: 'module',
    representation: WASM_MODULE_V1,
    content: bytesValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d])),
    metadata: {abi: WASM_VALUE_HANDLE_ABI_V0, literals: []},
  });
  assert.equal(assertWasmModuleArtifact(module), module);
  await runtime.close();
});

test('WASM function artifacts name an ABI entry and semantic calling shape', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  await runtime.images.putCodeArtifact('demo', {
    id: 'module',
    representation: WASM_MODULE_V1,
    content: bytesValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d])),
    metadata: {abi: WASM_VALUE_HANDLE_ABI_V0, literals: []},
  });
  const fn = await runtime.images.putCodeArtifact('demo', {
    id: 'function',
    representation: WASM_FUNCTION_V1,
    content: objectRef('demo', 'module'),
    metadata: {
      abi: WASM_VALUE_HANDLE_ABI_V0,
      entry: 'run',
      parameters: 1,
      captures: ['capture:x'],
    },
  });
  assert.equal(assertWasmFunctionArtifact(fn), fn);
  assert.deepEqual(fn.content, objectRef('demo', 'module'));
  await runtime.close();
});
