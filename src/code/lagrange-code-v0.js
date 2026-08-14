import {
  VALUE_KIND,
  canonicalizeValue,
  isObjectRef,
  textValue,
} from '../value/index.js';

const LAGRANGE_CODE_V0 = 'lagrange-code/v0';

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

function normalizeProgram(program) {
  exactKeys(program, ['parameters', 'captures', 'body'], 'lagrange code program');
  if (!Array.isArray(program.parameters)) throw new TypeError('lagrange code parameters must be an array');
  if (!Array.isArray(program.captures)) throw new TypeError('lagrange code captures must be an array');
  const parameters = Object.freeze(program.parameters.map((value, index) => normalizeBindingDescriptor(value, `parameter ${index}`)));
  const captures = Object.freeze(program.captures.map((value, index) => normalizeBindingDescriptor(value, `capture ${index}`)));
  return Object.freeze({parameters, captures, body: program.body});
}

function parseLagrangeCodeProgram(code) {
  if (!code || code.representation !== LAGRANGE_CODE_V0) throw new TypeError(`code artifact is not ${LAGRANGE_CODE_V0}`);
  if (code.content?.kind !== VALUE_KIND.TEXT) throw new TypeError(`${LAGRANGE_CODE_V0} content must be a text Value`);
  let program;
  try {
    program = JSON.parse(code.content.value);
  } catch (error) {
    throw new TypeError(`${LAGRANGE_CODE_V0} content must contain valid JSON`, {cause: error});
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
    throw new TypeError('lagrange code expression must be an object');
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
    case 'binding':
      exactKeys(expression, ['op', 'id'], 'binding expression');
      return Object.freeze({op: 'binding', id: requiredText(expression.id, 'binding id')});
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
        exactKeys(capture, ['id', 'name', 'value'], `block capture ${index}`);
        return Object.freeze({
          id: requiredText(capture.id, `block capture ${index} id`),
          name: requiredText(capture.name, `block capture ${index} name`),
          value: lowerExpression(capture.value, prototypes),
        });
      }));
      return Object.freeze({op: 'make-block', prototype, captures});
    }
    default:
      throw new TypeError(`unknown ${LAGRANGE_CODE_V0} expression op: ${expression.op}`);
  }
}

function lowerLagrangeCodeV0(program, {blockPrototypes = {}} = {}) {
  const normalized = normalizeProgram(program);
  const prototypes = normalizePrototypeMap(blockPrototypes);
  return Object.freeze({
    parameters: normalized.parameters.length,
    body: lowerExpression(normalized.body, prototypes),
  });
}

const lagrangeCodeV0ToNeutralExpressionCompiler = Object.freeze({
  async compile({source, options}) {
    const program = parseLagrangeCodeProgram(source);
    const lowered = lowerLagrangeCodeV0(program, options ?? {});
    return Object.freeze({
      languageId: source.languageId,
      content: textValue(JSON.stringify(lowered)),
      metadata: {semanticRepresentation: LAGRANGE_CODE_V0},
    });
  },
});

export {
  LAGRANGE_CODE_V0,
  lagrangeCodeV0ToNeutralExpressionCompiler,
  lowerLagrangeCodeV0,
  normalizeProgram as normalizeLagrangeCodeProgram,
  parseLagrangeCodeProgram,
};
