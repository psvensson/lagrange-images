// The narrow host crypto/random primitive seam (ADR: host portability, bead
// lagrange-images-g58).
//
// Crypto is a true HOST PRIMITIVE seam, but lagrange-images retains ALL semantic
// ownership. This provider computes primitives ONLY. It is deliberately the
// narrowest contract the executed Object Environment acceptance closure needs —
// it is NOT modeled on the broad Node `node:crypto` API, and no host is asked to
// supply Node's personality.
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
// authenticated, parsing, and integrity-failure handling. This provider never
// sees a cursor — only key/iv/plaintext/ciphertext/tag.

import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';

function requireBytes(value, label, length = null) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be a Uint8Array`);
  if (length !== null && value.length !== length) {
    throw new TypeError(`${label} must be ${length} bytes, got ${value.length}`);
  }
  return value;
}

// The Node default/reference provider. It is the reference implementation of the
// contract: any second provider must produce identical results for identical
// inputs (differential proof), and identical security properties.
function createNodeCryptoProvider() {
  return Object.freeze({
    secureRandomBytes(length) {
      return new Uint8Array(randomBytes(length));
    },
    sha256(bytes) {
      return new Uint8Array(createHash('sha256').update(requireBytes(bytes, 'sha256 input')).digest());
    },
    aes256gcmEncrypt({key, iv, plaintext}) {
      requireBytes(key, 'AES-256-GCM key', 32);
      requireBytes(iv, 'AES-256-GCM iv', 12);
      requireBytes(plaintext, 'AES-256-GCM plaintext');
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final()]));
      const tag = new Uint8Array(cipher.getAuthTag());
      return {ciphertext, tag};
    },
    aes256gcmDecrypt({key, iv, ciphertext, tag}) {
      requireBytes(key, 'AES-256-GCM key', 32);
      requireBytes(iv, 'AES-256-GCM iv', 12);
      requireBytes(ciphertext, 'AES-256-GCM ciphertext');
      requireBytes(tag, 'AES-256-GCM tag', 16);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    },
    uuid() {
      return randomUUID();
    },
  });
}

export {
  createNodeCryptoProvider,
};
