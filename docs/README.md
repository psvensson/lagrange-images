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

external compiler ecosystem
  -> ToolchainService
  -> imported executable artifacts

long-lived external runtime
  -> ForeignRuntimeService
  -> provider-private VM/process
```

The first external compiler proof is Rust/Cargo in digest-pinned OCI. The first foreign WASM interface is `wasm-scalar-call/v0`. The first real long-lived foreign runtime is OpenSmalltalkVM + a pinned Cuis image.

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

The OpenSmalltalkVM path now has a concrete first provider proof:

```text
ForeignRuntimeService
  -> headless OpenSmalltalkVM
  -> real Cuis 7.9 image
  -> Cuis compiles a service class
  -> persistent calls
  -> canonical Values
```

The bridge is intentionally whitelisted rather than generic `perform:`/eval, and the Spur heap remains foreign runtime state. A PR-only integration job downloads and verifies the pinned upstream VM/image and executes the proof against the real runtime.

Still ahead are an existing Cuis package compatibility proof, the OpenSmalltalkVM/Cuis compiler-toolchain role, structured class/method export, OCI/distributed placement and optional later interpreter/Spur-to-WASM hosting.

See [ADR 0022](decisions/0022-opensmalltalkvm-compatibility-direction.md), [ADR 0023](decisions/0023-foreign-runtime-lifecycle-substrate.md) and [ADR 0024](decisions/0024-opensmalltalkvm-cuis-runtime-proof.md).

## ADRs

Use [decisions/README.md](decisions/README.md) instead of reading the ADR directory in numeric order. ADRs are append-only design history; the current README/architecture/language docs describe the resulting model.

## Current frontier

The current substrate can now show both major ecosystem reuse modes:

```text
explicit artifact graph
   -> real existing compiler
   -> reusable executable artifact

explicit runtime interface
   -> real persistent existing VM/image
   -> canonical Value calls
```

The next pressure points are a useful existing Cuis package, the Cuis compiler/toolchain role, richer Component/WIT interfaces, Java/JAR and Common Lisp proofs, capabilities and distributed placement on the durable Lagrange backend.
