import {WASM_FUNCTION_V1} from '../code/wasm-artifacts.js';
import {FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1} from '../foreign-runtime/callable-artifacts.js';
import {createForeignRuntimeCallableInterfaceV1Executor} from '../foreign-runtime/callable-executor.js';
import {createWasmFunctionV1Executor} from '../wasm/executor.js';
import {WASM_CALLABLE_INTERFACE_V1} from '../wasm/foreign-artifacts.js';
import {createWasmCallableInterfaceV1Executor} from '../wasm/foreign-callable-executor.js';
import {ActivationExecutor} from './activation-executor.js';
import {CodeExecutorRegistry} from './executor-registry.js';
import {
  NEUTRAL_EXPRESSION_V0,
  neutralExpressionV0Executor,
} from './neutral-expression-v0.js';

function createDefaultCodeExecutorRegistry({
  wasmModuleCache,
  wasmInstancePool,
  foreignWasmModuleCache,
  foreignRuntimeDefinitions,
  foreignRuntimes,
  foreignRuntimeDefinitionBindings,
  foreignRuntimeInstanceCache,
} = {}) {
  const registry = new CodeExecutorRegistry();
  registry.register(NEUTRAL_EXPRESSION_V0, neutralExpressionV0Executor);
  const wasmOptions = {};
  if (wasmModuleCache !== undefined) wasmOptions.moduleCache = wasmModuleCache;
  if (wasmInstancePool !== undefined) wasmOptions.instancePool = wasmInstancePool;
  registry.register(WASM_FUNCTION_V1, createWasmFunctionV1Executor(wasmOptions));
  const foreignOptions = {};
  if (foreignWasmModuleCache !== undefined) foreignOptions.moduleCache = foreignWasmModuleCache;
  registry.register(WASM_CALLABLE_INTERFACE_V1, createWasmCallableInterfaceV1Executor(foreignOptions));

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
    registry.register(
      FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1,
      createForeignRuntimeCallableInterfaceV1Executor({
        definitions: foreignRuntimeDefinitions,
        runtimes: foreignRuntimes,
        bindings: foreignRuntimeDefinitionBindings,
        instanceCache: foreignRuntimeInstanceCache ?? null,
      }),
    );
  }
  return registry;
}

export {ActivationExecutor, createDefaultCodeExecutorRegistry};
export * from './executor-registry.js';
export * from './neutral-expression-v0.js';
