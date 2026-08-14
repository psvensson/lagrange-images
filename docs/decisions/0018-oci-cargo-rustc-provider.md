# ADR 0018: first OCI-backed Cargo/rustc provider

Status: accepted for the first real external-toolchain provider.

## Problem

ADR 0017 added explicit artifact dependencies plus a generic `ToolchainProviderRegistry` / `ToolchainService`, but the only proof provider was in-process. The next architectural test is whether a mature compiler ecosystem can run outside Lagrange Images without changing the generic artifact model.

Rust is the first target because the platform should reuse Cargo and `rustc`, not implement another Rust compiler.

## Decision

Add a real OCI-backed Cargo/rustc provider on top of `lagrange-toolchain-provider/v0`.

The provider is created explicitly:

```js
const provider = createCargoRustcOciProvider({
  image: 'registry.example/rust-wasm@sha256:<digest>',
});
```

and registered through the existing generic runtime seam:

```js
toolchainProviders: [
  [CARGO_RUSTC_OCI_PROVIDER_ID, provider],
]
```

There is no Rust-specific branch in `ToolchainService`.

## Artifact conventions

The first provider recognizes only:

```text
rust/cargo-manifest-v1
rust/cargo-lock-v1
rust/source-v1
```

The toolchain invocation has exactly one root, and that root must be the Cargo manifest artifact.

The explicit dependency closure must contain:

- exactly one Cargo manifest
- exactly one Cargo lock artifact
- one or more Rust source artifacts

A Rust source artifact stores its portable project path in non-reference metadata:

```js
metadata: {path: 'src/main.rs'}
```

Paths must be relative POSIX paths and may not contain empty, `.` or `..` segments or backslashes. This prevents an imported source artifact from escaping the temporary build workspace.

Unknown input representations fail explicitly. The provider does not silently ignore a JAR, native library, crate archive or other dependency it does not yet know how to materialize.

## Closed build inputs

The first provider deliberately uses a closed build environment:

```text
Cargo.lock required
cargo build --frozen
OCI network = none
```

`--frozen` is the Cargo contract that combines locked dependency resolution with offline operation.

This means v0 does not yet claim arbitrary crates.io dependency support. A future third-party-crate proof should materialize vendored/package artifacts and Cargo configuration explicitly into the artifact graph rather than allow hidden network fetches.

The OCI image may contain the compiler/toolchain itself, but project/library inputs should remain explicit graph inputs.

## OCI image identity

Build images must be pinned by digest:

```text
...@sha256:<64 lowercase hex digits>
```

Tags alone are rejected.

The provider stable identity includes:

```text
cargo-rustc-oci/v0
OCI image sha256 digest
```

The full pinned image reference and digest are also recorded on the produced artifact metadata.

This does not yet implement toolchain-result caching, but it establishes the identity material that a later derivation key must include.

## Target contract

The caller supplies the build target explicitly:

```js
{
  representation: 'wasm-binary/v1',
  triple: '...',
  binary: '...',
  profile: 'release' | 'debug',
  package: '...' // optional
}
```

The provider does not install Rust targets dynamically. The pinned toolchain image must already contain the requested target and whatever compiler/runtime support the build requires.

The first optional Cargo feature controls are:

```text
features[]
noDefaultFeatures
allFeatures
```

Arbitrary Cargo command-line injection is intentionally not exposed.

## Output is raw WASM, not the Lagrange ABI

Successful builds produce:

```text
wasm-binary/v1
```

with a bytes Value containing a validated version-1 WebAssembly binary.

This representation is deliberately different from:

```text
wasm-module/v1
```

which already means an executable module obeying the current Lagrange Value-handle/import/effect metadata contract.

A Cargo-produced module is therefore imported as portable executable bytes without pretending it is already callable through `ActivationExecutor`.

A later callable/component/ABI adapter can turn suitable foreign WASM into an executable image interface.

## Workspace materialization

For each invocation the provider:

1. creates a private temporary host directory
2. writes `Cargo.toml`
3. writes `Cargo.lock`
4. writes each explicit Rust source artifact at its declared safe relative path
5. invokes the OCI runner with the workspace bind-mounted at `/workspace`
6. reads the expected Cargo WASM output
7. validates the WASM magic/version header
8. returns the bytes through the normal toolchain provider result
9. removes the temporary workspace in a `finally` path

The temporary filesystem is build machinery, not canonical project state.

## OCI runner

`OciCliRunner` is a small host execution adapter for Docker/Podman-style CLIs.

It constructs argv directly and does not invoke a shell.

The default run shape is conceptually:

```text
<oci-cli> run --rm
  --network none
  --mount type=bind,src=<workspace>,dst=/workspace
  --workdir /workspace
  --user <host uid>:<host gid>   # where available
  --env CARGO_HOME=/tmp/...
  --env HOME=/tmp/...
  <digest-pinned image>
  cargo build ...
```

Running with the host uid/gid where available keeps bind-mounted build outputs removable by the host process. The runner is injectable so tests and alternative OCI engines do not change the Cargo provider contract.

The build container is still a **toolchain environment**, not a foreign runtime. It disappears after compilation.

## Failure semantics

A nonzero Cargo/container exit produces `CargoRustcOciBuildError` and no toolchain outputs are persisted.

Missing expected output or bytes that are not a version-1 WASM binary also fail explicitly.

`ToolchainService` continues to own output persistence/provenance after the provider returns successfully.

## Diagnostics

OCI stdout/stderr are returned as transient Cargo diagnostics.

They are not embedded automatically into durable artifact metadata.

## CI and real execution

Repository CI does not require Docker or network access.

Tests inject an OCI runner that inspects the real materialized workspace and writes a valid minimal WASM binary at the path Cargo would produce. Separate runner tests verify Docker/Podman-style argv construction.

The default `OciCliRunner` is real host code and invokes the configured OCI CLI when the provider is used outside those tests.

## Current limitations

Not implemented yet:

- vendored/crate-package materialization for third-party Cargo dependencies
- Cargo registry/network resolution
- toolchain derivation-key/result reuse
- callable interfaces for `wasm-binary/v1`
- WASM Component generation/import
- mapping arbitrary Rust ABI types to image Values
- execution/placement of the resulting raw WASM through Lagrange
- transactional multi-output toolchain installation

## Consequence

The architecture has now crossed the important boundary from an abstract external-toolchain protocol to a real existing compiler ecosystem:

```text
image artifact graph
  -> Cargo/rustc inside digest-pinned OCI
  -> imported raw WASM artifact
```

No Rust parser/compiler was added to Lagrange Images, and the generic `ToolchainService` did not need Rust- or OCI-specific semantics.
