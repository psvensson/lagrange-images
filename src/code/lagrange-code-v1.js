import {
  VALUE_KIND,
  canonicalizeValue,
  isObjectRef,
  textValue,
} from '../value/index.js';
import {NEUTRAL_EXPRESSION_V1} from '../execution/neutral-expression-v1.js';

// lagrange-code/v1 adds mutable lexical semantics: temporaries, statement sequences, assignment,
// and captures that must resolve to a live cell rather than a snapshot.
//
// v0 is frozen. Its grammar is closed — `exactKeys(program, ['parameters','captures','body'])` and
// a switch that throws on any unknown op — so extending it in place would silently change the
// meaning of a representation string already stored in artifacts. A program that needs none of
// these semantics still compiles to exactly its v0 artifact.
//
// This module duplicates v0's shared-op normalization rather than sharing a core with it. That is
// normally the wrong trade, but v0 is frozen by decision, so the copies cannot drift.
const LAGRANGE_CODE_V1 = 'lagrange-code/v1';

// A capture either carries a durable snapshot of a value, or requires the live execution cell of
// the binding it names. `cell` deliberately has no value: see ADR 0043 decision 5.
const CAPTURE_MODES = Object.freeze(['snapshot', 'cell']);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(', ')}`);
  }
  return value;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeBindingDescriptor(value, label) {
  exactKeys(value, ['id', 'name'], label);
  return Object.freeze({id: requiredText(value.id, `${label} id`), name: requiredText(value.name, `${label} name`)});
}

function normalizeCaptureDescriptor(value, label) {
  exactKeys(value, ['id', 'mode', 'name'], label);
  const mode = requiredText(value.mode, `${label} mode`);
  if (!CAPTURE_MODES.includes(mode)) {
    throw new TypeError(`${label} mode must be one of ${CAPTURE_MODES.join(', ')}`);
  }
  return Object.freeze({
    id: requiredText(value.id, `${label} id`),
    name: requiredText(value.name, `${label} name`),
    mode,
  });
}

function assertDistinctIds(descriptors, label) {
  const seen = new Set();
  for (const {id} of descriptors) {
    if (seen.has(id)) throw new TypeError(`${label} declares duplicate binding id ${id}`);
    seen.add(id);
  }
}

function normalizeProgram(program) {
  exactKeys(program, ['parameters', 'temporaries', 'captures', 'body'], 'lagrange code v1 program');
  for (const key of ['parameters', 'temporaries', 'captures']) {
    if (!Array.isArray(program[key])) throw new TypeError(`lagrange code v1 ${key} must be an array`);
  }
  const parameters = Object.freeze(program.parameters.map((value, index) => normalizeBindingDescriptor(value, `parameter ${index}`)));
  const temporaries = Object.freeze(program.temporaries.map((value, index) => normalizeBindingDescriptor(value, `temporary ${index}`)));
  const captures = Object.freeze(program.captures.map((value, index) => normalizeCaptureDescriptor(value, `capture ${index}`)));
  assertDistinctIds([...parameters, ...temporaries, ...captures], 'lagrange code v1 program');
  return Object.freeze({parameters, temporaries, captures, body: program.body});
}

function parseLagrangeCodeV1Program(code) {
  if (!code || code.representation !== LAGRANGE_CODE_V1) throw new TypeError(`code artifact is not ${LAGRANGE_CODE_V1}`);
  if (code.content?.kind !== VALUE_KIND.TEXT) throw new TypeError(`${LAGRANGE_CODE_V1} content must be a text Value`);
  let program;
  try {
    program = JSON.parse(code.content.value);
  } catch (error) {
    throw new TypeError(`${LAGRANGE_CODE_V1} content must contain valid JSON`, {cause: error});
  }
  return normalizeProgram(program);
}

function normalizePrototypeMap(blockPrototypes) {
  if (!blockPrototypes || typeof blockPrototypes !== 'object' || Array.isArray(blockPrototypes)) {
    throw new TypeError('blockPrototypes must be an object keyed by semantic block id');
  }
  const result = new Map();
  for (const [blockId, ref] of Object.entries(blockPrototypes)) {
    requiredText(blockId, 'block prototype id');
    const normalized = canonicalizeValue(ref);
    if (!isObjectRef(normalized)) throw new TypeError(`block prototype ${blockId} must be an unpinned object ref`);
    result.set(blockId, normalized);
  }
  return result;
}

function lowerExpression(expression, prototypes) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
    throw new TypeError('lagrange code v1 expression must be an object');
  }
  switch (expression.op) {
    case 'literal':
      exactKeys(expression, ['op', 'value'], 'literal expression');
      return Object.freeze({op: 'literal', value: canonicalizeValue(expression.value)});
    case 'argument':
      exactKeys(expression, ['op', 'index'], 'argument expression');
      if (!Number.isInteger(expression.index) || expression.index < 0) throw new TypeError('argument index must be a non-negative integer');
      return Object.freeze({op: 'argument', index: expression.index});
    case 'receiver':
      exactKeys(expression, ['op'], 'receiver expression');
      return Object.freeze({op: 'receiver'});
    // A read. Which runtime cell or durable snapshot this static id resolves to is
    // ActivationExecutor's business, not the representation's.
    case 'binding':
      exactKeys(expression, ['op', 'id'], 'binding expression');
      return Object.freeze({op: 'binding', id: requiredText(expression.id, 'binding id')});
    // Assignment. Evaluates to the written value, so `a := b := 1` works.
    case 'binding-write':
      exactKeys(expression, ['op', 'id', 'value'], 'binding-write expression');
      return Object.freeze({
        op: 'binding-write',
        id: requiredText(expression.id, 'binding-write id'),
        value: lowerExpression(expression.value, prototypes),
      });
    case 'sequence': {
      exactKeys(expression, ['op', 'statements'], 'sequence expression');
      if (!Array.isArray(expression.statements) || expression.statements.length === 0) {
        throw new TypeError('sequence statements must be a non-empty array');
      }
      return Object.freeze({
        op: 'sequence',
        statements: Object.freeze(expression.statements.map((entry) => lowerExpression(entry, prototypes))),
      });
    }
    case 'send': {
      exactKeys(expression, ['op', 'languageId', 'receiver', 'message', 'arguments'], 'send expression');
      if (!Array.isArray(expression.arguments)) throw new TypeError('send arguments must be an array');
      return Object.freeze({
        op: 'send',
        languageId: requiredText(expression.languageId, 'send languageId'),
        receiver: lowerExpression(expression.receiver, prototypes),
        message: canonicalizeValue(expression.message),
        arguments: Object.freeze(expression.arguments.map((entry) => lowerExpression(entry, prototypes))),
      });
    }
    case 'integer-add':
    case 'equals': {
      exactKeys(expression, ['op', 'left', 'right'], `${expression.op} expression`);
      return Object.freeze({
        op: expression.op,
        left: lowerExpression(expression.left, prototypes),
        right: lowerExpression(expression.right, prototypes),
      });
    }
    case 'if':
      exactKeys(expression, ['op', 'condition', 'then', 'else'], 'if expression');
      return Object.freeze({
        op: 'if',
        condition: lowerExpression(expression.condition, prototypes),
        then: lowerExpression(expression.then, prototypes),
        else: lowerExpression(expression.else, prototypes),
      });
    case 'block': {
      exactKeys(expression, ['op', 'blockId', 'captures', 'program'], 'block expression');
      const blockId = requiredText(expression.blockId, 'semantic block id');
      normalizeProgram(expression.program);
      if (!Array.isArray(expression.captures)) throw new TypeError('block captures must be an array');
      const prototype = prototypes.get(blockId);
      if (!prototype) throw new TypeError(`missing executable prototype for semantic block: ${blockId}`);
      const captures = Object.freeze(expression.captures.map((capture, index) => {
        const label = `block capture ${index}`;
        const mode = requiredText(capture?.mode, `${label} mode`);
        if (mode === 'cell') {
          // No value expression at all: a live-cell capture has nothing to snapshot, which is
          // precisely what stops a later invocation restarting from an old value.
          exactKeys(capture, ['id', 'mode', 'name'], label);
          return Object.freeze({
            id: requiredText(capture.id, `${label} id`),
            name: requiredText(capture.name, `${label} name`),
            mode: 'cell',
          });
        }
        if (mode !== 'snapshot') throw new TypeError(`${label} mode must be one of ${CAPTURE_MODES.join(', ')}`);
        exactKeys(capture, ['id', 'mode', 'name', 'value'], label);
        return Object.freeze({
          id: requiredText(capture.id, `${label} id`),
          name: requiredText(capture.name, `${label} name`),
          mode: 'snapshot',
          value: lowerExpression(capture.value, prototypes),
        });
      }));
      return Object.freeze({op: 'make-block', prototype, captures});
    }
    default:
      throw new TypeError(`unknown ${LAGRANGE_CODE_V1} expression op: ${expression.op}`);
  }
}

function lowerLagrangeCodeV1(program, {blockPrototypes = {}} = {}) {
  const normalized = normalizeProgram(program);
  const prototypes = normalizePrototypeMap(blockPrototypes);
  return Object.freeze({
    parameters: normalized.parameters.length,
    // The executor declares a cell per temporary when it allocates this activation's frame.
    temporaries: normalized.temporaries,
    body: lowerExpression(normalized.body, prototypes),
  });
}

const lagrangeCodeV1ToNeutralExpressionCompiler = Object.freeze({
  async compile({source, options}) {
    const program = parseLagrangeCodeV1Program(source);
    const lowered = lowerLagrangeCodeV1(program, options ?? {});
    return Object.freeze({
      languageId: source.languageId,
      content: textValue(JSON.stringify(lowered)),
      metadata: {semanticRepresentation: LAGRANGE_CODE_V1, executableRepresentation: NEUTRAL_EXPRESSION_V1},
    });
  },
});

export {
  CAPTURE_MODES,
  LAGRANGE_CODE_V1,
  lagrangeCodeV1ToNeutralExpressionCompiler,
  lowerLagrangeCodeV1,
  normalizeProgram as normalizeLagrangeCodeV1Program,
  parseLagrangeCodeV1Program,
};
