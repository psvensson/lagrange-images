// The narrow host crypto/random primitive contract (ADR: host portability, beads
// lagrange-images-g58, lagrange-images-16q). PORTABLE — no Node imports.
//
// Crypto is a true HOST PRIMITIVE seam, but lagrange-images retains ALL semantic
// ownership. A provider computes primitives ONLY. The contract is deliberately the
// narrowest the executed portable-client acceptance closure needs — it is NOT
// modeled on the broad Node `node:crypto` API, and no host is asked to supply
// Node's personality.
//
// THE CONTRACT IS SYNCHRONOUS. `typeFingerprint` (inside the synchronous
// `packCompositeValue`), `objectVersionToken`, and the observation cursor
// `encode`/`decode` all run deep inside synchronous executor code paths, so an
// async provider contract (e.g. WebCrypto) would not be injectable there without
// a forbidden semantic/IO change. A synchronous contract is exactly what a native
// JS host (Node crypto, a native SHA-256/AES binding, a seeded test provider) can
// supply directly. Hosts whose only crypto is async are NOT a target of this
// seam; that is a separate finding to report, not to shim over.
//
// All byte inputs/outputs are `Uint8Array` (never a Node Buffer). Semantics:
//
//   secureRandomBytes(length)      -> Uint8Array  cryptographically secure random
//   sha256(bytes)                  -> Uint8Array(32)  raw digest bytes
//   aes256gcmEncrypt({key, iv, plaintext}) -> {ciphertext, tag}   both Uint8Array;
//                                            key 32 bytes, iv 12 bytes, tag 16 bytes
//   aes256gcmDecrypt({key, iv, ciphertext, tag}) -> Uint8Array plaintext; throws on
//                                            authentication/integrity failure
//   uuid()                         -> string  RFC 4122 version 4 (random) UUID
//
// POLICY LIVES ABOVE. `image-observation-binding` alone decides the cursor format,
// the AES-GCM policy (key derivation, IV length, tag layout), what is
// authenticated, parsing, and integrity-failure handling. A provider never sees a
// cursor — only key/iv/plaintext/ciphertext/tag.
//
// IMPLEMENTATIONS. The Node reference implementation is `node-crypto-provider.js`
// (imported only by the Node composition root). This module stays import-clean so
// the portable runtime's static closure never touches `node:crypto`.

const REQUIRED_METHODS = Object.freeze([
  'secureRandomBytes',
  'sha256',
  'aes256gcmEncrypt',
  'aes256gcmDecrypt',
  'uuid',
]);

// Validate that a candidate supplies the full contract and freeze it. Every
// provider — the Node reference and any host-supplied one — passes through here so
// the contract has exactly one definition.
function assertCryptoProvider(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('crypto provider must be an object');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof candidate[method] !== 'function') {
      throw new TypeError(`crypto provider must supply ${method}()`);
    }
  }
  return Object.freeze(candidate);
}

export {
  REQUIRED_METHODS as CRYPTO_PROVIDER_METHODS,
  assertCryptoProvider,
};
