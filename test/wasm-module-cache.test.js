import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSymmetricSmalltalkBlock,
  createDefaultCodeExecutorRegistry,
  createRuntime,
  installWasmBlockTree,
  integerValue,
  objectRef,
  readModuleContract,
  textValue,
  WASM_FUNCTION_V1,
  WASM_MODULE_V2,
  WasmModuleCache,
} from '../src/runtime.js';

async function putSemantic(runtime, id, source) {
  const {semanticProgram} = compileSymmetricSmalltalkBlock(source);
  return await runtime.images.putCodeArtifact('demo', {
    id,
    languageId: 'symmetric-smalltalk',
    representation: 'lagrange-code/v0',
    content: textValue(JSON.stringify(semanticProgram)),
  });
}

async function compileModule(runtime, id = 'module-source') {
  const semantic = await putSemantic(runtime, id, '[ :x | x ]');
  return await runtime.compilation.compileArtifact(objectRef('demo', semantic.id), {
    id: `${id}:wasm`,
    targetRepresentation: WASM_MODULE_V2,
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

test('WasmModuleCache coalesces concurrent compilation of one immutable module artifact', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const artifact = await compileModule(runtime);
  const {bytes} = await readModuleContract(artifact, {resolveImplementation: (ref) => runtime.images.getCodeArtifact(ref.imageId, ref.objectId)});
  let compileCount = 0;
  const cache = new WasmModuleCache({
    async compile(bytes) {
      compileCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return await WebAssembly.compile(bytes);
    },
  });

  const [first, second] = await Promise.all([cache.get(artifact, bytes), cache.get(artifact, bytes)]);
  assert.equal(first, second);
  assert.equal(compileCount, 1);
  assert.deepEqual(cache.stats(), {
    entries: 1,
    hits: 1,
    misses: 1,
    compilations: 1,
    failures: 0,
  });
  await runtime.close();
});

test('WasmModuleCache evicts failed compilation so a later attempt can retry', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const artifact = await compileModule(runtime, 'retry-source');
  let attempts = 0;
  const cache = new WasmModuleCache({
    async compile(bytes) {
      attempts += 1;
      if (attempts === 1) throw new Error('synthetic compile failure');
      return await WebAssembly.compile(bytes);
    },
  });

  const {bytes} = await readModuleContract(artifact, {resolveImplementation: (ref) => runtime.images.getCodeArtifact(ref.imageId, ref.objectId)});
  await assert.rejects(cache.get(artifact, bytes), /synthetic compile failure/);
  assert.deepEqual(cache.stats(), {
    entries: 0,
    hits: 0,
    misses: 1,
    compilations: 1,
    failures: 1,
  });
  const compiled = await cache.get(artifact, bytes);
  assert.ok(compiled instanceof WebAssembly.Module);
  assert.equal(attempts, 2);
  assert.deepEqual(cache.stats(), {
    entries: 1,
    hits: 0,
    misses: 2,
    compilations: 2,
    failures: 1,
  });
  await runtime.close();
});

test('different entries in one shared WASM module reuse one compiled WebAssembly.Module', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await putSemantic(runtime, 'tree-semantic', '[ :x | [ :y | x ] ]');
  const installed = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    id: 'cache-tree',
  });
  const wasmExecutor = runtime.codeExecutors.get(WASM_FUNCTION_V1);
  assert.deepEqual(wasmExecutor.moduleCache.stats(), {
    entries: 0,
    hits: 0,
    misses: 0,
    compilations: 0,
    failures: 0,
  });

  const closure = await executeBlock(runtime, objectRef('demo', installed.block.id), [integerValue(17)]);
  assert.deepEqual(wasmExecutor.moduleCache.stats(), {
    entries: 1,
    hits: 0,
    misses: 1,
    compilations: 1,
    failures: 0,
  });
  assert.deepEqual(await invokeValue(runtime, closure, [integerValue(99)]), integerValue(17));
  assert.deepEqual(wasmExecutor.moduleCache.stats(), {
    entries: 1,
    hits: 1,
    misses: 1,
    compilations: 1,
    failures: 0,
  });

  const secondClosure = await executeBlock(runtime, objectRef('demo', installed.block.id), [integerValue(23)]);
  assert.deepEqual(await invokeValue(runtime, secondClosure, [integerValue(0)]), integerValue(23));
  assert.equal(wasmExecutor.moduleCache.stats().compilations, 1);
  assert.equal(wasmExecutor.moduleCache.stats().hits, 3);
  await runtime.close();
});

test('default executor registries own separate runtime-local WASM module caches', () => {
  const first = createDefaultCodeExecutorRegistry().get(WASM_FUNCTION_V1);
  const second = createDefaultCodeExecutorRegistry().get(WASM_FUNCTION_V1);
  assert.notEqual(first, second);
  assert.notEqual(first.moduleCache, second.moduleCache);
});
