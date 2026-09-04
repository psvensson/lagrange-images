import {LAGRANGE_CODE_V0, lagrangeCodeV0ToNeutralExpressionCompiler} from '../code/lagrange-code-v0.js';
import {LAGRANGE_CODE_V1, lagrangeCodeV1ToNeutralExpressionCompiler} from '../code/lagrange-code-v1.js';
import {WASM_MODULE_V1} from '../code/wasm-artifacts.js';
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
import {base64Decode} from '../support/portable-bytes.js';
import {
  WASM_MODULE_CONTRACT_KEYS,
  WASM_MODULE_SEMANTIC_MIRROR_KEYS,
  WASM_MODULE_V2,
  describeWasmModuleV2Result,
} from '../wasm/module-contract.js';
import {
  isWasmTailEffectRestrictionError,
  lagrangeCodeGroupToResumableWasmModuleCompiler,
  lagrangeCodeV0ToResumableWasmModuleCompiler,
} from '../wasm/resumable-compiler.js';
import {CompilationService} from './compilation-service.js';
import {CodeCompilerRegistry} from './compiler-registry.js';
import {CompilationGroupCompilerRegistry} from './group-compiler-registry.js';

const LAGRANGE_CODE_WASM_COMPILER_ID = 'lagrange-code-v0-to-wasm-module-v1/value-handle-hybrid/compiler-v3';
// New identities rather than a bump of the v0 ones: lagrange-code/v0 output is unchanged, so
// invalidating its derivation identity would rebuild every existing artifact for nothing.
const LAGRANGE_CODE_V1_WASM_COMPILER_ID = 'lagrange-code-v1-to-wasm-module-v1/lexical-cell/compiler-v1';
const LAGRANGE_CODE_V1_WASM_GROUP_COMPILER_ID = 'lagrange-code-v1-group-to-wasm-module-v1/lexical-cell/compiler-v1';
const LAGRANGE_CODE_WASM_GROUP_COMPILER_ID = 'lagrange-code-group-to-wasm-module-v1/value-handle-hybrid/compiler-v3';
// wasm-module/v2 targets (ygi). Distinct identities: the output representation is part of what a
// derivation names, and existing v1 artifacts must never be offered as reusable v2 results.
const LAGRANGE_CODE_WASM_V2_COMPILER_ID = 'lagrange-code-v0-to-wasm-module-v2/value-handle-hybrid/compiler-v1';
const LAGRANGE_CODE_V1_WASM_V2_COMPILER_ID = 'lagrange-code-v1-to-wasm-module-v2/lexical-cell/compiler-v1';
const LAGRANGE_CODE_V1_WASM_V2_GROUP_COMPILER_ID = 'lagrange-code-v1-group-to-wasm-module-v2/lexical-cell/compiler-v1';
const LAGRANGE_CODE_WASM_V2_GROUP_COMPILER_ID = 'lagrange-code-group-to-wasm-module-v2/value-handle-hybrid/compiler-v1';

// TRANSITIONAL (ygi step 2 only; deleted in step 3 when the compilers return facts directly):
// split a v1-shaped compiler result {content: bytes, metadata: contract + mirrors + provenance}
// into compilation FACTS {bytes, contract, metadata: provenance}. The contract keys and the
// single-function semantic mirrors are owned by the module-contract owner; everything else the
// compiler wrote is provenance (semanticRepresentation, groupPolicyId, physicalLayout,
// continuations — consumed by no executor).
function wasmModuleFactsFromV1Result(result) {
  const md = result.metadata ?? {};
  const contract = {};
  const provenance = {};
  for (const [key, value] of Object.entries(md)) {
    if (WASM_MODULE_CONTRACT_KEYS.includes(key)) contract[key] = value;
    else if (!WASM_MODULE_SEMANTIC_MIRROR_KEYS.includes(key)) provenance[key] = value;
  }
  contract.effectSites ??= [];
  return Object.freeze({
    languageId: result.languageId,
    bytes: base64Decode(result.content.base64),
    contract,
    metadata: provenance,
  });
}

// The ONE place a compiled WASM module's facts become the durable v2 result graph: the
// representation owner describes the graph, the CompilationService persists it. Compilers and
// every consumer stay unaware of the graph shape.
function asWasmModuleV2Result(result) {
  const facts = wasmModuleFactsFromV1Result(result);
  return describeWasmModuleV2Result({
    ...facts,
    metadata: {...facts.metadata, instanceReuse: WASM_INSTANCE_REUSE_STATELESS_V0},
  });
}

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

const reusableLagrangeCodeV1ToWasmCompiler = Object.freeze({
  identity: LAGRANGE_CODE_V1_WASM_COMPILER_ID,
  cacheKey({source}) {
    return Object.freeze({
      languageId: source.languageId,
      representation: source.representation,
      content: source.content,
    });
  },
  async compile(request, context) {
    return withStatelessInstanceReuse(await compileWithV1ResumableFallback(
      request,
      context,
      lagrangeCodeV1ToWasmModuleCompiler,
      lagrangeCodeV1ToResumableWasmModuleCompiler,
    ));
  },
});

const reusableLagrangeCodeV1GroupToWasmCompiler = Object.freeze({
  identity: LAGRANGE_CODE_V1_WASM_GROUP_COMPILER_ID,
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
    return withStatelessInstanceReuse(await compileWithV1ResumableFallback(
      request,
      context,
      lagrangeCodeV1GroupToWasmModuleCompiler,
      lagrangeCodeV1GroupToResumableWasmModuleCompiler,
    ));
  },
});

const reusableLagrangeCodeV0ToWasmV2Compiler = Object.freeze({
  identity: LAGRANGE_CODE_WASM_V2_COMPILER_ID,
  cacheKey: reusableLagrangeCodeV0ToWasmCompiler.cacheKey,
  async compile(request, context) {
    return asWasmModuleV2Result(await compileWithResumableFallback(
      request, context, lagrangeCodeV0ToWasmModuleCompiler, lagrangeCodeV0ToResumableWasmModuleCompiler,
    ));
  },
});

const reusableLagrangeCodeGroupToWasmV2Compiler = Object.freeze({
  identity: LAGRANGE_CODE_WASM_V2_GROUP_COMPILER_ID,
  cacheKey: reusableLagrangeCodeGroupToWasmCompiler.cacheKey,
  async compile(request, context) {
    return asWasmModuleV2Result(await compileWithResumableFallback(
      request, context, lagrangeCodeGroupToWasmModuleCompiler, lagrangeCodeGroupToResumableWasmModuleCompiler,
    ));
  },
});

const reusableLagrangeCodeV1ToWasmV2Compiler = Object.freeze({
  identity: LAGRANGE_CODE_V1_WASM_V2_COMPILER_ID,
  cacheKey: reusableLagrangeCodeV1ToWasmCompiler.cacheKey,
  async compile(request, context) {
    return asWasmModuleV2Result(await compileWithV1ResumableFallback(
      request, context, lagrangeCodeV1ToWasmModuleCompiler, lagrangeCodeV1ToResumableWasmModuleCompiler,
    ));
  },
});

const reusableLagrangeCodeV1GroupToWasmV2Compiler = Object.freeze({
  identity: LAGRANGE_CODE_V1_WASM_V2_GROUP_COMPILER_ID,
  cacheKey: reusableLagrangeCodeV1GroupToWasmCompiler.cacheKey,
  async compile(request, context) {
    return asWasmModuleV2Result(await compileWithV1ResumableFallback(
      request, context, lagrangeCodeV1GroupToWasmModuleCompiler, lagrangeCodeV1GroupToResumableWasmModuleCompiler,
    ));
  },
});

function createDefaultCodeCompilerRegistry() {
  const registry = new CodeCompilerRegistry();
  registry.register(LAGRANGE_CODE_V0, NEUTRAL_EXPRESSION_V0, lagrangeCodeV0ToNeutralExpressionCompiler);
  registry.register(LAGRANGE_CODE_V0, WASM_MODULE_V1, reusableLagrangeCodeV0ToWasmCompiler);
  registry.register(LAGRANGE_CODE_V0, WASM_MODULE_V2, reusableLagrangeCodeV0ToWasmV2Compiler);
  registry.register(LAGRANGE_CODE_V1, NEUTRAL_EXPRESSION_V1, lagrangeCodeV1ToNeutralExpressionCompiler);
  registry.register(LAGRANGE_CODE_V1, WASM_MODULE_V1, reusableLagrangeCodeV1ToWasmCompiler);
  registry.register(LAGRANGE_CODE_V1, WASM_MODULE_V2, reusableLagrangeCodeV1ToWasmV2Compiler);
  return registry;
}

function createDefaultCompilationGroupCompilerRegistry() {
  const registry = new CompilationGroupCompilerRegistry();
  registry.register(
    WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
    WASM_MODULE_V1,
    reusableLagrangeCodeGroupToWasmCompiler,
  );
  // A separate policy, not a second compiler under the v0 one: the group registry allows exactly
  // one compiler per (policyId, target), so reusing v0's policy would mean replacing the
  // compiler that serves unchanged v0 inputs.
  registry.register(
    WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1,
    WASM_MODULE_V1,
    reusableLagrangeCodeV1GroupToWasmCompiler,
  );
  registry.register(WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0, WASM_MODULE_V2, reusableLagrangeCodeGroupToWasmV2Compiler);
  registry.register(WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1, WASM_MODULE_V2, reusableLagrangeCodeV1GroupToWasmV2Compiler);
  return registry;
}

export {
  CompilationService,
  LAGRANGE_CODE_V1_WASM_COMPILER_ID,
  LAGRANGE_CODE_V1_WASM_GROUP_COMPILER_ID,
  LAGRANGE_CODE_WASM_COMPILER_ID,
  LAGRANGE_CODE_WASM_GROUP_COMPILER_ID,
  LAGRANGE_CODE_V1_WASM_V2_COMPILER_ID,
  LAGRANGE_CODE_V1_WASM_V2_GROUP_COMPILER_ID,
  LAGRANGE_CODE_WASM_V2_COMPILER_ID,
  LAGRANGE_CODE_WASM_V2_GROUP_COMPILER_ID,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
};
export * from './compiler-registry.js';
export * from './derivation-cache.js';
export * from './group.js';
export * from './group-compiler-registry.js';
