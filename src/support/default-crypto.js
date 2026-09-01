// Default crypto provider registry (ADR: host portability, beads
// lagrange-images-g58, lagrange-images-16q). PORTABLE — no Node imports.
//
// The pure, synchronous semantic functions that need a host primitive
// (`typeFingerprint`, the composite codec fingerprint, `objectVersionToken`, the
// observation cursor) are called deep inside synchronous executor paths where no
// provider can be threaded through an argument list without a forbidden signature
// change. They therefore resolve the ACTIVE provider here.
//
// THIS MODULE NEVER IMPORTS THE NODE PROVIDER. Keeping `node-crypto-provider.js`
// out of this module's static closure is what lets a non-Node host load the whole
// portable runtime without touching `node:crypto`. The Node composition root
// (`src/runtime.js`) installs the Node reference provider exactly once, at
// composition time, via `installNodeCryptoProvider()` below; a non-Node host calls
// `setDefaultCryptoProvider(nativeProvider)` BEFORE any semantic work that needs
// UUID/SHA/AES.
//
// This is a process-wide default for the language-neutral pure functions — NOT a
// per-request authority or policy channel; the observation lane's per-install
// cursor secret remains the security-relevant input and is unaffected.

import {assertCryptoProvider} from './crypto-provider.js';

let activeDefault = null;

function getDefaultCryptoProvider() {
  if (activeDefault === null) {
    throw new TypeError(
      'no crypto provider installed: the Node composition root installs one automatically; '
      + 'a portable host must call setDefaultCryptoProvider(nativeProvider) before semantic work',
    );
  }
  return activeDefault;
}

function setDefaultCryptoProvider(provider) {
  activeDefault = assertCryptoProvider(provider);
}

// Test/reset hook: drop the active provider so the next install starts clean.
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
