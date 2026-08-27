#!/usr/bin/env bash
# Export the environment the real foreign-runtime proofs read. Source it, do not run it:
#
#   source scripts/integration-env.sh
#   node --test test/opensmalltalk-cuis-real.test.js
#
# `npm run test:integration` does this for you. These variables exist only so the proofs
# can find the pinned assets; without them the tests skip rather than fail, which is why
# a green `npm test` does not mean the real proofs ran.
LAGRANGE_INTEGRATION_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$LAGRANGE_INTEGRATION_ROOT/.integration/opensmalltalk-vm/path" ]; then
  echo "missing .integration assets; run scripts/integration-setup.sh first" >&2
  return 1 2>/dev/null || exit 1
fi

export LAGRANGE_OPENSMALLTALK_INTEGRATION=1
export LAGRANGE_OPENSMALLTALK_VM_PATH="$LAGRANGE_INTEGRATION_ROOT/$(cat "$LAGRANGE_INTEGRATION_ROOT/.integration/opensmalltalk-vm/path")"
export LAGRANGE_CUIS_IMAGE_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/Cuis7.9-8090.image"
export LAGRANGE_CUIS_CHANGES_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/Cuis7.9-8090.changes"
export LAGRANGE_CUIS_SOURCES_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/Cuis7.8.sources"
export LAGRANGE_CUIS_JSON_PACKAGE_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/JSON.pck.st"
# Multi-package cluster (Bead lagrange-images-d57); see scripts/integration-setup.sh.
export LAGRANGE_CUIS_EXTENDEDCLIPBOARD_PACKAGE_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/ExtendedClipboard.pck.st"
export LAGRANGE_CUIS_FFI_PACKAGE_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/FFI.pck.st"
export LAGRANGE_CUIS_ALIEN_CORE_PACKAGE_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/Alien-Core.pck.st"
export LAGRANGE_CUIS_WEAKDICTIONARIES_PACKAGE_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/WeakDictionaries.pck.st"
export LAGRANGE_CUIS_GRAPHICS_FILES_ADDITIONAL_PACKAGE_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/Graphics-Files-Additional.pck.st"
export LAGRANGE_CUIS_COMPRESSION_PACKAGE_PATH="$LAGRANGE_INTEGRATION_ROOT/.integration/cuis/Compression.pck.st"
