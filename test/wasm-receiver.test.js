import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V0,
  compileWasmFunctionArtifact,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';

test('WASM receiver handle carries an object ref without making it a WASM identity', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await runtime.images.putCodeArtifact('demo', {
    id: 'yourself-semantic',
    languageId: 'symmetric-smalltalk',
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify({
      parameters: [],
      captures: [],
      body: {op: 'receiver'},
    })),
  });
  const {functionArtifact} = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    moduleId: 'yourself-module',
    functionId: 'yourself-function',
  });
  const method = await runtime.images.putBlock('demo', {
    id: 'yourself-method',
    code: objectRef('demo', functionArtifact.id),
  });
  const behaviorShape = await runtime.images.putShape('demo', {
    id: 'behavior-shape',
    slots: [{id: 'method-yourself', name: 'yourself'}],
  });
  await runtime.images.putObject('demo', {
    id: 'Behavior',
    shape: objectRef('demo', behaviorShape.id),
    slots: {'method-yourself': objectRef('demo', method.id)},
  });
  const receiverShape = await runtime.images.putShape('demo', {id: 'receiver-shape', slots: []});
  const receiver = await runtime.images.putObject('demo', {
    id: 'receiver',
    shape: objectRef('demo', receiverShape.id),
    behavior: objectRef('demo', 'Behavior'),
    slots: {},
  });

  const activation = await runtime.invocations.sendMessage({
    languageId: 'symmetric-smalltalk',
    receiver: objectRef('demo', receiver.id),
    message: textValue('yourself'),
    arguments: [],
  });
  assert.deepEqual(await runtime.executor.execute(activation), objectRef('demo', receiver.id));
  await runtime.close();
});
