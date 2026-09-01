// Default crypto provider registry (ADR: host portability, bead lagrange-images-g58).
//
// The pure, synchronous semantic functions that need a host primitive
// (`typeFingerprint`, the composite codec fingerprint, `objectVersionToken`, the
// observation cursor) are called deep inside synchronous executor paths where no
// provider can be threaded through an argument list without a forbidden signature
// change. They therefore resolve the ACTIVE provider here.
//
// The default is the Node reference provider (`createNodeCryptoProvider`), so the
// existing Node runtime behaves byte-for-byte identically with zero wiring. A
// non-Node host calls `setDefaultCryptoProvider(...)` ONCE, before executing the
// closure, to supply its own synchronous primitives. This is a process-wide
// default for the language-neutral pure functions — NOT a per-request authority
// or policy channel; the observation lane's per-install cursor secret remains the
// security-relevant input and is unaffected.
//
// Executor factories that already accept explicit options (e.g.
// `createImageObservationBindingV1Executor`) take an optional `crypto` override
// for direct injection in tests/cross-provider proofs; when omitted they fall
// back to the active default here.

import {createNodeCryptoProvider} from './crypto-provider.js';

let activeDefault = null;

function getDefaultCryptoProvider() {
  if (activeDefault === null) activeDefault = createNodeCryptoProvider();
  return activeDefault;
}

function setDefaultCryptoProvider(provider) {
  for (const method of ['secureRandomBytes', 'sha256', 'aes256gcmEncrypt', 'aes256gcmDecrypt', 'uuid']) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new TypeError(`crypto provider must supply ${method}()`);
    }
  }
  activeDefault = provider;
}

// Test/reset hook: restore the lazily-built Node reference provider.
function resetDefaultCryptoProvider() {
  activeDefault = null;
}

// Convenience for the many identity-minting call sites (binding/block/object ids)
// that only need a random UUID: resolve the active provider's uuid(). This keeps
// node:crypto's randomUUID out of every semantic module without threading a
// provider argument through pure identity helpers.
function uuid() {
  return getDefaultCryptoProvider().uuid();
}

export {
  getDefaultCryptoProvider,
  resetDefaultCryptoProvider,
  setDefaultCryptoProvider,
  uuid,
};
