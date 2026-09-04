import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSymmetricSmalltalkBlock,
  createRuntime,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  LAGRANGE_CODE_V0,
  objectRef,
  readModuleDescriptor,
  textValue,
  WASM_FUNCTION_V1,
  WASM_RESUMABLE_VALUE_HANDLE_ABI_V1,
} from '../src/runtime.js';

async function putSmalltalkSemantic(runtime, id, source) {
  const {semanticProgram} = compileSymmetricSmalltalkBlock(source);
  return await runtime.images.putCodeArtifact('demo', {
    id,
    languageId: 'symmetric-smalltalk',
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify(semanticProgram)),
  });
}

async function executeBlock(runtime, blockRef, args = []) {
  const activation = await runtime.invocations.invokeBlock(blockRef, args);
  return await runtime.executor.execute(activation);
}

async function invokeValue(runtime, blockRef, args = []) {
  const selector = args.length === 0 ? 'value' : 'value:'.repeat(args.length);
  const activation = await runtime.invocations.sendMessage({
    languageId: 'symmetric-smalltalk',
    receiver: blockRef,
    message: textValue(selector),
    arguments: args,
  });
  return await runtime.executor.execute(activation);
}

test('installWasmBlockTree recursively compiles and installs a complete nested Block tree', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await putSmalltalkSemantic(
    runtime,
    'tree-semantic',
    '[ :x | [ :y | [ :z | x ] ] ]',
  );

  const installed = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    id: 'wasm-tree',
  });

  assert.equal(installed.nodes.length, 3);
  assert.equal(installed.block.id, 'wasm-tree');
  assert.equal(installed.semanticBlockId, null);
  assert.ok(installed.nodes.every(({functionArtifact}) => functionArtifact.representation === WASM_FUNCTION_V1));

  const prototypeNodes = installed.nodes.filter(({semanticBlockId}) => semanticBlockId !== null);
  assert.equal(prototypeNodes.length, 2);
  for (const node of prototypeNodes) {
    assert.equal(node.block.metadata.prototype, true);
    assert.equal(node.block.metadata.wasmTreeRootId, 'wasm-tree');
    assert.deepEqual(node.block.code, objectRef('demo', node.functionArtifact.id));
  }

  const firstClosure = await executeBlock(runtime, objectRef('demo', installed.block.id), [integerValue(31)]);
  const secondClosure = await invokeValue(runtime, firstClosure, [integerValue(1)]);
  assert.deepEqual(await invokeValue(runtime, secondClosure, [integerValue(2)]), integerValue(31));

  const materialized = (await runtime.images.listBlocks('demo'))
    .filter((block) => block.metadata?.prototypeBlockId);
  assert.equal(materialized.length, 2);
  await runtime.close();
});

test('automatic WASM tree compilation includes nested Blocks whose bodies tail-send normally', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'echo-method',
    source: '[ :value | value ]',
  });
  const behaviorShape = await runtime.images.putShape('demo', {
    id: 'behavior-shape',
    slots: [{id: 'method-echo', name: 'echo:'}],
  });
  await runtime.images.putObject('demo', {
    id: 'Behavior',
    shape: objectRef('demo', behaviorShape.id),
    slots: {'method-echo': objectRef('demo', 'echo-method')},
  });
  const receiverShape = await runtime.images.putShape('demo', {id: 'receiver-shape', slots: []});
  const receiver = await runtime.images.putObject('demo', {
    id: 'receiver',
    shape: objectRef('demo', receiverShape.id),
    behavior: objectRef('demo', 'Behavior'),
    slots: {},
  });

  const semantic = await putSmalltalkSemantic(
    runtime,
    'send-tree-semantic',
    '[ :target | [ :value | target echo: value ] ]',
  );
  const installed = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    id: 'send-tree',
  });

  const closure = await executeBlock(runtime, objectRef('demo', installed.block.id), [objectRef('demo', receiver.id)]);
  assert.deepEqual(await invokeValue(runtime, closure, [integerValue(55)]), integerValue(55));
  assert.equal(installed.nodes.filter(({semanticBlockId}) => semanticBlockId !== null).length, 1);
  await runtime.close();
});

test('WASM Block trees resume after non-tail nested Block creation inside a shared module', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await putSmalltalkSemantic(
    runtime,
    'resumable-tree-semantic',
    '[ :x | [ :y | [ :z | x ] value: y ] ]',
  );

  const installed = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    id: 'resumable-tree',
  });
  assert.equal(readModuleDescriptor(installed.moduleArtifact).abi, WASM_RESUMABLE_VALUE_HANDLE_ABI_V1);
  assert.equal(installed.nodes.length, 3);
  assert.ok(readModuleDescriptor(installed.moduleArtifact).effectSites.some(({resumeEntry}) => resumeEntry !== null));

  const middle = await executeBlock(runtime, objectRef('demo', installed.block.id), [integerValue(31)]);
  assert.deepEqual(await invokeValue(runtime, middle, [integerValue(7)]), integerValue(31));
  await runtime.close();
});
