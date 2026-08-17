# ADR 0027: artifact-backed foreign runtime definitions

Status: accepted — the first durable foreign-runtime definition path.

## Problem

The foreign-runtime lifecycle from ADR 0023 is intentionally transient:

```text
provider selection -> start(spec) -> runtimeId -> call -> stop
```

That is the right model for a running process, but it leaves an architectural gap. A Cuis runtime can currently be started from configured host paths and package paths, while the same Cuis image and packages can already exist as immutable `CodeArtifact`s in the image graph. The real Cuis toolchain from ADR 0026 therefore produces durable runnable image bytes, but the verification step has to materialize those bytes manually and configure another runtime provider around the resulting host path.

A running runtime must remain transient, but the *definition of what should be run* needs durable image identity and explicit artifact dependencies.

## Decision

Add a generic `ForeignRuntimeDefinitionService` above the existing lifecycle service.

```text
runtime-definition CodeArtifact
        |
        | explicit dependencies only
        v
ForeignRuntimeDefinitionService
        |
        | frozen artifact snapshots
        v
ForeignRuntimeService.start({providerId, spec})
        |
        v
selected provider installation
        |
        v
transient runtimeId
```

The durable definition does **not** contain the provider selection ID. Provider selection remains runtime/deployment policy supplied by the caller. This keeps a durable definition independent of whether a future deployment uses a local process, OCI, a remote runtime host or Lagrange placement.

The generic definition envelope is:

```text
lagrange-foreign-runtime-definition/v0
  root      -> one durable CodeArtifact snapshot
  artifacts -> root plus its explicit dependency closure
```

Like `ToolchainService`, the resolver follows `CodeArtifact.dependencies` and does not turn `derivedFrom` provenance into hidden runtime input. Providers receive frozen snapshots and no ambient `ImageService` access.

## First concrete definition: Cuis

The first definition representation is:

```text
smalltalk/cuis-runtime-definition-v1
content: cuis-runtime-definition/v0
```

Its direct dependency roles are:

```text
image    -> exactly one smalltalk/cuis-image-v1
changes  -> zero or one smalltalk/cuis-changes-v1
sources  -> zero or one smalltalk/cuis-sources-v1
package  -> zero or more ordered smalltalk/cuis-package-v1 artifacts
```

The image is the durable executable state. Changes/sources are companion/support files materialized beside it when present. Package artifacts are optional startup inputs for definitions that intentionally install packages at start; a toolchain-produced image that already contains a package does not list that package again.

## Artifact-backed OpenSmalltalkVM provider

Add `createArtifactBackedOpenSmalltalkCuisProvider()` under the existing provider selection ID:

```text
smalltalk/opensmalltalk-cuis
```

Its stable provider identity is derived from `vmIdentity` only. The Cuis image is no longer provider configuration; it is an explicit runtime-definition artifact input.

```text
VM executable path   transient installation detail
VM identity          provider identity material
runtime definition   durable image identity
Cuis image bytes     explicit artifact input
changes/sources      explicit support artifacts
packages             explicit artifact inputs
running runtimeId    transient lifecycle identity
```

The artifact-backed provider materializes the definition graph into a private staging directory and then delegates the actual VM bridge/call/stop behavior to the already-proven configured-image Cuis provider. This deliberately reuses the same whitelisted bridge and does not introduce a second execution protocol.

Host paths remain transient. Runtime metadata records artifact refs, stable package identities and safe guest-visible filenames, not staging paths.

## Toolchain-to-runtime proof

The real integration proof now closes the previous manual gap:

```text
base Cuis artifacts + JSON package
        |
        v
ToolchainService
        |
        v
derived image + changes artifacts
        |
        v
smalltalk/cuis-runtime-definition-v1
        |
        v
ForeignRuntimeDefinitionService
        |
        v
artifact-backed OpenSmalltalkVM provider
        |
        v
fresh Cuis runtime
        |
        v
JSON package already present and executes
```

The runtime definition contains no JSON package dependency in this proof. Success therefore demonstrates that the package state captured by the toolchain-produced image survives as the runtime artifact itself; it is not silently reinstalled during runtime startup.

## What remains transient

This ADR does not make a running VM durable. It does not persist `runtimeId`, provider handles, stdin/stdout transports, process IDs, staging directories or live Spur object pointers.

It also does not yet define:

- desired-instance counts or deployment objects;
- restart/reconciliation policy;
- placement, OCI or remote runtime hosts;
- capabilities/principal context;
- ordinary Block invocation of foreign runtime services;
- snapshot-back/writeback policy for a mutated live runtime;
- failure/retry/idempotency semantics.

Those are separate concerns built on top of the durable definition.

## Guardrails

```text
runtime definition != running runtime instance
runtime definition != provider installation
provider selection != durable definition identity
provider identity != runtime image identity
artifact dependency != provenance
host path != artifact identity
materialized staging directory != durable state
Spur heap != Lagrange image graph
Spur oop != ObjectRef
runtimeId != capability
package startup input != package already captured in image
```

## Consequence

Foreign runtimes now have the same important identity split already present elsewhere in the system: immutable durable artifacts describe *what* exists, while runtime-local machinery describes *where/how it is currently executing*.

The next useful increment is to place an implementation-independent callable interface and ordinary `Block` above this runtime-definition/lifecycle seam, so callers no longer need to know whether an implementation is Cuis, foreign WASM or image-native code.
