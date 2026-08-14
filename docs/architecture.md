# Architecture

## Core idea

An image is a long-lived graph of objects and artifacts with stable identity, state and history. It may be active on one machine, distributed across a cluster, asleep, snapshotted, branched or inspected without changing what an object or artifact is.

The architecture separates five concerns:

1. image semantics — values, identity, refs, shapes, objects, artifacts, roots, history, snapshots, projects
2. language semantics — behavior, syntax, language-specific meaning, debugging, compatibility layers
3. compiler/tooling substrate — artifact dependencies, compilation groups, toolchain providers, derivation/reuse, executable representations
4. execution — dispatch, activations, local/remote execution, capabilities, foreign/runtime boundaries
5. substrate — durable records, transactions, placement, replication and compute

Only the fifth layer should know it is running on Lagrange. Artifact/toolchain semantics must not assume a source language.

## Layers

```text
tools / REPL / browser / graphical shell / HTTP
                    |
language personalities: Smalltalk | Lisp | Java | Rust | ...
                    |
compiler/tooling: artifact graph | groups | providers | derivation cache
                    |
language-neutral runtime: callables/Blocks | dispatch | activations
                    |
image graph: Values | refs | shapes | objects | artifacts | history | roots
                    |
backend contract: mock | Lagrange adapter
                    |
Lagrange: distributed data + WASM compute
```

Languages may skip or specialize parts of the stack. Rust can reuse Cargo/`rustc`; Java can use existing Java runtimes/toolchains; Lisp may retain macro-expanded semantic artifacts. They can still share image identity/history, projects, capabilities, artifact dependencies and placement.

## Boundaries worth protecting

**Shape is not behavior.** Shape describes durable physical slots. Behavior is an optional language/runtime ref.

**Reference is not authority.** A ref identifies an object/artifact. Capability and principal context decide access.

**Identity is not revision.** Ordinary refs name evolving object identities. Pinned refs add historical revision. Backend row versions are concurrency metadata.

**Source is not the artifact boundary.** Source is one artifact representation. Bytecode, JARs, WASM, manifests and precompiled libraries may be legitimate durable inputs.

**Dependency is not provenance.** `CodeArtifact.dependencies` describes role-tagged artifact relationships. `derivedFrom` describes how an immutable result was produced.

**Semantic code is not executable code.** Rebuildable execution artifacts must not become the only surviving program meaning. Binary-only imported dependencies may themselves be canonical artifacts.

**Toolchain selection is not toolchain identity.** A provider ID selects an implementation; `provider.identity` names the stable implementation/toolchain generation for provenance and future cache equivalence.

**Toolchain is not language semantics.** Supporting Rust does not mean implementing Rust. Supporting Java does not mean implementing a JVM/compiler.

**Build OCI is not foreign-runtime OCI.** A compiler container disappears after producing artifacts. A JVM/native/Python compatibility container remains part of execution and lifecycle policy.

**Raw foreign WASM is not the Lagrange WASM ABI.** `wasm-binary/v1` is opaque validated foreign WASM. `wasm-module/v1` is the current Lagrange Value-handle/import/effect contract.

**Compilation group is not a language construct.** Grouping belongs to compiler/toolchain policy.

**Physical module is not function identity.** Several semantic members may share one WASM module while keeping distinct function/Block identity.

**Compiled host module is not durable code identity.** `WebAssembly.Module` is a runtime cache.

**Pooled instance is not activation state.** Reused `WebAssembly.Instance` objects may hold only state permitted by an explicit reset/reuse contract.

## Durable artifact graph

The programming model is a durable artifact/dependency graph:

```text
source -------------------+
semantic / IR ------------+
bytecode / package -------+
precompiled library ------+----> compiler/toolchain
WASM component/module ----+            |
manifest / lock / config -+            v
                                    derived artifacts
                                    + interfaces
```

`CodeArtifact` is the current bootstrap carrier:

```text
CodeArtifact
  representation
  content
  dependencies[]: role + artifact ref
  derivedFrom[]
  metadata
```

Dependency roles are language/tooling policy, not generic image semantics.

## Compiler and toolchain seams

There are three related paths:

```text
source representation + target
  -> CodeCompilerRegistry

group policy + target
  -> CompilationGroupCompilerRegistry

provider selection ID
  -> ToolchainProviderRegistry
  -> ToolchainService
```

The first two feed `CompilationService` and already support compiler-declared derivation reuse.

`ToolchainService` resolves explicit transitive artifact dependencies and sends frozen build-relevant snapshots plus target/options to a provider. The generic provider context has no ambient `ImageService`.

Providers return named output artifact descriptions plus transient diagnostics. The service owns persistence and provenance:

```text
resolved input graph
  -> provider.run(...)
  -> output descriptions
  -> durable CodeArtifacts
       derivedFrom = resolved inputs
       dependencies = provider-declared output dependencies
       metadata = provider selection/identity/protocol + output metadata
```

## First external provider: Cargo/rustc in OCI

The generic provider contract is now exercised by a real existing compiler ecosystem:

```text
rust/cargo-manifest-v1
  -> rust/source-v1
  -> rust/cargo-lock-v1
  -> optional explicit Cargo vendor artifacts
        |
        v
 digest-pinned OCI image
        |
 cargo build --frozen
        |
        v
   wasm-binary/v1
```

The Rust/Cargo conventions live in `cargo-rustc-oci-provider.js`, not in `ToolchainService` or the image graph.

The provider:

- requires a digest-pinned OCI image
- requires one manifest root, one lock artifact and one or more Rust source artifacts
- materializes safe relative source paths into a temporary workspace
- disables the container network
- runs Cargo frozen/offline
- expects the requested Rust target to already exist in the toolchain image
- validates and imports the resulting raw WASM
- removes the temporary workspace in a `finally` path

Unknown artifact representations fail rather than being ignored.

### Explicit Cargo directory-source dependencies

Third-party registry-style dependencies can now be represented without build-time network discovery:

```text
rust/cargo-config-v1
rust/cargo-vendor-file-v1
```

The v1 Cargo config contract is intentionally narrow and materializes only:

```toml
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "vendor"
```

A vendor file may contain text or bytes and carries a safe explicit path such as:

```text
vendor/example-1.2.3/Cargo.toml
vendor/example-1.2.3/src/lib.rs
vendor/example-1.2.3/.cargo-checksum.json
```

Package directories are immediate non-hidden children of `vendor/`. Before OCI execution the provider groups every explicit vendor file by package directory, requires `Cargo.toml` and `.cargo-checksum.json`, requires the checksum file to describe exactly all other explicit package files, and verifies every SHA-256 over the actual text/byte artifact content.

Root-package `rust/source-v1` paths cannot overlap `.cargo/` or `vendor/`; those locations belong to the explicit Cargo config/vendor representations.

The provider still does not run `cargo vendor`, `cargo fetch` or another acquisition step. Import/acquisition of third-party packages remains separate from compilation.

Because this changes the provider input contract, newly created providers identify as:

```text
cargo-rustc-oci/v1/<image-digest>
```

The output remains `wasm-binary/v1`, with all manifest/source/lock/config/vendor inputs preserved as normal `derivedFrom` provenance.

### OCI host runner

`OciCliRunner` is a small Docker/Podman-style adapter. It constructs argv directly without a shell and uses:

```text
run --rm
--network none
--mount <temporary workspace> -> /workspace
--workdir /workspace
--user <host uid>:<host gid> where available
<digest-pinned image>
<toolchain command...>
```

The runner is injectable; CI substitutes the runner while still testing real workspace materialization and WASM import.

## OCI integration roles

### Build/toolchain OCI — implemented for Cargo

```text
artifact graph -> OCI compiler/package manager -> derived artifact
```

The build image is toolchain identity/provenance and disappears after compilation.

### Foreign-runtime OCI — later

```text
image callable/interface -> adapter -> live JVM/native/Python/etc. runtime
```

Objects in a foreign heap are not automatically durable image objects. Foreign runtime integration needs explicit callable interfaces, capabilities, failure semantics and placement/lifecycle policy.

## Compiled libraries and interfaces

Precompiled libraries should remain reusable dependencies where their compatibility contract permits it.

- Java should retain JAR/class dependencies rather than decompile them.
- Rust can now carry explicit vendored source-package files; standard package/archive import can be layered on later.
- Rust should still favor stable portable ABIs/components for long-lived binary dependencies.
- WASM Components are attractive cross-language library boundaries.

Imported executable artifacts need an explicit callable/interface description before image code invokes them. Interface description remains separate from authority.

The current Cargo provider intentionally stops at `wasm-binary/v1`; it does not guess a callable ABI.

## Reuse and provenance

Compiler-derived artifacts already use stable compiler identities and deterministic derivation keys.

External `ToolchainService` calls do not yet cache results. A later cache key must cover:

```text
provider/toolchain identity
OCI image digest where applicable
target / ABI
options
resolved artifact representation/content/dependency/metadata fingerprints
manifest / lock / config / vendor inputs
```

Storage timestamps, backend versions and old provenance history should not become cache inputs automatically.

## Internal Lagrange WASM execution

The current image-native path remains:

```text
lagrange-code/v0
  -> wasm-module/v1
  -> wasm-function/v1
  -> ActivationExecutor
```

Runtime execution reuses compiled `WebAssembly.Module` objects and, for explicitly `stateless-v0` modules, pooled instances with fresh activation bindings.

This is separate from foreign/raw `wasm-binary/v1` artifacts.

## Backend contract

The backend boundary remains small: lifecycle, optimistic get/put, scan and history streams. It must not grow into a second language/toolchain API.

A durable backend may later index compiler/toolchain derivation keys without changing artifact semantics.

## Active execution later

```text
message/call
    |
receiver + capability context
    |
object locator / interface / foreign-runtime adapter
    |---- local optimized activation
    |---- Lagrange WASM activation
    |---- component/foreign WASM activation
    |---- foreign OCI runtime
    |
    +---- distributed activation ----> ctx.call / placed WASM
```

Not every object send becomes RPC and not every foreign call becomes an image message send. Placement remains runtime policy with explicit authority and failure semantics.

Projects should eventually relate source, binary dependencies, manifests, tests, notes and work items as graph objects/artifacts, with files/Git as interoperability projections.

See ADR 0016 for the broad artifact/toolchain direction, ADR 0017 for the generic dependency/provider substrate, ADR 0018 for the first OCI Cargo/rustc provider, and ADR 0019 for explicit vendored Cargo dependencies.
