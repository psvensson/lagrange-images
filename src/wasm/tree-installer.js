import {randomUUID} from 'node:crypto';
import {
  LAGRANGE_CODE_V0,
  normalizeLagrangeCodeProgram,
  parseLagrangeCodeProgram,
} from '../code/lagrange-code-v0.js';
import {WASM_MODULE_V1} from '../code/wasm-artifacts.js';
import {createCompilationGroup} from '../compilation/group.js';
import {normalizeMetadata} from '../object/model.js';
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/index.js';
import {compileWasmFunctionArtifact, compileWasmModule} from './compiler.js';

const WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0 = 'wasm-nested-block-tree/v0';

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
  if (!compilation || typeof compilation.compileArtifact !== 'function') {
    throw new TypeError('compilation service is required');
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

function validateTree(program, seen = new Set()) {
  const normalized = normalizeLagrangeCodeProgram(program);
  compileWasmModule(normalized);
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
    moduleId: `${rootId}:wasm:module:${key}`,
    functionId: `${rootId}:wasm:function:${key}`,
    blockId: `${rootId}:wasm:prototype:${key}`,
  });
}

async function installNode({
  images,
  compilation,
  semanticRef,
  semanticArtifact,
  program,
  rootId,
  semanticBlockId = null,
  environment = null,
  metadata = {},
  nodes,
}) {
  const ids = nodeIds(rootId, semanticBlockId);
  const blockPrototypes = {};

  for (const nested of directNestedBlocks(program.body)) {
    const childIds = nodeIds(rootId, nested.blockId);
    const childProgram = normalizeLagrangeCodeProgram(nested.program);
    const childSemanticArtifact = await images.putCodeArtifact(semanticRef.imageId, {
      id: childIds.semanticId,
      languageId: semanticArtifact.languageId,
      representation: LAGRANGE_CODE_V0,
      content: textValue(JSON.stringify(childProgram)),
      derivedFrom: [semanticRef],
      metadata: {
        semanticBlockId: nested.blockId,
        wasmTreeRootId: rootId,
      },
    });
    const childSemanticRef = objectRef(childSemanticArtifact.imageId, childSemanticArtifact.id);
    const child = await installNode({
      images,
      compilation,
      semanticRef: childSemanticRef,
      semanticArtifact: childSemanticArtifact,
      program: childProgram,
      rootId,
      semanticBlockId: nested.blockId,
      nodes,
    });
    blockPrototypes[nested.blockId] = objectRef(child.block.imageId, child.block.id);
  }

  const {moduleArtifact, functionArtifact} = await compileWasmFunctionArtifact({
    images,
    compilation,
    semanticRef,
    moduleId: ids.moduleId,
    functionId: ids.functionId,
    blockPrototypes,
  });

  const isRoot = semanticBlockId === null;
  const block = await images.putBlock(semanticRef.imageId, {
    id: ids.blockId,
    code: objectRef(functionArtifact.imageId, functionArtifact.id),
    environment: isRoot ? environment : null,
    metadata: isRoot
      ? metadata
      : {prototype: true, semanticBlockId, wasmTreeRootId: rootId},
  });

  const node = Object.freeze({
    semanticBlockId,
    semanticArtifact,
    moduleArtifact,
    functionArtifact,
    block,
    blockPrototypes: Object.freeze({...blockPrototypes}),
  });
  nodes.push(node);
  return node;
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
  if (!semanticArtifact || semanticArtifact.representation !== LAGRANGE_CODE_V0) {
    throw new TypeError(`root semantic code artifact must be ${LAGRANGE_CODE_V0}`);
  }

  const program = validateTree(parseLagrangeCodeProgram(semanticArtifact));
  const nodes = [];
  const root = await installNode({
    images,
    compilation,
    semanticRef: rootRef,
    semanticArtifact,
    program,
    rootId: id,
    environment: rootEnvironment,
    metadata: rootMetadata,
    nodes,
  });
  const frozenNodes = Object.freeze([...nodes]);
  const groupNodes = [
    root,
    ...nodes.filter((node) => node !== root).sort((left, right) =>
      String(left.semanticBlockId).localeCompare(String(right.semanticBlockId))),
  ];
  const group = createCompilationGroup({
    policyId: WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
    targetRepresentation: WASM_MODULE_V1,
    members: groupNodes.map((node) => objectRef(node.semanticArtifact.imageId, node.semanticArtifact.id)),
    options: {physicalLayout: 'one-module-per-member'},
  });

  return Object.freeze({
    ...root,
    nodes: frozenNodes,
    group,
  });
}

export {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
  installWasmBlockTree,
};
