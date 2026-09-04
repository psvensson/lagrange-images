import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V0,
  WASM_FUNCTION_V1,
  WASM_INSTANCE_REUSE_STATELESS_V0,
  WASM_MODULE_V1,
  WASM_MODULE_V2,
  WasmInstancePool,
  compileSymmetricSmalltalkBlock,
  compileWasmFunctionArtifact,
  createDefaultCodeExecutorRegistry,
  createRuntime,
  installWasmBlockTree,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

async function putSemantic(runtime, id, source) {
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

test('different entries and captures reuse one stateless shared WASM instance safely', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await putSemantic(runtime, 'tree-semantic', '[ :x | [ :y | x ] ]');
  const installed = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    id: 'pool-tree',
  });
  const moduleArtifact = installed.moduleArtifact;
  assert.equal(moduleArtifact.metadata.instanceReuse, WASM_INSTANCE_REUSE_STATELESS_V0);

  const wasmExecutor = runtime.codeExecutors.get(WASM_FUNCTION_V1);
  assert.deepEqual(wasmExecutor.instancePool.stats(), {
    modules: 0,
    idle: 0,
    inUse: 0,
    hits: 0,
    misses: 0,
    created: 0,
    retired: 0,
    discarded: 0,
  });

  const firstClosure = await executeBlock(runtime, objectRef('demo', installed.block.id), [integerValue(17)]);
  assert.deepEqual(await invokeValue(runtime, firstClosure, [integerValue(1)]), integerValue(17));
  assert.deepEqual(wasmExecutor.instancePool.stats(), {
    modules: 1,
    idle: 1,
    inUse: 0,
    hits: 1,
    misses: 1,
    created: 1,
    retired: 0,
    discarded: 0,
  });

  const secondClosure = await executeBlock(runtime, objectRef('demo', installed.block.id), [integerValue(23)]);
  assert.deepEqual(await invokeValue(runtime, secondClosure, [integerValue(99)]), integerValue(23));
  assert.equal(wasmExecutor.instancePool.stats().created, 1);
  assert.equal(wasmExecutor.instancePool.stats().hits, 3);
  assert.equal(wasmExecutor.moduleCache.stats().compilations, 1);
  await runtime.close();
});

test('WasmInstancePool does not serialize concurrent misses and bounds retained idle instances', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const emptyBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const artifact = await runtime.images.putCodeArtifact('demo', {
    id: 'empty-module',
    representation: WASM_MODULE_V1,
    content: {kind: 'bytes', base64: emptyBytes.toString('base64')},
    metadata: {
      abi: 'test-empty/v0',
      literals: [],
      instanceReuse: WASM_INSTANCE_REUSE_STATELESS_V0,
    },
  });
  const compiled = await WebAssembly.compile(emptyBytes);
  const pool = new WasmInstancePool({maxIdlePerModule: 1});
  let createCount = 0;
  let releaseFactory;
  const gate = new Promise((resolve) => { releaseFactory = resolve; });
  const create = async () => {
    createCount += 1;
    await gate;
    return {instance: await WebAssembly.instantiate(compiled)};
  };

  const firstPromise = pool.acquire(artifact, create);
  const secondPromise = pool.acquire(artifact, create);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createCount, 2);
  releaseFactory();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  first.release();
  second.release();
  assert.deepEqual(pool.stats(), {
    modules: 1,
    idle: 1,
    inUse: 0,
    hits: 0,
    misses: 2,
    created: 2,
    retired: 0,
    discarded: 1,
  });
  const reused = await pool.acquire(artifact, create);
  assert.equal(createCount, 2);
  reused.release();
  assert.equal(pool.stats().hits, 1);
  await runtime.close();
});

test('guest-boundary failure retires a pooled instance before the next activation', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await runtime.images.putCodeArtifact('demo', {
    id: 'bad-condition-semantic',
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify({
      parameters: [],
      captures: [],
      body: {
        op: 'if',
        condition: {op: 'literal', value: integerValue(1)},
        then: {op: 'literal', value: integerValue(2)},
        else: {op: 'literal', value: integerValue(3)},
      },
    })),
  });
  const {functionArtifact, moduleArtifact} = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    moduleId: 'bad-condition-module',
    functionId: 'bad-condition-function',
  });
  assert.equal(moduleArtifact.metadata.instanceReuse, WASM_INSTANCE_REUSE_STATELESS_V0);
  const block = await runtime.images.putBlock('demo', {
    id: 'bad-condition-block',
    code: objectRef('demo', functionArtifact.id),
  });
  const wasmExecutor = runtime.codeExecutors.get(WASM_FUNCTION_V1);

  await assert.rejects(executeBlock(runtime, objectRef('demo', block.id)), /boolean/);
  assert.deepEqual(wasmExecutor.instancePool.stats(), {
    modules: 0,
    idle: 0,
    inUse: 0,
    hits: 0,
    misses: 1,
    created: 1,
    retired: 1,
    discarded: 0,
  });
  await assert.rejects(executeBlock(runtime, objectRef('demo', block.id)), /boolean/);
  assert.equal(wasmExecutor.instancePool.stats().created, 2);
  assert.equal(wasmExecutor.instancePool.stats().retired, 2);
  await runtime.close();
});

test('WASM modules without an explicit instance-reuse contract remain one-shot', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await putSemantic(runtime, 'one-shot-semantic', '[ :x | x ]');
  const {functionArtifact, moduleArtifact} = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    moduleId: 'marked-module',
    functionId: 'marked-function',
  });
  const {instanceReuse, compilerIdentity: _compilerIdentity, derivationKey: _derivationKey, ...moduleMetadata} = moduleArtifact.metadata;
  assert.equal(instanceReuse, WASM_INSTANCE_REUSE_STATELESS_V0);
  // The same v2 descriptor and the same implementation bytes, with the instanceReuse provenance
  // dropped: a provenance-only difference, so meaning is identical and only pooling changes.
  const oneShotModule = await runtime.images.putCodeArtifact('demo', {
    id: 'one-shot-module',
    languageId: moduleArtifact.languageId,
    representation: WASM_MODULE_V2,
    content: moduleArtifact.content,
    dependencies: moduleArtifact.dependencies,
    derivedFrom: moduleArtifact.derivedFrom,
    metadata: moduleMetadata,
  });
  const oneShotFunction = await runtime.images.putCodeArtifact('demo', {
    id: 'one-shot-function',
    languageId: functionArtifact.languageId,
    representation: WASM_FUNCTION_V1,
    content: objectRef('demo', oneShotModule.id),
    derivedFrom: [objectRef('demo', semantic.id), objectRef('demo', oneShotModule.id)],
    metadata: functionArtifact.metadata,
  });
  const block = await runtime.images.putBlock('demo', {
    id: 'one-shot-block',
    code: objectRef('demo', oneShotFunction.id),
  });
  const wasmExecutor = runtime.codeExecutors.get(WASM_FUNCTION_V1);

  assert.deepEqual(await executeBlock(runtime, objectRef('demo', block.id), [integerValue(4)]), integerValue(4));
  assert.deepEqual(await executeBlock(runtime, objectRef('demo', block.id), [integerValue(5)]), integerValue(5));
  assert.equal(wasmExecutor.instancePool.stats().created, 0);
  assert.equal(wasmExecutor.instancePool.stats().hits, 0);
  assert.equal(wasmExecutor.moduleCache.stats().compilations, 1);
  await runtime.close();
});

test('default executor registries own separate runtime-local WASM instance pools', () => {
  const first = createDefaultCodeExecutorRegistry().get(WASM_FUNCTION_V1);
  const second = createDefaultCodeExecutorRegistry().get(WASM_FUNCTION_V1);
  assert.notEqual(first, second);
  assert.notEqual(first.instancePool, second.instancePool);
  assert.notEqual(first.moduleCache, second.moduleCache);
});
