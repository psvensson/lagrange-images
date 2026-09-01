import {ensureBlock, ensureCodeArtifact} from '../graph/ensure-records.js';
import {uuid as randomUUID} from '../support/default-crypto.js';
import {
  LAGRANGE_CODE_V0,
  normalizeLagrangeCodeProgram,
  parseLagrangeCodeProgram,
} from '../code/lagrange-code-v0.js';
import {WASM_MODULE_V1} from '../code/wasm-artifacts.js';
import {createCompilationGroup} from '../compilation/group.js';
import {normalizeMetadata} from '../object/model.js';
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/index.js';
import {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
  assembleWasmFunctionArtifact,
  compileWasmModule,
  compileWasmModuleEntries,
} from './compiler.js';
import {LAGRANGE_CODE_V1} from '../code/lagrange-code-v1.js';
import {installWasmV1BlockTree} from './tree-installer-v1.js';
import {
  compileResumableWasmModule,
  compileResumableWasmModuleEntries,
  isWasmTailEffectRestrictionError,
} from './resumable-compiler.js';

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

function directNestedBlocks(expression, result = []) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return result;
  switch (expression.op) {
    case 'block':
      result.push(expression);
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
  if (typeof blockId !== 'string' || blockId.length === 0) throw new TypeError('semantic block id must be non-empty text');
  return Buffer.from(blockId, 'utf8').toString('base64url');
}

function preflightProgram(program) {
  try {
    return compileWasmModule(program);
  } catch (error) {
    if (!isWasmTailEffectRestrictionError(error)) throw error;
    return compileResumableWasmModule(program);
  }
}

function preflightEntries(entries) {
  try {
    return compileWasmModuleEntries(entries);
  } catch (error) {
    if (!isWasmTailEffectRestrictionError(error)) throw error;
    return compileResumableWasmModuleEntries(entries);
  }
}

function validateTree(program, seen = new Set()) {
  const normalized = normalizeLagrangeCodeProgram(program);
  preflightProgram(normalized);
  for (const nested of directNestedBlocks(normalized.body)) {
    if (typeof nested.blockId !== 'string' || nested.blockId.length === 0) {
      throw new TypeError('nested semantic block id must be non-empty text');
    }
    if (seen.has(nested.blockId)) throw new TypeError(`duplicate semantic block id in WASM tree: ${nested.blockId}`);
    seen.add(nested.blockId);
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
    program: normalizeLagrangeCodeProgram(program),
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

function preflightSharedModule(groupPlans) {
  preflightEntries(groupPlans.map((plan, memberIndex) => ({
    entry: `run_${memberIndex}`,
    memberIndex,
    program: plan.program,
  })));
}

async function persistSemanticTree({images, rootRef, rootArtifact, rootPlan, rootId}) {
  rootPlan.semanticRef = rootRef;
  rootPlan.semanticArtifact = rootArtifact;

  const persistChildren = async (parentPlan) => {
    for (const child of parentPlan.children) {
      const childArtifact = await ensureCodeArtifact(images, parentPlan.semanticRef.imageId, {
        id: child.ids.semanticId,
        languageId: parentPlan.semanticArtifact.languageId,
        representation: LAGRANGE_CODE_V0,
        content: textValue(JSON.stringify(child.program)),
        derivedFrom: [parentPlan.semanticRef],
        metadata: {
          semanticBlockId: child.semanticBlockId,
          wasmTreeRootId: rootId,
        },
      });
      child.semanticArtifact = childArtifact;
      child.semanticRef = objectRef(childArtifact.imageId, childArtifact.id);
      await persistChildren(child);
    }
  };

  await persistChildren(rootPlan);
}

function descriptorForMember(moduleArtifact, memberIndex) {
  const functions = moduleArtifact.metadata?.functions;
  if (!Array.isArray(functions)) throw new TypeError('shared WASM module must describe exported functions');
  const descriptor = functions.find((entry) => entry?.memberIndex === memberIndex);
  if (!descriptor) throw new TypeError(`shared WASM module has no entry for group member ${memberIndex}`);
  return descriptor;
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

    const descriptor = descriptorForMember(moduleArtifact, memberIndex.get(plan));
    const {functionArtifact} = await assembleWasmFunctionArtifact({
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

async function installWasmBlockTree({
  images,
  compilation,
  semanticRef,
  id = randomUUID(),
  environment = null,
  metadata = {},
} = {}) {
  assertServices(images, compilation);
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('WASM Block tree id must be non-empty text');
  const rootEnvironment = environment === null ? null : normalizeObjectRef(environment, 'root WASM Block environment');
  const rootMetadata = normalizeMetadata(metadata, 'WASM Block tree metadata');
  const rootRef = normalizeObjectRef(semanticRef, 'root semantic code artifact');
  const semanticArtifact = await images.getCodeArtifact(rootRef.imageId, rootRef.objectId);
  if (!semanticArtifact) throw new TypeError(`root semantic code artifact must be ${LAGRANGE_CODE_V0}`);
  // Dispatch on the root representation, before anything is written. The v1 path is a sibling
  // implementation rather than a widening of this one: that decision was already made when the
  // semantic artifact was created, so there is no second "does this need mutable state?" analysis.
  if (semanticArtifact.representation === LAGRANGE_CODE_V1) {
    return await installWasmV1BlockTree({images, compilation, semanticRef, id, environment, metadata});
  }
  if (semanticArtifact.representation !== LAGRANGE_CODE_V0) {
    throw new TypeError(`root semantic code artifact must be ${LAGRANGE_CODE_V0} or ${LAGRANGE_CODE_V1}`);
  }

  const program = validateTree(parseLagrangeCodeProgram(semanticArtifact));
  const rootPlan = planTree(program, id);
  const groupPlans = flattenPlans(rootPlan);
  preflightSharedModule(groupPlans);
  await persistSemanticTree({images, rootRef, rootArtifact: semanticArtifact, rootPlan, rootId: id});

  const group = createCompilationGroup({
    policyId: WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
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

  return Object.freeze({
    ...installed.root,
    nodes: installed.nodes,
    group,
  });
}

export {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
  installWasmBlockTree,
};
