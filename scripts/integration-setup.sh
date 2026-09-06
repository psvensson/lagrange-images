#!/usr/bin/env bash
# Download the pinned OpenSmalltalkVM, Cuis image/changes/sources and the pinned Cuis packages
# (JSON, YAXO and the multi-package cluster) into .integration/ so the real foreign-runtime proofs
# can run.
#
# This is the single source of truth for those pins: .github/workflows/test.yml calls this
# script rather than repeating the URLs, so CI and a local checkout cannot drift.
#
# Usage:  scripts/integration-setup.sh
# Then:   npm run test:integration
#
# Re-running is cheap: existing files with the expected digest are left alone.
set -euo pipefail
cd "$(dirname "$0")/.."

VM_RELEASE=202606270913
VM_ARCHIVE_SHA256=dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba
CUIS_COMMIT=6bcee3f38ce037c9714b997ccd3b5b3ff62965c8
CUIS_IMAGE_BLOB=523dc5e74b5b550922b56ff2406415c19700ee8e
CUIS_JSON_BLOB=47fab65d0d9017d706aa07d39ab0451619488ccd

# The ADR 0085 M4 forcing application (Bead lagrange-images-xxm; selected and validated by
# lagrange-images-moq). YAXO is an independently authored upstream XML package whose parse result
# is a graph of instances of ITS OWN classes, which is the property the JSON harness structurally
# cannot supply. Same distribution commit as everything above, so no new upstream trust anchor is
# introduced; license MIT, verified at that commit. Tests-YAXO is the package's own upstream test
# package and is fetched because the behaviour oracle is upstream-authored rather than invented
# here. Pinned by Git blob hash exactly like JSON.
#   Cuis-Base -> YAXO -> Tests-YAXO   (YAXO declares no !requires: line at all)
CUIS_YAXO_BLOB=67d670ed38cc136d88afdf7e0df5bf8bc6519087
CUIS_TESTS_YAXO_BLOB=8c50cbe6f29f3f4b25c883511eb905e44120ec5e

# Multi-package Cuis cluster (Bead lagrange-images-d57): a real upstream dependency DAG
# with a diamond, used to prove dependency ordering / Feature-requirement resolution and
# failure diagnostics through the toolchain. All from the same pinned commit, pinned by
# Git blob hash exactly like JSON.
#   ExtendedClipboard -> FFI + Graphics-Files-Additional
#   FFI               -> WeakDictionaries + Alien-Core
#   Alien-Core        -> WeakDictionaries            (diamond on WeakDictionaries)
#   Graphics-Files-Additional -> Compression
#   WeakDictionaries, Compression -> (base)
CUIS_EXTENDEDCLIPBOARD_BLOB=d561a0dcedf37e6bd93c15cb07498c34ce6d3c5f
CUIS_FFI_BLOB=76bcc869cb66a602d4658465177913269697118b
CUIS_ALIEN_CORE_BLOB=59a2b4bdaa0f21287e3af3479cc31f6a71957758
CUIS_WEAKDICTIONARIES_BLOB=773620a6f3c15bb21deca5e9895ecfac881c8b64
CUIS_GRAPHICS_FILES_ADDITIONAL_BLOB=6cddf265949b90fd58d0fea0498df6a1c3594685
CUIS_COMPRESSION_BLOB=243d8265b411fc36a72dd101f21a18e7c94b2d87

CUIS_ROOT="https://raw.githubusercontent.com/Cuis-Smalltalk/Cuis-Smalltalk-Dev/$CUIS_COMMIT"
CUIS_IMAGE_ROOT="$CUIS_ROOT/CuisImage"

mkdir -p .integration/opensmalltalk-vm .integration/cuis

fetch() {
  local url="$1" output="$2" tmp="$2.part"
  if [ -f "$output" ]; then
    echo "have $output"
    return 0
  fi
  echo "fetching $output"
  rm -f "$tmp"
  # --retry-all-errors because curl does not retry an HTTP 429 without it, and these pinned
  # assets are fetched often enough to be rate limited by the host.
  # The partial is removed explicitly rather than relying on errexit, because a caller that
  # invokes fetch inside a conditional disables errexit for the whole call — which would let a
  # doomed `mv` run and bury curl's real diagnostic under "cannot stat".
  if ! curl \
    --fail \
    --location \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 2 \
    --output "$tmp" \
    "$url"; then
    rm -f "$tmp"
    return 1
  fi
  # Renamed only on success. Otherwise a failed or truncated transfer leaves the output file
  # behind, and the next run's "have $output" check treats it as a good asset — turning one
  # transient failure into a persistently broken checkout.
  mv "$tmp" "$output"
}

# The VM archive is content-addressed by sha256; the Cuis files are pinned to a Git commit
# and verified by Git blob hash, which is what upstream publishes them as.
fetch "https://github.com/OpenSmalltalk/opensmalltalk-vm/releases/download/$VM_RELEASE/squeak.cog.spur_linux64x64.tar.gz" \
  .integration/opensmalltalk-vm/vm.tar.gz
echo "$VM_ARCHIVE_SHA256  .integration/opensmalltalk-vm/vm.tar.gz" | sha256sum --check --strict
tar -xzf .integration/opensmalltalk-vm/vm.tar.gz -C .integration/opensmalltalk-vm

fetch "$CUIS_IMAGE_ROOT/Cuis7.9-8090.image" .integration/cuis/Cuis7.9-8090.image
test "$(git hash-object .integration/cuis/Cuis7.9-8090.image)" = "$CUIS_IMAGE_BLOB"

fetch "$CUIS_IMAGE_ROOT/Cuis7.9-8090.changes" .integration/cuis/Cuis7.9-8090.changes
fetch "$CUIS_IMAGE_ROOT/Cuis7.8.sources" .integration/cuis/Cuis7.8.sources

fetch "$CUIS_ROOT/Packages/Features/JSON.pck.st" .integration/cuis/JSON.pck.st
test "$(git hash-object .integration/cuis/JSON.pck.st)" = "$CUIS_JSON_BLOB"

# The M4 forcing application (see the pin block above).
fetch "$CUIS_ROOT/Packages/Features/YAXO.pck.st" .integration/cuis/YAXO.pck.st
test "$(git hash-object .integration/cuis/YAXO.pck.st)" = "$CUIS_YAXO_BLOB"
fetch "$CUIS_ROOT/Packages/Features/Tests-YAXO.pck.st" .integration/cuis/Tests-YAXO.pck.st
test "$(git hash-object .integration/cuis/Tests-YAXO.pck.st)" = "$CUIS_TESTS_YAXO_BLOB"

# The multi-package cluster (see the pin block above).
fetch "$CUIS_ROOT/Packages/System/ExtendedClipboard.pck.st" .integration/cuis/ExtendedClipboard.pck.st
test "$(git hash-object .integration/cuis/ExtendedClipboard.pck.st)" = "$CUIS_EXTENDEDCLIPBOARD_BLOB"
fetch "$CUIS_ROOT/Packages/System/FFI.pck.st" .integration/cuis/FFI.pck.st
test "$(git hash-object .integration/cuis/FFI.pck.st)" = "$CUIS_FFI_BLOB"
fetch "$CUIS_ROOT/Packages/System/Alien-Core.pck.st" .integration/cuis/Alien-Core.pck.st
test "$(git hash-object .integration/cuis/Alien-Core.pck.st)" = "$CUIS_ALIEN_CORE_BLOB"
fetch "$CUIS_ROOT/Packages/System/WeakDictionaries.pck.st" .integration/cuis/WeakDictionaries.pck.st
test "$(git hash-object .integration/cuis/WeakDictionaries.pck.st)" = "$CUIS_WEAKDICTIONARIES_BLOB"
fetch "$CUIS_ROOT/Packages/Features/Graphics-Files-Additional.pck.st" .integration/cuis/Graphics-Files-Additional.pck.st
test "$(git hash-object .integration/cuis/Graphics-Files-Additional.pck.st)" = "$CUIS_GRAPHICS_FILES_ADDITIONAL_BLOB"
fetch "$CUIS_ROOT/Packages/Features/Compression.pck.st" .integration/cuis/Compression.pck.st
test "$(git hash-object .integration/cuis/Compression.pck.st)" = "$CUIS_COMPRESSION_BLOB"

VM_PATH="$(find .integration/opensmalltalk-vm -type f -name squeak -perm -111 -print -quit)"
if [ -z "$VM_PATH" ]; then
  echo 'Could not find executable squeak in pinned OpenSmalltalkVM archive' >&2
  find .integration/opensmalltalk-vm -maxdepth 4 -type f -print >&2
  exit 1
fi
printf '%s\n' "$VM_PATH" > .integration/opensmalltalk-vm/path

echo
echo "integration assets ready. Run: npm run test:integration"
