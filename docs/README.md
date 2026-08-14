# Documentation map

The top-level README is the quick overview. These docs describe the current model. ADRs preserve the detailed decision history.

## Start here

1. [Architecture](architecture.md) — the layers, boundaries and execution paths
2. [Image model](image-model.md) — durable graph records and identity
3. [Language platform](language-platform.md) — how Smalltalk, Rust, Java, Lisp and foreign code fit
4. [Roadmap](roadmap.md) — what exists and what is next

## Focused concepts

- [Value/reference/object model](value-model.md) — tagged Values, refs, shapes and generic objects
- [Security boundary](security.md) — identity vs authority and capability direction
- [Lagrange integration](lagrange-integration.md) — backend/distributed integration boundary

## Execution and toolchains at a glance

```text
image-native semantics
  -> wasm-module/v1 / wasm-function/v1
  -> Lagrange Value-handle ABI

external compiler/tooling ecosystem
  -> ToolchainService
  -> derived/imported executable/runtime artifacts

long-lived external runtime
  -> ForeignRuntimeService
  -> provider-private VM/process
```

Two mature toolchains now exercise `ToolchainService`: Cargo/rustc produces raw WASM from an explicit Rust graph, while OpenSmalltalkVM/Cuis produces a fresh runnable Cuis image from explicit base-image/support/package artifacts. The first foreign WASM interface is `wasm-scalar-call/v0`.

## Smalltalk direction

Smalltalk has two complementary paths:

```text
native Symmetric Smalltalk
          |
          | shared projects/artifacts/interfaces/tools
          |
OpenSmalltalkVM-backed compatible Smalltalk
```

Symmetric Smalltalk is the image-native language experiment.

The compatibility path now has both runtime and compiler/toolchain proofs:

```text
runtime
  ForeignRuntimeService
    -> headless OpenSmalltalkVM
    -> Cuis image + explicit packages
    -> canonical Value calls

toolchain
  explicit Cuis artifact graph
    -> ToolchainService
    -> OpenSmalltalkVM + real Cuis package/compiler machinery
    -> derived .image + .changes
    -> fresh runtime proof of the derived image
```

The runtime bridge is intentionally whitelisted rather than generic `perform:`/eval, and the Spur heap remains foreign runtime state. PR-only integration downloads and verifies the pinned upstream VM/image/package fixture, executes package code, builds a new Cuis image, then starts that derived image without reinstalling the package.

Still ahead are a larger multi-package Cuis project, structured class/method/package export, mixed native/compatible Smalltalk services, OCI/distributed placement and optional later interpreter/Spur-to-WASM hosting.

See [ADR 0022](decisions/0022-opensmalltalkvm-compatibility-direction.md), [ADR 0023](decisions/0023-foreign-runtime-lifecycle-substrate.md), [ADR 0024](decisions/0024-opensmalltalkvm-cuis-runtime-proof.md), [ADR 0025](decisions/0025-existing-cuis-package-proof.md) and [ADR 0026](decisions/0026-opensmalltalkvm-cuis-toolchain-provider.md).

## ADRs

Use [decisions/README.md](decisions/README.md) instead of reading the ADR directory in numeric order. ADRs are append-only design history; the current README/architecture/language docs describe the resulting model.

## Current frontier

The substrate now demonstrates both directions of ecosystem reuse:

```text
explicit artifact graph
   -> real existing compiler/tooling
   -> runnable/executable artifact

explicit runtime interface
   -> real persistent existing VM/image
   -> canonical Value calls
```

The next pressure points are multi-package Smalltalk dependencies and structured export, richer Component/WIT interfaces, Java/JAR and Common Lisp proofs, capabilities and distributed placement on the durable Lagrange backend.
