import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {utf8Encode} from '../support/portable-bytes.js';
import {
  VALUE_KIND,
  booleanValue,
  canonicalizeValue,
  float64ToNumber,
  integerValue,
  isObjectRef,
} from '../value/index.js';

// ADR 0048 decisions 2 and 3: the built-in `=` relation and the stable `hash` that must agree with
// it. Everything here is a pure function of canonical Values, which is what lets a later
// MethodDictionary fast path use the same helpers on Text selectors without executing any Smalltalk.
//
// This is deliberately *not* the `lagrange-code` `equals` op. That op is a frozen language-neutral
// structural comparison; this is one language's equality protocol, and the two must be able to
// disagree without either changing.
const SMALLTALK_EQUALITY_DOMAIN = 'smalltalk/equality/v1';

// The hash is a durable contract, not an implementation detail. Existing persistent tables were laid
// out with it, so replacing the algorithm is a migration decision rather than an optimization.
const SMALLTALK_HASH_BITS = 63n;
const SMALLTALK_HASH_MASK = (1n << SMALLTALK_HASH_BITS) - 1n;

class SmalltalkUnhashableValueError extends TypeError {
  constructor(kind) {
    super(
      `Symmetric Smalltalk has no equality or hash contract for a ${kind} Value; `
      + 'it is graph/history state rather than a Smalltalk receiver',
    );
    this.name = 'SmalltalkUnhashableValueError';
    this.kind = kind;
  }
}

function sameRefIdentity(left, right) {
  return left.imageId === right.imageId && left.objectId === right.objectId;
}

// An integral Float64 and an Integer denote the same number, so they share one normal form. The
// conversion goes through the Float's own value rather than through JavaScript's safe-integer range:
// 2^60 is exactly representable and must hash like the Integer 2^60, while 2^60+1 must not.
function integralFloat(value) {
  const number = float64ToNumber(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return null;
  // -0 and +0 both become 0n, which is what makes them one key.
  return BigInt(number);
}

// The equality normal form, and therefore the hash pre-image. Two Values are built-in equal exactly
// when their normal forms are identical, which is what makes `a = b => a hash = b hash` true by
// construction rather than by parallel maintenance of two functions.
//
// NaN is the one deliberate exception: it has a stable normal form, but `=` says it is unequal to
// everything including itself. Dictionary does not repair a key whose own equality relation rejects
// it.
function equalityNormalForm(input) {
  const value = canonicalizeValue(input);
  switch (value.kind) {
    case VALUE_KIND.BOOLEAN:
      return ['boolean', value.value];
    case VALUE_KIND.TEXT:
      return ['text', value.value];
    case VALUE_KIND.BYTES:
      return ['bytes', value.base64];
    case VALUE_KIND.INTEGER:
      return ['number/integer', BigInt(value.value).toString(10)];
    case VALUE_KIND.FLOAT64: {
      const number = float64ToNumber(value);
      if (Number.isNaN(number)) return ['number/nan', value.bits];
      if (!Number.isFinite(number)) return ['number/infinity', number > 0 ? '+' : '-'];
      const integral = integralFloat(value);
      if (integral !== null) return ['number/integer', integral.toString(10)];
      // IEEE64 has exactly one bit pattern per finite non-integral value, so the bits are already a
      // canonical form; only NaN payloads and signed zero needed special handling, and both are
      // handled above.
      return ['number/float64', value.bits];
    }
    case VALUE_KIND.REF:
      return ['ref', value.imageId, value.objectId];
    default:
      throw new SmalltalkUnhashableValueError(value.kind);
  }
}

function builtInEquals(leftInput, rightInput) {
  const left = canonicalizeValue(leftInput);
  const right = canonicalizeValue(rightInput);

  // Identity, and nothing else: no record is read, so `_version`, Shape, behavior and slot contents
  // never participate. Two refs to the same object are equal however much the object has changed.
  if (isObjectRef(left) || isObjectRef(right)) {
    return isObjectRef(left) && isObjectRef(right) && sameRefIdentity(left, right);
  }
  // A pinned ref has no Smalltalk behavior, so it is not equal to anything rather than being an
  // error here; `hash` is where using one as a key actually fails.
  if (left.kind === VALUE_KIND.PINNED_REF || right.kind === VALUE_KIND.PINNED_REF) return false;

  const numericKinds = new Set([VALUE_KIND.INTEGER, VALUE_KIND.FLOAT64]);
  if (numericKinds.has(left.kind) && numericKinds.has(right.kind)) {
    // NaN must be unequal to itself, and no normal form can express that, so numbers are compared
    // directly rather than by comparing normal forms.
    if (left.kind === VALUE_KIND.FLOAT64 && Number.isNaN(float64ToNumber(left))) return false;
    if (right.kind === VALUE_KIND.FLOAT64 && Number.isNaN(float64ToNumber(right))) return false;
    const asBigInt = (value) => (value.kind === VALUE_KIND.INTEGER ? BigInt(value.value) : integralFloat(value));
    const leftInteger = asBigInt(left);
    const rightInteger = asBigInt(right);
    if (leftInteger !== null && rightInteger !== null) return leftInteger === rightInteger;
    // At least one is a non-integral or infinite Float; an Integer can equal neither.
    if (left.kind !== VALUE_KIND.FLOAT64 || right.kind !== VALUE_KIND.FLOAT64) return false;
    return float64ToNumber(left) === float64ToNumber(right);
  }

  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case VALUE_KIND.BOOLEAN:
      return left.value === right.value;
    case VALUE_KIND.TEXT:
      return left.value === right.value;
    case VALUE_KIND.BYTES:
      // Canonical base64, so string equality is byte equality.
      return left.base64 === right.base64;
    default:
      throw new SmalltalkUnhashableValueError(left.kind);
  }
}

// Deterministic across processes and restarts, because bucket placement in a durable table depends
// on it. A host-randomized or address-derived hash would relocate every key on restart.
function builtInHash(value) {
  const form = equalityNormalForm(value);
  const digest = getDefaultCryptoProvider().sha256(
    utf8Encode(JSON.stringify([SMALLTALK_EQUALITY_DOMAIN, ...form])),
  );
  return integerValue(new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getBigUint64(0, false) & SMALLTALK_HASH_MASK);
}

// ADR 0045 makes the `true`/`false` singleton the effective receiver of a boolean send, so a
// built-in comparison would otherwise see a ref on one side and a boolean Value on the other and
// answer false. Normalizing the two well-known local singletons back to their boolean values keeps
// `true = true` from depending on which side of the bridge each operand arrived through.
function normalizeBooleanSingleton(value, kernel) {
  if (!kernel || !isObjectRef(value)) return value;
  if (sameRefIdentity(value, kernel.true)) return booleanValue(true);
  if (sameRefIdentity(value, kernel.false)) return booleanValue(false);
  return value;
}

export {
  sameRefIdentity,
  SMALLTALK_EQUALITY_DOMAIN,
  SMALLTALK_HASH_BITS,
  SmalltalkUnhashableValueError,
  builtInEquals,
  builtInHash,
  equalityNormalForm,
  normalizeBooleanSingleton,
};
