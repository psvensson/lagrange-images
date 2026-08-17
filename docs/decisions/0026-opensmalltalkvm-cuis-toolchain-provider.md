# ADR 0026: OpenSmalltalkVM + Cuis as a real toolchain provider

Status: implemented — the first Smalltalk external-toolchain implementation.
Proven by: test/opensmalltalk-cuis-toolchain-real.test.js

## Problem

ADR 0024 proved a real OpenSmalltalkVM/Cuis runtime and ADR 0025 proved that an unchanged upstream Cuis package can be installed and executed in that runtime.

The next question is different:

> Can the same mature Smalltalk environment act as a compiler/toolchain host that consumes explicit image/package artifacts and produces a new runnable image artifact through the language-neutral `ToolchainService`?

This must not collapse runtime lifecycle into toolchain lifecycle. A compiler invocation is finite build work; a foreign runtime is a long-lived live heap.

## Decision

Add a real toolchain provider:

```text
smalltalk/opensmalltalk-cuis-toolchain
```

implemented by `createOpenSmalltalkCuisToolchainProvider()`.

The provider uses the existing `ToolchainProviderRegistry` / `ToolchainService` contract without adding Smalltalk semantics to the generic service.

```text
explicit Cuis build artifact graph
        |
        v
ToolchainService
        |
        v
OpenSmalltalkVM + real Cuis compiler/package loader
        |
        v
derived Cuis image + changes artifacts
```

## Provider identity vs compiler-image inputs

The configured OpenSmalltalkVM executable is installation/deployment machinery. Its stable version/digest is supplied as `vmIdentity` and determines provider identity.

The Cuis compiler itself lives in the base image. Therefore the base image is **not** hidden inside provider identity. It is an explicit build input artifact and its complete bytes participate in the generic ToolchainService input graph.

```text
host VM path          transient installation detail
VM identity           provider identity material
base Cuis image       explicit artifact input
base changes/sources  explicit artifact inputs
Cuis packages         explicit artifact inputs
```

A different base image therefore means a different build graph even when the same OpenSmalltalkVM executable runs it.

## First artifact conventions

The first toolchain-specific representations are:

```text
smalltalk/cuis-build-v1
smalltalk/cuis-image-v1
smalltalk/cuis-changes-v1
smalltalk/cuis-sources-v1
smalltalk/cuis-package-v1
```

A build root has text content:

```text
cuis-build/v0
```

and explicit dependency roles:

```text
build
  dependency(base-image)   -> exactly one smalltalk/cuis-image-v1
  dependency(base-changes) -> exactly one matching smalltalk/cuis-changes-v1
  dependency(base-sources) -> zero or one smalltalk/cuis-sources-v1
  dependency(package)      -> zero or more smalltalk/cuis-package-v1
```

The base changes basename must match the base image stem. It is required because the finite Cuis snapshot operation copies the current changes file to the derived image name.

Package dependency order is the installation order for this provider version.

Each physical Cuis file artifact carries a validated guest-visible filename in `metadata.fileName`. Host filesystem paths never become artifact identity or provider metadata.

## Materialization

The provider creates a private temporary workspace and writes the explicit graph into it:

```text
Cuis7.9-8090.image
Cuis7.9-8090.changes
Cuis7.8.sources
JSON.pck.st
lagrange-build.st
```

It launches OpenSmalltalkVM directly, without a shell:

```text
squeak
  -vm-sound-null
  -vm-display-null
  Cuis7.9-8090.image
  -s lagrange-build.st
```

The build script installs packages with the real Cuis API:

```smalltalk
CodePackageFile installPackage:
    DirectoryEntry currentDirectory // 'JSON.pck.st'.
```

and finishes the finite toolchain process with Cuis' explicit snapshot-and-exit API:

```smalltalk
Smalltalk
    saveAndQuitAs: 'LagrangeDerived'
    clearAllClassState: false.
```

The current Cuis implementation copies the current changes file to the new image name, changes image identity and snapshots with `andQuit: true`. A plain `saveAs:` followed by a separate quit was rejected by the real integration proof because the build process remained alive until timeout.

The temporary workspace is build machinery only and is always removed after the provider returns or fails.

## Outputs

The first target contract is:

```js
{
  representation: 'smalltalk/cuis-image-v1',
  fileName: 'LagrangeDerived.image'
}
```

The provider returns two named outputs:

```text
image   -> smalltalk/cuis-image-v1
changes -> smalltalk/cuis-changes-v1
```

The unchanged base `.sources` artifact is retained as an explicit dependency of the derived image rather than copied into a new derived artifact.

`ToolchainService` owns normal provenance, so both derived outputs point through `derivedFrom` to the complete resolved build graph.

The derived image metadata records stable/build-relevant facts such as VM identity, base image artifact ID, package artifact IDs, package filenames, companion file names and the `saveAndQuitAs/v0` snapshot contract. Host paths are absent.

## Runtime verification is separate

Producing image bytes is not enough to claim success.

The authoritative real integration test:

1. imports the pinned current Cuis `.image`, `.changes`, `.sources` and upstream JSON package as CodeArtifacts;
2. creates a `smalltalk/cuis-build-v1` root with explicit dependency roles;
3. invokes the real provider through `ToolchainService`;
4. receives the derived image and changes artifacts;
5. materializes those outputs plus the unchanged sources artifact into a fresh runtime directory;
6. starts the derived image through the ordinary OpenSmalltalkVM foreign-runtime provider **without reinstalling JSON**;
7. calls the existing `json/package-proof` service and requires canonical `true`.

So the proof is:

```text
artifact graph
  -> real Cuis toolchain
  -> derived image artifact
  -> fresh real OpenSmalltalkVM runtime
  -> package already present
  -> real Json parser/renderer executes
```

Toolchain construction and runtime execution remain different contracts even though they use the same mature ecosystem.

## Deterministic reuse is deliberately not enabled yet

The provider does **not** implement `cacheKey()` in this version.

All relevant inputs are explicit, but a Smalltalk snapshot may still contain timestamps, runtime bookkeeping, object-layout effects or other run-dependent state. Closed inputs do not by themselves prove byte-identical outputs.

The generic cache must not infer determinism from provider name or representation.

Before enabling toolchain-result reuse we should run independent identical builds and demonstrate a stable normalization or byte-level reproducibility contract. If snapshots are intentionally nondeterministic, reuse may instead require a higher-level semantic/install artifact rather than raw image-byte equality.

## Boundaries not generalized yet

This first toolchain provider does not yet define:

- automatic Cuis Feature dependency resolution;
- package version solving or remote package discovery;
- durable runtime-definition/deployment artifacts;
- image normalization for reproducible snapshot bytes;
- package saving/export back out of a derived image;
- structured Class/CompiledMethod export;
- sibling-output dependency edges between image and changes artifacts;
- OCI placement for the toolchain process;
- automatic conversion of runtime package specs into build artifacts.

Those should follow real multi-package/toolchain use rather than being guessed in advance.

## Guardrails

```text
foreign runtime lifecycle != toolchain lifecycle
VM path != provider identity
VM identity != base Cuis image identity
base image != hidden provider input
base image name != arbitrary changes filename
package path != package artifact identity
build dependency order != generic dependency semantics outside this provider
snapshot bytes != assumed deterministic output
changes file != durable image graph
sources artifact != regenerated output when unchanged
runnable derived image != native Lagrange image object graph
```

## Consequence

The Smalltalk compatibility path now reuses both sides of the mature ecosystem:

```text
runtime:
  OpenSmalltalkVM + Cuis image -> persistent compatible Smalltalk

toolchain:
  explicit image/package graph -> OpenSmalltalkVM + Cuis compiler -> derived runnable image
```

This removes another reason to build a replacement Cuis compiler merely for integration. The next useful pressure tests are a real multi-package dependency graph and structured export/migration from a toolchain-produced image.
