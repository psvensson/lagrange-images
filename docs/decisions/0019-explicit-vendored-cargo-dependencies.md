# ADR 0019: explicit vendored Cargo dependencies

Status: accepted for the first third-party Cargo dependency slice.

## Problem

ADR 0018 proved that an explicit Rust source/manifest/lock graph can drive Cargo/rustc inside a digest-pinned OCI build environment and return raw WASM. That first provider deliberately rejected every other input representation.

A normal Cargo project soon needs dependencies that are not part of the root package. Allowing Cargo to fetch those dependencies from the network would break the explicit-input/toolchain-provenance model established by ADR 0017.

The next proof therefore needs a real Cargo-style vendored dependency while keeping:

```text
network = none
cargo build --frozen
explicit artifact graph only
```

## Decision

Extend the Cargo/rustc OCI provider with two Rust-specific artifact representations:

```text
rust/cargo-config-v1
rust/cargo-vendor-file-v1
```

The existing representations remain:

```text
rust/cargo-manifest-v1
rust/cargo-lock-v1
rust/source-v1
```

The provider still receives all of these only through the generic `ToolchainService` dependency closure. No Cargo/Rust semantics are added to the generic artifact or toolchain service.

## Why vendor files instead of a new archive format

The first dependency representation mirrors the materialized Cargo directory source directly.

A vendor file is an immutable CodeArtifact whose content is either text or bytes and whose metadata contains a safe workspace-relative path:

```js
{
  representation: 'rust/cargo-vendor-file-v1',
  content: textValue('...'), // or bytesValue(...)
  metadata: {
    path: 'vendor/example-1.2.3/src/lib.rs'
  }
}
```

This keeps the current slice simple:

- no new tar/archive parser
- no generic filesystem abstraction
- no assumption that all third-party files are UTF-8 text
- individual vendored files retain artifact identity/history
- graph/provenance can identify the exact files consumed by the build

If large real dependency graphs make per-file artifacts too granular, a later standard package/archive representation can be added from evidence rather than replacing the generic dependency model now.

## Cargo source replacement config

Vendored dependencies require exactly one `rust/cargo-config-v1` artifact.

For v1 this representation is intentionally narrow. Its content must equal the canonical crates.io directory-source replacement used by the provider:

```toml
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "vendor"
```

The provider writes this at:

```text
.cargo/config.toml
```

Arbitrary Cargo configuration is not accepted in this slice. A free-form config could redirect sources to undeclared directories baked into the toolchain image and thereby create hidden project inputs.

Later Cargo configuration features can receive explicit representations/contracts when a real use case requires them.

## Vendor layout

Every `rust/cargo-vendor-file-v1` path must have the shape:

```text
vendor/<package-directory>/<package-relative-path>
```

The package directory is one immediate child of `vendor/` and may not be hidden.

For each package directory the explicit file set must contain:

```text
Cargo.toml
.cargo-checksum.json
```

The provider groups files by package directory and validates the package before OCI execution.

## Checksum validation

`.cargo-checksum.json` is treated as part of the explicit dependency input.

The provider requires:

```text
package: null | lowercase SHA-256
files: package-relative path -> lowercase SHA-256
```

The `files` map must describe exactly every explicit package file except `.cargo-checksum.json` itself.

Before invoking Cargo the provider computes SHA-256 over the exact text/byte content of every vendored file and compares it with the checksum map.

Therefore these fail before container execution:

- missing vendored file
- extra vendored file not listed in the checksum
- checksum path with traversal/unsafe segments
- changed file content
- missing Cargo.toml
- missing `.cargo-checksum.json`
- malformed checksum data

The package checksum is retained for Cargo's registry/source-replacement semantics; this provider cannot independently reconstruct and verify the original registry `.crate` archive because that archive is not part of the v1 artifact graph.

## Project path separation

Root-package `rust/source-v1` paths may not overlap:

```text
Cargo.toml
Cargo.lock
.cargo/...
vendor/...
```

Cargo config and vendor paths are owned by their explicit artifact representations. This avoids one artifact representation silently shadowing another during workspace materialization.

Vendor paths continue to use the existing portable relative POSIX path rules: no absolute paths, backslashes, empty segments, `.` or `..`.

## Provider identity

The Cargo/rustc provider stable identity advances from:

```text
cargo-rustc-oci/v0
```

to:

```text
cargo-rustc-oci/v1
```

because the supported input graph and observable output metadata changed.

The runtime selection ID remains:

```text
rust/cargo-oci
```

The historical v0 identity constant remains exported, but newly created providers use v1.

## Output metadata

The raw WASM output remains:

```text
wasm-binary/v1
```

It now additionally records:

```text
cargoVendored: boolean
cargoVendoredPackages: integer
```

All manifest/source/lock/config/vendor artifacts still become ordinary `derivedFrom` provenance through `ToolchainService`.

The output does not keep vendor files as runtime dependencies merely because they were build dependencies.

## Third-party dependency proof

The repository test fixture now models an application that declares a versioned dependency on a separate vendored library package.

The explicit graph contains:

```text
Cargo.toml
Cargo.lock
src/main.rs
.cargo/config.toml artifact
vendor/<package>/Cargo.toml
vendor/<package>/src/lib.rs
vendor/<package>/binary asset
vendor/<package>/.cargo-checksum.json
```

The test runner inspects the fully materialized Cargo vendor layout and writes a real minimal WASM binary at Cargo's expected output location.

CI still injects the OCI runner, so the repository test does not claim that GitHub Actions launched Docker or actually compiled the fixture with rustc. The production/default `OciCliRunner` remains the real Docker/Podman execution path established in ADR 0018.

## No hidden dependency fetches

The build contract remains:

```text
explicit graph
  -> materialized root + vendor directory
  -> canonical source replacement
  -> cargo build --frozen
  -> OCI network none
```

The provider does not run `cargo vendor`, `cargo fetch`, `cargo update`, or another dependency-discovery/download step during the build.

Dependency acquisition/import is a separate concern from compilation.

## Current limitations

Not implemented yet:

- automatic import of crates.io `.crate` archives into vendor-file artifacts
- git dependency vendoring
- alternate/private registry source replacement
- validation of the package checksum against an original `.crate` archive
- toolchain derivation-key/result reuse
- callable interfaces for Rust-produced `wasm-binary/v1`
- WASM Component generation/import
- transactional multi-output installation

## Consequence

The Rust external-toolchain path can now represent a package dependency without network access or implicit host/toolchain state:

```text
root Rust artifacts
        +
explicit Cargo vendor artifacts
        -> Cargo/rustc in pinned OCI
        -> raw WASM
```

This is the first proof that the artifact graph can carry a package ecosystem dependency rather than only one self-contained source tree.
