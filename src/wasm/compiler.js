import {ensureCodeArtifact} from '../graph/ensure-records.js';
import {
  I32,
  functionExport,
  functionImport,
  functionType,
  s32,
  section,
  u32,
  vector,
} from './encoding.js';
import {LAGRANGE_CODE_V0, parseLagrangeCodeProgram} from '../code/lagrange-code-v0.js';
import {WASM_FUNCTION_V1} from '../code/wasm-artifacts.js';
import {WASM_MODULE_V2, moduleFunctionOf, readModuleDescriptor, soleModuleEntry} from './module-contract.js';
import {canonicalizeValue, isObjectRef, isReference, objectRef} from '../value/index.js';
import {
  WASM_ENTRY_V0,
  WASM_IMPORT_MODULE,
  WASM_VALUE_HANDLE_ABI_V0,
} from './abi.js';

const BASE_IMPORT_COUNT = 4;
const WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0 = 'wasm-nested-block-tree/v0';









function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(', ')}`);
  }
  return value;
}

function collectLiteral(literals, value) {
  const normalized = canonicalizeValue(value);
  if (isReference(normalized)) throw new TypeError('WASM backend v0 does not embed reference literals; use arguments/captures instead');
  const key = JSON.stringify(normalized);
  const existing = literals.keys.get(key);
  if (existing !== undefined) return existing;
  const index = literals.values.length;
  literals.values.push(normalized);
  literals.keys.set(key, index);
  return index;
}

function collectSendSite(state, expression) {
  const message = canonicalizeValue(expression.message);
  if (isReference(message)) throw new TypeError('WASM backend v0 does not place reference messages in module metadata');
  const kindIndex = state.sendSites.length;
  state.sendSites.push(Object.freeze({
    languageId: requiredText(expression.languageId, 'send languageId'),
    message,
    arity: expression.arguments.length,
  }));
  const effectIndex = state.effects.length;
  state.effects.push(Object.freeze({kind: 'send', kindIndex, arity: 1 + expression.arguments.length}));
  state.effectIndex.set(expression, effectIndex);
}

function normalizeClosureCapture(capture, index) {
  exactKeys(capture, ['id', 'name', 'value'], `WASM closure capture ${index}`);
  return Object.freeze({
    id: requiredText(capture.id, `WASM closure capture ${index} id`),
    name: requiredText(capture.name, `WASM closure capture ${index} name`),
  });
}

function collectClosureSite(state, expression) {
  if (!Array.isArray(expression.captures)) throw new TypeError('WASM nested Block captures must be an array');
  const captures = Object.freeze(expression.captures.map(normalizeClosureCapture));
  const kindIndex = state.closureSites.length;
  state.closureSites.push(Object.freeze({
    blockId: requiredText(expression.blockId, 'WASM semantic block id'),
    captures,
  }));
  const effectIndex = state.effects.length;
  state.effects.push(Object.freeze({kind: 'closure', kindIndex, arity: captures.length}));
  state.effectIndex.set(expression, effectIndex);
}

function analyzeEffects(expression, state, {tail = false} = {}) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) throw new TypeError('WASM compiler expression must be an object');
  switch (expression.op) {
    case 'literal':
    case 'argument':
    case 'receiver':
    case 'binding':
      return;
    case 'integer-add':
    case 'equals':
      analyzeEffects(expression.left, state);
      analyzeEffects(expression.right, state);
      return;
    case 'if':
      analyzeEffects(expression.condition, state);
      analyzeEffects(expression.then, state, {tail});
      analyzeEffects(expression.else, state, {tail});
      return;
    case 'send':
      if (!tail) throw new TypeError('WASM backend v0 supports message sends only in tail position');
      if (!Array.isArray(expression.arguments)) throw new TypeError('WASM send arguments must be an array');
      analyzeEffects(expression.receiver, state);
      for (const argument of expression.arguments) analyzeEffects(argument, state);
      collectSendSite(state, expression);
      return;
    case 'block':
      if (!tail) throw new TypeError('WASM backend v0 supports nested Block creation only in tail position');
      if (!Array.isArray(expression.captures)) throw new TypeError('WASM nested Block captures must be an array');
      expression.captures.forEach((capture, index) => {
        normalizeClosureCapture(capture, index);
        analyzeEffects(capture.value, state);
      });
      collectClosureSite(state, expression);
      return;
    default:
      throw new TypeError(`WASM backend v0 does not support semantic op: ${expression.op}`);
  }
}

function compileExpression(expression, context) {
  switch (expression.op) {
    case 'literal': {
      const index = collectLiteral(context.literals, expression.value);
      return [0x41, ...s32(index), 0x10, ...u32(0)];
    }
    case 'argument': {
      if (!Number.isInteger(expression.index) || expression.index < 0 || expression.index >= context.parameterCount) {
        throw new TypeError(`WASM argument index out of range: ${expression.index}`);
      }
      return [0x20, ...u32(1 + expression.index)];
    }
    case 'receiver':
      return [0x20, ...u32(0)];
    case 'binding': {
      const captureIndex = context.captureIndex.get(expression.id);
      if (captureIndex === undefined) throw new TypeError(`WASM binding is not declared as a capture: ${expression.id}`);
      return [0x20, ...u32(1 + context.parameterCount + captureIndex)];
    }
    case 'integer-add':
      return [...compileExpression(expression.left, context), ...compileExpression(expression.right, context), 0x10, ...u32(1)];
    case 'equals':
      return [...compileExpression(expression.left, context), ...compileExpression(expression.right, context), 0x10, ...u32(2)];
    case 'if':
      return [
        ...compileExpression(expression.condition, context),
        0x10, ...u32(3),
        0x04, I32,
        ...compileExpression(expression.then, context),
        0x05,
        ...compileExpression(expression.else, context),
        0x0b,
      ];
    case 'send':
      return [
        ...compileExpression(expression.receiver, context),
        ...expression.arguments.flatMap((argument) => compileExpression(argument, context)),
        0x10, ...u32(BASE_IMPORT_COUNT + context.effectIndex.get(expression)),
      ];
    case 'block':
      return [
        ...expression.captures.flatMap((capture) => compileExpression(capture.value, context)),
        0x10, ...u32(BASE_IMPORT_COUNT + context.effectIndex.get(expression)),
      ];
    default:
      throw new TypeError(`WASM backend v0 does not support semantic op: ${expression.op}`);
  }
}

function normalizeModuleEntry(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`WASM module entry ${index} must be an object`);
  const entry = requiredText(value.entry, `WASM module entry ${index} name`);
  if (!Number.isInteger(value.memberIndex) || value.memberIndex < 0) {
    throw new TypeError(`WASM module entry ${index} memberIndex must be a non-negative integer`);
  }
  return Object.freeze({entry, memberIndex: value.memberIndex, program: value.program});
}

function compileWasmModuleEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('WASM module entries must be a non-empty array');
  const normalizedEntries = entries.map(normalizeModuleEntry);
  const entryNames = new Set();
  const memberIndices = new Set();
  for (const entry of normalizedEntries) {
    if (entryNames.has(entry.entry)) throw new TypeError(`duplicate WASM export entry: ${entry.entry}`);
    if (memberIndices.has(entry.memberIndex)) throw new TypeError(`duplicate WASM member index: ${entry.memberIndex}`);
    entryNames.add(entry.entry);
    memberIndices.add(entry.memberIndex);
  }

  const literals = {values: [], keys: new Map()};
  const state = {sendSites: [], closureSites: [], effects: [], effectIndex: new WeakMap()};
  const plans = [];

  for (const entry of normalizedEntries) {
    const program = entry.program;
    if (!program || !Array.isArray(program.parameters) || !Array.isArray(program.captures)) {
      throw new TypeError(`WASM module entry ${entry.entry} program must contain parameters and captures arrays`);
    }
    const sendStart = state.sendSites.length;
    const closureStart = state.closureSites.length;
    analyzeEffects(program.body, state, {tail: true});
    const parameterCount = program.parameters.length;
    const captureIds = program.captures.map(({id}) => id);
    const captureIndex = new Map(captureIds.map((id, captureIndexValue) => [id, captureIndexValue]));
    plans.push({
      entry: entry.entry,
      memberIndex: entry.memberIndex,
      program,
      parameterCount,
      captureIds,
      captureIndex,
      sendSiteIndices: Array.from({length: state.sendSites.length - sendStart}, (_, offset) => sendStart + offset),
      closureSiteIndices: Array.from({length: state.closureSites.length - closureStart}, (_, offset) => closureStart + offset),
    });
  }

  const bodies = plans.map((plan) => compileExpression(plan.program.body, {
    ...state,
    parameterCount: plan.parameterCount,
    captureIndex: plan.captureIndex,
    literals,
  }));

  const effectTypes = state.effects.map(({arity}) => functionType(Array.from({length: arity}, () => I32), [I32]));
  const functionTypes = plans.map((plan) =>
    functionType(Array.from({length: 1 + plan.parameterCount + plan.captureIds.length}, () => I32), [I32]));
  const types = vector([
    functionType([I32], [I32]),
    functionType([I32, I32], [I32]),
    ...effectTypes,
    ...functionTypes,
  ]);
  const effectImports = state.effects.map((effect, effectIndex) => {
    const name = effect.kind === 'send'
      ? `send_site_${effect.kindIndex}`
      : `make_block_site_${effect.kindIndex}`;
    return functionImport(WASM_IMPORT_MODULE, name, 2 + effectIndex);
  });
  const imports = vector([
    functionImport(WASM_IMPORT_MODULE, 'literal', 0),
    functionImport(WASM_IMPORT_MODULE, 'integer_add', 1),
    functionImport(WASM_IMPORT_MODULE, 'equals', 1),
    functionImport(WASM_IMPORT_MODULE, 'is_true', 0),
    ...effectImports,
  ]);
  const firstFunctionTypeIndex = 2 + state.effects.length;
  const functions = vector(plans.map((_, index) => [...u32(firstFunctionTypeIndex + index)]));
  const firstFunctionIndex = BASE_IMPORT_COUNT + state.effects.length;
  const exports = vector(plans.map((plan, index) => functionExport(plan.entry, firstFunctionIndex + index)));
  const code = vector(bodies.map((bodyExpression) => {
    const functionBody = [0x00, ...bodyExpression, 0x0b];
    return [...u32(functionBody.length), ...functionBody];
  }));

  const functionDescriptors = Object.freeze(plans.map((plan) => Object.freeze({
    entry: plan.entry,
    memberIndex: plan.memberIndex,
    parameters: plan.parameterCount,
    captures: Object.freeze(plan.captureIds),
    sendSiteIndices: Object.freeze(plan.sendSiteIndices),
    closureSiteIndices: Object.freeze(plan.closureSiteIndices),
  })));

  return Object.freeze({
    bytes: new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00,
      ...section(1, types),
      ...section(2, imports),
      ...section(3, functions),
      ...section(7, exports),
      ...section(10, code),
    ]),
    literals: Object.freeze(literals.values),
    sendSites: Object.freeze(state.sendSites),
    closureSites: Object.freeze(state.closureSites),
    functions: functionDescriptors,
  });
}

function compileWasmModule(program) {
  const compiled = compileWasmModuleEntries([{entry: WASM_ENTRY_V0, memberIndex: 0, program}]);
  const descriptor = compiled.functions[0];
  return Object.freeze({
    ...compiled,
    parameterCount: descriptor.parameters,
    captureIds: descriptor.captures,
  });
}

const lagrangeCodeV0ToWasmModuleCompiler = Object.freeze({
  async compile({source}) {
    if (source.representation !== LAGRANGE_CODE_V0) throw new TypeError(`source must be ${LAGRANGE_CODE_V0}`);
    const program = parseLagrangeCodeProgram(source);
    const compiled = compileWasmModule(program);
    return Object.freeze({
      languageId: source.languageId,
      bytes: compiled.bytes,
      contract: {
        abi: WASM_VALUE_HANDLE_ABI_V0,
        literals: compiled.literals,
        functions: compiled.functions,
        sendSites: compiled.sendSites,
        closureSites: compiled.closureSites,
        effectSites: [],
      },
      metadata: {
        semanticRepresentation: LAGRANGE_CODE_V0,
      },
    });
  },
});

const lagrangeCodeGroupToWasmModuleCompiler = Object.freeze({
  async compile({group, members}) {
    if (group.policyId !== WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0) {
      throw new TypeError(`unsupported WASM compilation group policy: ${group.policyId}`);
    }
    if (group.options?.physicalLayout !== 'shared-module') {
      throw new TypeError('WASM shared-module compiler requires physicalLayout=shared-module');
    }
    const entries = members.map((source, memberIndex) => {
      if (source.representation !== LAGRANGE_CODE_V0) {
        throw new TypeError(`WASM group member ${memberIndex} must be ${LAGRANGE_CODE_V0}`);
      }
      return {
        entry: `run_${memberIndex}`,
        memberIndex,
        program: parseLagrangeCodeProgram(source),
      };
    });
    const compiled = compileWasmModuleEntries(entries);
    return Object.freeze({
      bytes: compiled.bytes,
      contract: {
        abi: WASM_VALUE_HANDLE_ABI_V0,
        literals: compiled.literals,
        functions: compiled.functions,
        sendSites: compiled.sendSites,
        closureSites: compiled.closureSites,
        effectSites: [],
      },
      metadata: {
        semanticRepresentation: LAGRANGE_CODE_V0,
        groupPolicyId: group.policyId,
        physicalLayout: 'shared-module',
      },
    });
  },
});

function normalizePrototypeMap(blockPrototypes) {
  if (!blockPrototypes || typeof blockPrototypes !== 'object' || Array.isArray(blockPrototypes)) {
    throw new TypeError('blockPrototypes must be an object keyed by semantic block id');
  }
  const result = new Map();
  for (const [blockId, value] of Object.entries(blockPrototypes)) {
    requiredText(blockId, 'block prototype id');
    const ref = canonicalizeValue(value);
    if (!isObjectRef(ref)) throw new TypeError(`block prototype ${blockId} must be an unpinned object ref`);
    result.set(blockId, ref);
  }
  return result;
}

// The module's function table is read through the canonical accessor (either durable version);
// this is the compile-side counterpart of the executors' readModuleContract and never touches the
// representation schema itself.
function moduleFunctionDescriptor(moduleArtifact, entry) {
  return moduleFunctionOf(readModuleDescriptor(moduleArtifact), {entry});
}

function describeWasmFunctionArtifact({
  functionId,
  languageId,
  semanticRef,
  moduleRef,
  moduleArtifact,
  descriptor,
  closurePrototypes,
  prototypeRefs = [],
}) {
  return Object.freeze({
    id: functionId,
    languageId,
    representation: WASM_FUNCTION_V1,
    content: moduleRef,
    derivedFrom: [semanticRef, moduleRef, ...prototypeRefs],
    metadata: {
      abi: readModuleDescriptor(moduleArtifact).abi,
      entry: descriptor.entry,
      parameters: descriptor.parameters,
      captures: descriptor.captures,
      closurePrototypes,
    },
  });
}

async function assembleWasmFunctionArtifact({
  images,
  semanticRef,
  moduleRef,
  functionId,
  entry,
  blockPrototypes = {},
} = {}) {
  if (!images || typeof images.getCodeArtifact !== 'function' || typeof images.putCodeArtifact !== 'function' || typeof images.getBlock !== 'function') {
    throw new TypeError('images service with code artifact and Block access is required');
  }
  const semantic = await images.getCodeArtifact(semanticRef.imageId, semanticRef.objectId);
  if (!semantic || semantic.representation !== LAGRANGE_CODE_V0) throw new TypeError(`semanticRef must reference ${LAGRANGE_CODE_V0}`);
  const normalizedModuleRef = canonicalizeValue(moduleRef);
  if (!isObjectRef(normalizedModuleRef)) throw new TypeError('moduleRef must be an unpinned object ref');
  const moduleArtifact = await images.getCodeArtifact(normalizedModuleRef.imageId, normalizedModuleRef.objectId);
  if (!moduleArtifact) throw new TypeError('moduleRef must reference a WASM module artifact');
  const moduleDescriptor = readModuleDescriptor(moduleArtifact);
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

  // The complete wasm-function/v1 contract, in one place. A caller deciding whether an existing
  // artifact may be reused compares against this same description, so "exact" cannot drift apart
  // from what assembly would actually write.
  const input = describeWasmFunctionArtifact({
    functionId,
    languageId: semantic.languageId,
    semanticRef,
    moduleRef: normalizedModuleRef,
    moduleArtifact,
    descriptor,
    closurePrototypes,
    prototypeRefs,
  });
  // Ensure-exact-or-create, like every other deterministic-id write in this substrate. The function
  // id is derived, so a commit whose acknowledgement was lost would otherwise make an identical
  // retry collide with the artifact it had just written. `ensureWasmFunction` performs a stricter
  // describe-based check before calling here; the nested-tree path calls this directly and has no
  // such caller-side guard.
  const functionArtifact = await ensureCodeArtifact(images, semanticRef.imageId, input);
  return Object.freeze({moduleArtifact, functionArtifact});
}

async function compileWasmFunctionArtifact({
  images,
  compilation,
  semanticRef,
  moduleId,
  functionId,
  blockPrototypes = {},
} = {}) {
  if (!compilation || typeof compilation.compileArtifact !== 'function') throw new TypeError('compilation service is required');
  const moduleArtifact = await compilation.compileArtifact(semanticRef, {
    targetRepresentation: WASM_MODULE_V2,
    id: moduleId,
  });
  return await assembleWasmFunctionArtifact({
    images,
    semanticRef,
    moduleRef: objectRef(moduleArtifact.imageId, moduleArtifact.id),
    functionId,
    entry: soleModuleEntry(readModuleDescriptor(moduleArtifact)),
    blockPrototypes,
  });
}

export {
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V0,
  assembleWasmFunctionArtifact,
  describeWasmFunctionArtifact,
  moduleFunctionDescriptor,
  compileWasmFunctionArtifact,
  compileWasmModule,
  compileWasmModuleEntries,
  lagrangeCodeGroupToWasmModuleCompiler,
  lagrangeCodeV0ToWasmModuleCompiler,
};
