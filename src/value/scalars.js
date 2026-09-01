import {base64Decode, base64Encode} from '../support/portable-bytes.js';
import {VALUE_KIND} from './kinds.js';

const freeze = (record) => Object.freeze(record);
const invalid = (message) => new TypeError(message);

function booleanValue(value) {
  if (typeof value !== 'boolean') throw invalid('boolean value must be a boolean');
  return freeze({kind: VALUE_KIND.BOOLEAN, value});
}

function integerValue(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw invalid('number input for integer must be a safe integer; use bigint or a decimal string');
  } else if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw invalid('integer string must be decimal');
  } else if (typeof value !== 'bigint') {
    throw invalid('integer must be a bigint, safe integer, or decimal string');
  }
  return freeze({kind: VALUE_KIND.INTEGER, value: BigInt(value).toString(10)});
}

function float64FromBits(bits) {
  if (typeof bits !== 'string' || !/^[0-9a-fA-F]{16}$/.test(bits)) throw invalid('float64 bits must be 16 hexadecimal characters');
  return freeze({kind: VALUE_KIND.FLOAT64, bits: bits.toLowerCase()});
}

function float64Value(value) {
  if (typeof value !== 'number') throw invalid('float64 value must be a number');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return float64FromBits(view.getBigUint64(0, false).toString(16).padStart(16, '0'));
}

function float64ToNumber(value) {
  if (!value || value.kind !== VALUE_KIND.FLOAT64) throw invalid('value is not a float64');
  const normalized = float64FromBits(value.bits);
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${normalized.bits}`), false);
  return view.getFloat64(0, false);
}

function textValue(value) {
  if (typeof value !== 'string') throw invalid('text value must be a string');
  return freeze({kind: VALUE_KIND.TEXT, value});
}

function bytesFromBase64(base64) {
  if (typeof base64 !== 'string') throw invalid('bytes base64 must be a string');
  const decoded = base64Decode(base64);
  if (base64Encode(decoded) !== base64) throw invalid('bytes value must use canonical base64');
  return freeze({kind: VALUE_KIND.BYTES, base64});
}

function bytesValue(value) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw invalid('bytes value must be an ArrayBuffer or typed-array view');
  return bytesFromBase64(base64Encode(bytes));
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${label} must be a non-empty string`);
  return value;
}

function objectRef(imageId, objectId) {
  return freeze({kind: VALUE_KIND.REF, imageId: requiredText(imageId, 'imageId'), objectId: requiredText(objectId, 'objectId')});
}

function pinnedRef(imageId, objectId, revision) {
  if (!['string', 'number', 'bigint'].includes(typeof revision)) throw invalid('revision must be text or integer');
  if (typeof revision === 'number' && !Number.isSafeInteger(revision)) throw invalid('numeric revision must be a safe integer');
  const text = String(revision);
  if (text.length === 0) throw invalid('revision must not be empty');
  return freeze({kind: VALUE_KIND.PINNED_REF, imageId: requiredText(imageId, 'imageId'), objectId: requiredText(objectId, 'objectId'), revision: text});
}

function sameKeys(value, names) {
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalizeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('value must be a tagged record');
  switch (value.kind) {
    case VALUE_KIND.BOOLEAN:
      if (!sameKeys(value, ['kind', 'value'])) throw invalid('malformed boolean value');
      return booleanValue(value.value);
    case VALUE_KIND.INTEGER:
      if (!sameKeys(value, ['kind', 'value'])) throw invalid('malformed integer value');
      return integerValue(value.value);
    case VALUE_KIND.FLOAT64:
      if (!sameKeys(value, ['kind', 'bits'])) throw invalid('malformed float value');
      return float64FromBits(value.bits);
    case VALUE_KIND.TEXT:
      if (!sameKeys(value, ['kind', 'value'])) throw invalid('malformed text value');
      return textValue(value.value);
    case VALUE_KIND.BYTES:
      if (!sameKeys(value, ['kind', 'base64'])) throw invalid('malformed bytes value');
      return bytesFromBase64(value.base64);
    case VALUE_KIND.REF:
      if (!sameKeys(value, ['kind', 'imageId', 'objectId'])) throw invalid('malformed object ref');
      return objectRef(value.imageId, value.objectId);
    case VALUE_KIND.PINNED_REF:
      if (!sameKeys(value, ['kind', 'imageId', 'objectId', 'revision'])) throw invalid('malformed pinned ref');
      return pinnedRef(value.imageId, value.objectId, value.revision);
    default:
      throw invalid('unknown value kind');
  }
}

function isValue(value) { try { canonicalizeValue(value); return true; } catch { return false; } }
function isObjectRef(value) { return isValue(value) && value.kind === VALUE_KIND.REF; }
function isPinnedRef(value) { return isValue(value) && value.kind === VALUE_KIND.PINNED_REF; }
const isReference = (value) => isObjectRef(value) || isPinnedRef(value);
function referencesOfValue(value) {
  const normalized = canonicalizeValue(value);
  return isReference(normalized) ? [normalized] : [];
}

export {
  booleanValue,
  bytesFromBase64,
  bytesValue,
  canonicalizeValue,
  float64FromBits,
  float64ToNumber,
  float64Value,
  integerValue,
  isObjectRef,
  isPinnedRef,
  isReference,
  isValue,
  objectRef,
  pinnedRef,
  referencesOfValue,
  textValue,
};
