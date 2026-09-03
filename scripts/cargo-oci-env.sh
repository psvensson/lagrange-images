#!/usr/bin/env bash
# Export the environment the real Cargo/rustc OCI proof reads. Source it, do not run it:
#
#   source scripts/cargo-oci-env.sh
#   node --test test/cargo-rustc-oci-real.test.js
#
# `npm run test:cargo-oci` does this for you. Without these variables the proof skips rather than
# fails, which is why a green `npm test` does not mean the real Cargo lane ran.
#
# Neither the pinned reference nor the container engine is repeated here: scripts/cargo-oci-setup.sh
# writes both, so this file cannot name a digest that was never fetched or an engine whose store
# does not hold it. To switch engines, re-run the setup script with LAGRANGE_OCI_CLI set.
LAGRANGE_CARGO_OCI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Both files, so a .integration/ left over from before the engine was recorded re-runs setup
# instead of silently falling back to an engine that may not hold the image.
if [ ! -f "$LAGRANGE_CARGO_OCI_ROOT/.integration/cargo-oci/image" ] \
  || [ ! -f "$LAGRANGE_CARGO_OCI_ROOT/.integration/cargo-oci/cli" ]; then
  echo "missing pinned Cargo/rustc image; run scripts/cargo-oci-setup.sh first" >&2
  return 1 2>/dev/null || exit 1
fi

export LAGRANGE_CARGO_OCI_INTEGRATION=1
export LAGRANGE_CARGO_OCI_IMAGE="$(cat "$LAGRANGE_CARGO_OCI_ROOT/.integration/cargo-oci/image")"
export LAGRANGE_OCI_CLI="$(cat "$LAGRANGE_CARGO_OCI_ROOT/.integration/cargo-oci/cli")"
