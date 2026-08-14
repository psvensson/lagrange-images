import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WASM_FUNCTION_V1,
  WASM_MODULE_V1,
  assertWasmFunctionArtifact,
  assertWasmModuleArtifact,
  bytesValue,
  createRuntime,
  objectRef,
} from '../src/runtime.js';

test('WASM module artifacts are bytes derived from semantic code', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const module = await runtime.images.putCodeArtifact('demo', {
    id: 'module',
    representation: WASM_MODULE_V1,
    content: bytesValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d])),
  });
  assert.equal(assertWasmModuleArtifact(module), module);
  await runtime.close();
});

test('WASM function artifacts name an entry inside a referenced module artifact', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  await runtime.images.putCodeArtifact('demo', {
    id: 'module',
    representation: WASM_MODULE_V1,
    content: bytesValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d])),
  });
  const fn = await runtime.images.putCodeArtifact('demo', {
    id: 'function',
    representation: WASM_FUNCTION_V1,
    content: objectRef('demo', 'module'),
    metadata: {entry: 'block_0'},
  });
  assert.equal(assertWasmFunctionArtifact(fn), fn);
  assert.deepEqual(fn.content, objectRef('demo', 'module'));
  await runtime.close();
});
