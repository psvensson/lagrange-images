# ADR 0017: artifact dependencies and toolchain providers

Status: accepted — the external-toolchain substrate.

## Problem

ADR 0016 established that the durable programming model is an artifact/dependency graph rather than a source-only compiler pipeline. The implementation still lacked two concrete pieces:

1. an explicit dependency edge that is not confused with derivation/provenance
2. a language-neutral way to invoke a toolchain without assuming that the compiler runs in-process

Those are prerequisites for Cargo/rustc, Java/JAR, OCI build and component-library work.

## Decision

Extend immutable `CodeArtifact` as the bootstrap generic artifact carrier with explicit dependencies:

```text
CodeArtifact
  representation
  content
  dependencies:
    role
    artifact ref
  derivedFrom
  metadata
```

Add a generic toolchain layer:

```text
artifact roots
  -> resolve explicit dependency graph
  -> ToolchainProviderRegistry
  -> ToolchainService
  -> provider
  -> derived output CodeArtifacts + transient diagnostics
```

This is deliberately smaller than a universal Artifact hierarchy. `CodeArtifact` remains the carrier until real integrations prove a broader durable record is needed.

## Dependency is not provenance

`dependencies` and `derivedFrom` have different meanings.

```text
application source
  dependency -> library.jar

compiled application
  derivedFrom -> application source
  derivedFrom -> library.jar
```

A dependency says an artifact relates to another artifact for a role such as library, manifest, lock, runtime or build input.

`derivedFrom` says how a particular immutable artifact was produced.

Do not encode dependency refs in metadata and do not use `derivedFrom` as a package/library dependency list.

In-process compiler results may also explicitly declare output dependencies. Those dependencies are never copied implicitly from source inputs; linkage remains compiler policy.

## Dependency record

The bootstrap dependency shape is:

```js
{
  role: 'library',
  artifact: objectRef(imageId, artifactId),
}
```

Rules:

- `role` is non-empty text
- roles are intentionally not a platform enum
- `artifact` is an unpinned object ref
- the target must exist as a `code-artifact` when persisted through `ImageService`
- an artifact cannot depend on itself
- duplicate `(role, artifact)` edges are rejected
- the explicit graph reference walker includes dependency refs

CodeArtifacts are immutable, so an unpinned artifact ref already names immutable dependency content. A later generalized artifact model may revisit that assumption for other record kinds.

Older stored CodeArtifacts that predate this field are read as if `dependencies` were empty.

## Toolchain provider identity

A provider is registered under a selection ID but also declares a stable identity:

```text
providerId        example/default
provider.identity example-toolchain/v7
```

The selection ID is runtime/configuration policy. The identity describes the toolchain implementation/version and is what future reproducibility/cache contracts should fingerprint.

A provider implements:

```js
provider.run(request, context)
```

The first protocol is:

```text
lagrange-toolchain-provider/v0
```

## Toolchain request

`ToolchainService.run()` takes:

```text
providerId
output imageId
root artifact refs
target data
options data
optional output IDs
```

The output image is validated before provider execution.

The service resolves the complete explicit dependency graph reachable from the roots, once per artifact, in deterministic first-discovery order.

The provider receives frozen snapshots:

```text
protocol
providerId
toolchainIdentity
roots:
  ref
  artifact
artifacts:
  ref
  artifact
target
options
```

The artifact snapshot contains the build-relevant durable artifact view:

```text
kind
id
imageId
languageId
representation
content
dependencies
metadata
```

It omits backend/concurrency/time bookkeeping and `derivedFrom` provenance history. Provenance is not an implicit build input.

The generic context currently contains only the protocol ID and deliberately does **not** contain `ImageService` or another ambient artifact reader.

`target` and `options` are transient deterministic plain data.

## Provider result

A provider returns:

```text
outputs[]
  name
  languageId | null
  representation
  content
  dependencies[]
  metadata

diagnostics[]
```

Diagnostics are transient.

The provider cannot set output `derivedFrom` directly. `ToolchainService` owns provenance and writes every resolved input artifact as an explicit `derivedFrom` edge on every output.

Provider-declared output dependencies remain separate dependency edges.

The service stamps output metadata with:

```text
toolchainProviderId
toolchainIdentity
toolchainProtocol
```

## Multi-output behavior

One invocation may produce several independent artifacts, for example module, interface and debug artifacts.

Before the first output write the service validates:

- provider result/output shapes
- provider-declared dependency targets
- unique output names and IDs
- requested output names
- that every resolved output ID is unused

Output-to-output dependency refs are not supported in v0. Persistence is also not yet transactional across all outputs; a backend failure during persistence could leave a partial invocation.

## Artifact graph resolution

Traversal follows only explicit `dependencies` edges, not metadata or `derivedFrom` edges.

This is intentional:

- dependencies describe toolchain inputs
- provenance describes history and should not automatically become a build input

Shared transitive dependencies are deduplicated and cycles are rejected.

## First real mechanism proof

This ADR originally proved the protocol with an in-process provider and deliberately left execution mechanism open.

ADR 0018 now validates that separation with a real OCI-backed Cargo/rustc provider:

```text
explicit Rust artifact graph
  -> unchanged ToolchainService
  -> Cargo/rustc provider
  -> digest-pinned OCI runner
  -> wasm-binary/v1
```

No Rust, Cargo, path-materialization or OCI semantics were added to the generic service.

Still not implemented by this ADR/protocol layer:

- native-process provider
- remote build provider
- toolchain derivation-key caching
- callable/interface semantics
- transactional sibling-output graphs

## Reuse/cache consequence

Unlike `CompilationService`, `ToolchainService` does not yet reuse outputs by derivation key.

A later cache contract should fingerprint at least:

```text
toolchain identity
provider execution identity/digest where relevant
target
options
resolved input artifact representation/content/dependency/metadata fingerprints
manifest/lock/config inputs
```

Backend versions, timestamps and derivation history should not become cache inputs merely because they are storage/provenance fields.

## Multilingual consequence

Nothing in this contract knows what a Java JAR, Rust crate, Lisp system or Smalltalk package means.

Providers consume those representations according to ecosystem-specific rules while the platform keeps generic invariants:

```text
artifact dependency != provenance
toolchain selection id != stable toolchain identity
provider execution mechanism != language semantics
diagnostics != durable artifact state
```

## Guardrail

The provider substrate stays small:

> explicit artifact graph in, explicit derived artifacts out.

ADR 0018 shows that a real Cargo/rustc/OCI integration can fit this seam without broadening `ToolchainService` into a filesystem/process/package-manager abstraction.
