import {WASM_FUNCTION_V1, WASM_FUNCTION_V2} from '../code/wasm-artifacts.js';
import {FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1} from '../foreign-runtime/callable-artifacts.js';
import {createForeignRuntimeCallableInterfaceV1Executor} from '../foreign-runtime/callable-executor.js';
import {createWasmFunctionV1Executor} from '../wasm/function-executor.js';
import {WASM_CALLABLE_INTERFACE_V1} from '../wasm/foreign-artifacts.js';
import {createWasmCallableInterfaceV1Executor} from '../wasm/foreign-callable-executor.js';
import {
  WASM_COMPONENT_BINDING_V1,
  WASM_COMPONENT_BINDING_V2,
  createWasmComponentBindingV1Executor,
} from '../callable/wasm-component-binding.js';
import {
  FOREIGN_RUNTIME_BINDING_V1,
  createForeignRuntimeBindingV1Executor,
} from '../callable/foreign-runtime-binding.js';
import {
  IMAGE_PROJECTION_BINDING_V1,
  createImageProjectionBindingV1Executor,
} from '../callable/image-projection-binding.js';
import {
  IMAGE_MUTATION_BINDING_V1,
  createImageMutationBindingV1Executor,
} from '../callable/image-mutation-binding.js';
import {
  IMAGE_CREATION_BINDING_V1,
  createImageCreationBindingV1Executor,
} from '../callable/image-creation-binding.js';
import {
  IMAGE_CREATION_BATCH_BINDING_V1,
  createImageCreationBatchBindingV1Executor,
} from '../callable/image-creation-batch-binding.js';
import {
  IMAGE_VERSIONED_PROJECTION_BINDING_V1,
  createImageVersionedProjectionBindingV1Executor,
} from '../callable/image-versioned-projection-binding.js';
import {
  IMAGE_OBJECT_READ_BINDING_V1,
  createImageObjectReadBindingV1Executor,
} from '../callable/image-object-read-binding.js';
import {
  IMAGE_OBSERVATION_BINDING_V1,
  createImageObservationBindingV1Executor,
} from '../callable/image-observation-binding.js';
import {ActivationExecutor, ExpiredExecutionContextError} from './activation-executor.js';
import {CodeExecutorRegistry} from './executor-registry.js';
import {
  NEUTRAL_EXPRESSION_V0,
  neutralExpressionV0Executor,
} from './neutral-expression-v0.js';
import {
  NEUTRAL_EXPRESSION_V1,
  neutralExpressionV1Executor,
} from './neutral-expression-v1.js';

function createDefaultCodeExecutorRegistry({
  wasmModuleCache,
  wasmInstancePool,
  foreignWasmModuleCache,
  foreignRuntimeDefinitions,
  foreignRuntimes,
  foreignRuntimeDefinitionBindings,
  foreignRuntimeInstanceCache,
  componentRuntime,
  componentHostImports,
  creationObjectIds,
} = {}) {
  const registry = new CodeExecutorRegistry();
  registry.register(NEUTRAL_EXPRESSION_V0, neutralExpressionV0Executor);
  registry.register(NEUTRAL_EXPRESSION_V1, neutralExpressionV1Executor);
  const wasmOptions = {};
  if (wasmModuleCache !== undefined) wasmOptions.moduleCache = wasmModuleCache;
  if (wasmInstancePool !== undefined) wasmOptions.instancePool = wasmInstancePool;
  // One executor for both durable function versions: it dispatches on the MODULE's ABI and
  // reads the function through the function-contract owner, so v1 (frozen) and v2 share it.
  const wasmFunctionExecutor = createWasmFunctionV1Executor(wasmOptions);
  registry.register(WASM_FUNCTION_V1, wasmFunctionExecutor);
  registry.register(WASM_FUNCTION_V2, wasmFunctionExecutor);
  const foreignOptions = {};
  if (foreignWasmModuleCache !== undefined) foreignOptions.moduleCache = foreignWasmModuleCache;
  registry.register(WASM_CALLABLE_INTERFACE_V1, createWasmCallableInterfaceV1Executor(foreignOptions));
  const componentBindingExecutor = createWasmComponentBindingV1Executor({
    componentRuntime: componentRuntime ?? null,
    hostImports: componentHostImports ?? null,
  });
  registry.register(WASM_COMPONENT_BINDING_V1, componentBindingExecutor);
  registry.register(WASM_COMPONENT_BINDING_V2, componentBindingExecutor);
  // The image is a third implementation lane; it needs no external runtime at all.
  registry.register(IMAGE_PROJECTION_BINDING_V1, createImageProjectionBindingV1Executor());
  registry.register(IMAGE_MUTATION_BINDING_V1, createImageMutationBindingV1Executor());
  // ADR 0062. The creation lane mints object identity itself, so the generator is injectable here —
  // the same injection point the Smalltalk allocation lane uses, so one option governs both.
  registry.register(
    IMAGE_CREATION_BINDING_V1,
    createImageCreationBindingV1Executor(
      creationObjectIds === undefined ? {} : {newObjectId: creationObjectIds},
    ),
  );
  registry.register(
    IMAGE_CREATION_BATCH_BINDING_V1,
    createImageCreationBatchBindingV1Executor(
      creationObjectIds === undefined ? {} : {newObjectId: creationObjectIds},
    ),
  );
  registry.register(
    IMAGE_VERSIONED_PROJECTION_BINDING_V1,
    createImageVersionedProjectionBindingV1Executor(),
  );
  registry.register(
    IMAGE_OBJECT_READ_BINDING_V1,
    createImageObjectReadBindingV1Executor(),
  );
  // ADR 0070. The observation cursor HMAC secret defaults to a random per-registry value, so
  // cursors are unforgeable by the consumer; inject one only to share cursors across installs.
  registry.register(
    IMAGE_OBSERVATION_BINDING_V1,
    createImageObservationBindingV1Executor(),
  );

  const foreignRuntimeConfigured = [
    foreignRuntimeDefinitions,
    foreignRuntimes,
    foreignRuntimeDefinitionBindings,
    foreignRuntimeInstanceCache,
  ].some((value) => value !== undefined);
  if (foreignRuntimeConfigured) {
    if (foreignRuntimeDefinitions === undefined
      || foreignRuntimes === undefined
      || foreignRuntimeDefinitionBindings === undefined) {
      throw new TypeError(
        'foreign runtime callable executors require definitions, runtimes and definition bindings',
      );
    }
    const foreignRuntimeOptions = {
      definitions: foreignRuntimeDefinitions,
      runtimes: foreignRuntimes,
      bindings: foreignRuntimeDefinitionBindings,
      instanceCache: foreignRuntimeInstanceCache ?? null,
    };
    registry.register(
      FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1,
      createForeignRuntimeCallableInterfaceV1Executor(foreignRuntimeOptions),
    );
    registry.register(
      FOREIGN_RUNTIME_BINDING_V1,
      createForeignRuntimeBindingV1Executor(foreignRuntimeOptions),
    );
  }
  return registry;
}

export {ActivationExecutor, ExpiredExecutionContextError, createDefaultCodeExecutorRegistry};
export * from './block-application.js';
export * from './executor-registry.js';
export * from './neutral-expression-v0.js';
export {NEUTRAL_EXPRESSION_V1, neutralExpressionV1Executor} from './neutral-expression-v1.js';
export * from './lexical-cells.js';
