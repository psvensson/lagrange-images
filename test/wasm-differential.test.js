import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V0,
  NEUTRAL_EXPRESSION_V0,
  WASM_MODULE_V1,
  compileWasmFunctionArtifact,
  createRuntime,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

async function installSemantic(runtime, id, program) {
  return await runtime.images.putCodeArtifact('demo', {
    id,
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify(program)),
  });
}

async function installInterpreterBlock(runtime, semantic, id) {
  const code = await runtime.compilation.compileArtifact(
    objectRef('demo', semantic.id),
    {id: `${id}:code`, targetRepresentation: NEUTRAL_EXPRESSION_V0},
  );
  return await runtime.images.putBlock('demo', {
    id,
    code: objectRef('demo', code.id),
  });
}

async function installWasmBlock(runtime, semantic, id) {
  const {moduleArtifact, functionArtifact} = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    moduleId: `${id}:module`,
    functionId: `${id}:function`,
  });
  assert.equal(moduleArtifact.representation, WASM_MODULE_V1);
  assert.equal(WebAssembly.validate(Buffer.from(moduleArtifact.content.base64, 'base64')), true);
  return await runtime.images.putBlock('demo', {
    id,
    code: objectRef('demo', functionArtifact.id),
  });
}

async function execute(runtime, block, args = []) {
  const activation = await runtime.invocations.invokeBlock(objectRef('demo', block.id), args);
  return await runtime.executor.execute(activation);
}

test('WASM backend matches interpreter for argument integer addition', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await installSemantic(runtime, 'add-semantic', {
    parameters: [
      {id: 'arg:0:left', name: 'left'},
      {id: 'arg:1:right', name: 'right'},
    ],
    captures: [],
    body: {
      op: 'integer-add',
      left: {op: 'argument', index: 0},
      right: {op: 'argument', index: 1},
    },
  });
  const interpreted = await installInterpreterBlock(runtime, semantic, 'add-interpreted');
  const wasm = await installWasmBlock(runtime, semantic, 'add-wasm');
  const args = [integerValue('900719925474099312345'), integerValue('7')];
  assert.deepEqual(await execute(runtime, wasm, args), await execute(runtime, interpreted, args));
  assert.deepEqual(await execute(runtime, wasm, args), integerValue('900719925474099312352'));
  await runtime.close();
});

test('WASM backend matches interpreter for literals, equality and conditional control', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await installSemantic(runtime, 'if-semantic', {
    parameters: [{id: 'arg:0:value', name: 'value'}],
    captures: [],
    body: {
      op: 'if',
      condition: {
        op: 'equals',
        left: {op: 'argument', index: 0},
        right: {op: 'literal', value: integerValue(42)},
      },
      then: {op: 'literal', value: textValue('answer')},
      else: {op: 'literal', value: textValue('other')},
    },
  });
  const interpreted = await installInterpreterBlock(runtime, semantic, 'if-interpreted');
  const wasm = await installWasmBlock(runtime, semantic, 'if-wasm');
  for (const value of [integerValue(42), integerValue(9)]) {
    assert.deepEqual(await execute(runtime, wasm, [value]), await execute(runtime, interpreted, [value]));
  }
  await runtime.close();
});
