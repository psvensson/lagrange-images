import {base64Decode, bytesEqual, utf8DecodeLossy, utf8Encode} from '../support/portable-bytes.js';
import {
  VALUE_KIND,
  bytesValue,
  canonicalizeValue,
  integerValue,
  textValue,
} from '../value/index.js';
import {SmalltalkPrimitiveReceiverError} from './smalltalk-primitive-support.js';

// WS3 Text/ByteArray slice: a tiny byte-sequence primitive family over the
// native immutable Value representations.
//
// A Text Value (`{kind:'text', value}`) and an immediate bytes Value
// (`{kind:'bytes', base64}`) are *physically different models* from Array's
// indexed-object storage (ADR 0047): the bytes Value is a Value, dispatching
// through the kernel's `ByteArray` class, not an indexed image object. The
// directive is explicit — do NOT widen the ADR 0047 indexed primitives
// (`indexed-size`/`indexed-at`) to bytes Values, and do NOT create a second
// ByteArray as an indexed image object. This family is the byte-sequence
// equivalent of `symbol-intern`/`class-of`: language-owned primitives over the
// native representations.
//
// UTF-8 is the only codec here, matching the upstream Pharo portable-util
// precedent (which overrides `bytesFromString:`/`stringFromBytes:` with an
// explicit UTF-8 codec rather than a generic `asByteArray`). `asByteArray` /
// `asString` are deliberately NOT defined as UTF-8 — encoding is dialect
// policy, not a default.
//
// Refusal rules (directives): malformed UTF-8 decode is refused, never
// lossy-replaced; an ill-formed/lone-surrogate Text source is refused, never
// silently substituted.

function requireText(value, primitive) {
  const normalized = canonicalizeValue(value);
  if (normalized.kind !== VALUE_KIND.TEXT) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a ${normalized.kind} Value; ${primitive} requires a Text Value`);
  }
  return normalized.value;
}

function requireBytes(value, primitive) {
  const normalized = canonicalizeValue(value);
  if (normalized.kind !== VALUE_KIND.BYTES) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a ${normalized.kind} Value; ${primitive} requires a ByteArray Value`);
  }
  return base64Decode(normalized.base64);
}

// A lone surrogate is ill-formed Unicode scalar data: there is no valid UTF-8
// encoding for it, so encode must refuse rather than emit a replacement char.
function assertWellFormedText(text, primitive) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new SmalltalkPrimitiveReceiverError(
          primitive, 'a Text Value containing a lone surrogate (ill-formed Unicode scalar data)',
        );
      }
      index += 1; // skip the low surrogate of a valid pair
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new SmalltalkPrimitiveReceiverError(
        primitive, 'a Text Value containing a lone surrogate (ill-formed Unicode scalar data)',
      );
    }
  }
  return text;
}

// Strict UTF-8 decode: a lossy decode substitutes U+FFFD for malformed
// sequences, so decode is validated by re-encoding and comparing — any lossy
// substitution changes the bytes and is detected. Overlong forms and
// out-of-range sequences are likewise rejected by the round-trip check.
function decodeUtf8Strict(bytes, primitive) {
  const text = utf8DecodeLossy(bytes);
  if (!bytesEqual(utf8Encode(text), bytes)) {
    throw new SmalltalkPrimitiveReceiverError(primitive, 'a malformed UTF-8 byte sequence; decode refused');
  }
  return text;
}

async function textUtf8Bytes({value}) {
  const text = assertWellFormedText(requireText(value, 'text-utf8-bytes'), 'text-utf8-bytes');
  return bytesValue(utf8Encode(text));
}

async function byteArrayUtf8Text({value}) {
  const buffer = requireBytes(value, 'bytearray-utf8-text');
  return textValue(decodeUtf8Strict(buffer, 'bytearray-utf8-text'));
}

async function byteArraySize({value}) {
  return integerValue(requireBytes(value, 'bytearray-size').length);
}

async function byteArrayAt({value, indexValue}) {
  const buffer = requireBytes(value, 'bytearray-at');
  const normalized = canonicalizeValue(indexValue);
  if (normalized.kind !== VALUE_KIND.INTEGER) {
    throw new SmalltalkPrimitiveReceiverError('bytearray-at', `a ${normalized.kind} index; index must be an Integer Value`);
  }
  const oneBased = BigInt(normalized.value);
  // 1-based indexing, matching Array>>at: / Smalltalk collection convention.
  if (oneBased < 1n || oneBased > BigInt(buffer.length)) {
    throw new RangeError(
      `Symmetric Smalltalk bytearray-at index ${oneBased.toString()} is outside the 1..${buffer.length} range`,
    );
  }
  return integerValue(buffer[Number(oneBased) - 1]);
}

// `fromArray:` backing: an Array (or OrderedCollection's `asArray` result) of
// integer bytes -> a native bytes Value. Every element is validated 0..255 —
// a non-integer or out-of-range element is refused, never truncated.
async function arrayToByteArray({images, primitiveImage, value}) {
  const normalized = canonicalizeValue(value);
  if (normalized.kind !== VALUE_KIND.REF) {
    throw new SmalltalkPrimitiveReceiverError(
      'array-to-bytearray', `a ${normalized.kind} Value; the source must be an Array of integers`,
    );
  }
  const record = await images.getObject(primitiveImage, normalized.objectId);
  if (!record || !Array.isArray(record.indexed)) {
    throw new SmalltalkPrimitiveReceiverError(
      'array-to-bytearray', `${normalized.objectId}, which has no indexed integer storage`,
    );
  }
  const bytes = new Uint8Array(record.indexed.length);
  for (let index = 0; index < record.indexed.length; index += 1) {
    const element = canonicalizeValue(record.indexed[index]);
    if (element.kind !== VALUE_KIND.INTEGER) {
      throw new SmalltalkPrimitiveReceiverError(
        'array-to-bytearray', `an Array whose element ${index + 1} is a ${element.kind} Value, not an integer byte`,
      );
    }
    const byte = BigInt(element.value);
    if (byte < 0n || byte > 255n) {
      throw new RangeError(`Symmetric Smalltalk array-to-bytearray element ${index + 1} value ${byte.toString()} is not in 0..255`);
    }
    bytes[index] = Number(byte);
  }
  return bytesValue(bytes);
}

export {
  arrayToByteArray,
  byteArrayAt,
  byteArraySize,
  byteArrayUtf8Text,
  textUtf8Bytes,
};
