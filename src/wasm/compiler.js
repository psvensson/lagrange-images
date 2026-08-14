import {LAGRANGE_CODE_V0, parseLagrangeCodeProgram} from '../code/lagrange-code-v0.js';
import {WASM_FUNCTION_V1, WASM_MODULE_V1} from '../code/wasm-artifacts.js';
import {bytesValue, canonicalizeValue, isObjectRef, isReference, objectRef} from '../value/index.js';
import {
  WASM_ENTRY_V0,
  WASM_IMPORT_MODULE,
  WASM_VALUE_HANDLE_ABI_V0,
} from './abi.js';

const I32 = 0x7f;
const FUNC = 0x60;
const BASE_IMPORT_COUNT = 4;

function u32(value) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError('u32 LEB value must be a non-negative integer');
  const out = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    out.push(byte);
  } while (current !== 0);
  return out;
}

function s32(value) {
  if (!Number.isInteger(value)) throw new TypeError('s32 LEB value must be an integer');
  const out = [];
  let current = value | 0;
  while (true) {
    let byte = current & 0x7f;
    current >>= 7;
    const sign = byte & 0x40;
    const done = (current === 0 && sign === 0) || (current === -1 && sign !== 0);
    if (!done) byte |= 0x80;
    out.push(byte);
    if (done) return out;
  }
}

function text(value) {
  const bytes = [...new TextEncoder().encode(value)];
  return [...u32(bytes.length), ...bytes];
}

function vector(entries) {
  return [...u32(entries.length), ...entries.flat()];
}

function section(id, payload) {
  return [id, ...u32(payload.length), ...payload];
}

function functionType(parameters, results) {
  return [FUNC, ...vector(parameters.map((value) => [value])), ...vector(results.map((value) => [value]))];
}

function functionImport(module, name, typeIndex) {
  return [...text(module), ...text(name), 0x00, ...u32(typeIndex)];
}

function functionExport(name, functionIndex) {
  return [...text(name), 0x00, ...u32(functionIndex)];
}

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

function compileWasmModule(program) {
  const parameterCount = program.parameters.length;
  const captureIds = program.captures.map(({id}) => id);
  const captureIndex = new Map(captureIds.map((id, index) => [id, index]));
  const literals = {values: [], keys: new Map()};
  const state = {sendSites: [], closureSites: [], effects: [], effectIndex: new WeakMap()};
  analyzeEffects(program.body, state, {tail: true});
  const context = {...state, parameterCount, captureIndex, literals};
  const bodyExpression = compileExpression(program.body, context);

  const entryParameters = 1 + parameterCount + captureIds.length;
  const effectTypes = state.effects.map(({arity}) => functionType(Array.from({length: arity}, () => I32), [I32]));
  const entryTypeIndex = 2 + effectTypes.length;
  const types = vector([
    functionType([I32], [I32]),
    functionType([I32, I32], [I32]),
    ...effectTypes,
    functionType(Array.from({length: entryParameters}, () => I32), [I32]),
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
  const functions = vector([[...u32(entryTypeIndex)]]);
  const exports = vector([functionExport(WASM_ENTRY_V0, BASE_IMPORT_COUNT + state.effects.length)]);
  const functionBody = [0x00, ...bodyExpression, 0x0b];
  const code = vector([[...u32(functionBody.length), ...functionBody]]);

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
    parameterCount,
    captureIds: Object.freeze(captureIds),
  });
}

const lagrangeCodeV0ToWasmModuleCompiler = Object.freeze({
  async compile({source}) {
    if (source.representation !== LAGRANGE_CODE_V0) throw new TypeError(`source must be ${LAGRANGE_CODE_V0}`);
    const program = parseLagrangeCodeProgram(source);
    const compiled = compileWasmModule(program);
    return Object.freeze({
      languageId: source.languageId,
      content: bytesValue(compiled.bytes),
      metadata: {
        abi: WASM_VALUE_HANDLE_ABI_V0,
        entry: WASM_ENTRY_V0,
        parameters: compiled.parameterCount,
        captures: compiled.captureIds,
        literals: compiled.literals,
        sendSites: compiled.sendSites,
        closureSites: compiled.closureSites,
        semanticRepresentation: LAGRANGE_CODE_V0,
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

async function compileWasmFunctionArtifact({
  images,
  compilation,
  semanticRef,
  moduleId,
  functionId,
  blockPrototypes = {},
} = {}) {
  if (!images || typeof images.getCodeArtifact !== 'function' || typeof images.putCodeArtifact !== 'function' || typeof images.getBlock !== 'function') {
    throw new TypeError('images service with code artifact and Block access is required');
  }
  if (!compilation || typeof compilation.compileArtifact !== 'function') throw new TypeError('compilation service is required');
  const semantic = await images.getCodeArtifact(semanticRef.imageId, semanticRef.objectId);
  if (!semantic || semantic.representation !== LAGRANGE_CODE_V0) throw new TypeError(`semanticRef must reference ${LAGRANGE_CODE_V0}`);
  const moduleArtifact = await compilation.compileArtifact(semanticRef, {targetRepresentation: WASM_MODULE_V1, id: moduleId});
  const metadata = moduleArtifact.metadata ?? {};
  const closureSites = Array.isArray(metadata.closureSites) ? metadata.closureSites : [];
  const prototypes = normalizePrototypeMap(blockPrototypes);
  const prototypeRefs = [];
  const closurePrototypes = [];
  for (const site of closureSites) {
    const ref = prototypes.get(site.blockId);
    if (!ref) throw new TypeError(`missing WASM Block prototype for semantic block: ${site.blockId}`);
    if (!await images.getBlock(ref.imageId, ref.objectId)) {
      throw new TypeError(`WASM Block prototype not found: ${ref.imageId}/${ref.objectId}`);
    }
    prototypeRefs.push(ref);
    closurePrototypes.push(Object.freeze({blockId: site.blockId, derivedFromIndex: 2 + prototypeRefs.length - 1}));
    prototypes.delete(site.blockId);
  }
  if (prototypes.size > 0) throw new TypeError(`unused WASM Block prototype: ${prototypes.keys().next().value}`);

  const moduleRef = objectRef(moduleArtifact.imageId, moduleArtifact.id);
  const functionArtifact = await images.putCodeArtifact(semanticRef.imageId, {
    id: functionId,
    languageId: semantic.languageId,
    representation: WASM_FUNCTION_V1,
    content: moduleRef,
    derivedFrom: [semanticRef, moduleRef, ...prototypeRefs],
    metadata: {
      abi: metadata.abi,
      entry: metadata.entry,
      parameters: metadata.parameters,
      captures: metadata.captures,
      closurePrototypes,
    },
  });
  return Object.freeze({moduleArtifact, functionArtifact});
}

export {compileWasmFunctionArtifact, compileWasmModule, lagrangeCodeV0ToWasmModuleCompiler};
