import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileWasmFunctionArtifact,
  createRuntime,
  integerValue,
  LAGRANGE_CODE_V0,
  objectRef,
  textValue,
  WASM_MODULE_V2,
  WASM_VALUE_HANDLE_ABI_V0,
} from '../src/runtime.js';

test('WASM ABI passes captured bindings by stable binding id after receiver and arguments', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await runtime.images.putCodeArtifact('demo', {
    id: 'captured-semantic',
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify({
      parameters: [{id: 'arg:0:value', name: 'value'}],
      captures: [{id: 'capture:offset', name: 'offset'}],
      body: {
        op: 'integer-add',
        left: {op: 'argument', index: 0},
        right: {op: 'binding', id: 'capture:offset'},
      },
    })),
  });
  const {functionArtifact} = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    moduleId: 'captured-module',
    functionId: 'captured-function',
  });
  assert.equal(functionArtifact.metadata.abi, WASM_VALUE_HANDLE_ABI_V0);
  assert.equal(functionArtifact.metadata.parameters, 1);
  assert.deepEqual(functionArtifact.metadata.captures, ['capture:offset']);

  const environment = await runtime.images.putLexicalEnvironment('demo', {
    id: 'captured-env',
    bindings: {
      'capture:offset': {name: 'offset', value: integerValue('100000000000000000000')},
    },
  });
  const block = await runtime.images.putBlock('demo', {
    id: 'captured-block',
    code: objectRef('demo', functionArtifact.id),
    environment: objectRef('demo', environment.id),
  });
  const activation = await runtime.invocations.invokeBlock(
    objectRef('demo', block.id),
    [integerValue(23)],
  );
  assert.deepEqual(
    await runtime.executor.execute(activation),
    integerValue('100000000000000000023'),
  );
  await runtime.close();
});

test('WASM value handles are invocation-local and not persistent identities', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  assert.equal(runtime.codeExecutors.has('wasm-function/v1'), true);
  assert.equal(runtime.codeCompilers.has(LAGRANGE_CODE_V0, WASM_MODULE_V2), true);
  await runtime.close();
});
