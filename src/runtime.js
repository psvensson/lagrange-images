import {createBackend} from './backend/create-backend.js';
import {
  CompilationService,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
} from './compilation/index.js';
import {DispatchRegistry, InvocationService} from './dispatch/invocation-service.js';
import {ActivationExecutor, createDefaultCodeExecutorRegistry} from './execution/executor.js';
import {ImageService} from './image/graph-image-service.js';
import {
  SYMMETRIC_SMALLTALK_ID,
  createDefaultLanguagePlatform,
  createSymmetricSmalltalkDispatcher,
} from './language/index.js';
import {ToolchainProviderRegistry, ToolchainService} from './toolchain/index.js';

async function createRuntime(options = {}) {
  const backend = await createBackend(options.backend ?? {});
  await backend.start();
  const images = new ImageService({backend, clock: options.clock});
  const languages = createDefaultLanguagePlatform();

  const codeCompilers = createDefaultCodeCompilerRegistry();
  for (const entry of options.codeCompilers ?? []) {
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new TypeError('codeCompilers entries must be [sourceRepresentation, targetRepresentation, compiler]');
    }
    codeCompilers.register(entry[0], entry[1], entry[2]);
  }
  const groupCompilers = createDefaultCompilationGroupCompilerRegistry();
  for (const entry of options.groupCompilers ?? []) {
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new TypeError('groupCompilers entries must be [policyId, targetRepresentation, compiler]');
    }
    groupCompilers.register(entry[0], entry[1], entry[2]);
  }
  const compilation = new CompilationService({images, compilers: codeCompilers, groupCompilers});

  const toolchainProviders = new ToolchainProviderRegistry();
  for (const entry of options.toolchainProviders ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('toolchainProviders entries must be [providerId, provider]');
    }
    toolchainProviders.register(entry[0], entry[1]);
  }
  const toolchains = new ToolchainService({images, providers: toolchainProviders});

  const dispatchers = new DispatchRegistry();
  for (const [languageId, dispatcher] of Object.entries(options.dispatchers ?? {})) {
    dispatchers.register(languageId, dispatcher);
  }
  if (!dispatchers.has(SYMMETRIC_SMALLTALK_ID)) {
    dispatchers.register(SYMMETRIC_SMALLTALK_ID, createSymmetricSmalltalkDispatcher());
  }
  const invocations = new InvocationService({images, dispatchers});

  const codeExecutors = createDefaultCodeExecutorRegistry({
    wasmModuleCache: options.wasmModuleCache,
    wasmInstancePool: options.wasmInstancePool,
  });
  for (const [representation, executor] of Object.entries(options.codeExecutors ?? {})) {
    codeExecutors.register(representation, executor);
  }
  const executor = new ActivationExecutor({images, executors: codeExecutors, invocations});

  return {
    backend,
    images,
    languages,
    codeCompilers,
    groupCompilers,
    compilation,
    toolchainProviders,
    toolchains,
    dispatchers,
    invocations,
    codeExecutors,
    executor,
    async close() { await backend.stop(); },
  };
}

export * from './backend/index.js';
export * from './code/index.js';
export * from './compilation/index.js';
export * from './dispatch/invocation-service.js';
export {ImageService};
export * from './execution/executor.js';
export * from './execution/model.js';
export * from './language/index.js';
export * from './object/index.js';
export * from './toolchain/index.js';
export * from './value/index.js';
export * from './wasm/index.js';
export {createRuntime};
