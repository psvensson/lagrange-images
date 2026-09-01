import {base64Decode, bytesEqual, concatBytes, utf8DecodeLossy, utf8Encode} from '../support/portable-bytes.js';
import {VALUE_KIND, bytesValue, canonicalizeValue, isReference} from '../value/index.js';
import {isPrimitiveType, resolveDeclaredType, typeFingerprint} from './type-grammar.js';

// interface-composite/v0
//
// A schema-directed envelope carrying one composite InterfaceValue as canonical bytes. The
// payload carries no type tags whatsoever: the declared interface type says what every byte
// means, so decoding without that type is impossible by construction. That is the property
// which keeps this from becoming the generic nested collection Value the substrate rejects.
//
//   offset 0   'LGIC'                       magic
//   offset 4   version u8 = 0
//   offset 5   fingerprint, 32 bytes        sha256 of the normalized type schema
//   offset 37  payload                      schema-directed, untagged
//
// The fingerprint is over the type, never over the interface artifact identity, so the
// envelope hides no graph relationship.
const INTERFACE_COMPOSITE_V0 = 'interface-composite/v0';
const MAGIC = utf8Encode('LGIC');
const VERSION = 0;
const FINGERPRINT_LENGTH = 32;
const HEADER_LENGTH = MAGIC.length + 1 + FINGERPRINT_LENGTH;

// Bounds keep a malformed envelope from costing unbounded memory or time.
const MAX_VALUE_DEPTH = 32;
const MAX_LIST_LENGTH = 1_000_000;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

const S32_MIN = -(2n ** 31n);
const S32_MAX = 2n ** 31n - 1n;
const S64_MIN = -(2n ** 63n);
const S64_MAX = 2n ** 63n - 1n;

class InterfaceCompositeError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'InterfaceCompositeError';
  }
}

function fail(message) {
  throw new InterfaceCompositeError(message);
}

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(buffer) {
    this.length += buffer.length;
    if (this.length > MAX_PAYLOAD_BYTES) fail(`composite payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    this.chunks.push(buffer);
  }

  u8(value) { const b = new Uint8Array(1); new DataView(b.buffer).setUint8(0, value); this.push(b); }
  u32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, false); this.push(b); }
  s32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, value, false); this.push(b); }
  s64(value) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, value, false); this.push(b); }
  f32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value, false); this.push(b); }
  f64(value) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, value, false); this.push(b); }
  bytes(bytes) { this.u32(bytes.length); this.push(bytes); }

  contents() { return concatBytes(this.chunks); }
}

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  take(count) {
    if (count < 0 || this.offset + count > this.buffer.length) fail('composite payload ended early');
    const slice = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  u8() { const s = this.take(1); return new DataView(s.buffer, s.byteOffset, s.byteLength).getUint8(0); }
  u32() { const s = this.take(4); return new DataView(s.buffer, s.byteOffset, s.byteLength).getUint32(0, false); }
  s32() { const s = this.take(4); return new DataView(s.buffer, s.byteOffset, s.byteLength).getInt32(0, false); }
  s64() { const s = this.take(8); return new DataView(s.buffer, s.byteOffset, s.byteLength).getBigInt64(0, false); }
  f32() { const s = this.take(4); return new DataView(s.buffer, s.byteOffset, s.byteLength).getFloat32(0, false); }
  f64() { const s = this.take(8); return new DataView(s.buffer, s.byteOffset, s.byteLength).getFloat64(0, false); }
  bytes() { return this.take(this.u32()); }

  atEnd() { return this.offset === this.buffer.length; }
}

// An InterfaceValue is a plain host value: a primitive, an array, or a plain record object.
// It may never contain a canonical ref, because the graph walker is flat and would not see
// a reference buried inside an envelope.
function assertRefFree(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.kind !== undefined) {
    const canonical = (() => {
      try { return canonicalizeValue(value); } catch { return null; }
    })();
    if (canonical && isReference(canonical)) {
      fail(`${label} contains a reference; InterfaceValues must be ref-free`);
    }
  }
  return value;
}

function writeValue(writer, value, type, types, label, depth) {
  if (depth > MAX_VALUE_DEPTH) fail(`${label} exceeds the maximum value depth of ${MAX_VALUE_DEPTH}`);
  assertRefFree(value, label);

  if (isPrimitiveType(type)) {
    switch (type) {
      case 'bool':
        if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
        return writer.u8(value ? 1 : 0);
      case 's32': {
        if (typeof value !== 'number' && typeof value !== 'bigint') fail(`${label} must be an integer`);
        const n = BigInt(value);
        if (n < S32_MIN || n > S32_MAX) fail(`${label} is outside s32 range`);
        return writer.s32(Number(n));
      }
      case 's64': {
        if (typeof value !== 'number' && typeof value !== 'bigint') fail(`${label} must be an integer`);
        const n = BigInt(value);
        if (n < S64_MIN || n > S64_MAX) fail(`${label} is outside s64 range`);
        return writer.s64(n);
      }
      case 'f32':
        if (typeof value !== 'number') fail(`${label} must be a number`);
        return writer.f32(Math.fround(value));
      case 'f64':
        if (typeof value !== 'number') fail(`${label} must be a number`);
        return writer.f64(value);
      case 'string':
        if (typeof value !== 'string') fail(`${label} must be a string`);
        return writer.bytes(utf8Encode(value));
      case 'list<u8>': {
        if (!(value instanceof Uint8Array) && !Array.isArray(value)) fail(`${label} must be a byte sequence`);
        return writer.bytes(value instanceof Uint8Array ? value : Uint8Array.from(value));
      }
      default:
        return fail(`${label} has unsupported primitive type ${type}`);
    }
  }

  const resolved = resolveDeclaredType(type, types);
  if (resolved.kind === 'list') {
    if (!Array.isArray(value)) fail(`${label} must be an array`);
    if (value.length > MAX_LIST_LENGTH) fail(`${label} exceeds ${MAX_LIST_LENGTH} elements`);
    writer.u32(value.length);
    value.forEach((element, index) => {
      writeValue(writer, element, resolved.element, types, `${label}[${index}]`, depth + 1);
    });
    return undefined;
  }
  if (resolved.kind === 'record') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a record object`);
    const extra = Object.keys(value).filter((key) => !resolved.fields.some((field) => field.name === key));
    if (extra.length > 0) fail(`${label} has fields not in the type: ${extra.join(', ')}`);
    // Declared field order, not object key order: the layout is part of the type.
    for (const field of resolved.fields) {
      if (!Object.hasOwn(value, field.name)) fail(`${label} is missing field ${field.name}`);
      writeValue(writer, value[field.name], field.type, types, `${label}.${field.name}`, depth + 1);
    }
    return undefined;
  }
  return fail(`${label} has unsupported type constructor ${resolved.kind}`);
}

function readValue(reader, type, types, label, depth) {
  if (depth > MAX_VALUE_DEPTH) fail(`${label} exceeds the maximum value depth of ${MAX_VALUE_DEPTH}`);

  if (isPrimitiveType(type)) {
    switch (type) {
      case 'bool': {
        const raw = reader.u8();
        if (raw > 1) fail(`${label} has invalid boolean encoding`);
        return raw === 1;
      }
      case 's32': return reader.s32();
      case 's64': return reader.s64();
      case 'f32': return reader.f32();
      case 'f64': return reader.f64();
      case 'string': return utf8DecodeLossy(reader.bytes());
      case 'list<u8>': return reader.bytes().slice();
      default: return fail(`${label} has unsupported primitive type ${type}`);
    }
  }

  const resolved = resolveDeclaredType(type, types);
  if (resolved.kind === 'list') {
    const count = reader.u32();
    if (count > MAX_LIST_LENGTH) fail(`${label} declares more than ${MAX_LIST_LENGTH} elements`);
    const items = [];
    for (let index = 0; index < count; index++) {
      items.push(readValue(reader, resolved.element, types, `${label}[${index}]`, depth + 1));
    }
    return items;
  }
  if (resolved.kind === 'record') {
    const record = {};
    for (const field of resolved.fields) {
      record[field.name] = readValue(reader, field.type, types, `${label}.${field.name}`, depth + 1);
    }
    return record;
  }
  return fail(`${label} has unsupported type constructor ${resolved.kind}`);
}

function packCompositeValue(value, type, types = {}, label = 'composite') {
  const writer = new Writer();
  writeValue(writer, value, type, types, label, 0);
  const envelope = concatBytes([
    MAGIC,
    new Uint8Array([VERSION]),
    typeFingerprint(type, types),
    writer.contents(),
  ]);
  return bytesValue(envelope);
}

function envelopeFingerprint(envelope) {
  return envelope.slice(MAGIC.length + 1, HEADER_LENGTH);
}

// A lane whose transport the host controls at both ends may carry the payload alone. The
// header exists to protect an envelope that floats around as an opaque Value; inside such a
// transport the host has already verified the incoming fingerprint and is the one entitled
// to assert the outgoing type, because it is the side that knows it.
//
// This is what lets the Cuis image handle any composite type without computing SHA-256.
function compositePayloadOf(value, label = 'composite') {
  const canonical = canonicalizeValue(value);
  if (canonical.kind !== VALUE_KIND.BYTES) fail(`${label} must be a bytes Value`);
  const envelope = base64Decode(canonical.base64);
  if (envelope.length < HEADER_LENGTH) fail(`${label} envelope is too short`);
  return bytesValue(new Uint8Array(envelope.subarray(HEADER_LENGTH)));
}

function compositeEnvelopeOf(payload, type, types = {}, label = 'composite') {
  const canonical = canonicalizeValue(payload);
  if (canonical.kind !== VALUE_KIND.BYTES) fail(`${label} payload must be a bytes Value`);
  const bytes = base64Decode(canonical.base64);
  // Decoding against the declared type is what earns the right to stamp its fingerprint.
  const reader = new Reader(bytes);
  const decoded = readValue(reader, type, types, label, 0);
  if (!reader.atEnd()) fail(`${label} payload has trailing bytes`);
  return packCompositeValue(decoded, type, types, label);
}

function unpackCompositeValue(value, type, types = {}, label = 'composite') {
  const canonical = canonicalizeValue(value);
  if (canonical.kind !== VALUE_KIND.BYTES) {
    fail(`${label} must be a bytes Value carrying an ${INTERFACE_COMPOSITE_V0} envelope`);
  }
  const envelope = base64Decode(canonical.base64);
  if (envelope.length < HEADER_LENGTH) fail(`${label} envelope is too short`);
  if (!bytesEqual(envelope.subarray(0, MAGIC.length), MAGIC)) {
    fail(`${label} is not an ${INTERFACE_COMPOSITE_V0} envelope`);
  }
  const version = envelope[MAGIC.length];
  if (version !== VERSION) fail(`${label} envelope declares unsupported version ${version}`);

  // The fingerprint check is what makes decoding require the *exact* expected type rather
  // than merely a structurally compatible one.
  const expected = typeFingerprint(type, types);
  if (!bytesEqual(envelopeFingerprint(envelope), expected)) {
    fail(`${label} envelope was encoded against a different interface type`);
  }

  const reader = new Reader(envelope.subarray(HEADER_LENGTH));
  const decoded = readValue(reader, type, types, label, 0);
  if (!reader.atEnd()) fail(`${label} envelope has trailing bytes`);
  return decoded;
}

export {
  HEADER_LENGTH as INTERFACE_COMPOSITE_HEADER_LENGTH,
  INTERFACE_COMPOSITE_V0,
  InterfaceCompositeError,
  MAX_LIST_LENGTH,
  MAX_VALUE_DEPTH,
  compositeEnvelopeOf,
  compositePayloadOf,
  envelopeFingerprint,
  packCompositeValue,
  unpackCompositeValue,
};
