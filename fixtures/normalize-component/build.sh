#!/usr/bin/env bash
# Rebuild normalize.component.wasm from the Rust source in this directory.
#
# The built component is committed so the test suite does not require a Rust
# toolchain. Run this only when src/lib.rs or wit/normalize.wit changes, then
# commit the regenerated .wasm alongside the source change.
#
# Requires: rustup target add wasm32-unknown-unknown, and wasm-tools on PATH.
set -euo pipefail
cd "$(dirname "$0")"

cargo build --target wasm32-unknown-unknown --release
wasm-tools component new \
  target/wasm32-unknown-unknown/release/lagrange_normalize.wasm \
  -o normalize.component.wasm

# The committed component is the contract the callable interface is checked against,
# so fail loudly if the produced signature ever drifts from what the tests expect.
wasm-tools component wit normalize.component.wasm
