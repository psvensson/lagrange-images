// Test bootstrap: install the Node reference crypto provider for tests that
// exercise pure semantic functions (type fingerprints, release identity, version
// tokens) directly, WITHOUT going through a composition root. Production callers
// get a provider from their composition root (the Node root installs it at load;
// a portable host installs its own). Pure-model tests have no root, so they import
// this for the side effect. Idempotent and never overrides an installed provider.

import {getDefaultCryptoProvider, setDefaultCryptoProvider} from '../src/support/default-crypto.js';
import {createNodeCryptoProvider} from '../src/support/node-crypto-provider.js';

try {
  getDefaultCryptoProvider();
} catch {
  setDefaultCryptoProvider(createNodeCryptoProvider());
}
