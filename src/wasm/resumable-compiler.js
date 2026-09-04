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
import {canonicalizeValue, isReference} from '../value/index.js';
import {
  WASM_ENTRY_V0,
  WASM_IMPORT_MODULE,
} from './abi.js';
import {WASM_RESUMABLE_VALUE_HANDLE_ABI_V1} from './resumable-abi.js';

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

function normalizeModuleEntry(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`WASM module entry ${index} must be an object`);
  const entry = requiredText(value.entry, `WASM module entry ${index} name`);
  if (!Number.isInteger(value.memberIndex) || value.memberIndex < 0) {
    throw new TypeError(`WASM module entry ${index} memberIndex must be a non-negative integer`);
  }
  return Object.freeze({entry, memberIndex: value.memberIndex, program: value.program});
}

function collectLiteral(literals, value) {
  const normalized = canonicalizeValue(value);
  if (isReference(normalized)) throw new TypeError('WASM resumable backend does not embed reference literals; use arguments/captures instead');
  const key = JSON.stringify(normalized);
  const existing = literals.keys.get(key);
  if (existing !== undefined) return existing;
  const index = literals.values.length;
  literals.values.push(normalized);
  literals.keys.set(key, index);
  return index;
}

function normalizeCaptureDescriptor(capture, index) {
  exactKeys(capture, ['id', 'name', 'value'], `WASM closure capture ${index}`);
  return Object.freeze({
    id: requiredText(capture.id, `WASM closure capture ${index} id`),
    name: requiredText(capture.name, `WASM closure capture ${index} name`),
  });
}

function newTemp(state) {
  const id = `$t${state.nextTemp}`;
  state.nextTemp += 1;
  return id;
}

function collectSendEffect(state, expression) {
  if (!Array.isArray(expression.arguments)) throw new TypeError('WASM send arguments must be an array');
  const message = canonicalizeValue(expression.message);
  if (isReference(message)) throw new TypeError('WASM resumable backend does not place reference messages in module metadata');
  const siteIndex = state.sendSites.length;
  state.sendSites.push(Object.freeze({
    languageId: requiredText(expression.languageId, 'send languageId'),
    message,
    arity: expression.arguments.length,
  }));
  const effectIndex = state.effects.length;
  state.effects.push({
    kind: 'send',
    siteIndex,
    requestArity: 1 + expression.arguments.length,
    savedCount: 0,
    resumeEntry: null,
  });
  return effectIndex;
}

function collectClosureEffect(state, expression) {
  if (!Array.isArray(expression.captures)) throw new TypeError('WASM nested Block captures must be an array');
  const captures = Object.freeze(expression.captures.map(normalizeCaptureDescriptor));
  const siteIndex = state.closureSites.length;
  state.closureSites.push(Object.freeze({
    blockId: requiredText(expression.blockId, 'WASM semantic block id'),
    captures,
  }));
  const effectIndex = state.effects.length;
  state.effects.push({
    kind: 'closure',
    siteIndex,
    requestArity: captures.length,
    savedCount: 0,
    resumeEntry: null,
  });
  return effectIndex;
}

function lowerSequence(expressions, state, context, index, values, done) {
  if (index >= expressions.length) return done(values);
  return lowerExpression(expressions[index], state, context, (value) =>
    lowerSequence(expressions, state, context, index + 1, [...values, value], done));
}

function lowerExpression(expression, state, context, continuation) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
    throw new TypeError('WASM compiler expression must be an object');
  }

  switch (expression.op) {
    case 'literal': {
      const id = newTemp(state);
      const value = canonicalizeValue(expression.value);
      if (isReference(value)) throw new TypeError('WASM resumable backend does not embed reference literals; use arguments/captures instead');
      return {kind: 'let', id, op: 'literal', value, next: continuation(id)};
    }
    case 'argument': {
      if (!Number.isInteger(expression.index) || expression.index < 0 || expression.index >= context.parameterCount) {
        throw new TypeError(`WASM argument index out of range: ${expression.index}`);
      }
      return continuation(`$argument:${expression.index}`);
    }
    case 'receiver':
      return continuation('$receiver');
    case 'binding': {
      if (!context.captureIds.has(expression.id)) {
        throw new TypeError(`WASM binding is not declared as a capture: ${expression.id}`);
      }
      return continuation(`$capture:${expression.id}`);
    }
    case 'integer-add':
    case 'equals':
      return lowerExpression(expression.left, state, context, (left) =>
        lowerExpression(expression.right, state, context, (right) => {
          const id = newTemp(state);
          return {kind: 'let', id, op: expression.op, left, right, next: continuation(id)};
        }));
    case 'if':
      return lowerExpression(expression.condition, state, context, (condition) => ({
        kind: 'if',
        condition,
        then: lowerExpression(expression.then, state, context, continuation),
        else: lowerExpression(expression.else, state, context, continuation),
      }));
    case 'send':
      return lowerExpression(expression.receiver, state, context, (receiver) =>
        lowerSequence(expression.arguments, state, context, 0, [], (args) => {
          const resultId = newTemp(state);
          return {
            kind: 'effect',
            effectIndex: collectSendEffect(state, expression),
            requestValues: [receiver, ...args],
            resultId,
            next: continuation(resultId),
          };
        }));
    case 'block':
      if (!Array.isArray(expression.captures)) throw new TypeError('WASM nested Block captures must be an array');
      expression.captures.forEach((capture, index) => normalizeCaptureDescriptor(capture, index));
      return lowerSequence(expression.captures.map(({value}) => value), state, context, 0, [], (captures) => {
        const resultId = newTemp(state);
        return {
          kind: 'effect',
          effectIndex: collectClosureEffect(state, expression),
          requestValues: captures,
          resultId,
          next: continuation(resultId),
        };
      });
    default:
      throw new TypeError(`WASM resumable backend does not support semantic op: ${expression.op}`);
  }
}

function directEffectReturn(plan) {
  return plan.next?.kind === 'return' && plan.next.value === plan.resultId;
}

function splitPlan(plan, available, state, rootEntry, segments) {
  switch (plan.kind) {
    case 'let':
      return {
        ...plan,
        next: splitPlan(plan.next, [...available, plan.id], state, rootEntry, segments),
      };
    case 'if':
      return {
        ...plan,
        then: splitPlan(plan.then, [...available], state, rootEntry, segments),
        else: splitPlan(plan.else, [...available], state, rootEntry, segments),
      };
    case 'return':
      return plan;
    case 'effect': {
      const effect = state.effects[plan.effectIndex];
      if (directEffectReturn(plan)) {
        effect.savedCount = 0;
        effect.resumeEntry = null;
        return {
          kind: 'effect-terminal',
          effectIndex: plan.effectIndex,
          requestValues: plan.requestValues,
          savedValues: [],
        };
      }

      const savedValues = [...available];
      const resumeEntry = `${rootEntry}$resume_${plan.effectIndex}`;
      if (state.exportNames.has(resumeEntry)) throw new TypeError(`duplicate WASM resume export entry: ${resumeEntry}`);
      state.exportNames.add(resumeEntry);
      effect.savedCount = savedValues.length;
      effect.resumeEntry = resumeEntry;

      const continuationSegment = {
        entry: resumeEntry,
        parameterVars: [...savedValues, plan.resultId],
        effectIndex: plan.effectIndex,
        root: false,
        plan: null,
      };
      segments.push(continuationSegment);
      continuationSegment.plan = splitPlan(
        plan.next,
        [...savedValues, plan.resultId],
        state,
        rootEntry,
        segments,
      );

      return {
        kind: 'effect-terminal',
        effectIndex: plan.effectIndex,
        requestValues: plan.requestValues,
        savedValues,
      };
    }
    default:
      throw new TypeError(`unknown resumable plan node: ${plan.kind}`);
  }
}

function compilePlan(plan, context) {
  const localGet = (id) => {
    const index = context.env.get(id);
    if (index === undefined) throw new TypeError(`WASM resumable variable is unavailable: ${id}`);
    return [0x20, ...u32(index)];
  };

  const localFor = (id) => {
    const existing = context.env.get(id);
    if (existing !== undefined) return existing;
    const index = context.parameterCount + context.localCount;
    context.localCount += 1;
    context.env.set(id, index);
    return index;
  };

  switch (plan.kind) {
    case 'let': {
      const localIndex = localFor(plan.id);
      let valueCode;
      if (plan.op === 'literal') {
        const literalIndex = collectLiteral(context.literals, plan.value);
        valueCode = [0x41, ...s32(literalIndex), 0x10, ...u32(0)];
      } else if (plan.op === 'integer-add') {
        valueCode = [...localGet(plan.left), ...localGet(plan.right), 0x10, ...u32(1)];
      } else if (plan.op === 'equals') {
        valueCode = [...localGet(plan.left), ...localGet(plan.right), 0x10, ...u32(2)];
      } else {
        throw new TypeError(`unknown resumable pure op: ${plan.op}`);
      }
      return [...valueCode, 0x21, ...u32(localIndex), ...compilePlan(plan.next, context)];
    }
    case 'if':
      return [
        ...localGet(plan.condition),
        0x10, ...u32(3),
        0x04, 0x40,
        ...compilePlan(plan.then, context),
        0x05,
        ...compilePlan(plan.else, context),
        0x0b,
        0x00,
      ];
    case 'effect-terminal':
      return [
        ...plan.requestValues.flatMap(localGet),
        ...plan.savedValues.flatMap(localGet),
        0x10, ...u32(BASE_IMPORT_COUNT + plan.effectIndex),
        0x0f,
      ];
    case 'return':
      return [...localGet(plan.value), 0x0f];
    default:
      throw new TypeError(`unknown resumable plan node: ${plan.kind}`);
  }
}

function compileSegment(segment, literals) {
  const env = new Map(segment.parameterVars.map((name, index) => [name, index]));
  const context = {
    env,
    parameterCount: segment.parameterVars.length,
    localCount: 0,
    literals,
  };
  const instructions = compilePlan(segment.plan, context);
  const localDeclarations = context.localCount === 0
    ? [0x00]
    : [0x01, ...u32(context.localCount), I32];
  const body = [...localDeclarations, ...instructions, 0x00, 0x0b];
  return Object.freeze({
    entry: segment.entry,
    parameterCount: segment.parameterVars.length,
    effectIndex: segment.effectIndex ?? null,
    root: segment.root,
    body: [...u32(body.length), ...body],
  });
}

function prepareEntries(entries) {
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
  return {normalizedEntries, entryNames};
}

function compileResumableWasmModuleEntries(entries) {
  const {normalizedEntries, entryNames} = prepareEntries(entries);
  const state = {
    sendSites: [],
    closureSites: [],
    effects: [],
    nextTemp: 0,
    exportNames: new Set(entryNames),
  };
  const segments = [];
  const functionDescriptors = [];

  for (const entry of normalizedEntries) {
    const program = entry.program;
    if (!program || !Array.isArray(program.parameters) || !Array.isArray(program.captures)) {
      throw new TypeError(`WASM module entry ${entry.entry} program must contain parameters and captures arrays`);
    }
    const captureIds = program.captures.map(({id}, index) => requiredText(id, `WASM capture ${index} id`));
    if (new Set(captureIds).size !== captureIds.length) throw new TypeError(`WASM module entry ${entry.entry} has duplicate capture ids`);
    const context = {
      parameterCount: program.parameters.length,
      captureIds: new Set(captureIds),
    };

    const sendStart = state.sendSites.length;
    const closureStart = state.closureSites.length;
    const plan = lowerExpression(program.body, state, context, (value) => ({kind: 'return', value}));
    const parameterVars = [
      '$receiver',
      ...Array.from({length: program.parameters.length}, (_, index) => `$argument:${index}`),
      ...captureIds.map((id) => `$capture:${id}`),
    ];
    const rootSegment = {
      entry: entry.entry,
      parameterVars,
      effectIndex: null,
      root: true,
      plan: null,
    };
    segments.push(rootSegment);
    rootSegment.plan = splitPlan(plan, [...parameterVars], state, entry.entry, segments);

    functionDescriptors.push(Object.freeze({
      entry: entry.entry,
      memberIndex: entry.memberIndex,
      parameters: program.parameters.length,
      captures: Object.freeze(captureIds),
      sendSiteIndices: Object.freeze(Array.from(
        {length: state.sendSites.length - sendStart},
        (_, offset) => sendStart + offset,
      )),
      closureSiteIndices: Object.freeze(Array.from(
        {length: state.closureSites.length - closureStart},
        (_, offset) => closureStart + offset,
      )),
    }));
  }

  const literals = {values: [], keys: new Map()};
  const compiledSegments = segments.map((segment) => compileSegment(segment, literals));
  const effectSites = Object.freeze(state.effects.map((effect) => Object.freeze({
    kind: effect.kind,
    siteIndex: effect.siteIndex,
    requestArity: effect.requestArity,
    savedCount: effect.savedCount,
    resumeEntry: effect.resumeEntry,
  })));
  const continuations = Object.freeze(compiledSegments
    .filter(({root}) => !root)
    .map(({entry, effectIndex, parameterCount}) => Object.freeze({
      entry,
      effectIndex,
      parameters: parameterCount,
    })));

  const effectTypes = effectSites.map(({requestArity, savedCount}) =>
    functionType(Array.from({length: requestArity + savedCount}, () => I32), [I32]));
  const segmentTypes = compiledSegments.map(({parameterCount}) =>
    functionType(Array.from({length: parameterCount}, () => I32), [I32]));
  const types = vector([
    functionType([I32], [I32]),
    functionType([I32, I32], [I32]),
    ...effectTypes,
    ...segmentTypes,
  ]);

  const effectImports = effectSites.map((effect, effectIndex) => {
    const name = effect.kind === 'send'
      ? `send_site_${effect.siteIndex}`
      : `make_block_site_${effect.siteIndex}`;
    return functionImport(WASM_IMPORT_MODULE, name, 2 + effectIndex);
  });
  const imports = vector([
    functionImport(WASM_IMPORT_MODULE, 'literal', 0),
    functionImport(WASM_IMPORT_MODULE, 'integer_add', 1),
    functionImport(WASM_IMPORT_MODULE, 'equals', 1),
    functionImport(WASM_IMPORT_MODULE, 'is_true', 0),
    ...effectImports,
  ]);

  const firstSegmentTypeIndex = 2 + effectSites.length;
  const functions = vector(compiledSegments.map((_, index) => [...u32(firstSegmentTypeIndex + index)]));
  const firstFunctionIndex = BASE_IMPORT_COUNT + effectSites.length;
  const exports = vector(compiledSegments.map(({entry}, index) => functionExport(entry, firstFunctionIndex + index)));
  const code = vector(compiledSegments.map(({body}) => body));

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
    effectSites,
    continuations,
    functions: Object.freeze(functionDescriptors),
  });
}

function compileResumableWasmModule(program) {
  const compiled = compileResumableWasmModuleEntries([{entry: WASM_ENTRY_V0, memberIndex: 0, program}]);
  const descriptor = compiled.functions[0];
  return Object.freeze({
    ...compiled,
    parameterCount: descriptor.parameters,
    captureIds: descriptor.captures,
  });
}

const lagrangeCodeV0ToResumableWasmModuleCompiler = Object.freeze({
  async compile({source}) {
    if (source.representation !== LAGRANGE_CODE_V0) throw new TypeError(`source must be ${LAGRANGE_CODE_V0}`);
    const program = parseLagrangeCodeProgram(source);
    const compiled = compileResumableWasmModule(program);
    return Object.freeze({
      languageId: source.languageId,
      bytes: compiled.bytes,
      contract: {
        abi: WASM_RESUMABLE_VALUE_HANDLE_ABI_V1,
        literals: compiled.literals,
        functions: compiled.functions,
        sendSites: compiled.sendSites,
        closureSites: compiled.closureSites,
        effectSites: compiled.effectSites,
      },
      metadata: {
        continuations: compiled.continuations,
        semanticRepresentation: LAGRANGE_CODE_V0,
      },
    });
  },
});

const lagrangeCodeGroupToResumableWasmModuleCompiler = Object.freeze({
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
    const compiled = compileResumableWasmModuleEntries(entries);
    return Object.freeze({
      bytes: compiled.bytes,
      contract: {
        abi: WASM_RESUMABLE_VALUE_HANDLE_ABI_V1,
        literals: compiled.literals,
        functions: compiled.functions,
        sendSites: compiled.sendSites,
        closureSites: compiled.closureSites,
        effectSites: compiled.effectSites,
      },
      metadata: {
        continuations: compiled.continuations,
        semanticRepresentation: LAGRANGE_CODE_V0,
        groupPolicyId: group.policyId,
        physicalLayout: 'shared-module',
      },
    });
  },
});

function isWasmTailEffectRestrictionError(error) {
  if (!(error instanceof TypeError)) return false;
  return error.message.includes('message sends only in tail position')
    || error.message.includes('nested Block creation only in tail position');
}

export {
  compileResumableWasmModule,
  compileResumableWasmModuleEntries,
  isWasmTailEffectRestrictionError,
  lagrangeCodeGroupToResumableWasmModuleCompiler,
  lagrangeCodeV0ToResumableWasmModuleCompiler,
};
