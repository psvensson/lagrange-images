#!/usr/bin/env bash
# Download the pinned OpenSmalltalkVM, Cuis image/changes/sources and JSON package into
# .integration/ so the real foreign-runtime proofs can run.
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

CUIS_ROOT="https://raw.githubusercontent.com/Cuis-Smalltalk/Cuis-Smalltalk-Dev/$CUIS_COMMIT"
CUIS_IMAGE_ROOT="$CUIS_ROOT/CuisImage"

mkdir -p .integration/opensmalltalk-vm .integration/cuis

fetch() {
  local url="$1" output="$2"
  if [ -f "$output" ]; then
    echo "have $output"
    return 0
  fi
  echo "fetching $output"
  curl --fail --location --retry 3 --output "$output" "$url"
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

VM_PATH="$(find .integration/opensmalltalk-vm -type f -name squeak -perm -111 -print -quit)"
if [ -z "$VM_PATH" ]; then
  echo 'Could not find executable squeak in pinned OpenSmalltalkVM archive' >&2
  find .integration/opensmalltalk-vm -maxdepth 4 -type f -print >&2
  exit 1
fi
printf '%s\n' "$VM_PATH" > .integration/opensmalltalk-vm/path

echo
echo "integration assets ready. Run: npm run test:integration"
