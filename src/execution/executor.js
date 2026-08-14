import {WASM_FUNCTION_V1} from '../code/wasm-artifacts.js';
import {createWasmFunctionV1Executor} from '../wasm/executor.js';
import {ActivationExecutor} from './activation-executor.js';
import {CodeExecutorRegistry} from './executor-registry.js';
import {
  NEUTRAL_EXPRESSION_V0,
  neutralExpressionV0Executor,
} from './neutral-expression-v0.js';

function createDefaultCodeExecutorRegistry({wasmModuleCache} = {}) {
  const registry = new CodeExecutorRegistry();
  registry.register(NEUTRAL_EXPRESSION_V0, neutralExpressionV0Executor);
  registry.register(WASM_FUNCTION_V1, createWasmFunctionV1Executor(
    wasmModuleCache === undefined ? {} : {moduleCache: wasmModuleCache},
  ));
  return registry;
}

export {ActivationExecutor, createDefaultCodeExecutorRegistry};
export * from './executor-registry.js';
export * from './neutral-expression-v0.js';
