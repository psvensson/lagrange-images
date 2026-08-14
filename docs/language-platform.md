# Language platform

## One image substrate, multiple language personalities

The platform should not be one VM per language and should not be one compiler implementation per language. It provides shared durable identity, artifacts, dependencies, compilation/toolchains, execution, debugging and capabilities. A language personality maps its own semantics and ecosystem conventions onto that substrate.

Implemented now includes:

- language-neutral object/Block graph
- immutable CodeArtifacts with explicit dependency edges and separate provenance
- single/group compiler registries
- generic `ToolchainProviderRegistry` / `ToolchainService`
- frozen explicit artifact-graph requests for toolchain providers
- a real digest-pinned OCI Cargo/rustc provider
- `lagrange-code/v0` plus the neutral-expression interpreter
- Symmetric Smalltalk as the first image-native language experiment
- the Lagrange WASM backend, shared modules and runtime caches/pools

Java/JAR adapters, vendored third-party Cargo dependency artifacts, callable foreign-WASM/component interfaces and foreign-runtime adapters remain future work.

## Language personality does not mean compiler ownership

Symmetric Smalltalk owns its parser/compiler because this project defines that language experiment.

That is not the platform rule.

A language personality may own any combination of:

- syntax/editing conventions
- semantic object/runtime conventions
- dispatch rules
- project/package conventions
- adapters to an existing compiler/package manager
- adapters to precompiled libraries/components
- adapters to a foreign runtime

Rust should normally use Cargo/`rustc`. Java should normally use existing Java/JVM/AOT/WASM tooling. The image owns the artifact graph and integration contract rather than replacement compiler ecosystems.

## Artifact graph, not source-only pipeline

The durable programming model is an artifact/dependency graph:

```text
source -------------------+
semantic / IR ------------+
bytecode / package -------+
precompiled library ------+----> compiler/toolchain
WASM component/module ----+            |
manifest / lock / config -+            v
                                    derived artifacts
                                    + callable interfaces
```

`CodeArtifact` is currently the bootstrap generic artifact carrier. Representations belong to language/tooling adapters rather than generic image semantics.

Examples now or planned include:

```text
symmetric-smalltalk/source-v0
rust/source-v1
rust/cargo-manifest-v1
rust/cargo-lock-v1
java/jar-v1
wasm-binary/v1
wasm-module/v1
wasm-component/v1
```

The generic graph should not learn what a JAR, Cargo manifest or shared library means.

### Dependency is not provenance

CodeArtifacts have explicit dependencies:

```js
{
  role: 'library',
  artifact: objectRef(imageId, artifactId),
}
```

They are distinct from `derivedFrom`:

```text
source
  dependency -> manifest
  dependency -> library

compiled output
  derivedFrom -> source
  derivedFrom -> manifest
  derivedFrom -> library
```

Dependency roles are tooling policy, not a platform enum. Metadata may not hide graph refs. Toolchain graph resolution follows `dependencies`, not provenance history.

Older CodeArtifacts without a stored dependency field behave as dependency-free artifacts.

### Source is canonical when it is what we own

Editable source/semantic meaning should remain sufficient to rebuild derived execution artifacts.

That does not imply a binary-only third-party artifact must be reconstructed as source. If what we possess is a JAR or WASM component, that binary can be the canonical imported dependency.

## Generic toolchain providers

The first external-toolchain protocol is:

```text
lagrange-toolchain-provider/v0
```

A provider is selected by configuration/runtime ID and declares a separate stable implementation identity:

```text
providerId          rust/cargo-oci
provider.identity   cargo-rustc-oci/v0/sha256:...
```

`ToolchainService.run()` receives:

```text
providerId
output imageId
root artifact refs
target data
options data
optional output IDs
```

It resolves the transitive explicit dependency graph and sends the provider frozen build-relevant snapshots:

```text
protocol
providerId
toolchainIdentity
roots
artifacts
target
options
```

The generic provider context deliberately exposes no ambient `ImageService`. Providers should compile the artifact graph they were given rather than quietly fetch undeclared inputs.

A provider returns named output descriptions plus transient diagnostics. `ToolchainService` owns persistence and `derivedFrom` provenance; provider-declared runtime/library dependencies remain separate dependency edges.

## First real provider: Cargo/rustc in OCI

The first provider physically executes an existing compiler ecosystem rather than an in-process proof compiler:

```text
rust/cargo-manifest-v1  <-- root
    |
    +-- source --> rust/source-v1
    `-- lock   --> rust/cargo-lock-v1
            |
            v
     digest-pinned OCI image
            |
     cargo build --frozen
            |
            v
       wasm-binary/v1
```

Create it explicitly:

```js
const provider = createCargoRustcOciProvider({
  image: 'registry.example/rust-wasm@sha256:<digest>',
});
```

and register it through the generic runtime seam:

```js
const runtime = await createRuntime({
  toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, provider]],
});
```

A build target is explicit:

```js
{
  representation: WASM_BINARY_V1,
  triple: 'wasm32-wasip1',
  binary: 'demo',
  profile: 'release',
}
```

The target triple is caller policy. The pinned image must already contain Cargo/rustc and that target.

### Closed input graph

The first Cargo provider requires:

- exactly one manifest root
- exactly one lock artifact
- one or more Rust source artifacts
- no unknown input representations

Each `rust/source-v1` declares a safe portable relative path in `metadata.path`.

The provider materializes a private temporary workspace, runs Cargo frozen with OCI network `none`, imports the expected output, validates the WASM header and deletes the workspace afterward.

This is deliberately stricter than ordinary interactive Cargo use. Third-party crate support should add explicit vendored/package/config artifacts instead of enabling hidden network resolution.

### OCI runner

`OciCliRunner` is a small Docker/Podman-style host adapter. It constructs argv directly rather than using a shell, bind-mounts the temporary workspace, selects an explicit container workdir/network, and uses the host uid/gid where available so build outputs remain removable.

The OCI image must be digest-pinned. Tags alone are rejected.

The provider stable identity and output metadata include the pinned digest so the later toolchain-cache contract has a reproducible toolchain identity to fingerprint.

## Raw WASM is not the Lagrange WASM ABI

Cargo output is stored as:

```text
wasm-binary/v1
```

That means validated opaque WebAssembly bytes from a foreign/external toolchain.

It is intentionally **not**:

```text
wasm-module/v1
```

`wasm-module/v1` already means executable code following the current Lagrange Value-handle imports, function metadata and host-effect contract.

A valid Cargo WASM module is therefore not automatically an image Block or directly executable through `ActivationExecutor`. It needs a later callable/component/ABI adapter.

This separation keeps external-language integration honest and leaves room for WASI, Component Model and language-specific runtimes.

## Rust direction

Rust now has its first concrete artifact/toolchain path without a Rust compiler in this project:

```text
image artifacts
  -> Cargo/rustc in OCI
  -> raw WASM artifact
```

Next Rust work should focus on:

- explicit vendored crate/package/config artifacts
- one real third-party dependency build with no hidden network input
- toolchain result caching keyed by image digest + target/options + complete input fingerprints
- a callable/component boundary for suitable Rust-produced WASM
- Lagrange Rust SDK/crate for explicit host calls

Compiler-private Rust intermediates should remain build-cache material unless a stable compatibility contract says otherwise.

## Java direction

Java can support more than one integration tier.

Deep/compiled integration:

```text
Java source + JAR dependencies
        -> existing Java/AOT/WASM provider
        -> executable artifact
```

Compatibility/runtime integration:

```text
image callable/interface
        -> foreign-runtime adapter
        -> JVM in OCI
```

Those can coexist. A JVM heap remains foreign runtime state rather than automatically becoming the durable image graph.

## OCI has two roles

OCI as a **build environment** is now implemented for the Cargo provider:

```text
artifact graph -> temporary workspace -> OCI compiler -> derived artifact
```

OCI as a **foreign runtime** remains future execution work:

```text
image callable/interface -> adapter -> live JVM/native/Python/etc. container
```

Do not conflate the two. Build containers disappear after compilation; foreign-runtime containers remain part of execution/lifecycle policy.

## Compiled libraries and components

Compiled libraries should remain first-class dependencies whenever their format/runtime/ABI permits it.

- Java JAR/class artifacts can remain byte dependencies.
- Rust should favor source crates or explicitly stable portable ABIs/components for long-lived reuse.
- WASM Components are attractive cross-language library boundaries.

A future callable/interface artifact should describe exported calls, argument/result representation, ABI/component contract, required capabilities and version/provenance. Interface description remains separate from authority.

## Compilation groups and durable reuse

`CompilationGroup` remains a transient compiler planning value. The substrate does not assume it means a Smalltalk Block tree, Java class set or Rust crate.

In-process compilers already support deterministic derived-artifact reuse through explicit compiler identity + cache key.

`ToolchainService` does **not** yet reuse external-toolchain results. The later key needs to include at least:

```text
toolchain/provider identity
OCI image digest when applicable
target / ABI
options
resolved source/binary dependency fingerprints
manifest / lock/config artifacts
```

Backend versions, timestamps and old provenance history should not become cache inputs merely because they exist in storage.

## Internal Lagrange WASM backend

The current image-native `lagrange-code/v0 -> wasm-module/v1` path remains separate from foreign/raw WASM.

It supports scalar literals, positional arguments, receiver, captures, arbitrary-precision integer addition, equality, `if`, tail sends and tail Block materialization through the `lagrange-value-handle/v0` ABI.

Grouped Smalltalk Block trees may share one `wasm-module/v1`, and runtime execution reuses compiled `WebAssembly.Module` objects plus explicitly stateless `WebAssembly.Instance` objects without merging Block/function/activation identity.

A future Java/Rust/Lisp backend with mutable heaps/globals/TLS must not inherit the current `stateless-v0` instance contract unless its compiler can honestly guarantee it.

## Blocks and invocation

The durable closure substrate remains:

```text
Block
  code --------> CodeArtifact
  environment -> LexicalEnvironment | null
```

Smalltalk maps naturally to it; Lisp closures can too. Java/Rust do not need every source-level function to become Smalltalk-shaped. They can use common callable/activation infrastructure according to their language/runtime/interface semantics.

Receiver remains an optional distinguished Value rather than argument zero:

```text
Smalltalk instance method -> receiver = self
Java instance method      -> receiver = this
static/free function       -> receiver = null
```

Sharing the artifact/toolchain substrate does not make different language dispatch semantics identical.

## Next open questions

- vendored/package/config artifact conventions for third-party Cargo dependencies
- external-toolchain derivation cache/fingerprint contract
- callable/interface artifact contract for `wasm-binary/v1`
- WASM Component artifact/interface boundary
- Java JAR/class importer and existing-toolchain spike
- foreign OCI runtime adapter and lifecycle
- dependency linkage policy: static/component/foreign-runtime/service/build-only
- transactional multi-output toolchain installation if real builds need it
- general non-tail asynchronous Lagrange-WASM effects
- capability-aware host/foreign/component interfaces
- distributed placement of compiled artifacts and foreign runtimes
- debugger activation durability and conditions/exceptions

See ADR 0016 for the broad artifact/toolchain direction, ADR 0017 for the generic dependency/provider contract, and ADR 0018 for the first OCI Cargo/rustc provider.
