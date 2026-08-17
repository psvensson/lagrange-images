import {LAGRANGE_CODE_V0, lagrangeCodeV0ToNeutralExpressionCompiler} from '../code/lagrange-code-v0.js';
import {LAGRANGE_CODE_V1, lagrangeCodeV1ToNeutralExpressionCompiler} from '../code/lagrange-code-v1.js';
import {WASM_MODULE_V1} from '../code/wasm-artifacts.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {NEUTRAL_EXPRESSION_V1} from '../execution/neutral-expression-v1.js';
import {assertWasmSupportedSemanticRepresentation} from '../wasm/mutable-lexical-support.js';
import {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
  lagrangeCodeGroupToWasmModuleCompiler,
  lagrangeCodeV0ToWasmModuleCompiler,
} from '../wasm/compiler.js';
import {WASM_INSTANCE_REUSE_STATELESS_V0} from '../wasm/instance-pool.js';
import {
  isWasmTailEffectRestrictionError,
  lagrangeCodeGroupToResumableWasmModuleCompiler,
  lagrangeCodeV0ToResumableWasmModuleCompiler,
} from '../wasm/resumable-compiler.js';
import {CompilationService} from './compilation-service.js';
import {CodeCompilerRegistry} from './compiler-registry.js';
import {CompilationGroupCompilerRegistry} from './group-compiler-registry.js';

const LAGRANGE_CODE_WASM_COMPILER_ID = 'lagrange-code-v0-to-wasm-module-v1/value-handle-hybrid/compiler-v3';
const LAGRANGE_CODE_WASM_GROUP_COMPILER_ID = 'lagrange-code-group-to-wasm-module-v1/value-handle-hybrid/compiler-v3';

function withStatelessInstanceReuse(result) {
  return Object.freeze({
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      instanceReuse: WASM_INSTANCE_REUSE_STATELESS_V0,
    },
  });
}

async function compileWithResumableFallback(request, context, tailCompiler, resumableCompiler) {
  try {
    return await tailCompiler.compile(request, context);
  } catch (error) {
    if (!isWasmTailEffectRestrictionError(error)) throw error;
    return await resumableCompiler.compile(request, context);
  }
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
    return withStatelessInstanceReuse(await compileWithResumableFallback(
      request,
      context,
      lagrangeCodeV0ToWasmModuleCompiler,
      lagrangeCodeV0ToResumableWasmModuleCompiler,
    ));
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
    return withStatelessInstanceReuse(await compileWithResumableFallback(
      request,
      context,
      lagrangeCodeGroupToWasmModuleCompiler,
      lagrangeCodeGroupToResumableWasmModuleCompiler,
    ));
  },
});

// Registered so the refusal is explicit and reaches the caller before any derived artifact is
// written. Leaving the pair unregistered would report "no compiler" — true, but it reads like a
// wiring mistake rather than the deliberate lane gap it is.
const rejectingLagrangeCodeV1ToWasmCompiler = Object.freeze({
  identity: 'lagrange-code-v1-to-wasm-module-v1/unsupported',
  async compile({source}) {
    assertWasmSupportedSemanticRepresentation(source.representation);
    throw new TypeError(`unexpected ${LAGRANGE_CODE_V1} WASM compilation request`);
  },
});

function createDefaultCodeCompilerRegistry() {
  const registry = new CodeCompilerRegistry();
  registry.register(LAGRANGE_CODE_V0, NEUTRAL_EXPRESSION_V0, lagrangeCodeV0ToNeutralExpressionCompiler);
  registry.register(LAGRANGE_CODE_V0, WASM_MODULE_V1, reusableLagrangeCodeV0ToWasmCompiler);
  registry.register(LAGRANGE_CODE_V1, NEUTRAL_EXPRESSION_V1, lagrangeCodeV1ToNeutralExpressionCompiler);
  registry.register(LAGRANGE_CODE_V1, WASM_MODULE_V1, rejectingLagrangeCodeV1ToWasmCompiler);
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
