import {createCargoRustcOciProvider as createBaseCargoRustcOciProvider} from './cargo-rustc-oci-provider.js';

// The cache contract names the *computation* a persisted derivation stands for, not merely the
// inputs it consumed. It must move whenever what the runner executes for identical inputs changes,
// or one contract identifier ends up naming results produced under two different execution
// semantics — and a record from the old semantics becomes admissible for the new ones.
//
// v0: the image's declared ENTRYPOINT still participated in choosing the container program.
// v1: the requested program is authoritative and the ENTRYPOINT is neutralized (ADR 0077); the
//     bump is ADR 0078. The v0 constant stays exported as historical identity only.
const CARGO_RUSTC_OCI_CACHE_CONTRACT_V0 = 'cargo-rustc-oci-cache/v0';
const CARGO_RUSTC_OCI_CACHE_CONTRACT_V1 = 'cargo-rustc-oci-cache/v1';

function createCacheableCargoRustcOciProvider(options = {}) {
  const provider = createBaseCargoRustcOciProvider(options);
  return Object.freeze({
    ...provider,
    cacheKey() {
      return Object.freeze({
        contract: CARGO_RUSTC_OCI_CACHE_CONTRACT_V1,
        ociImage: provider.image,
      });
    },
  });
}

export {
  CARGO_RUSTC_OCI_CACHE_CONTRACT_V0,
  CARGO_RUSTC_OCI_CACHE_CONTRACT_V1,
  createCacheableCargoRustcOciProvider,
};
