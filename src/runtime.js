import {createBackend} from './backend/create-backend.js';
import {createSmalltalkTemporaryInitializer} from './language/smalltalk-kernel.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  createSmalltalkKernelPrimitiveV1Executor,
} from './language/smalltalk-primitives.js';
import {
  CompilationService,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
} from './compilation/index.js';
import {DispatchRegistry, InvocationService} from './dispatch/invocation-service.js';
import {ActivationExecutor, createDefaultCodeExecutorRegistry} from './execution/executor.js';
import {createAuthorityService} from './authority/index.js';
import {ComponentHostImportRegistry} from './callable/host-import-registry.js';
import {
  ForeignRuntimeDefinitionBindingRegistry,
  ForeignRuntimeDefinitionInstanceCache,
  ForeignRuntimeDefinitionService,
  ForeignRuntimeProviderRegistry,
  ForeignRuntimeService,
} from './foreign-runtime/index.js';
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

  const foreignRuntimeProviders = new ForeignRuntimeProviderRegistry();
  for (const entry of options.foreignRuntimeProviders ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('foreignRuntimeProviders entries must be [providerId, provider]');
    }
    foreignRuntimeProviders.register(entry[0], entry[1]);
  }
  const foreignRuntimes = new ForeignRuntimeService({providers: foreignRuntimeProviders});
  const foreignRuntimeDefinitions = new ForeignRuntimeDefinitionService({images, runtimes: foreignRuntimes});
  const foreignRuntimeDefinitionBindings = new ForeignRuntimeDefinitionBindingRegistry();
  for (const entry of options.foreignRuntimeDefinitionBindings ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError(
        'foreignRuntimeDefinitionBindings entries must be [definitionRepresentation, providerId]',
      );
    }
    foreignRuntimeDefinitionBindings.register(entry[0], entry[1]);
  }
  const foreignRuntimeInstanceCache = new ForeignRuntimeDefinitionInstanceCache({
    definitions: foreignRuntimeDefinitions,
    bindings: foreignRuntimeDefinitionBindings,
  });

  const dispatchers = new DispatchRegistry();
  for (const [languageId, dispatcher] of Object.entries(options.dispatchers ?? {})) {
    dispatchers.register(languageId, dispatcher);
  }
  if (!dispatchers.has(SYMMETRIC_SMALLTALK_ID)) {
    dispatchers.register(SYMMETRIC_SMALLTALK_ID, createSymmetricSmalltalkDispatcher());
  }
  const invocations = new InvocationService({images, dispatchers});

  // Runtime-local: the durable binding says which host interfaces a program may import;
  // this says which implementation satisfies them in this deployment.
  const componentHostImports = options.componentHostImports instanceof ComponentHostImportRegistry
    ? options.componentHostImports
    : new ComponentHostImportRegistry(Object.entries(options.componentHostImports ?? {}));

  const codeExecutors = createDefaultCodeExecutorRegistry({
    wasmModuleCache: options.wasmModuleCache,
    wasmInstancePool: options.wasmInstancePool,
    foreignWasmModuleCache: options.foreignWasmModuleCache,
    foreignRuntimeDefinitions,
    foreignRuntimes,
    foreignRuntimeDefinitionBindings,
    foreignRuntimeInstanceCache,
    componentRuntime: options.componentRuntime,
    componentHostImports,
    // ADR 0062: the creation lane mints object identity, injectable through the same option the
    // Smalltalk allocation lane uses (a test has to be able to force a collision).
    creationObjectIds: options.smalltalkObjectIds,
  });
  // ADR 0046 decision 2a. A language-owned executor is registered here, by the composition root, and
  // never inside `createDefaultCodeExecutorRegistry` — `src/language` already imports
  // `src/execution`, so registering it there would close a dependency cycle that the `export *`
  // barrel turns into an import-time failure naming neither file. This is the same route ADR 0044
  // decision 8's `temporaryInitializer` takes just below: language-owned execution policy enters
  // through composition, so execution never depends on language.
  for (const [representation, executor] of Object.entries(options.codeExecutors ?? {})) {
    codeExecutors.register(representation, executor);
  }
  // Registered only if the embedder did not supply their own, the same way the Symmetric Smalltalk
  // dispatcher is registered above. Registering unconditionally would make an explicit override a
  // hard `ExecutorRegistrationError` from `createRuntime` itself rather than a supported choice.
  if (!codeExecutors.has(SMALLTALK_KERNEL_PRIMITIVE_V1)) {
    codeExecutors.register(
      SMALLTALK_KERNEL_PRIMITIVE_V1,
      createSmalltalkKernelPrimitiveV1Executor(
        // Object identity is runtime machinery rather than durable class semantics, so it is
        // injectable — a test has to be able to force a collision.
        options.smalltalkObjectIds === undefined ? {} : {newObjectId: options.smalltalkObjectIds},
      ),
    );
  }
  // The authority service is a control-plane surface: the embedder may issue and revoke
  // contexts through `runtime.authority`, and executors never see it.
  const authority = options.authority ?? createAuthorityService();
  const executor = new ActivationExecutor({
    images,
    executors: codeExecutors,
    invocations,
    authority,
    // ADR 0044 decision 8. The policy is the language's; the mechanism is the execution layer's.
    temporaryInitializer: createSmalltalkTemporaryInitializer(),
  });

  return {
    backend,
    images,
    languages,
    codeCompilers,
    groupCompilers,
    compilation,
    toolchainProviders,
    toolchains,
    foreignRuntimeProviders,
    foreignRuntimes,
    foreignRuntimeDefinitions,
    foreignRuntimeDefinitionBindings,
    foreignRuntimeInstanceCache,
    dispatchers,
    invocations,
    codeExecutors,
    componentHostImports,
    authority,
    executor,
    async close() {
      let runtimeError = null;
      try {
        await foreignRuntimes.close();
      } catch (error) {
        runtimeError = error;
      } finally {
        foreignRuntimeInstanceCache.clear();
      }
      try {
        await backend.stop();
      } catch (backendError) {
        if (runtimeError) throw new AggregateError([runtimeError, backendError], 'runtime shutdown failed');
        throw backendError;
      }
      if (runtimeError) throw runtimeError;
    },
  };
}

export * from './backend/index.js';
export * from './authority/index.js';
export * from './callable/index.js';
export * from './code/index.js';
export * from './compilation/index.js';
export * from './dispatch/invocation-service.js';
export * from './foreign-runtime/index.js';
export {ImageService};
export * from './execution/executor.js';
export * from './execution/model.js';
export * from './language/index.js';
export * from './object/index.js';
export * from './toolchain/index.js';
export * from './value/index.js';
export * from './wasm/index.js';
export {createRuntime};
