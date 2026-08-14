import {LAGRANGE_CODE_V0, lagrangeCodeV0ToNeutralExpressionCompiler} from '../code/lagrange-code-v0.js';
import {WASM_MODULE_V1} from '../code/wasm-artifacts.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
  lagrangeCodeGroupToWasmModuleCompiler,
  lagrangeCodeV0ToWasmModuleCompiler,
} from '../wasm/compiler.js';
import {WASM_INSTANCE_REUSE_STATELESS_V0} from '../wasm/instance-pool.js';
import {CompilationService} from './compilation-service.js';
import {CodeCompilerRegistry} from './compiler-registry.js';
import {CompilationGroupCompilerRegistry} from './group-compiler-registry.js';

const LAGRANGE_CODE_WASM_COMPILER_ID = 'lagrange-code-v0-to-wasm-module-v1/value-handle-v0/compiler-v2';
const LAGRANGE_CODE_WASM_GROUP_COMPILER_ID = 'lagrange-code-group-to-wasm-module-v1/value-handle-v0/compiler-v2';

function withStatelessInstanceReuse(result) {
  return Object.freeze({
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      instanceReuse: WASM_INSTANCE_REUSE_STATELESS_V0,
    },
  });
}

const reusableLagrangeCodeV0ToWasmCompiler = Object.freeze({
  identity: LAGRANGE_CODE_WASM_COMPILER_ID,
  cacheKey({source}) {
    return Object.freeze({
      languageId: source.languageId,
      representation: source.representation,
      content: source.content,
    });
  },
  async compile(request, context) {
    return withStatelessInstanceReuse(await lagrangeCodeV0ToWasmModuleCompiler.compile(request, context));
  },
});

const reusableLagrangeCodeGroupToWasmCompiler = Object.freeze({
  identity: LAGRANGE_CODE_WASM_GROUP_COMPILER_ID,
  cacheKey({group, members}) {
    return Object.freeze({
      policyId: group.policyId,
      targetRepresentation: group.targetRepresentation,
      options: group.options,
      members: members.map((member) => Object.freeze({
        languageId: member.languageId,
        representation: member.representation,
        content: member.content,
      })),
    });
  },
  async compile(request, context) {
    return withStatelessInstanceReuse(await lagrangeCodeGroupToWasmModuleCompiler.compile(request, context));
  },
});

function createDefaultCodeCompilerRegistry() {
  const registry = new CodeCompilerRegistry();
  registry.register(LAGRANGE_CODE_V0, NEUTRAL_EXPRESSION_V0, lagrangeCodeV0ToNeutralExpressionCompiler);
  registry.register(LAGRANGE_CODE_V0, WASM_MODULE_V1, reusableLagrangeCodeV0ToWasmCompiler);
  return registry;
}

function createDefaultCompilationGroupCompilerRegistry() {
  const registry = new CompilationGroupCompilerRegistry();
  registry.register(
    WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
    WASM_MODULE_V1,
    reusableLagrangeCodeGroupToWasmCompiler,
  );
  return registry;
}

export {
  CompilationService,
  LAGRANGE_CODE_WASM_COMPILER_ID,
  LAGRANGE_CODE_WASM_GROUP_COMPILER_ID,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
};
export * from './compiler-registry.js';
export * from './derivation-cache.js';
export * from './group.js';
export * from './group-compiler-registry.js';
