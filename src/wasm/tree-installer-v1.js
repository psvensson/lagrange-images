import {ensureBlock, ensureCodeArtifact} from '../graph/ensure-records.js';
import {uuid as randomUUID} from '../support/default-crypto.js';
import {base64urlEncode, utf8Encode} from '../support/portable-bytes.js';
import {
  LAGRANGE_CODE_V1,
  LAGRANGE_CODE_V2,
  normalizeLagrangeCodeV1Program,
  normalizeLagrangeCodeV2Program,
  parseLagrangeCodeV1Program,
  parseLagrangeCodeV2Program,
} from '../code/lagrange-code-v1.js';
import {bindClosurePrototypes, describeWasmFunctionV2} from './function-contract.js';
import {WASM_MODULE_V2, moduleFunctionOf, readModuleDescriptor} from './module-contract.js';
import {createCompilationGroup} from '../compilation/group.js';
import {normalizeMetadata} from '../object/model.js';
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/index.js';
import {WASM_VALUE_HANDLE_ABI_V1} from './abi.js';
import {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1,
  compileWasmV1ModuleEntries,
  isWasmV1TailEffectRestrictionError,
} from './compiler-v1.js';
import {WASM_RESUMABLE_VALUE_HANDLE_ABI_V2} from './resumable-abi.js';
import {compileResumableWasmV2ModuleEntries} from './resumable-compiler-v2.js';
import {
  optimizeNonEscapingClosures,
  partitionCompilationGroupByBudget,
} from './group-optimizations.js';

// The lagrange-code/v1 Block-tree installer. A sibling of the v0 installer rather than a
// generalization of it: that one hardcodes v0 normalization, v0 semantic persistence and v0
// preflight throughout, and making it generic while the v1 path is still unproven would add risk
// without adding meaning. Shared plumbing can be extracted later if it turns out to be worth it.
//
// There is deliberately no "does this program need mutable state?" analysis here. That decision was
// made when the semantic artifact was created; the representation is now the source of truth.
const SUPPORTED_MODULE_ABIS = Object.freeze([WASM_VALUE_HANDLE_ABI_V1, WASM_RESUMABLE_VALUE_HANDLE_ABI_V2]);

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

function assertServices(images, compilation) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getCodeArtifact', 'putCodeArtifact', 'getBlock', 'putBlock']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  if (!compilation || typeof compilation.compileGroup !== 'function') {
    throw new TypeError('compilation service with compileGroup is required');
  }
}

// v1 bodies reach nested Blocks through statement sequences and assignment right-hand sides as
// well as the v0 positions, so omitting those would silently install no prototype for them.
function directNestedBlocks(expression, result = []) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return result;
  switch (expression.op) {
    case 'block':
      result.push(expression);
      return result;
    case 'binding-write':
      return directNestedBlocks(expression.value, result);
    case 'sequence':
      for (const statement of expression.statements) directNestedBlocks(statement, result);
      return result;
    case 'send':
      directNestedBlocks(expression.receiver, result);
      for (const argument of expression.arguments ?? []) directNestedBlocks(argument, result);
      return result;
    case 'apply':
      directNestedBlocks(expression.callee, result);
      for (const argument of expression.arguments ?? []) directNestedBlocks(argument, result);
      return result;
    case 'integer-add':
    case 'equals':
      directNestedBlocks(expression.left, result);
      directNestedBlocks(expression.right, result);
      return result;
    case 'if':
      directNestedBlocks(expression.condition, result);
      directNestedBlocks(expression.then, result);
      directNestedBlocks(expression.else, result);
      return result;
    default:
      return result;
  }
}

function blockKey(blockId) {
  return base64urlEncode(utf8Encode(requiredText(blockId, 'semantic block id')));
}

// Preflight both backends before anything is written: the simple one where legal, the resumable one
// where a non-tail effect makes it necessary.
function preflightEntries(entries, options = {}) {
  try {
    return {compiled: compileWasmV1ModuleEntries(entries, options), abi: WASM_VALUE_HANDLE_ABI_V1};
  } catch (error) {
    if (!isWasmV1TailEffectRestrictionError(error)) throw error;
    return {compiled: compileResumableWasmV2ModuleEntries(entries, options), abi: WASM_RESUMABLE_VALUE_HANDLE_ABI_V2};
  }
}

function validateTree(program, seen = new Set(), {representation = LAGRANGE_CODE_V1} = {}) {
  const normalized = representation === LAGRANGE_CODE_V2
    ? normalizeLagrangeCodeV2Program(program)
    : normalizeLagrangeCodeV1Program(program);
  for (const nested of directNestedBlocks(normalized.body)) {
    const blockId = requiredText(nested.blockId, 'nested semantic block id');
    if (seen.has(blockId)) throw new TypeError(`duplicate semantic block id in WASM tree: ${blockId}`);
    seen.add(blockId);
    validateTree(nested.program, seen, {representation});
  }
  return normalized;
}

function nodeIds(rootId, semanticBlockId = null) {
  if (semanticBlockId === null) {
    return Object.freeze({
      moduleId: `${rootId}:wasm:module`,
      functionId: `${rootId}:wasm:function`,
      blockId: rootId,
      semanticId: null,
    });
  }
  const key = blockKey(semanticBlockId);
  return Object.freeze({
    semanticId: `${rootId}:wasm:semantic:${key}`,
    moduleId: `${rootId}:wasm:module`,
    functionId: `${rootId}:wasm:function:${key}`,
    blockId: `${rootId}:wasm:prototype:${key}`,
  });
}

function planTree(program, rootId, semanticBlockId = null, {representation = LAGRANGE_CODE_V1} = {}) {
  const plan = {
    semanticBlockId,
    program: representation === LAGRANGE_CODE_V2
      ? normalizeLagrangeCodeV2Program(program)
      : normalizeLagrangeCodeV1Program(program),
    ids: nodeIds(rootId, semanticBlockId),
    children: [],
  };
  for (const nested of directNestedBlocks(plan.program.body)) {
    plan.children.push(planTree(nested.program, rootId, nested.blockId, {representation}));
  }
  return plan;
}

function flattenPlans(root) {
  const all = [];
  const visit = (plan) => {
    all.push(plan);
    for (const child of plan.children) visit(child);
  };
  visit(root);
  return [
    root,
    ...all.filter((plan) => plan !== root).sort((left, right) =>
      String(left.semanticBlockId).localeCompare(String(right.semanticBlockId))),
  ];
}

async function persistSemanticTree({images, rootRef, rootArtifact, rootPlan, rootId}) {
  rootPlan.semanticRef = rootRef;
  rootPlan.semanticArtifact = rootArtifact;

  const persistChildren = async (parentPlan) => {
    for (const child of parentPlan.children) {
      const childArtifact = await ensureCodeArtifact(images, parentPlan.semanticRef.imageId, {
        id: child.ids.semanticId,
        languageId: parentPlan.semanticArtifact.languageId,
        representation: rootArtifact.representation,
        content: textValue(JSON.stringify(child.program)),
        derivedFrom: [parentPlan.semanticRef],
        metadata: {semanticBlockId: child.semanticBlockId, wasmTreeRootId: rootId},
      });
      child.semanticArtifact = childArtifact;
      child.semanticRef = objectRef(childArtifact.imageId, childArtifact.id);
      await persistChildren(child);
    }
  };

  await persistChildren(rootPlan);
}

function normalizePrototypeMap(blockPrototypes) {
  if (!blockPrototypes || typeof blockPrototypes !== 'object' || Array.isArray(blockPrototypes)) {
    throw new TypeError('blockPrototypes must be an object keyed by semantic block id');
  }
  const result = new Map();
  for (const [blockId, ref] of Object.entries(blockPrototypes)) {
    requiredText(blockId, 'block prototype id');
    result.set(blockId, normalizeObjectRef(ref, `block prototype ${blockId}`));
  }
  return result;
}

// The v1-lane assembly seam. Separate from assembleWasmFunctionArtifact(), which requires
// lagrange-code/v0; the SUPPORTED_MODULE_ABIS gate is what keeps a v0-ABI module out of this lane.
async function assembleWasmV1FunctionArtifact({
  images,
  semanticRef,
  moduleRef,
  functionId,
  entry,
  blockPrototypes = {},
} = {}) {
  const semantic = await images.getCodeArtifact(semanticRef.imageId, semanticRef.objectId);
  if (!semantic || (semantic.representation !== LAGRANGE_CODE_V1 && semantic.representation !== LAGRANGE_CODE_V2)) {
    throw new TypeError(`semanticRef must reference ${LAGRANGE_CODE_V1}`);
  }
  const normalizedModuleRef = normalizeObjectRef(moduleRef, 'moduleRef');
  const moduleArtifact = await images.getCodeArtifact(normalizedModuleRef.imageId, normalizedModuleRef.objectId);
  if (!moduleArtifact) throw new TypeError('moduleRef must reference a WASM module artifact');
  const moduleDescriptor = readModuleDescriptor(moduleArtifact);
  const abi = moduleDescriptor.abi;
  if (!SUPPORTED_MODULE_ABIS.includes(abi)) {
    throw new TypeError(`WASM v1 function assembly requires ${SUPPORTED_MODULE_ABIS.join(' or ')}, got ${abi}`);
  }

  const descriptor = moduleFunctionOf(moduleDescriptor, {entry: requiredText(entry, 'WASM function entry')});
  const {closurePrototypes, prototypeRefs} = bindClosurePrototypes({
    descriptor,
    closureSites: moduleDescriptor.closureSites,
    prototypes: normalizePrototypeMap(blockPrototypes),
  });
  for (const ref of prototypeRefs) {
    if (!await images.getBlock(ref.imageId, ref.objectId)) {
      throw new TypeError(`WASM Block prototype not found: ${ref.imageId}/${ref.objectId}`);
    }
  }

  // The v2 function carries only its selection; abi/parameters/captures/cellBindings are the
  // module's function-table entry, resolved at execution through the module accessor.
  const functionArtifact = await ensureCodeArtifact(images, semanticRef.imageId, describeWasmFunctionV2({
    functionId,
    languageId: semantic.languageId,
    semanticRef,
    moduleRef: normalizedModuleRef,
    entry: descriptor.entry,
    closurePrototypes,
    prototypeRefs,
  }));
  return Object.freeze({moduleArtifact, functionArtifact});
}

async function installExecutableTree({
  images,
  moduleArtifact,
  shardPlacement = null,
  groupPlans,
  rootPlan,
  rootId,
  rootEnvironment,
  rootMetadata,
}) {
  const memberIndex = new Map(groupPlans.map((plan, index) => [plan, index]));
  const nodes = [];

  const install = async (plan) => {
    const blockPrototypes = {};
    for (const childPlan of plan.children) {
      const child = await install(childPlan);
      blockPrototypes[childPlan.semanticBlockId] = objectRef(child.block.imageId, child.block.id);
    }

    const placement = shardPlacement?.get(plan) ?? {
      moduleArtifact,
      shardMemberIndex: memberIndex.get(plan),
    };
    const planModuleArtifact = placement.moduleArtifact;
    const moduleRef = objectRef(planModuleArtifact.imageId, planModuleArtifact.id);
    const moduleDescriptor = readModuleDescriptor(planModuleArtifact);
    const descriptor = moduleFunctionOf(moduleDescriptor, {memberIndex: placement.shardMemberIndex});
    const activeClosureBlockIds = new Set(
      descriptor.closureSiteIndices.map((siteIdx) => moduleDescriptor.closureSites[siteIdx]?.blockId),
    );
    const activeBlockPrototypes = Object.fromEntries(
      Object.entries(blockPrototypes).filter(([blockId]) => activeClosureBlockIds.has(blockId)),
    );

    const {functionArtifact} = await assembleWasmV1FunctionArtifact({
      images,
      semanticRef: plan.semanticRef,
      moduleRef,
      functionId: plan.ids.functionId,
      entry: descriptor.entry,
      blockPrototypes: activeBlockPrototypes,
    });
    const isRoot = plan === rootPlan;
    const block = await ensureBlock(images, plan.semanticRef.imageId, {
      id: plan.ids.blockId,
      code: objectRef(functionArtifact.imageId, functionArtifact.id),
      environment: isRoot ? rootEnvironment : null,
      metadata: isRoot
        ? rootMetadata
        : {prototype: true, semanticBlockId: plan.semanticBlockId, wasmTreeRootId: rootId},
    });
    const node = Object.freeze({
      semanticBlockId: plan.semanticBlockId,
      semanticArtifact: plan.semanticArtifact,
      moduleArtifact: planModuleArtifact,
      functionArtifact,
      block,
      blockPrototypes: Object.freeze({...activeBlockPrototypes}),
    });
    nodes.push(node);
    return node;
  };

  const root = await install(rootPlan);
  return Object.freeze({root, nodes: Object.freeze(nodes)});
}

async function installWasmV1BlockTree({
  images,
  compilation,
  semanticRef,
  id = randomUUID(),
  environment = null,
  metadata = {},
  optimizeClosures = false,
  intraModuleDirectCalls = false,
  moduleBudget = null,
} = {}) {
  assertServices(images, compilation);
  requiredText(id, 'WASM Block tree id');
  const rootEnvironment = environment === null ? null : normalizeObjectRef(environment, 'root WASM Block environment');
  const rootMetadata = normalizeMetadata(metadata, 'WASM Block tree metadata');
  const rootRef = normalizeObjectRef(semanticRef, 'root semantic code artifact');
  const semanticArtifact = await images.getCodeArtifact(rootRef.imageId, rootRef.objectId);
  if (!semanticArtifact || (semanticArtifact.representation !== LAGRANGE_CODE_V1 && semanticArtifact.representation !== LAGRANGE_CODE_V2)) {
    throw new TypeError(`root semantic code artifact must be ${LAGRANGE_CODE_V1}`);
  }

  const representation = semanticArtifact.representation;
  const isV2 = representation === LAGRANGE_CODE_V2;
  const parsed = isV2
    ? parseLagrangeCodeV2Program(semanticArtifact)
    : parseLagrangeCodeV1Program(semanticArtifact);
  const rawProgram = validateTree(parsed, new Set(), {representation});
  const closureOptimization = optimizeClosures
    ? optimizeNonEscapingClosures(rawProgram)
    : {program: rawProgram, inlinedBlockIds: [], eliminatedClosureSites: 0, eliminatedApplySites: 0};
  const program = validateTree(closureOptimization.program, new Set(), {representation});
  const rootPlan = planTree(program, id, null, {representation});
  const groupPlans = flattenPlans(rootPlan);
  // Preflight before any write, so a program neither backend accepts installs nothing.
  preflightEntries(
    groupPlans.map((plan, memberIndex) => ({
      entry: `run_${memberIndex}`,
      memberIndex,
      program: plan.program,
      allowApply: isV2,
      semanticBlockId: plan.semanticBlockId,
    })),
    {intraModuleDirectCalls: Boolean(intraModuleDirectCalls)},
  );

  let effectiveRootRef = rootRef;
  let effectiveRootArtifact = semanticArtifact;
  if (closureOptimization.inlinedBlockIds.length > 0) {
    effectiveRootArtifact = await ensureCodeArtifact(images, rootRef.imageId, {
      id: `${id}:wasm:semantic:root`,
      languageId: semanticArtifact.languageId,
      representation,
      content: textValue(JSON.stringify(program)),
      derivedFrom: [rootRef],
      metadata: {wasmTreeRootId: id, inlinedBlockIds: closureOptimization.inlinedBlockIds},
    });
    effectiveRootRef = objectRef(effectiveRootArtifact.imageId, effectiveRootArtifact.id);
  }
  await persistSemanticTree({
    images,
    rootRef: effectiveRootRef,
    rootArtifact: effectiveRootArtifact,
    rootPlan,
    rootId: id,
  });

  if (moduleBudget && typeof moduleBudget === 'object') {
    const planEntries = groupPlans.map((plan, memberIndex) => ({
      entry: `run_${memberIndex}`,
      memberIndex,
      program: plan.program,
      allowApply: isV2,
      semanticBlockId: plan.semanticBlockId,
      plan,
    }));
    const split = partitionCompilationGroupByBudget({
      entries: planEntries,
      maxMembersPerModule: moduleBudget.maxMembersPerModule ?? Infinity,
      maxByteBudget: moduleBudget.maxByteBudget ?? Infinity,
      strictSingleMemberBudget: moduleBudget.strictSingleMemberBudget === true,
      compileEntries: (shardEntries) => preflightEntries(
        shardEntries.map((e, idx) => ({
          entry: `run_${idx}`,
          memberIndex: idx,
          program: e.program,
          allowApply: e.allowApply,
          semanticBlockId: e.semanticBlockId,
        })),
        {intraModuleDirectCalls: Boolean(intraModuleDirectCalls)},
      ).compiled,
    });
    const shardPlacement = new Map();
    const moduleArtifacts = [];
    const groups = [];
    const shardSummaries = [];

    for (const shard of split.shards) {
      const shardModuleId = shard.shardIndex === 0
        ? nodeIds(id).moduleId
        : `${nodeIds(id).moduleId}:shard:${shard.shardIndex}`;
      const shardGroup = createCompilationGroup({
        policyId: WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1,
        targetRepresentation: WASM_MODULE_V2,
        members: shard.entries.map((e) => e.plan.semanticRef),
        options: {
          physicalLayout: 'shared-module',
          ...(intraModuleDirectCalls ? {intraModuleDirectCalls: true} : {}),
        },
      });
      const shardModuleArtifact = await compilation.compileGroup(shardGroup, {id: shardModuleId});
      moduleArtifacts.push(shardModuleArtifact);
      groups.push(shardGroup);
      shard.entries.forEach((e, shardMemberIndex) => {
        shardPlacement.set(e.plan, {moduleArtifact: shardModuleArtifact, shardMemberIndex});
      });
      shardSummaries.push(Object.freeze({
        shardIndex: shard.shardIndex,
        moduleId: shardModuleArtifact.id,
        memberIndices: shard.memberIndices,
        byteLength: shard.byteLength,
      }));
    }

    const installed = await installExecutableTree({
      images,
      moduleArtifact: moduleArtifacts[0],
      shardPlacement,
      groupPlans,
      rootPlan,
      rootId: id,
      rootEnvironment,
      rootMetadata,
    });

    return Object.freeze({
      ...installed.root,
      nodes: installed.nodes,
      group: groups[0],
      groups: Object.freeze(groups),
      moduleArtifacts: Object.freeze(moduleArtifacts),
      budgetSplit: Object.freeze({
        shardCount: split.shardCount,
        maxMembersPerModule: split.maxMembersPerModule,
        maxByteBudget: split.maxByteBudget,
        shards: Object.freeze(shardSummaries),
      }),
      closureOptimization: Object.freeze({
        inlinedBlockIds: closureOptimization.inlinedBlockIds,
        eliminatedClosureSites: closureOptimization.eliminatedClosureSites,
        eliminatedApplySites: closureOptimization.eliminatedApplySites,
      }),
    });
  }

  const group = createCompilationGroup({
    policyId: WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1,
    targetRepresentation: WASM_MODULE_V2,
    members: groupPlans.map((plan) => plan.semanticRef),
    options: {
      physicalLayout: 'shared-module',
      ...(intraModuleDirectCalls ? {intraModuleDirectCalls: true} : {}),
    },
  });
  const moduleArtifact = await compilation.compileGroup(group, {id: nodeIds(id).moduleId});
  const installed = await installExecutableTree({
    images,
    moduleArtifact,
    groupPlans,
    rootPlan,
    rootId: id,
    rootEnvironment,
    rootMetadata,
  });

  return Object.freeze({
    ...installed.root,
    nodes: installed.nodes,
    group,
    closureOptimization: Object.freeze({
      inlinedBlockIds: closureOptimization.inlinedBlockIds,
      eliminatedClosureSites: closureOptimization.eliminatedClosureSites,
      eliminatedApplySites: closureOptimization.eliminatedApplySites,
    }),
  });
}

export {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1,
  assembleWasmV1FunctionArtifact,
  installWasmV1BlockTree,
};
