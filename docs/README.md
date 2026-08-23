# Documentation map

The top-level README is the quick overview. These docs describe the current model. ADRs preserve the detailed decision history.

## Start here

1. [Architecture](architecture.md) — the image/language/execution layers and boundaries
2. [Image model](image-model.md) — durable graph records and identity
3. [Object-environment boundary](object-environment-boundary.md) — what moved to the higher-level Project/UI environment
4. [Language platform](language-platform.md) — how Smalltalk, Rust, Java, Lisp and foreign code fit
5. [Roadmap](roadmap.md) — remaining substrate work

If you are here to change something rather than to understand it, start instead with
[the runbook](runbook.md) (how to run and debug) and [the seam map](seams.md) (what the
representations, installers and executors are called).

## Focused concepts

- [Value/reference/object model](value-model.md) — tagged Values, refs, shapes and generic objects
- [Security boundary](security.md) — identity vs authority and capability direction
- [Lagrange integration](lagrange-integration.md) — backend/distributed integration boundary
- [Object-environment boundary](object-environment-boundary.md) — Project, Perspective, collaboration and graphical UI ownership
- [Runbook](runbook.md) — running the suite, integration assets, debugging silent foreign-runtime failures
- [Seam map](seams.md) — representations, installers, executors and where code lives

## Boundary in one sentence

`lagrange-images` owns the generic durable object/language/execution substrate; [lagrange-object-environment](https://github.com/psvensson/lagrange-object-environment) owns how humans organize and inhabit it.

A Project or Perspective may be an ordinary durable image object without becoming a built-in image record kind.

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

Two mature toolchains exercise `ToolchainService`: Cargo/rustc produces raw WASM from an explicit Rust graph, while OpenSmalltalkVM/Cuis produces a fresh runnable Cuis image from explicit base-image/support/package artifacts.

## Smalltalk direction

Smalltalk has two complementary paths:

```text
native Symmetric Smalltalk
          |
          | shared image/artifact/interface substrate
          |
OpenSmalltalkVM-backed compatible Smalltalk
```

Symmetric Smalltalk is the image-native language. The compatibility path reuses the real runtime/compiler/package ecosystem. Higher-level mixed-language Project organization and tooling belongs to Lagrange Object Environment.

## ADRs

Use [decisions/README.md](decisions/README.md) instead of reading the ADR directory in numeric order. ADRs are append-only design history; the current README/architecture/language docs describe the resulting model.
