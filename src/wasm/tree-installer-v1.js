import {ensureBlock, ensureCodeArtifact} from '../graph/ensure-records.js';
import {uuid as randomUUID} from '../support/default-crypto.js';
import {
  LAGRANGE_CODE_V1,
  normalizeLagrangeCodeV1Program,
  parseLagrangeCodeV1Program,
} from '../code/lagrange-code-v1.js';
import {WASM_FUNCTION_V1, WASM_MODULE_V1} from '../code/wasm-artifacts.js';
import {moduleFunctionOf, readModuleDescriptor} from './module-contract.js';
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
  return Buffer.from(requiredText(blockId, 'semantic block id'), 'utf8').toString('base64url');
}

// Preflight both backends before anything is written: the simple one where legal, the resumable one
// where a non-tail effect makes it necessary.
function preflightEntries(entries) {
  try {
    return {compiled: compileWasmV1ModuleEntries(entries), abi: WASM_VALUE_HANDLE_ABI_V1};
  } catch (error) {
    if (!isWasmV1TailEffectRestrictionError(error)) throw error;
    return {compiled: compileResumableWasmV2ModuleEntries(entries), abi: WASM_RESUMABLE_VALUE_HANDLE_ABI_V2};
  }
}

function validateTree(program, seen = new Set()) {
  const normalized = normalizeLagrangeCodeV1Program(program);
  for (const nested of directNestedBlocks(normalized.body)) {
    const blockId = requiredText(nested.blockId, 'nested semantic block id');
    if (seen.has(blockId)) throw new TypeError(`duplicate semantic block id in WASM tree: ${blockId}`);
    seen.add(blockId);
    validateTree(nested.program, seen);
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

function planTree(program, rootId, semanticBlockId = null) {
  const plan = {
    semanticBlockId,
    program: normalizeLagrangeCodeV1Program(program),
    ids: nodeIds(rootId, semanticBlockId),
    children: [],
  };
  for (const nested of directNestedBlocks(plan.program.body)) {
    plan.children.push(planTree(nested.program, rootId, nested.blockId));
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
        representation: LAGRANGE_CODE_V1,
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

// The v1 assembly seam. Separate from assembleWasmFunctionArtifact(), which requires
// lagrange-code/v0 and writes no cellBindings — copying the full {id, name, source} descriptor is
// what keeps the module/function consistency check meaningful.
async function assembleWasmV1FunctionArtifact({
  images,
  semanticRef,
  moduleRef,
  functionId,
  entry,
  blockPrototypes = {},
} = {}) {
  const semantic = await images.getCodeArtifact(semanticRef.imageId, semanticRef.objectId);
  if (!semantic || semantic.representation !== LAGRANGE_CODE_V1) {
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
  const allClosureSites = moduleDescriptor.closureSites;
  const closureSites = descriptor.closureSiteIndices.map((siteIndex) => {
    if (!Number.isInteger(siteIndex) || siteIndex < 0 || siteIndex >= allClosureSites.length) {
      throw new TypeError(`WASM function closure site index out of range: ${siteIndex}`);
    }
    return allClosureSites[siteIndex];
  });

  const prototypes = normalizePrototypeMap(blockPrototypes);
  const prototypeRefs = [];
  const closurePrototypes = [];
  for (let localIndex = 0; localIndex < closureSites.length; localIndex += 1) {
    const site = closureSites[localIndex];
    const ref = prototypes.get(site.blockId);
    if (!ref) throw new TypeError(`missing WASM Block prototype for semantic block: ${site.blockId}`);
    if (!await images.getBlock(ref.imageId, ref.objectId)) {
      throw new TypeError(`WASM Block prototype not found: ${ref.imageId}/${ref.objectId}`);
    }
    prototypeRefs.push(ref);
    closurePrototypes.push(Object.freeze({
      blockId: site.blockId,
      siteIndex: descriptor.closureSiteIndices[localIndex],
      derivedFromIndex: 2 + prototypeRefs.length - 1,
    }));
    prototypes.delete(site.blockId);
  }
  if (prototypes.size > 0) throw new TypeError(`unused WASM Block prototype: ${prototypes.keys().next().value}`);

  const functionArtifact = await ensureCodeArtifact(images, semanticRef.imageId, {
    id: functionId,
    languageId: semantic.languageId,
    representation: WASM_FUNCTION_V1,
    content: normalizedModuleRef,
    derivedFrom: [semanticRef, normalizedModuleRef, ...prototypeRefs],
    metadata: {
      abi,
      entry: descriptor.entry,
      parameters: descriptor.parameters,
      // Snapshot captures only, exactly as the module descriptor records them.
      captures: descriptor.captures,
      cellBindings: descriptor.cellBindings,
      closurePrototypes,
    },
  });
  return Object.freeze({moduleArtifact, functionArtifact});
}

async function installExecutableTree({
  images,
  moduleArtifact,
  groupPlans,
  rootPlan,
  rootId,
  rootEnvironment,
  rootMetadata,
}) {
  const memberIndex = new Map(groupPlans.map((plan, index) => [plan, index]));
  const nodes = [];
  const moduleRef = objectRef(moduleArtifact.imageId, moduleArtifact.id);

  const install = async (plan) => {
    const blockPrototypes = {};
    for (const childPlan of plan.children) {
      const child = await install(childPlan);
      blockPrototypes[childPlan.semanticBlockId] = objectRef(child.block.imageId, child.block.id);
    }

    const descriptor = moduleFunctionOf(readModuleDescriptor(moduleArtifact), {memberIndex: memberIndex.get(plan)});

    const {functionArtifact} = await assembleWasmV1FunctionArtifact({
      images,
      semanticRef: plan.semanticRef,
      moduleRef,
      functionId: plan.ids.functionId,
      entry: descriptor.entry,
      blockPrototypes,
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
      moduleArtifact,
      functionArtifact,
      block,
      blockPrototypes: Object.freeze({...blockPrototypes}),
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
} = {}) {
  assertServices(images, compilation);
  requiredText(id, 'WASM Block tree id');
  const rootEnvironment = environment === null ? null : normalizeObjectRef(environment, 'root WASM Block environment');
  const rootMetadata = normalizeMetadata(metadata, 'WASM Block tree metadata');
  const rootRef = normalizeObjectRef(semanticRef, 'root semantic code artifact');
  const semanticArtifact = await images.getCodeArtifact(rootRef.imageId, rootRef.objectId);
  if (!semanticArtifact || semanticArtifact.representation !== LAGRANGE_CODE_V1) {
    throw new TypeError(`root semantic code artifact must be ${LAGRANGE_CODE_V1}`);
  }

  const program = validateTree(parseLagrangeCodeV1Program(semanticArtifact));
  const rootPlan = planTree(program, id);
  const groupPlans = flattenPlans(rootPlan);
  // Preflight before any write, so a program neither backend accepts installs nothing.
  preflightEntries(groupPlans.map((plan, memberIndex) => ({
    entry: `run_${memberIndex}`,
    memberIndex,
    program: plan.program,
  })));
  await persistSemanticTree({images, rootRef, rootArtifact: semanticArtifact, rootPlan, rootId: id});

  const group = createCompilationGroup({
    policyId: WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1,
    targetRepresentation: WASM_MODULE_V1,
    members: groupPlans.map((plan) => plan.semanticRef),
    options: {physicalLayout: 'shared-module'},
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

  return Object.freeze({...installed.root, nodes: installed.nodes, group});
}

export {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1,
  assembleWasmV1FunctionArtifact,
  installWasmV1BlockTree,
};
