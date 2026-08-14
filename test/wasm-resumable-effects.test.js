import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WASM_BINARY_V1,
  WASM_RESUMABLE_VALUE_HANDLE_ABI_V1,
  bytesValue,
  compileWasmFunctionArtifact,
  createRuntime,
  installSymmetricSmalltalkBlock,
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

test('resumable Lagrange WASM survives multiple sequential non-tail Block sends in one activation', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  try {
    const wasm = await runtime.images.putCodeArtifact('demo', {
      id: 'add-wasm',
      languageId: 'rust',
      representation: WASM_BINARY_V1,
      content: bytesValue(I32_ADD_WASM),
    });
    const {block: addBlock} = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef('demo', wasm.id),
      interfaceId: 'add-interface',
      blockId: 'add-block',
      exportName: 'add',
      parameters: ['i32', 'i32'],
      result: 'i32',
    });
    const environment = await runtime.images.putLexicalEnvironment('demo', {
      id: 'env',
      bindings: {
        'binding:add': {name: 'add', value: objectRef('demo', addBlock.id)},
      },
    });
    const environmentRef = objectRef('demo', environment.id);
    const source = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'demo',
      id: 'orchestrator',
      source: '[ :x | add value: (add value: x value: x) value: (add value: x value: x) ]',
      captures: {add: 'binding:add'},
      environment: environmentRef,
    });
    const compiled = await compileWasmFunctionArtifact({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('demo', source.semanticArtifact.id),
      moduleId: 'orchestrator:wasm-module',
      functionId: 'orchestrator:wasm-function',
    });
    const block = await runtime.images.putBlock('demo', {
      id: 'orchestrator:wasm-block',
      code: objectRef('demo', compiled.functionArtifact.id),
      environment: environmentRef,
    });

    assert.equal(compiled.moduleArtifact.metadata.abi, WASM_RESUMABLE_VALUE_HANDLE_ABI_V1);
    assert.equal(compiled.moduleArtifact.metadata.effectSites.length, 3);
    assert.notEqual(compiled.moduleArtifact.metadata.effectSites[0].resumeEntry, null);
    assert.notEqual(compiled.moduleArtifact.metadata.effectSites[1].resumeEntry, null);
    assert.equal(compiled.moduleArtifact.metadata.effectSites[2].resumeEntry, null);
    assert.equal(compiled.moduleArtifact.metadata.continuations.length, 2);

    const activation = await runtime.invocations.invokeBlock(
      objectRef('demo', block.id),
      [integerValue(3)],
    );
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(12));
  } finally {
    await runtime.close();
  }
});
