import {WASM_FUNCTION_V1} from '../code/wasm-artifacts.js';
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
  IMAGE_VERSIONED_PROJECTION_BINDING_V1,
  createImageVersionedProjectionBindingV1Executor,
} from '../callable/image-versioned-projection-binding.js';
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
} = {}) {
  const registry = new CodeExecutorRegistry();
  registry.register(NEUTRAL_EXPRESSION_V0, neutralExpressionV0Executor);
  registry.register(NEUTRAL_EXPRESSION_V1, neutralExpressionV1Executor);
  const wasmOptions = {};
  if (wasmModuleCache !== undefined) wasmOptions.moduleCache = wasmModuleCache;
  if (wasmInstancePool !== undefined) wasmOptions.instancePool = wasmInstancePool;
  registry.register(WASM_FUNCTION_V1, createWasmFunctionV1Executor(wasmOptions));
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
  registry.register(
    IMAGE_VERSIONED_PROJECTION_BINDING_V1,
    createImageVersionedProjectionBindingV1Executor(),
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
