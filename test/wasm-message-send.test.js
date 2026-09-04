import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileWasmFunctionArtifact,
  createRuntime,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  readModuleDescriptor,
  textValue,
} from '../src/runtime.js';

async function wasmBlock(runtime, semanticArtifact, id) {
  const compiled = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef(semanticArtifact.imageId, semanticArtifact.id),
    moduleId: `${id}:module`,
    functionId: `${id}:function`,
  });
  const block = await runtime.images.putBlock(semanticArtifact.imageId, {
    id,
    code: objectRef(semanticArtifact.imageId, compiled.functionArtifact.id),
  });
  return Object.freeze({...compiled, block});
}

test('WASM tail sends re-enter normal Smalltalk dispatch and may resolve another WASM Block', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  const method = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'echo-method-neutral',
    source: '[ :value | value ]',
  });
  const wasmMethod = await wasmBlock(runtime, method.semanticArtifact, 'echo-method-wasm');

  const behaviorShape = await runtime.images.putShape('demo', {
    id: 'echo-behavior-shape',
    slots: [{id: 'method-echo', name: 'echo:'}],
  });
  await runtime.images.putObject('demo', {
    id: 'EchoBehavior',
    shape: objectRef('demo', behaviorShape.id),
    slots: {'method-echo': objectRef('demo', wasmMethod.block.id)},
  });
  const receiverShape = await runtime.images.putShape('demo', {id: 'receiver-shape', slots: []});
  const receiver = await runtime.images.putObject('demo', {
    id: 'receiver',
    shape: objectRef('demo', receiverShape.id),
    behavior: objectRef('demo', 'EchoBehavior'),
    slots: {},
  });

  const sender = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'sender-neutral',
    source: '[ :target | target echo: 42 ]',
  });
  const wasmSender = await wasmBlock(runtime, sender.semanticArtifact, 'sender-wasm');

  const target = objectRef('demo', receiver.id);
  const neutralActivation = await runtime.invocations.invokeBlock(objectRef('demo', sender.block.id), [target]);
  const wasmActivation = await runtime.invocations.invokeBlock(objectRef('demo', wasmSender.block.id), [target]);

  const expected = integerValue(42);
  assert.deepEqual(await runtime.executor.execute(neutralActivation), expected);
  assert.deepEqual(await runtime.executor.execute(wasmActivation), expected);
  assert.equal(readModuleDescriptor(wasmSender.moduleArtifact).sendSites.length, 1);
  assert.equal(readModuleDescriptor(wasmSender.moduleArtifact).sendSites[0].languageId, 'symmetric-smalltalk');
  assert.deepEqual(readModuleDescriptor(wasmSender.moduleArtifact).sendSites[0].message, textValue('echo:'));
  assert.equal(readModuleDescriptor(wasmSender.moduleArtifact).sendSites[0].arity, 1);

  await runtime.close();
});

test('WASM tail sends can select a branch before yielding to the host', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  const method = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'yourself-neutral',
    source: '[ self ]',
  });
  const wasmMethod = await wasmBlock(runtime, method.semanticArtifact, 'yourself-wasm');
  const behaviorShape = await runtime.images.putShape('demo', {
    id: 'behavior-shape',
    slots: [{id: 'method-yourself', name: 'yourself'}],
  });
  await runtime.images.putObject('demo', {
    id: 'Behavior',
    shape: objectRef('demo', behaviorShape.id),
    slots: {'method-yourself': objectRef('demo', wasmMethod.block.id)},
  });
  const receiverShape = await runtime.images.putShape('demo', {id: 'shape', slots: []});
  const receiver = await runtime.images.putObject('demo', {
    id: 'receiver',
    shape: objectRef('demo', receiverShape.id),
    behavior: objectRef('demo', 'Behavior'),
    slots: {},
  });

  const semantic = await runtime.images.putCodeArtifact('demo', {
    id: 'conditional-send-semantic',
    representation: 'lagrange-code/v0',
    content: textValue(JSON.stringify({
      parameters: [{id: 'arg:0', name: 'target'}],
      captures: [],
      body: {
        op: 'if',
        condition: {
          op: 'equals',
          left: {op: 'literal', value: integerValue(1)},
          right: {op: 'literal', value: integerValue(1)},
        },
        then: {
          op: 'send',
          languageId: 'symmetric-smalltalk',
          receiver: {op: 'argument', index: 0},
          message: textValue('yourself'),
          arguments: [],
        },
        else: {op: 'literal', value: integerValue(0)},
      },
    })),
  });
  const wasm = await wasmBlock(runtime, semantic, 'conditional-send-wasm');
  const activation = await runtime.invocations.invokeBlock(objectRef('demo', wasm.block.id), [objectRef('demo', receiver.id)]);
  assert.deepEqual(await runtime.executor.execute(activation), objectRef('demo', receiver.id));

  await runtime.close();
});
