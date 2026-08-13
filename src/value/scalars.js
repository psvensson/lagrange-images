import {VALUE_KIND} from './kinds.js';

const freeze = (record) => Object.freeze(record);
const invalid = (message) => new TypeError(message);

function booleanValue(value) {
  if (typeof value !== 'boolean') throw invalid('boolean value must be a boolean');
  return freeze({kind: VALUE_KIND.BOOLEAN, value});
}

function integerValue(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw invalid('number input for integer must be a safe integer; use bigint or a decimal string');
    }
  } else if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw invalid('integer string must be decimal');
  } else if (typeof value !== 'bigint') {
    throw invalid('integer must be a bigint, safe integer, or decimal string');
  }
  return freeze({kind: VALUE_KIND.INTEGER, value: BigInt(value).toString(10)});
}

function float64FromBits(bits) {
  if (typeof bits !== 'string' || !/^[0-9a-fA-F]{16}$/.test(bits)) {
    throw invalid('float64 bits must be exactly 16 hexadecimal characters');
  }
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
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.toString('base64') !== base64) throw invalid('bytes value must use canonical base64');
  return freeze({kind: VALUE_KIND.BYTES, base64});
}

function bytesValue(value) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw invalid('bytes value must be an ArrayBuffer or typed-array view');
  return bytesFromBase64(Buffer.from(bytes).toString('base64'));
}

export {
  booleanValue,
  bytesFromBase64,
  bytesValue,
  float64FromBits,
  float64ToNumber,
  float64Value,
  integerValue,
  textValue,
};
