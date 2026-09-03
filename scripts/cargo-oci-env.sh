#!/usr/bin/env bash
# Export the environment the real Cargo/rustc OCI proof reads. Source it, do not run it:
#
#   source scripts/cargo-oci-env.sh
#   node --test test/cargo-rustc-oci-real.test.js
#
# `npm run test:cargo-oci` does this for you. Without these variables the proof skips rather than
# fails, which is why a green `npm test` does not mean the real Cargo lane ran.
#
# The pinned reference is not repeated here: scripts/cargo-oci-setup.sh writes the image it pulled,
# so this file cannot name a digest that was never fetched.
LAGRANGE_CARGO_OCI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$LAGRANGE_CARGO_OCI_ROOT/.integration/cargo-oci/image" ]; then
  echo "missing pinned Cargo/rustc image; run scripts/cargo-oci-setup.sh first" >&2
  return 1 2>/dev/null || exit 1
fi

export LAGRANGE_CARGO_OCI_INTEGRATION=1
export LAGRANGE_CARGO_OCI_IMAGE="$(cat "$LAGRANGE_CARGO_OCI_ROOT/.integration/cargo-oci/image")"
export LAGRANGE_OCI_CLI="${LAGRANGE_OCI_CLI:-docker}"
