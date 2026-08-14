import {ActivationExecutor} from './activation-executor.js';
import {CodeExecutorRegistry} from './executor-registry.js';
import {
  NEUTRAL_EXPRESSION_V0,
  neutralExpressionV0Executor,
} from './neutral-expression-v0.js';

function createDefaultCodeExecutorRegistry() {
  const registry = new CodeExecutorRegistry();
  registry.register(NEUTRAL_EXPRESSION_V0, neutralExpressionV0Executor);
  return registry;
}

export {ActivationExecutor, createDefaultCodeExecutorRegistry};
export * from './executor-registry.js';
export * from './neutral-expression-v0.js';
