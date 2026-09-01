// Host-portable byte utilities (ADR: host portability, bead lagrange-images-g58).
//
// OWNERSHIP. Binary layout semantics stay owned entirely here; this module is the
// single internal home for the standard language-neutral machinery every
// language-neutral binary operation in lagrange-images is built on:
//
//   Uint8Array / DataView / TextEncoder / TextDecoder / internal base64/base64url.
//
// Node `Buffer` is NOT a host capability and is never accepted or returned by these
// primitives. Every function operates on and returns `Uint8Array` (the standard,
// host-portable binary type). Because Node's `Buffer` IS a `Uint8Array` subclass,
// a Node caller that still holds a Buffer can pass it anywhere a `Uint8Array` is
// accepted and it will behave identically — but nothing here constructs or exposes
// a Buffer, so a non-Node host needs no Buffer global.
//
// The on-wire bytes are frozen by compatibility: these primitives exist to produce
// exactly the same bytes the previous Buffer-based implementation produced.

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Lazily-created shared coders. TextEncoder/TextDecoder are standard on every ES host
// that matters (browsers, Node >= 11, Deno, Bun, QuickJS-NG with the standard module,
// WASM component hosts); they are language-neutral, not a Node personality.
let sharedEncoder = null;
function textEncoder() {
  if (sharedEncoder === null) sharedEncoder = new TextEncoder();
  return sharedEncoder;
}

function utf8Encode(text) {
  return textEncoder().encode(text);
}

// Strict UTF-8 decode: `fatal: true` refuses malformed sequences instead of
// substituting U+FFFD, matching the strictness the byte primitives require. A fresh
// decoder per call because `fatal` is a construction-time option.
function utf8DecodeStrict(bytes) {
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

// Lenient UTF-8 decode (U+FFFD substitution), matching Buffer's default toString.
// Used only where the previous implementation relied on lossy decode for a
// round-trip comparison; the strictness decision stays at the call site.
function utf8DecodeLossy(bytes) {
  return new TextDecoder('utf-8', {fatal: false}).decode(bytes);
}

function concatBytes(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

// --- base64 / base64url -------------------------------------------------------
//
// Self-contained codecs so no host base64 facility (Buffer, atob/btoa) is required.
// The URL-safe variant is RFC 4648 base64url WITHOUT padding (matching Node's
// 'base64url' encoding, which omits '='). The standard variant uses '+'/'/' and
// emits padding exactly as Node's 'base64' encoding does.

function encodeBase64With(bytes, alphabet, pad) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : undefined;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : undefined;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? (pad ? '=' : '') : alphabet[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? (pad ? '=' : '') : alphabet[b2 & 0x3f];
  }
  return out;
}

function decodeBase64With(text, alphabet, label) {
  const reverse = new Map();
  for (let index = 0; index < 64; index += 1) reverse.set(alphabet[index], index);
  const bytes = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of text) {
    if (char === '=') break; // padding terminates the meaningful input
    const value = reverse.get(char);
    if (value === undefined) throw new TypeError(`${label} contains an invalid base64 character`);
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function base64Encode(bytes) {
  return encodeBase64With(bytes, BASE64_ALPHABET, true);
}

function base64Decode(text) {
  return decodeBase64With(text, BASE64_ALPHABET, 'base64 input');
}

function base64urlEncode(bytes) {
  return encodeBase64With(bytes, BASE64URL_ALPHABET, false);
}

function base64urlDecode(text) {
  return decodeBase64With(text, BASE64URL_ALPHABET, 'base64url input');
}

// --- hex ----------------------------------------------------------------------
//
// `bytesToHex` / `hexToBytes` cover the digest-as-hex call sites (derivation cache,
// release identity, equality hash) that previously used Buffer `.toString('hex')`.

function bytesToHex(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    out += bytes[index].toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(text) {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw new TypeError('hex input must be an even-length string of hexadecimal digits');
  }
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export {
  base64Decode,
  base64Encode,
  base64urlDecode,
  base64urlEncode,
  bytesEqual,
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8DecodeLossy,
  utf8DecodeStrict,
  utf8Encode,
};
