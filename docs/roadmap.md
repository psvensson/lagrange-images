# Roadmap

The roadmap is ordered by architectural pressure, not by language popularity. Completed implementation detail lives in the ADRs; this file should make the current frontier obvious.

## Current frontier

The substrate can now do these paths end to end:

```text
image-native Smalltalk
        -> semantic code -> Lagrange WASM -> ordinary activation

external Rust/Cargo project
        -> explicit source/lock/vendor artifact graph
        -> digest-pinned OCI Cargo/rustc
        -> deterministic toolchain-result reuse
        -> wasm-binary/v1
        -> wasm-callable-interface/v1
        -> ordinary Block activation

long-lived foreign runtime
        -> ForeignRuntimeProviderRegistry
        -> ForeignRuntimeService
        -> start -> canonical-Value calls -> stop

real compatible Smalltalk runtime
        -> OpenSmalltalkVM provider
        -> pinned headless Cuis image
        -> provider bridge compiled in pristine image
        -> explicit pinned upstream .pck.st package installation
        -> real Cuis package code
        -> canonical Value result
```

The first package proof uses the unchanged upstream Cuis JSON package and exercises its parser and renderer. The OpenSmalltalk bridge remains deliberately whitelisted; it does not expose arbitrary `perform:`, eval or Spur object pointers.

## Next

### 1. OpenSmalltalkVM / Cuis compatibility path

The end goal is two complementary Smalltalk paths:

```text
native Symmetric Smalltalk
          |
          | shared projects/artifacts/interfaces/tools
          |
OpenSmalltalkVM-backed compatible Smalltalk
          |
          +-> native/OCI compatibility runtime
          +-> optional later WASM-hosted interpreter runtime
          `-> selective migration into native representations
```

#### A. Real compatibility runtime

- [x] language-neutral foreign-runtime provider registry/service with explicit start/call/stop lifecycle
- [x] runtime-local instance IDs and private provider handles separate from ObjectRefs/capabilities
- [x] OpenSmalltalkVM/Cuis provider over the generic lifecycle
- [x] stable provider identity from explicit VM/image identities rather than local paths
- [x] shell-free headless local-process launch
- [x] tiny whitelisted persistent stdin/stdout bridge
- [x] compile a real Smalltalk service class in the running Cuis image
- [x] invoke service methods through canonical Lagrange Values
- [x] PR-only integration job using a SHA-256-pinned OpenSmalltalkVM release and commit/blob-pinned Cuis image
- [x] explicit package path/identity inputs with safe guest-visible `.pck.st` basenames
- [x] install an unchanged upstream Cuis package with Cuis' own `CodePackageFile` loader
- [x] prove useful existing Cuis package code beyond the bridge service: JSON parse/render/reparse
- [x] establish provider bridge/control plane before loading guest packages
- [ ] durable artifact conventions for OpenSmalltalkVM runtime/build identity and Smalltalk runtime/package artifacts
- [ ] explicit dependency graph/order for several Cuis packages
- [ ] OCI foreign-runtime launcher/placement implementation
- [ ] explicit restart/reconciliation and image/snapshot persistence behavior
- [ ] richer explicit Smalltalk service interfaces without introducing ambient eval
- [ ] prove a larger third-party Cuis package with real package dependencies

Guardrails:

```text
Spur object memory != Lagrange image graph
Spur oop != durable ObjectRef
runtime instance != image object
provider handle != ObjectRef
runtime ID != capability
package host path != package identity
package basename != package identity
exported service != arbitrary perform:
provider control plane != guest package state
compatibility != mandatory migration
```

#### B. Real Smalltalk compiler/toolchain

- [ ] add an OpenSmalltalkVM/Cuis toolchain provider over `ToolchainService`
- [ ] make VM/compiler-image version plus source/package artifacts explicit deterministic inputs
- [ ] compile/load a real Cuis package set using the real Smalltalk compiler
- [ ] produce a reproducible runnable Smalltalk image artifact as the first derived output
- [ ] opt deterministic builds into toolchain result reuse where honest
- [ ] expose compiler diagnostics/source mapping/provenance through the generic toolchain result contract

The runtime proof has now established real package materialization and loading, so this toolchain work can reuse observed Cuis conventions rather than inventing a parallel package model.

#### C. Structured export and migration bridge

- [ ] export classes, superclass relationships, methods/selectors and package/source relationships as structured artifacts
- [ ] export CompiledMethod/bytecode/literal information where stable/useful
- [ ] import those structures without treating foreign object pointers as durable identity
- [ ] inspect/relate foreign Smalltalk code from image-native projects/tools while it still runs on OpenSmalltalkVM
- [ ] prove a mixed project where OpenSmalltalkVM and native Lagrange services call through explicit interfaces
- [ ] selectively lower/recompile methods where semantics and benefit justify it
- [ ] measure which code benefits from migration and leave the rest on the compatibility runtime

#### D. Longer-term WASM-hosted compatibility runtime

- [ ] identify/build the smallest headless interpreter-style OpenSmalltalk/Spur runtime suitable for WASM
- [ ] compile that runtime to `wasm-binary/v1` without requiring a native-code-generating JIT
- [ ] define a richer runtime/component interface for initialization, image loading, memory/string transport and services
- [ ] add controlled capability-aware host callbacks and async effects only through explicit contracts
- [ ] support snapshot/export semantics without conflating guest heap state with image graph state
- [ ] compare native/OCI and WASM-hosted OpenSmalltalkVM for compatibility/startup/placement/sandboxing/performance

Success: a real compatible Smalltalk application/library can remain on OpenSmalltalkVM, participate in Lagrange image projects/interfaces/history, and selectively move code or the runtime itself toward native/WASM execution without a flag-day port.

See ADR 0022 for the end state, ADR 0023 for the generic lifecycle, ADR 0024 for the first real runtime proof and ADR 0025 for the first unchanged upstream-package proof.

### 2. Richer foreign/component interfaces

- [x] separate raw `wasm-binary/v1` from callable interface identity
- [x] first `wasm-callable-interface/v1`
- [x] first `wasm-scalar-call/v0` for boolean/i32/i64/f32/f64
- [x] ordinary Block/ActivationExecutor invocation of foreign scalar WASM
- [x] runtime-local compiled foreign module cache with fresh instance per activation
- [ ] explicit string/bytes memory ABI or skip directly to Component/WIT values
- [ ] records/arrays and multiple results
- [ ] WASM Component/WIT-style callable artifact contract
- [ ] capability-aware imported host functions
- [ ] async foreign effects/callbacks without blocking/replay hacks
- [ ] reusable foreign instance/reset contracts where a toolchain can prove safety

Success: a nontrivial external library is callable from at least two language personalities through one implementation-independent interface.

### 3. Real package import and toolchain integration

- [x] generic artifact dependencies separate from provenance
- [x] generic external ToolchainProvider/ToolchainService contract
- [x] digest-pinned OCI runner
- [x] Cargo/rustc provider using existing compiler ecosystem
- [x] explicit Cargo manifest/lock/source artifacts
- [x] explicit vendored package config/files and SHA-256 validation
- [x] deterministic provider-opt-in result reuse
- [x] first existing-runtime package import proof through OpenSmalltalkVM/Cuis
- [ ] durable Cuis package artifact convention and dependency graph
- [ ] crates.io `.crate` importer -> explicit vendor/package artifacts
- [ ] git/private-registry dependency import conventions
- [ ] real pinned-OCI integration job for the vendored Cargo fixture
- [ ] indexed durable lookup for toolchain result keys
- [ ] cross-install content-addressed reuse with truthful installation provenance

### 4. Durable Lagrange backend

- [ ] settle the public Lagrange embedding seam
- [ ] map Values/refs/shapes/objects/artifacts/history to durable schema
- [ ] atomic state + history writes
- [ ] backend conformance suite shared with mock
- [ ] restart and multi-node durability tests
- [ ] logical snapshot/revision frontiers
- [ ] indexes for graph reachability and derivation lookup
- [ ] measure partitioning/index choices on large images

Success: the same image and artifact graph survives process/node failure with no semantic changes.

## Language work

### Symmetric Smalltalk

Implemented:

- parser/tokenizer with unary/binary/keyword precedence
- source -> syntax -> `lagrange-code/v0`
- image-resident bootstrap dispatch
- nested lexical Blocks and stable binding IDs
- lexical `self` capture
- neutral interpreter + Lagrange WASM execution
- automatic nested Block-tree WASM installation
- shared physical modules with separate Block/function identity

Next:

- [ ] create/use nested Block inside one WASM activation
- [ ] assignments, temporaries, sequences and cascades
- [ ] Object/Behavior/Class/Metaclass bootstrap and inheritance
- [ ] immediate-value objects/primitives
- [ ] REPL/workspace
- [ ] bootstrap image

Symmetric Smalltalk remains the native language experiment; Cuis compatibility is no longer blocked on a replacement compiler/runtime.

### Compatible Smalltalk via OpenSmalltalkVM

- [x] generic runtime registry/service + lifecycle contract
- [x] real OpenSmalltalkVM runtime adapter + explicit proof service boundary
- [x] real pinned Cuis image execution in CI
- [x] existing unchanged Cuis package compatibility proof using upstream JSON package
- [x] explicit package identities separate from host paths and provider identity
- [ ] multi-package dependency proof with a larger third-party package
- [ ] real Smalltalk compiler/toolchain provider
- [ ] structured class/method/package export
- [ ] mixed foreign/native Smalltalk project proof
- [ ] selective native lowering/compilation where useful
- [ ] optional headless interpreter/Spur-to-WASM runtime proof

### Common Lisp

- [ ] personality spike using common artifact/closure/toolchain substrate
- [ ] reader/macroexpansion representation
- [ ] dynamic bindings
- [ ] multiple values
- [ ] conditions/restarts
- [ ] integrate an existing Lisp compiler/runtime where useful rather than forcing Smalltalk semantics

### Rust

Implemented: explicit Cargo graph, Cargo/rustc in OCI, closed vendored dependencies, toolchain cache, raw WASM import and scalar callable interface.

Next:

- [ ] standard package importer
- [ ] Lagrange Rust SDK/crate for explicit host calls
- [ ] Component/WIT-style rich interface proof
- [ ] portable precompiled WASM/component dependency reuse
- [ ] document stable library artifacts vs compiler-private build caches

### Java

- [ ] Java source/class/JAR artifact conventions
- [ ] JAR/class importer and dependency reuse
- [ ] existing javac/JVM/AOT/Java-to-WASM toolchain spike
- [ ] JVM/OCI foreign-runtime compatibility spike over the generic lifecycle
- [ ] compare JVM compatibility vs deeper WASM/image integration on one realistic application

## Execution/runtime work

### Image-native Lagrange WASM

Implemented: `lagrange-value-handle/v0`, tail send/Block effects, compilation groups, shared multi-entry modules, deterministic compiler reuse, module cache and `stateless-v0` instance pooling.

Next:

- [ ] module-size/budget splitting of logical groups
- [ ] direct optimized calls between entries in one shared module
- [ ] general non-tail async effects/continuations
- [ ] optimized/non-materialized closure representations
- [ ] exception/condition substrate
- [ ] debugger activation metadata

### Distributed and foreign-runtime execution

Implemented:

- language-neutral `ForeignRuntimeProviderRegistry` / `ForeignRuntimeService`
- stable provider identity separate from provider selection ID
- transient runtime IDs and provider-private opaque handles
- explicit start/call/stop protocol with canonical Values
- stop gating/waiting and top-level shutdown ownership
- first real local-process OpenSmalltalkVM/Cuis provider
- process-line runner with no shell
- pinned real-runtime integration proof in PR CI
- explicit Cuis package startup inputs with immutable identities and safe basenames
- provider bridge bootstrap before guest package installation
- first unchanged upstream package execution proof
- transient bootstrap progress diagnostics for runtime/package startup

Next:

- [ ] object locator and placement policy
- [ ] capability handles separate from object refs
- [ ] capability/principal context on foreign calls
- [ ] local vs remote call semantics
- [ ] Lagrange WASM placement
- [ ] OCI foreign-runtime lifecycle/placement implementation
- [ ] JVM foreign-runtime implementation using the generic contract
- [ ] routing between image-native, component/foreign WASM and live foreign runtimes
- [ ] explicit failure/retry/idempotency semantics
- [ ] durable runtime-definition/reconciliation contract where deployment requires it
- [ ] measured `ctx.call()` compute-near-object wins

## Graph and project work

### Graph services

- [ ] indexed reachability traversal
- [ ] revision-aware reads
- [ ] export/import graph format
- [ ] garbage-collection rules respecting history/pinned refs
- [ ] object migration between immutable shapes

### Projects and collaborative history

- [ ] project objects and relationships
- [ ] code + notes + tests + data + work items
- [ ] first-class package/binary/component/runtime dependency relationships
- [ ] manifest/lock/runtime-image artifacts as project members where applicable
- [ ] projects that mix native code and OpenSmalltalkVM-backed code through explicit relationships/interfaces
- [ ] branches/working views and object-level diffs
- [ ] merge semantics
- [ ] Git import/export as projection rather than canonical storage
- [ ] multi-author conflict UI/API

## Graphical environment

- [ ] drawing/input substrate
- [ ] retained UI objects, widgets and layout
- [ ] surfaces/windows
- [ ] replaceable shell/window-manager policy
- [ ] inspectors, browsers and debugger as image-resident tools
- [ ] inspect/browse OpenSmalltalkVM-backed structures through explicit adapter identities without conflating its heap with the image graph

## Completed foundation

Established substrate:

- language-neutral Value/ref/shape/object graph
- Block + LexicalEnvironment closure model
- language-owned dispatch + common activation execution
- semantic vs executable code separation
- internal Lagrange WASM backend
- artifact dependency/provenance graph
- generic external toolchain providers + deterministic reuse
- Cargo/rustc OCI integration with explicit package inputs
- first explicit foreign-WASM callable interface
- generic long-lived foreign-runtime lifecycle
- real OpenSmalltalkVM/Cuis foreign-runtime provider
- unchanged upstream Cuis package loading/execution proof

See [decisions/README.md](decisions/README.md) for ADRs grouped by topic.
