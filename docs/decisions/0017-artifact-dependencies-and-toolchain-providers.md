# ADR 0017: artifact dependencies and toolchain providers

Status: accepted for the first external-toolchain substrate.

## Problem

ADR 0016 established that the durable programming model is an artifact/dependency graph rather than a source-only compiler pipeline. The implementation still lacked two concrete pieces:

1. an explicit dependency edge that is not confused with derivation/provenance
2. a language-neutral way to invoke a toolchain without assuming that the compiler runs in-process

Those are prerequisites for later Cargo/rustc, Java/JAR, OCI build and component-library work.

## Decision

Extend the current immutable `CodeArtifact` record as the bootstrap generic artifact carrier with explicit dependencies:

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

This is deliberately smaller than a universal Artifact hierarchy. `CodeArtifact` remains the carrier until real Rust/Java/component imports prove that a broader durable record is needed.

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
providerId       example/default
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

The generic context currently contains only the protocol ID.

It deliberately does **not** contain `ImageService` or another ambient artifact reader. A provider should not quietly fetch undeclared build inputs outside the graph it was given. Later providers may receive narrowly scoped services when a concrete need exists, but hidden dependency access should remain exceptional.

`target` and `options` are transient plain deterministic data under the same type restrictions used by derivation-key material.

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

Output names are invocation-local names used to assign requested or generated durable IDs.

Diagnostics are transient. They are returned to the caller but are not silently embedded in output metadata.

The provider cannot set output `derivedFrom` directly. `ToolchainService` owns provenance and writes every resolved input artifact as an explicit `derivedFrom` edge on every output.

Provider-declared output dependencies remain separate dependency edges. For example a compiled module may derive from a source graph while retaining a runtime dependency on an imported component.

The service stamps non-reference output metadata with:

```text
toolchainProviderId
toolchainIdentity
toolchainProtocol
```

## Multi-output behavior

One toolchain invocation may produce several independent artifacts, for example:

```text
module
interface description
debug artifact
```

The bootstrap service validates all result shapes and dependency targets before writing outputs.

Output-to-output dependency references are not supported in v0 because sibling outputs do not exist yet during preflight. A later transactional/multi-output artifact protocol can add named sibling edges if real toolchains require them.

The mock/backend persistence path is not yet a transaction spanning all outputs. Whole-invocation atomicity remains future work.

## Artifact graph resolution

Artifact graph traversal follows only explicit `dependencies` edges, not arbitrary metadata or `derivedFrom` edges.

This is intentional:

- dependencies describe the inputs the toolchain is allowed to see as the dependency graph
- provenance describes history and should not automatically become a new build input

Shared transitive dependencies are deduplicated.

A dependency cycle is rejected by the resolver. Normal immutable artifact creation already makes such cycles difficult to construct through the public API, but the resolver still defends against corrupted/imported graph data.

## No external process yet

This ADR implements the generic contract and proves it with an in-process provider.

It does **not** yet implement:

- OCI build execution
- native-process execution
- remote build services
- Cargo/rustc integration
- Java/JAR compilation integration
- toolchain derivation-key caching
- callable/interface semantics

Those remain separate follow-up work. The next intended proof is an OCI-backed Cargo/rustc provider using this same contract rather than changing the generic image model.

## Reuse/cache consequence

Unlike `CompilationService`, `ToolchainService` does not yet reuse outputs by a derivation key.

A later cache contract should fingerprint at least:

```text
toolchain identity
provider execution identity/digest where relevant
target
options
ordered/resolved input artifact fingerprints
manifest/lock inputs
```

Adding cache reuse must not weaken the explicit input/provenance model introduced here.

## Multilingual consequence

Nothing in this contract knows what a Java JAR, Rust crate, Lisp system or Smalltalk package means.

A future provider can consume those representations according to its own ecosystem while the platform keeps the same generic invariants:

```text
artifact dependency != provenance
toolchain selection id != stable toolchain identity
provider execution mechanism != language semantics
diagnostics != durable artifact state
```

## Guardrail

The first external-toolchain substrate should stay small:

> explicit artifact graph in, explicit derived artifacts out.

Do not broaden it into a filesystem/process/package-manager abstraction before the first real Cargo/rustc provider demonstrates which additional seams are actually necessary.
