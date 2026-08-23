# Documentation map

The top-level README is the quick overview. These docs describe the current model. ADRs preserve the detailed decision history.

## Start here

1. [Architecture](architecture.md) — the image/project/language/execution layers and boundaries
2. [Image model](image-model.md) — durable graph records, identity and image-level Project convention
3. [Object-environment boundary](object-environment-boundary.md) — what the higher-level human environment owns
4. [Language platform](language-platform.md) — how Smalltalk, Rust, Java, Lisp and foreign code fit
5. [Roadmap](roadmap.md) — remaining image/project/language substrate work

If you are here to change something rather than to understand it, start with:

- [Agent workflow](agent-workflow.md) — provider-independent planning, falsification, verification and handoff
- [Ownership registry](ownership.md) — single owners for major subsystems and every cross-subsystem interaction
- [Runbook](runbook.md) — how to run and debug the repository
- [Seam map](seams.md) — exact representations, installers and executors
- [Domain agent rules](domain-agent-rules.md) — accumulated low-level implementation invariants preserved from the original `AGENTS.md`

## Focused concepts

- [Value/reference/object model](value-model.md) — tagged Values, refs, shapes and generic objects
- [Security boundary](security.md) — identity vs authority and capability direction
- [Lagrange integration](lagrange-integration.md) — backend/distributed integration boundary
- [Object-environment boundary](object-environment-boundary.md) — Project semantic model vs Project/UI interaction; Perspective and graphical UI ownership
- [Agent workflow](agent-workflow.md) — durable task/memory discipline across LLM providers
- [Ownership registry](ownership.md) — authoritative owner of each major responsibility and interaction
- [Runbook](runbook.md) — running the suite, integration assets, debugging silent foreign-runtime failures
- [Seam map](seams.md) — representations, installers, executors and where code lives

## Boundary in one sentence

`lagrange-images` owns the durable image, Project, language and execution semantics; [lagrange-object-environment](https://github.com/psvensson/lagrange-object-environment) owns how humans see and inhabit them.

Project is the intentional middle case: it is image-level but represented using ordinary objects/refs rather than a special backend record type. Perspective is environment-level even when persisted in the image.

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
          | shared image/Project/artifact/interface substrate
          |
OpenSmalltalkVM-backed compatible Smalltalk
```

Symmetric Smalltalk is the image-native language. The compatibility path reuses the real runtime/compiler/package ecosystem. Their artifacts may participate in the same image-level Projects; the Object Environment supplies the human tooling over them.

## ADRs

Use [decisions/README.md](decisions/README.md) instead of reading the ADR directory in numeric order. ADRs are append-only design history; the current README/architecture/language docs describe the resulting model.
