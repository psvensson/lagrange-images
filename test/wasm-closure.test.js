import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileWasmFunctionArtifact,
  createRuntime,
  installSymmetricSmalltalkBlock,
  integerValue,
  LAGRANGE_CODE_V0,
  objectRef,
  readModuleDescriptor,
  textValue,
} from '../src/runtime.js';

async function executeBlock(runtime, blockRef, args = []) {
  const activation = await runtime.invocations.invokeBlock(blockRef, args);
  return await runtime.executor.execute(activation);
}

async function invokeValue(runtime, blockRef, args = []) {
  const selector = args.length === 0 ? 'value' : `${'value:'.repeat(args.length)}`;
  const activation = await runtime.invocations.sendMessage({
    languageId: 'symmetric-smalltalk',
    receiver: blockRef,
    message: textValue(selector),
    arguments: args,
  });
  return await runtime.executor.execute(activation);
}

async function installOuterWasm(runtime, installed, blockPrototypes, id) {
  const {functionArtifact} = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', installed.semanticArtifact.id),
    moduleId: `${id}:module`,
    functionId: `${id}:function`,
    blockPrototypes,
  });
  return await runtime.images.putBlock('demo', {
    id,
    code: objectRef('demo', functionArtifact.id),
  });
}

test('WASM tail closure creation materializes the same captured Block semantics as the interpreter', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'closure-source',
    source: '[ :x | [ :y | x ] ]',
  });
  const semanticBlockId = installed.semanticProgram.body.blockId;
  const wasmOuter = await installOuterWasm(
    runtime,
    installed,
    {[semanticBlockId]: installed.blockPrototypes[semanticBlockId]},
    'wasm-outer',
  );

  const closureRef = await executeBlock(runtime, objectRef('demo', wasmOuter.id), [integerValue(7)]);
  assert.equal(closureRef.kind, 'ref');
  assert.deepEqual(await invokeValue(runtime, closureRef, [integerValue(99)]), integerValue(7));

  const closure = await runtime.images.getBlock(closureRef.imageId, closureRef.objectId);
  assert.ok(closure.environment);
  const environment = await runtime.images.getLexicalEnvironment(closure.environment.imageId, closure.environment.objectId);
  assert.deepEqual(environment.bindings['root:parameter:0'].value, integerValue(7));
  assert.equal(closure.metadata.prototypeBlockId, installed.blockPrototypes[semanticBlockId].objectId);
  await runtime.close();
});

test('a WASM-created closure may itself use a WASM-backed prototype', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'mixed-source',
    source: '[ :x | [ :y | x ] ]',
  });
  const semanticBlockId = installed.semanticProgram.body.blockId;
  const nestedSemantic = (await runtime.images.listCodeArtifacts('demo')).find((artifact) =>
    artifact.representation === LAGRANGE_CODE_V0 && artifact.metadata?.semanticBlockId === semanticBlockId);
  assert.ok(nestedSemantic);

  const {functionArtifact: childFunction} = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', nestedSemantic.id),
    moduleId: 'wasm-child:module',
    functionId: 'wasm-child:function',
  });
  const childPrototype = await runtime.images.putBlock('demo', {
    id: 'wasm-child:prototype',
    code: objectRef('demo', childFunction.id),
    metadata: {prototype: true, semanticBlockId},
  });
  const wasmOuter = await installOuterWasm(
    runtime,
    installed,
    {[semanticBlockId]: objectRef('demo', childPrototype.id)},
    'wasm-parent',
  );

  const closureRef = await executeBlock(runtime, objectRef('demo', wasmOuter.id), [integerValue(23)]);
  assert.deepEqual(await invokeValue(runtime, closureRef, [integerValue(0)]), integerValue(23));
  const materialized = await runtime.images.getBlock(closureRef.imageId, closureRef.objectId);
  assert.equal(materialized.code.objectId, childFunction.id);
  await runtime.close();
});

test('WASM function artifacts require an explicit Block prototype for every closure site', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'missing-prototype',
    source: '[ [ 1 ] ]',
  });
  await assert.rejects(
    compileWasmFunctionArtifact({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('demo', installed.semanticArtifact.id),
      moduleId: 'missing-prototype:module',
      functionId: 'missing-prototype:function',
    }),
    /missing WASM Block prototype/,
  );
  await runtime.close();
});

test('WASM function artifacts keep closure prototype graph edges in derivedFrom rather than metadata', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'edge-source',
    source: '[ :x | [ x ] ]',
  });
  const blockId = installed.semanticProgram.body.blockId;
  const prototypeRef = installed.blockPrototypes[blockId];
  const {moduleArtifact, functionArtifact} = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', installed.semanticArtifact.id),
    moduleId: 'edge-module',
    functionId: 'edge-function',
    blockPrototypes: {[blockId]: prototypeRef},
  });

  assert.equal(readModuleDescriptor(moduleArtifact).closureSites[0].blockId, blockId);
  assert.equal(functionArtifact.metadata.closurePrototypes[0].blockId, blockId);
  assert.equal(functionArtifact.metadata.closurePrototypes[0].derivedFromIndex, 2);
  assert.deepEqual(functionArtifact.derivedFrom[2], prototypeRef);
  assert.equal(JSON.stringify(functionArtifact.metadata).includes(prototypeRef.objectId), false);
  await runtime.close();
});
