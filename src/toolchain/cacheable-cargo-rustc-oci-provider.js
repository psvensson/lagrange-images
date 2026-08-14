import {createCargoRustcOciProvider as createBaseCargoRustcOciProvider} from './cargo-rustc-oci-provider.js';

const CARGO_RUSTC_OCI_CACHE_CONTRACT_V0 = 'cargo-rustc-oci-cache/v0';

function createCacheableCargoRustcOciProvider(options = {}) {
  const provider = createBaseCargoRustcOciProvider(options);
  return Object.freeze({
    ...provider,
    cacheKey() {
      return Object.freeze({
        contract: CARGO_RUSTC_OCI_CACHE_CONTRACT_V0,
        ociImage: provider.image,
      });
    },
  });
}

export {
  CARGO_RUSTC_OCI_CACHE_CONTRACT_V0,
  createCacheableCargoRustcOciProvider,
};
