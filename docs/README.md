# Documentation map

The top-level README is the quick overview. These docs describe the current model. ADRs preserve the detailed decision history.

## Start here

1. [Architecture](architecture.md) — the image/project/language/execution layers and boundaries
2. [Image model](image-model.md) — durable graph records, identity and image-level Project convention
3. [Object-environment boundary](object-environment-boundary.md) — what the higher-level human environment owns
4. [Language platform](language-platform.md) — how Smalltalk, Rust, Java, Lisp and foreign code fit
5. [Progressive native import](native-import.md) — how existing applications converge onto native Lagrange classes, methods, objects and storage
6. [Roadmap](roadmap.md) — remaining image/project/language substrate work, ordered around the native-import path

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
- [Progressive native import](native-import.md) — existing ecosystem source/package graph -> native image semantics
- [Object-environment boundary](object-environment-boundary.md) — Project semantic model vs Project/UI interaction; Perspective and graphical UI ownership
- [Agent workflow](agent-workflow.md) — durable task/memory discipline across LLM providers
- [Ownership registry](ownership.md) — authoritative owner of each major responsibility and interaction
- [Runbook](runbook.md) — running the suite, integration assets, debugging silent foreign-runtime failures
- [Seam map](seams.md) — representations, installers, executors and where code lives

## Boundary in one sentence

`lagrange-images` owns the durable image, Project, language, import and execution semantics; [lagrange-object-environment](https://github.com/psvensson/lagrange-object-environment) owns how humans see and inhabit them.

Project is the intentional middle case: it is image-level but represented using ordinary objects/refs rather than a special backend record type. Perspective is environment-level even when persisted in the image.

## Execution and toolchains at a glance

```text
image-native semantics
  -> wasm-module/v2 (+ wasm-binary/v1) / wasm-function/v2
  -> Lagrange Value-handle ABI

external compiler/tooling ecosystem
  -> ToolchainService
  -> semantic import inputs and/or derived executable/runtime artifacts

long-lived external runtime
  -> ForeignRuntimeService
  -> provider-private VM/process
```

Two mature toolchains exercise `ToolchainService`: Cargo/rustc produces raw WASM from an explicit Rust graph, while OpenSmalltalkVM/Cuis produces a fresh runnable Cuis image and deterministic semantic export from explicit base-image/support/package artifacts.

## Smalltalk direction

Smalltalk still has native and compatibility machinery, but ADR 0085 fixes their strategic relationship:

```text
existing Cuis application
        |
        v
real Cuis tooling / semantic export
        |
        v
progressive native import
        |
        v
native Smalltalk classes / methods / objects
        |
        v
Lagrange WASM + durable image state

OpenSmalltalkVM
  = importer/toolchain + semantic oracle + explicit foreign escape hatch
  != automatic fallback execution path
```

Symmetric Smalltalk supplies the image-native class/object/compiler substrate. The Cuis compatibility path reuses the real runtime/compiler/package ecosystem to bootstrap and verify import, while the convergence destination is ordinary native Lagrange classes, methods, Blocks and ObjectRefs.

## Other languages

Rust remains the mature external-compiler -> WASM path. ADR 0084 has already proved Common Lisp/SBCL through the generic foreign-runtime contracts; deeper Lisp-native import work is intentionally sequenced behind the Cuis forcing path so the generic architecture is extracted from real second-language pressure rather than anticipated.

## ADRs

Use [decisions/README.md](decisions/README.md) instead of reading the ADR directory in numeric order. ADRs are append-only design history; the current README/architecture/language/import docs describe the resulting model. ADR 0085 is the current convergence decision.
