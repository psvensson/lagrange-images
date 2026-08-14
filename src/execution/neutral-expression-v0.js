import {
  VALUE_KIND,
  booleanValue,
  canonicalizeValue,
  integerValue,
} from '../value/index.js';

const NEUTRAL_EXPRESSION_V0 = 'neutral-expression/v0';
const MAX_EXPRESSION_DEPTH = 256;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(', ')}`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function parseProgram(code) {
  if (code.content?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(`${NEUTRAL_EXPRESSION_V0} code content must be a text Value`);
  }
  let program;
  try {
    program = JSON.parse(code.content.value);
  } catch (error) {
    throw new TypeError(`${NEUTRAL_EXPRESSION_V0} code content must contain valid JSON`, {cause: error});
  }
  exactKeys(program, ['parameters', 'body'], 'neutral expression program');
  nonNegativeInteger(program.parameters, 'neutral expression parameter count');
  return program;
}

function sameValue(left, right) {
  return JSON.stringify(canonicalizeValue(left)) === JSON.stringify(canonicalizeValue(right));
}

async function evaluate(expression, frame, context, depth = 0) {
  if (depth > MAX_EXPRESSION_DEPTH) throw new TypeError('neutral expression depth limit exceeded');
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
    throw new TypeError('neutral expression must be an object');
  }

  switch (expression.op) {
    case 'literal': {
      exactKeys(expression, ['op', 'value'], 'literal expression');
      return canonicalizeValue(expression.value);
    }
    case 'argument': {
      exactKeys(expression, ['op', 'index'], 'argument expression');
      const index = nonNegativeInteger(expression.index, 'argument index');
      if (index >= frame.arguments.length) throw new TypeError(`argument index out of range: ${index}`);
      return frame.arguments[index];
    }
    case 'receiver': {
      exactKeys(expression, ['op'], 'receiver expression');
      if (frame.receiver === null) throw new TypeError('activation has no receiver');
      return frame.receiver;
    }
    case 'binding': {
      exactKeys(expression, ['op', 'id'], 'binding expression');
      if (typeof expression.id !== 'string' || expression.id.length === 0) {
        throw new TypeError('binding expression id must be a non-empty string');
      }
      return await context.lookupBinding(expression.id);
    }
    case 'integer-add': {
      exactKeys(expression, ['op', 'left', 'right'], 'integer-add expression');
      const left = await evaluate(expression.left, frame, context, depth + 1);
      const right = await evaluate(expression.right, frame, context, depth + 1);
      if (left.kind !== VALUE_KIND.INTEGER || right.kind !== VALUE_KIND.INTEGER) {
        throw new TypeError('integer-add operands must be integer Values');
      }
      return integerValue(BigInt(left.value) + BigInt(right.value));
    }
    case 'equals': {
      exactKeys(expression, ['op', 'left', 'right'], 'equals expression');
      const left = await evaluate(expression.left, frame, context, depth + 1);
      const right = await evaluate(expression.right, frame, context, depth + 1);
      return booleanValue(sameValue(left, right));
    }
    case 'if': {
      exactKeys(expression, ['op', 'condition', 'then', 'else'], 'if expression');
      const condition = await evaluate(expression.condition, frame, context, depth + 1);
      if (condition.kind !== VALUE_KIND.BOOLEAN) throw new TypeError('if condition must be a boolean Value');
      return await evaluate(condition.value ? expression.then : expression.else, frame, context, depth + 1);
    }
    default:
      throw new TypeError(`unknown neutral expression op: ${expression.op}`);
  }
}

const neutralExpressionV0Executor = Object.freeze({
  async execute({activation, code}, context) {
    const program = parseProgram(code);
    if (activation.arguments.length !== program.parameters) {
      throw new TypeError(
        `activation expected ${program.parameters} arguments, received ${activation.arguments.length}`,
      );
    }
    const frame = Object.freeze({
      receiver: activation.receiver,
      arguments: activation.arguments,
    });
    return await evaluate(program.body, frame, context);
  },
});

export {
  MAX_EXPRESSION_DEPTH,
  NEUTRAL_EXPRESSION_V0,
  neutralExpressionV0Executor,
  parseProgram,
};
