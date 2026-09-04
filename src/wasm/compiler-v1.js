import {LAGRANGE_CODE_V1, parseLagrangeCodeV1Program} from '../code/lagrange-code-v1.js';
import {canonicalizeValue, isReference} from '../value/index.js';
import {WASM_ENTRY_V0, WASM_IMPORT_MODULE, WASM_VALUE_HANDLE_ABI_V1} from './abi.js';
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

// The Lagrange-WASM backend for lagrange-code/v1, per ADR 0043 decision 10.
//
// The v0 backend is untouched. Its ABI resolves every capture to a Value handle before entry and
// gives make_block_site exactly one handle per capture; neither can express a live cell, so this is
// a new ABI rather than a widening of that one.
//
// The load-bearing finding: **a shared cell cannot be a WASM local**. The closure that writes it is
// a separate activation with its own frame, so the cell must stay host-side and be reached through
// synchronous imports. Locals would give each activation its own copy, which is exactly the
// snapshot semantics ADR 0043 exists to remove.
const WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1 = 'wasm-nested-block-tree/v1';

// literal, integer_add, equals, is_true, cell_get, cell_set. Effect imports follow.
const BASE_IMPORT_COUNT_V1 = 6;
const CELL_GET_IMPORT = 4;
const CELL_SET_IMPORT = 5;

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
  if (isReference(normalized)) throw new TypeError('WASM backend v1 does not embed reference literals; use arguments/captures instead');
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
  if (isReference(message)) throw new TypeError('WASM backend v1 does not place reference messages in module metadata');
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

// A closure site records each capture's disposition, and its WASM arity counts snapshot captures
// only. A cell capture consumes no handle position at all, so there is literally nowhere for a
// snapshot of a mutable cell to enter the closure.
function normalizeClosureCapture(capture, index) {
  const label = `WASM closure capture ${index}`;
  const mode = requiredText(capture?.mode, `${label} mode`);
  if (mode === 'cell') {
    exactKeys(capture, ['id', 'mode', 'name'], label);
    return Object.freeze({
      id: requiredText(capture.id, `${label} id`),
      name: requiredText(capture.name, `${label} name`),
      mode: 'cell',
    });
  }
  if (mode !== 'snapshot') throw new TypeError(`${label} mode must be snapshot or cell`);
  exactKeys(capture, ['id', 'mode', 'name', 'value'], label);
  return Object.freeze({
    id: requiredText(capture.id, `${label} id`),
    name: requiredText(capture.name, `${label} name`),
    mode: 'snapshot',
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
  state.effects.push(Object.freeze({
    kind: 'closure',
    kindIndex,
    arity: captures.filter(({mode}) => mode === 'snapshot').length,
  }));
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
    // Cell reads and writes are ordinary synchronous calls, never effects: they neither suspend nor
    // re-enter, so they impose no tail-position restriction of their own.
    case 'binding-write':
      analyzeEffects(expression.value, state);
      return;
    case 'sequence': {
      const last = expression.statements.length - 1;
      expression.statements.forEach((statement, index) => {
        analyzeEffects(statement, state, {tail: tail && index === last});
      });
      return;
    }
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
      if (!tail) throw new WasmV1TailEffectRestrictionError('message sends');
      if (!Array.isArray(expression.arguments)) throw new TypeError('WASM send arguments must be an array');
      analyzeEffects(expression.receiver, state);
      for (const argument of expression.arguments) analyzeEffects(argument, state);
      collectSendSite(state, expression);
      return;
    case 'make-block':
    case 'block': {
      if (!tail) throw new WasmV1TailEffectRestrictionError('nested Block creation');
      if (!Array.isArray(expression.captures)) throw new TypeError('WASM nested Block captures must be an array');
      for (const capture of expression.captures) {
        if (capture?.mode === 'snapshot') analyzeEffects(capture.value, state);
      }
      collectClosureSite(state, expression);
      return;
    }
    default:
      throw new TypeError(`WASM backend v1 does not support semantic op: ${expression.op}`);
  }
}

// The simple backend handles only tail-position effects; anything else is the resumable backend's
// job. Mirrors the v0 arrangement so the caller's fallback logic is unchanged in shape.
class WasmV1TailEffectRestrictionError extends TypeError {
  constructor(what) {
    super(`WASM backend v1 supports ${what} only in tail position`);
    this.name = 'WasmV1TailEffectRestrictionError';
  }
}

function isWasmV1TailEffectRestrictionError(error) {
  return error instanceof WasmV1TailEffectRestrictionError;
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
      // A cell read goes through the host by slot index; a snapshot capture is still an entry
      // parameter, exactly as in v0.
      const cellSlot = context.cellSlots.get(expression.id);
      if (cellSlot !== undefined) return [0x41, ...s32(cellSlot), 0x10, ...u32(CELL_GET_IMPORT)];
      const captureIndex = context.captureIndex.get(expression.id);
      if (captureIndex === undefined) throw new TypeError(`WASM binding is neither a cell nor a snapshot capture: ${expression.id}`);
      return [0x20, ...u32(1 + context.parameterCount + captureIndex)];
    }
    case 'binding-write': {
      const cellSlot = context.cellSlots.get(expression.id);
      if (cellSlot === undefined) throw new TypeError(`WASM assignment target is not a cell: ${expression.id}`);
      return [
        0x41, ...s32(cellSlot),
        ...compileExpression(expression.value, context),
        0x10, ...u32(CELL_SET_IMPORT),
      ];
    }
    // Each statement but the last is evaluated for effect and dropped, so the sequence leaves
    // exactly one handle on the stack.
    case 'sequence': {
      const last = expression.statements.length - 1;
      return expression.statements.flatMap((statement, index) => (
        index === last
          ? compileExpression(statement, context)
          : [...compileExpression(statement, context), 0x1a]
      ));
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
        0x10, ...u32(BASE_IMPORT_COUNT_V1 + context.effectIndex.get(expression)),
      ];
    case 'make-block':
    case 'block':
      return [
        ...expression.captures
          .filter(({mode}) => mode === 'snapshot')
          .flatMap((capture) => compileExpression(capture.value, context)),
        0x10, ...u32(BASE_IMPORT_COUNT_V1 + context.effectIndex.get(expression)),
      ];
    default:
      throw new TypeError(`WASM backend v1 does not support semantic op: ${expression.op}`);
  }
}

// The function-local cell table. Slot indices are meaningful only through the descriptor of the
// function being activated: a shared module holds several semantic Blocks whose static binding ids
// all start at `root:`, so a module-global table would confuse unrelated slots that happen to
// share a name.
//
// Each entry says where its cell comes from, because the two sources have opposite lifetimes: a
// temporary is declared by this activation, while a cell capture already exists in the frame that
// declared it. Declaring a captured cell here would shadow it with a fresh empty one — the snapshot
// bug in another costume — so the distinction is part of the metadata rather than re-derived.
function cellBindingsOf(program) {
  const bindings = [];
  const slots = new Map();
  const declare = ({id, name}, source) => {
    if (slots.has(id)) return;
    slots.set(id, bindings.length);
    bindings.push(Object.freeze({id, name, source}));
  };
  for (const temporary of program.temporaries) declare(temporary, 'temporary');
  for (const capture of program.captures) {
    if (capture.mode === 'cell') declare(capture, 'capture');
  }
  return {bindings: Object.freeze(bindings), slots};
}

function normalizeModuleEntry(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`WASM module entry ${index} must be an object`);
  const entry = requiredText(value.entry, `WASM module entry ${index} name`);
  if (!Number.isInteger(value.memberIndex) || value.memberIndex < 0) {
    throw new TypeError(`WASM module entry ${index} memberIndex must be a non-negative integer`);
  }
  return Object.freeze({entry, memberIndex: value.memberIndex, program: value.program});
}

function compileWasmV1ModuleEntries(entries) {
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
    if (!program || !Array.isArray(program.parameters) || !Array.isArray(program.captures) || !Array.isArray(program.temporaries)) {
      throw new TypeError(`WASM module entry ${entry.entry} program must contain parameters, temporaries and captures arrays`);
    }
    const sendStart = state.sendSites.length;
    const closureStart = state.closureSites.length;
    analyzeEffects(program.body, state, {tail: true});
    // Only snapshot captures become entry parameters. A cell capture is reached through the host
    // cell table, so it has no handle position anywhere in the ABI.
    const snapshotCaptures = program.captures.filter(({mode}) => mode !== 'cell');
    const captureIds = snapshotCaptures.map(({id}) => id);
    const {bindings: cellBindings, slots: cellSlots} = cellBindingsOf(program);
    plans.push({
      entry: entry.entry,
      memberIndex: entry.memberIndex,
      program,
      parameterCount: program.parameters.length,
      captureIds,
      captureIndex: new Map(captureIds.map((id, index) => [id, index])),
      cellBindings,
      cellSlots,
      sendSiteIndices: Array.from({length: state.sendSites.length - sendStart}, (_, offset) => sendStart + offset),
      closureSiteIndices: Array.from({length: state.closureSites.length - closureStart}, (_, offset) => closureStart + offset),
    });
  }

  const bodies = plans.map((plan) => compileExpression(plan.program.body, {
    ...state,
    parameterCount: plan.parameterCount,
    captureIndex: plan.captureIndex,
    cellSlots: plan.cellSlots,
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
    // Synchronous and cell-only. They resolve through the host's ActivationCells and raise if the
    // slot is not a cell, so no durable-environment lookup can answer them.
    functionImport(WASM_IMPORT_MODULE, 'cell_get', 0),
    functionImport(WASM_IMPORT_MODULE, 'cell_set', 1),
    ...effectImports,
  ]);
  const firstFunctionTypeIndex = 2 + state.effects.length;
  const functions = vector(plans.map((_, index) => [...u32(firstFunctionTypeIndex + index)]));
  const firstFunctionIndex = BASE_IMPORT_COUNT_V1 + state.effects.length;
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
    cellBindings: plan.cellBindings,
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

function compileWasmV1Module(program) {
  const compiled = compileWasmV1ModuleEntries([{entry: WASM_ENTRY_V0, memberIndex: 0, program}]);
  const descriptor = compiled.functions[0];
  return Object.freeze({
    ...compiled,
    parameterCount: descriptor.parameters,
    captureIds: descriptor.captures,
    cellBindings: descriptor.cellBindings,
  });
}

const lagrangeCodeV1ToWasmModuleCompiler = Object.freeze({
  async compile({source}) {
    if (source.representation !== LAGRANGE_CODE_V1) throw new TypeError(`source must be ${LAGRANGE_CODE_V1}`);
    const compiled = compileWasmV1Module(parseLagrangeCodeV1Program(source));
    return Object.freeze({
      languageId: source.languageId,
      bytes: compiled.bytes,
      contract: {
        abi: WASM_VALUE_HANDLE_ABI_V1,
        literals: compiled.literals,
        functions: compiled.functions,
        sendSites: compiled.sendSites,
        closureSites: compiled.closureSites,
        effectSites: [],
      },
      metadata: {
        semanticRepresentation: LAGRANGE_CODE_V1,
      },
    });
  },
});

const lagrangeCodeV1GroupToWasmModuleCompiler = Object.freeze({
  async compile({group, members}) {
    if (group.policyId !== WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1) {
      throw new TypeError(`unsupported WASM compilation group policy: ${group.policyId}`);
    }
    if (group.options?.physicalLayout !== 'shared-module') {
      throw new TypeError('WASM shared-module compiler requires physicalLayout=shared-module');
    }
    const entries = members.map((source, memberIndex) => {
      if (source.representation !== LAGRANGE_CODE_V1) {
        throw new TypeError(`WASM group member ${memberIndex} must be ${LAGRANGE_CODE_V1}`);
      }
      return {
        entry: `run_${memberIndex}`,
        memberIndex,
        program: parseLagrangeCodeV1Program(source),
      };
    });
    const compiled = compileWasmV1ModuleEntries(entries);
    return Object.freeze({
      bytes: compiled.bytes,
      contract: {
        abi: WASM_VALUE_HANDLE_ABI_V1,
        literals: compiled.literals,
        functions: compiled.functions,
        sendSites: compiled.sendSites,
        closureSites: compiled.closureSites,
        effectSites: [],
      },
      metadata: {
        semanticRepresentation: LAGRANGE_CODE_V1,
        groupPolicyId: group.policyId,
        physicalLayout: 'shared-module',
      },
    });
  },
});

export {
  BASE_IMPORT_COUNT_V1,
  WASM_NESTED_BLOCK_TREE_GROUP_POLICY_V1,
  WasmV1TailEffectRestrictionError,
  compileWasmV1Module,
  compileWasmV1ModuleEntries,
  isWasmV1TailEffectRestrictionError,
  lagrangeCodeV1GroupToWasmModuleCompiler,
  lagrangeCodeV1ToWasmModuleCompiler,
};