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

There are two WASM lanes:

```text
image-native semantics
  -> wasm-module/v1 / wasm-function/v1
  -> Lagrange Value-handle ABI

external language/toolchain
  -> wasm-binary/v1
  -> explicit callable/component interface
```

Toolchains consume explicit artifact dependency graphs and produce immutable derived artifacts. Deterministic providers may opt into result reuse.

The first external ecosystem proof is Rust/Cargo in digest-pinned OCI. The first foreign executable interface is `wasm-scalar-call/v0` over `wasm-callable-interface/v1`.

## ADRs

Use [decisions/README.md](decisions/README.md) instead of reading the ADR directory in numeric order.

The decision index groups ADRs into:

- foundation and image semantics
- language/execution model
- Lagrange WASM backend
- runtime reuse
- artifact/toolchain ecosystem integration
- foreign WASM interfaces

ADRs are append-only design history. If a newer ADR extends an older one, the current README/architecture/language docs should describe the resulting model.

## Current frontier

The current substrate can:

```text
explicit source/package artifact graph
   -> deterministic existing toolchain
   -> reusable raw WASM
   -> explicit scalar callable interface
   -> ordinary Block activation
```

The next pressure points are richer component interfaces, Java/JAR and Common Lisp ecosystem proofs, standard package importers, capabilities and distributed placement on the durable Lagrange backend.
