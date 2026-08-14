import {LAGRANGE_CODE_V0, lagrangeCodeV0ToNeutralExpressionCompiler} from '../code/lagrange-code-v0.js';
import {WASM_MODULE_V1} from '../code/wasm-artifacts.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {lagrangeCodeV0ToWasmModuleCompiler} from '../wasm/compiler.js';
import {CompilationService} from './compilation-service.js';
import {CodeCompilerRegistry} from './compiler-registry.js';

function createDefaultCodeCompilerRegistry() {
  const registry = new CodeCompilerRegistry();
  registry.register(LAGRANGE_CODE_V0, NEUTRAL_EXPRESSION_V0, lagrangeCodeV0ToNeutralExpressionCompiler);
  registry.register(LAGRANGE_CODE_V0, WASM_MODULE_V1, lagrangeCodeV0ToWasmModuleCompiler);
  return registry;
}

export {CompilationService, createDefaultCodeCompilerRegistry};
export * from './compiler-registry.js';
