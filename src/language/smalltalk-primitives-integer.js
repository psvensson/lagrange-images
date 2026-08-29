import {HOST_CONDITION_CLASS} from './smalltalk-condition-ids.js';
import {
  VALUE_KIND,
  booleanValue,
  canonicalizeValue,
  integerValue,
} from '../value/index.js';
import {
  SMALLTALK_PRIMITIVE,
  signalHostCondition,
} from './smalltalk-primitive-support.js';

// ADR 0053. Two Integers, and nothing else: mixed Integer/Float *ordering and arithmetic* need
// coercion rules this ADR deliberately defers. Mixed *equality* is untouched — ADR 0048 already
// decided that an Integer equals a finite integral Float of the same mathematical value.
class SmalltalkIntegerOperandError extends TypeError {
  constructor(primitive, kind, position) {
    super(`Symmetric Smalltalk ${primitive} primitive requires two Integers; the ${position} is a ${kind} Value`);
    this.name = 'SmalltalkIntegerOperandError';
    this.primitive = primitive;
  }
}

class SmalltalkDivideByZeroError extends TypeError {
  constructor(primitive) {
    super(`Symmetric Smalltalk ${primitive} primitive cannot divide by zero`);
    this.name = 'SmalltalkDivideByZeroError';
    this.primitive = primitive;
  }
}

const SMALLTALK_INTEGER_ARITY = Object.freeze({
  [SMALLTALK_PRIMITIVE.INTEGER_LESS_THAN]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_MODULO]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_BIT_AND]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_BIT_OR]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_BIT_XOR]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_BIT_SHIFT]: 2,
});

function integerOperands(primitive, left, right) {
  const a = canonicalizeValue(left);
  const b = canonicalizeValue(right);
  if (a.kind !== VALUE_KIND.INTEGER) throw new SmalltalkIntegerOperandError(primitive, a.kind, 'receiver');
  if (b.kind !== VALUE_KIND.INTEGER) throw new SmalltalkIntegerOperandError(primitive, b.kind, 'argument');
  // BigInt throughout: an Integer Value is arbitrary precision, and a host number round-trip would
  // silently round anything past 2^53.
  return [BigInt(a.value), BigInt(b.value)];
}

// q = floor(a / b). Host BigInt division truncates toward zero, so the correction below is the whole
// point of this primitive existing rather than the operator being wired straight through.
function floorDivide(a, b) {
  const quotient = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? quotient - 1n : quotient;
}

async function integerOperation(primitive, left, right, {
  images, primitiveImage, context, newObjectId, maxIdentityAttempts,
}) {
  const [a, b] = integerOperands(primitive, left, right);
  // ADR 0054 decision 8: divide-by-zero is a catchable `ZeroDivide`, and a handler that resumes
  // answers the division. Absent the condition protocol it stays the host error it was.
  const divideByZero = async () => await signalHostCondition({
    images,
    primitiveImage,
    context,
    classId: HOST_CONDITION_CLASS.zeroDivide,
    hostError: new SmalltalkDivideByZeroError(primitive),
    newObjectId,
    maxIdentityAttempts,
  });
  switch (primitive) {
    case SMALLTALK_PRIMITIVE.INTEGER_LESS_THAN:
      return booleanValue(a < b);
    case SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT:
      return integerValue(a - b);
    case SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY:
      return integerValue(a * b);
    case SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE:
      if (b === 0n) return await divideByZero();
      return integerValue(floorDivide(a, b));
    // BigInt bitwise semantics match Smalltalk's two's-complement-at-arbitrary-precision exactly:
    // a negative receiver behaves as the infinite two's-complement bit string, which is what
    // `16rFF bitAnd: -1` must answer. `bitShift:` takes a signed count — negative shifts right —
    // mirroring `Integer>>bitShift:` rather than adding a second selector.
    case SMALLTALK_PRIMITIVE.INTEGER_BIT_AND:
      return integerValue(a & b);
    case SMALLTALK_PRIMITIVE.INTEGER_BIT_OR:
      return integerValue(a | b);
    case SMALLTALK_PRIMITIVE.INTEGER_BIT_XOR:
      return integerValue(a ^ b);
    case SMALLTALK_PRIMITIVE.INTEGER_BIT_SHIFT:
      return integerValue(b < 0n ? a >> -b : a << b);
    default:
      // r = a - q*b, so the remainder takes the divisor's sign: 0 <= r < b for b > 0, and
      // b < r <= 0 for b < 0. That range — not the reconstruction identity, which a truncating
      // implementation also satisfies — is what makes `\\` usable for hashing and indexing.
      if (b === 0n) return await divideByZero();
      return integerValue(a - floorDivide(a, b) * b);
  }
}

export {
  SMALLTALK_INTEGER_ARITY,
  SmalltalkDivideByZeroError,
  SmalltalkIntegerOperandError,
  integerOperation,
};
