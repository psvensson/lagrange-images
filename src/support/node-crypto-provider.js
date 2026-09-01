// The Node reference implementation of the narrow host crypto/random primitive
// contract defined in `src/support/crypto-provider.js` (beads lagrange-images-g58,
// lagrange-images-16q).
//
// This module is the ONLY place the contract is bound to `node:crypto`. It is
// imported ONLY by the Node composition root (`src/runtime.js` via
// `default-crypto.js`'s Node bootstrap) — NEVER by any module in the portable
// runtime's static transitive closure. A non-Node host supplies its own
// synchronous provider through `setDefaultCryptoProvider(...)` and never loads
// this file.
//
// The contract itself, and all semantic policy (cursor format, AES-GCM IV/tag
// layout, what is authenticated, key derivation), live in the portable modules;
// see `src/support/crypto-provider.js` for the contract terms.

import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import {assertCryptoProvider} from './crypto-provider.js';

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
  return assertCryptoProvider({
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
