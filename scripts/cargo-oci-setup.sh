#!/usr/bin/env bash
# Pull the digest-pinned Cargo/rustc toolchain image the real OCI proof compiles in.
#
# This is the single source of truth for that pin: .github/workflows/test.yml calls this script
# rather than repeating the reference, and scripts/cargo-oci-env.sh reads the reference back out
# of .integration/cargo-oci/image, so CI and a local checkout cannot drift.
#
# Usage:  scripts/cargo-oci-setup.sh
# Then:   npm run test:cargo-oci
#
# Re-running is cheap: the image layers are already in the local store.
set -euo pipefail
cd "$(dirname "$0")/.."

# Why this image: it is the only widely-maintained public image that already contains a Rust
# toolchain *and* the wasm32-unknown-unknown standard library. The official `rust` images ship only
# the host target, and installing a target needs the network the proof exists to prove it does not
# use. CosmWasm's optimizer is built from rust-lang/docker-rust (Alpine + Rust 1.86.0) with
# `rustup target add wasm32-unknown-unknown`; the proof uses it purely as a compiler environment
# and overrides its ENTRYPOINT, so nothing about contract optimization is involved.
#
# It is amd64-only. On an arm64 host, run the proof under an amd64 emulation-capable engine or skip
# it locally and read the CI lane instead.
#
# To move the pin: change the tag, re-resolve the digest with
#   docker manifest inspect --verbose cosmwasm/optimizer:<tag>
# and update both lines together. A digest without the tag it came from cannot be audited later.
CARGO_OCI_IMAGE_TAG=cosmwasm/optimizer:0.17.0
CARGO_OCI_IMAGE_DIGEST=sha256:7e0b9229c1a4118d0c9a2af2e7f5d95a91f264c26a2ce5681c779926e74d7f85

OCI_CLI="${LAGRANGE_OCI_CLI:-docker}"
# `%` (shortest suffix), not `%%`: a registry-qualified or port-bearing pin such as
# registry.example:5000/rust/tc:1.90 contains more than one colon, and `%%` would strip from the
# first one and pull a different repository entirely.
IMAGE="${CARGO_OCI_IMAGE_TAG%:*}@${CARGO_OCI_IMAGE_DIGEST}"

if ! command -v "$OCI_CLI" >/dev/null 2>&1; then
  echo "no OCI CLI on PATH: $OCI_CLI (set LAGRANGE_OCI_CLI=podman to use Podman)" >&2
  exit 1
fi

# Registries rate limit anonymous pulls, and this lane is required, so a single transient 429 must
# not fail the build. Layers already pulled are not re-fetched by a retry.
attempt=1
until "$OCI_CLI" pull "$IMAGE"; do
  if [ "$attempt" -ge 4 ]; then
    echo "could not pull $IMAGE after $attempt attempts" >&2
    exit 1
  fi
  echo "pull failed, retrying ($attempt)" >&2
  sleep $((attempt * 5))
  attempt=$((attempt + 1))
done

# Pulling by digest already guarantees the content, but the toolchain the proof claims to have used
# is worth stating out loud in the log next to the digest that produced it.
"$OCI_CLI" run --rm --network none --entrypoint cargo "$IMAGE" --version
"$OCI_CLI" run --rm --network none --entrypoint rustup "$IMAGE" target list --installed

mkdir -p .integration/cargo-oci
printf '%s\n' "$IMAGE" > .integration/cargo-oci/image
# The engine is recorded for the same reason the reference is: the image now exists in *this*
# CLI's store and nowhere else. Without this, `LAGRANGE_OCI_CLI=podman scripts/cargo-oci-setup.sh`
# would pull into Podman and leave the proof defaulting back to Docker, which fails with a missing
# image after a setup that reported success.
printf '%s\n' "$OCI_CLI" > .integration/cargo-oci/cli

echo
echo "Cargo/rustc OCI toolchain ready: $IMAGE"
echo "Run: npm run test:cargo-oci"
