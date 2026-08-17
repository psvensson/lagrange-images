import {
  VALUE_KIND,
  booleanValue,
  canonicalizeValue,
  integerValue,
} from '../value/index.js';

// neutral-expression/v1 adds the executable form of ADR 0043's mutable lexical semantics:
// temporaries, statement sequences, assignment, and captures that carry a disposition.
//
// v0 is frozen, and its grammar is closed in the same way lagrange-code/v0 is, so extending it in
// place would change the meaning of a representation string already present in artifacts.
//
// The representation describes *what the program does*. It contains no frame machinery: which
// runtime cell a static binding id resolves to is ActivationExecutor's business, reached through
// the narrow context operations below. That is what keeps a single lexical-state model shared with
// the WASM lane instead of two lane-private ones.
const NEUTRAL_EXPRESSION_V1 = 'neutral-expression/v1';
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

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function parseProgram(code) {
  if (code.content?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(`${NEUTRAL_EXPRESSION_V1} code content must be a text Value`);
  }
  let program;
  try {
    program = JSON.parse(code.content.value);
  } catch (error) {
    throw new TypeError(`${NEUTRAL_EXPRESSION_V1} code content must contain valid JSON`, {cause: error});
  }
  exactKeys(program, ['parameters', 'temporaries', 'body'], 'neutral expression v1 program');
  nonNegativeInteger(program.parameters, 'neutral expression parameter count');
  if (!Array.isArray(program.temporaries)) throw new TypeError('neutral expression temporaries must be an array');
  for (const [index, temporary] of program.temporaries.entries()) {
    exactKeys(temporary, ['id', 'name'], `temporary ${index}`);
    requiredText(temporary.id, `temporary ${index} id`);
    requiredText(temporary.name, `temporary ${index} name`);
  }
  return program;
}

function sameValue(left, right) {
  return JSON.stringify(canonicalizeValue(left)) === JSON.stringify(canonicalizeValue(right));
}

function requireOperation(context, name, label) {
  if (typeof context[name] !== 'function') {
    throw new TypeError(`${label} requires the ${name} execution operation`);
  }
  return context[name];
}

async function evaluate(expression, frame, context, depth = 0) {
  if (depth > MAX_EXPRESSION_DEPTH) throw new TypeError('neutral expression depth limit exceeded');
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
    throw new TypeError('neutral expression must be an object');
  }

  switch (expression.op) {
    case 'literal':
      exactKeys(expression, ['op', 'value'], 'literal expression');
      return canonicalizeValue(expression.value);
    case 'argument': {
      exactKeys(expression, ['op', 'index'], 'argument expression');
      const index = nonNegativeInteger(expression.index, 'argument index');
      if (index >= frame.arguments.length) throw new TypeError(`argument index out of range: ${index}`);
      return frame.arguments[index];
    }
    case 'receiver':
      exactKeys(expression, ['op'], 'receiver expression');
      if (frame.receiver === null) throw new TypeError('activation has no receiver');
      return frame.receiver;
    // A read of this activation's own cell, a captured cell, or a durable snapshot — resolved by
    // the executor, in that order.
    case 'binding':
      exactKeys(expression, ['op', 'id'], 'binding expression');
      return await requireOperation(context, 'readBinding', 'binding')(
        requiredText(expression.id, 'binding expression id'),
      );
    // Assignment, whose value is the written value.
    case 'binding-write': {
      exactKeys(expression, ['op', 'id', 'value'], 'binding-write expression');
      const id = requiredText(expression.id, 'binding-write id');
      const value = await evaluate(expression.value, frame, context, depth + 1);
      return await requireOperation(context, 'writeBinding', 'binding-write')(id, value);
    }
    case 'sequence': {
      exactKeys(expression, ['op', 'statements'], 'sequence expression');
      if (!Array.isArray(expression.statements) || expression.statements.length === 0) {
        throw new TypeError('sequence statements must be a non-empty array');
      }
      let result = null;
      for (const statement of expression.statements) {
        result = await evaluate(statement, frame, context, depth + 1);
      }
      return result;
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
    case 'send': {
      exactKeys(expression, ['op', 'languageId', 'receiver', 'message', 'arguments'], 'send expression');
      const languageId = requiredText(expression.languageId, 'send languageId');
      const message = canonicalizeValue(expression.message);
      if (!Array.isArray(expression.arguments)) throw new TypeError('send arguments must be an array');
      const sendMessage = requireOperation(context, 'sendMessage', 'send');
      const receiver = await evaluate(expression.receiver, frame, context, depth + 1);
      const args = [];
      for (const argument of expression.arguments) {
        args.push(await evaluate(argument, frame, context, depth + 1));
      }
      return await sendMessage({languageId, receiver, message, arguments: args});
    }
    case 'make-block': {
      exactKeys(expression, ['op', 'prototype', 'captures'], 'make-block expression');
      if (!Array.isArray(expression.captures)) throw new TypeError('make-block captures must be an array');
      const createClosure = requireOperation(context, 'createClosure', 'make-block');
      const captures = [];
      for (const [index, capture] of expression.captures.entries()) {
        const label = `make-block capture ${index}`;
        const mode = requiredText(capture?.mode, `${label} mode`);
        if (mode === 'cell') {
          // No value is evaluated: the executor binds the declaring frame's live cell. Evaluating
          // one here is exactly how a snapshot would sneak back in.
          exactKeys(capture, ['id', 'mode', 'name'], label);
          captures.push(Object.freeze({
            id: requiredText(capture.id, `${label} id`),
            name: requiredText(capture.name, `${label} name`),
            mode: 'cell',
          }));
          continue;
        }
        if (mode !== 'snapshot') throw new TypeError(`${label} mode must be snapshot or cell`);
        exactKeys(capture, ['id', 'mode', 'name', 'value'], label);
        captures.push(Object.freeze({
          id: requiredText(capture.id, `${label} id`),
          name: requiredText(capture.name, `${label} name`),
          mode: 'snapshot',
          value: await evaluate(capture.value, frame, context, depth + 1),
        }));
      }
      return await createClosure({prototype: canonicalizeValue(expression.prototype), captures});
    }
    default:
      throw new TypeError(`unknown ${NEUTRAL_EXPRESSION_V1} expression op: ${expression.op}`);
  }
}

const neutralExpressionV1Executor = Object.freeze({
  async execute({activation, code}, context) {
    const program = parseProgram(code);
    if (activation.arguments.length !== program.parameters) {
      throw new TypeError(
        `activation expected ${program.parameters} arguments, received ${activation.arguments.length}`,
      );
    }
    // One frame per lexical activation, so two activations of this code — recursion included —
    // get distinct cells despite sharing static binding ids.
    if (program.temporaries.length > 0) {
      requireOperation(context, 'declareTemporaries', 'temporaries')(program.temporaries);
    }
    const frame = Object.freeze({
      receiver: activation.receiver,
      arguments: activation.arguments,
    });
    return await evaluate(program.body, frame, context);
  },
});

export {
  NEUTRAL_EXPRESSION_V1,
  neutralExpressionV1Executor,
  parseProgram as parseNeutralExpressionV1Program,
};
