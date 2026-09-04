import {LAGRANGE_CODE_V0, lagrangeCodeV0ToNeutralExpressionCompiler} from '../code/lagrange-code-v0.js';
import {LAGRANGE_CODE_V1, lagrangeCodeV1ToNeutralExpressionCompiler} from '../code/lagrange-code-v1.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {NEUTRAL_EXPRESSION_V1} from '../execution/neutral-expression-v1.js';
import {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1,
  isWasmV1TailEffectRestrictionError,
  lagrangeCodeV1GroupToWasmModuleCompiler,
  lagrangeCodeV1ToWasmModuleCompiler,
} from '../wasm/compiler-v1.js';
import {
  lagrangeCodeV1GroupToResumableWasmModuleCompiler,
  lagrangeCodeV1ToResumableWasmModuleCompiler,
} from '../wasm/resumable-compiler-v2.js';
import {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
  lagrangeCodeGroupToWasmModuleCompiler,
  lagrangeCodeV0ToWasmModuleCompiler,
} from '../wasm/compiler.js';
import {WASM_INSTANCE_REUSE_STATELESS_V0} from '../wasm/instance-pool.js';
import {WASM_MODULE_V2, describeWasmModuleV2Result} from '../wasm/module-contract.js';
import {
  isWasmTailEffectRestrictionError,
  lagrangeCodeGroupToResumableWasmModuleCompiler,
  lagrangeCodeV0ToResumableWasmModuleCompiler,
} from '../wasm/resumable-compiler.js';
import {CompilationService} from './compilation-service.js';
import {CodeCompilerRegistry} from './compiler-registry.js';
import {CompilationGroupCompilerRegistry} from './group-compiler-registry.js';

// wasm-module/v2 is the only compiled-module output (ygi). wasm-module/v1 is FROZEN: existing
// durable v1 artifacts remain readable and executable through the canonical accessor's frozen
// path, and nothing produces new ones. The compilers return compilation FACTS
// {languageId, bytes, contract, metadata}; the module-contract owner describes the durable
// graph; the CompilationService persists it. `instanceReuse` (stateless pooling) is a
// non-semantic optimization the registry attaches as provenance, never as contract.
const LAGRANGE_CODE_WASM_COMPILER_ID = 'lagrange-code-v0-to-wasm-module-v2/value-handle-hybrid/compiler-v1';
const LAGRANGE_CODE_V1_WASM_COMPILER_ID = 'lagrange-code-v1-to-wasm-module-v2/lexical-cell/compiler-v1';
const LAGRANGE_CODE_V1_WASM_GROUP_COMPILER_ID = 'lagrange-code-v1-group-to-wasm-module-v2/lexical-cell/compiler-v1';
const LAGRANGE_CODE_WASM_GROUP_COMPILER_ID = 'lagrange-code-group-to-wasm-module-v2/value-handle-hybrid/compiler-v1';

function asWasmModuleV2Result(facts) {
  return describeWasmModuleV2Result({
    ...facts,
    metadata: {...(facts.metadata ?? {}), instanceReuse: WASM_INSTANCE_REUSE_STATELESS_V0},
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

// Same shape as the v0 fallback: try the simple backend, and drop to the resumable one when an
// effect is not in tail position. Only the ABI pair differs.
async function compileWithV1ResumableFallback(request, context, tailCompiler, resumableCompiler) {
  try {
    return await tailCompiler.compile(request, context);
  } catch (error) {
    if (!isWasmV1TailEffectRestrictionError(error)) throw error;
    return await resumableCompiler.compile(request, context);
  }
}

const sourceCacheKey = ({source}) => Object.freeze({
  languageId: source.languageId,
  representation: source.representation,
  content: source.content,
});

const groupCacheKey = ({group, members}) => Object.freeze({
  policyId: group.policyId,
  targetRepresentation: group.targetRepresentation,
  options: group.options,
  members: members.map((member) => Object.freeze({
    languageId: member.languageId,
    representation: member.representation,
    content: member.content,
  })),
});

const reusableLagrangeCodeV0ToWasmCompiler = Object.freeze({
  identity: LAGRANGE_CODE_WASM_COMPILER_ID,
  cacheKey: sourceCacheKey,
  async compile(request, context) {
    return asWasmModuleV2Result(await compileWithResumableFallback(
      request, context, lagrangeCodeV0ToWasmModuleCompiler, lagrangeCodeV0ToResumableWasmModuleCompiler,
    ));
  },
});

const reusableLagrangeCodeGroupToWasmCompiler = Object.freeze({
  identity: LAGRANGE_CODE_WASM_GROUP_COMPILER_ID,
  cacheKey: groupCacheKey,
  async compile(request, context) {
    return asWasmModuleV2Result(await compileWithResumableFallback(
      request, context, lagrangeCodeGroupToWasmModuleCompiler, lagrangeCodeGroupToResumableWasmModuleCompiler,
    ));
  },
});

const reusableLagrangeCodeV1ToWasmCompiler = Object.freeze({
  identity: LAGRANGE_CODE_V1_WASM_COMPILER_ID,
  cacheKey: sourceCacheKey,
  async compile(request, context) {
    return asWasmModuleV2Result(await compileWithV1ResumableFallback(
      request, context, lagrangeCodeV1ToWasmModuleCompiler, lagrangeCodeV1ToResumableWasmModuleCompiler,
    ));
  },
});

const reusableLagrangeCodeV1GroupToWasmCompiler = Object.freeze({
  identity: LAGRANGE_CODE_V1_WASM_GROUP_COMPILER_ID,
  cacheKey: groupCacheKey,
  async compile(request, context) {
    return asWasmModuleV2Result(await compileWithV1ResumableFallback(
      request, context, lagrangeCodeV1GroupToWasmModuleCompiler, lagrangeCodeV1GroupToResumableWasmModuleCompiler,
    ));
  },
});

function createDefaultCodeCompilerRegistry() {
  const registry = new CodeCompilerRegistry();
  registry.register(LAGRANGE_CODE_V0, NEUTRAL_EXPRESSION_V0, lagrangeCodeV0ToNeutralExpressionCompiler);
  registry.register(LAGRANGE_CODE_V0, WASM_MODULE_V2, reusableLagrangeCodeV0ToWasmCompiler);
  registry.register(LAGRANGE_CODE_V1, NEUTRAL_EXPRESSION_V1, lagrangeCodeV1ToNeutralExpressionCompiler);
  registry.register(LAGRANGE_CODE_V1, WASM_MODULE_V2, reusableLagrangeCodeV1ToWasmCompiler);
  return registry;
}

function createDefaultCompilationGroupCompilerRegistry() {
  const registry = new CompilationGroupCompilerRegistry();
  registry.register(WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0, WASM_MODULE_V2, reusableLagrangeCodeGroupToWasmCompiler);
  // A separate policy, not a second compiler under the v0 one: the group registry allows exactly
  // one compiler per (policyId, target), so reusing v0's policy would mean replacing the
  // compiler that serves unchanged v0 inputs.
  registry.register(WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1, WASM_MODULE_V2, reusableLagrangeCodeV1GroupToWasmCompiler);
  return registry;
}

export {
  CompilationService,
  LAGRANGE_CODE_V1_WASM_COMPILER_ID,
  LAGRANGE_CODE_V1_WASM_GROUP_COMPILER_ID,
  LAGRANGE_CODE_WASM_COMPILER_ID,
  LAGRANGE_CODE_WASM_GROUP_COMPILER_ID,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
};
export * from './compiler-registry.js';
export * from './derivation-cache.js';
export * from './group.js';
export * from './group-compiler-registry.js';
