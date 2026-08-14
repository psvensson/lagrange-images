import {LAGRANGE_CODE_V0, parseLagrangeCodeProgram} from '../code/lagrange-code-v0.js';
import {WASM_MODULE_V1} from '../code/wasm-artifacts.js';
import {bytesValue, canonicalizeValue, objectRef} from '../value/index.js';
import {
  WASM_ENTRY_V0,
  WASM_IMPORT_MODULE,
  WASM_VALUE_HANDLE_ABI_V0,
} from './abi.js';

const I32 = 0x7f;
const FUNC = 0x60;

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

function collectLiteral(literals, value) {
  const normalized = canonicalizeValue(value);
  const key = JSON.stringify(normalized);
  const existing = literals.keys.get(key);
  if (existing !== undefined) return existing;
  const index = literals.values.length;
  literals.values.push(normalized);
  literals.keys.set(key, index);
  return index;
}

function compileExpression(expression, context) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
    throw new TypeError('WASM compiler expression must be an object');
  }
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
      return [
        ...compileExpression(expression.left, context),
        ...compileExpression(expression.right, context),
        0x10, ...u32(1),
      ];
    case 'equals':
      return [
        ...compileExpression(expression.left, context),
        ...compileExpression(expression.right, context),
        0x10, ...u32(2),
      ];
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
      throw new TypeError('WASM backend v0 does not yet support message sends');
    case 'block':
      throw new TypeError('WASM backend v0 does not yet support nested Block creation');
    default:
      throw new TypeError(`WASM backend v0 does not support semantic op: ${expression.op}`);
  }
}

function compileWasmModule(program) {
  const parameterCount = program.parameters.length;
  const captureIds = program.captures.map(({id}) => id);
  const captureIndex = new Map(captureIds.map((id, index) => [id, index]));
  const literals = {values: [], keys: new Map()};
  const bodyExpression = compileExpression(program.body, {
    parameterCount,
    captureIndex,
    literals,
  });

  const entryParameters = 1 + parameterCount + captureIds.length;
  const types = vector([
    functionType([I32], [I32]),
    functionType([I32, I32], [I32]),
    functionType([I32], [I32]),
    functionType(Array.from({length: entryParameters}, () => I32), [I32]),
  ]);
  const imports = vector([
    functionImport(WASM_IMPORT_MODULE, 'literal', 0),
    functionImport(WASM_IMPORT_MODULE, 'integer_add', 1),
    functionImport(WASM_IMPORT_MODULE, 'equals', 1),
    functionImport(WASM_IMPORT_MODULE, 'is_true', 2),
  ]);
  const functions = vector([[...u32(3)]]);
  const exports = vector([functionExport(WASM_ENTRY_V0, 4)]);
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
        semanticRepresentation: LAGRANGE_CODE_V0,
      },
    });
  },
});

async function compileWasmFunctionArtifact({
  images,
  compilation,
  semanticRef,
  moduleId,
  functionId,
} = {}) {
  if (!images || typeof images.getCodeArtifact !== 'function' || typeof images.putCodeArtifact !== 'function') {
    throw new TypeError('images service with code artifact access is required');
  }
  if (!compilation || typeof compilation.compileArtifact !== 'function') {
    throw new TypeError('compilation service is required');
  }
  const semantic = await images.getCodeArtifact(semanticRef.imageId, semanticRef.objectId);
  if (!semantic || semantic.representation !== LAGRANGE_CODE_V0) throw new TypeError(`semanticRef must reference ${LAGRANGE_CODE_V0}`);
  const moduleArtifact = await compilation.compileArtifact(semanticRef, {
    targetRepresentation: WASM_MODULE_V1,
    id: moduleId,
  });
  const metadata = moduleArtifact.metadata ?? {};
  const functionArtifact = await images.putCodeArtifact(semanticRef.imageId, {
    id: functionId,
    languageId: semantic.languageId,
    representation: 'wasm-function/v1',
    content: objectRef(moduleArtifact.imageId, moduleArtifact.id),
    derivedFrom: [semanticRef, objectRef(moduleArtifact.imageId, moduleArtifact.id)],
    metadata: {
      abi: metadata.abi,
      entry: metadata.entry,
      parameters: metadata.parameters,
      captures: metadata.captures,
    },
  });
  return Object.freeze({moduleArtifact, functionArtifact});
}

export {
  compileWasmFunctionArtifact,
  compileWasmModule,
  lagrangeCodeV0ToWasmModuleCompiler,
};
