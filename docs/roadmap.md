# Roadmap

The roadmap is ordered by architectural pressure, not by language popularity. Completed implementation detail lives in the ADRs; this file should make the current frontier obvious.

## Current frontier

The substrate can now do this end to end:

```text
image-native Smalltalk
        |
        +-> semantic code -> Lagrange WASM -> ordinary activation

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
```

The first foreign callable ABI, `wasm-scalar-call/v0`, supports pure synchronous no-import scalar functions.

The generic long-lived foreign-runtime lifecycle is now implemented. The next major compatibility proof is to put it under real pressure with OpenSmalltalkVM + a Cuis-compatible image rather than extending the abstraction in isolation.

## Next

These are the highest-value pressure tests on the current abstractions.

### 1. Richer foreign/component interfaces

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

### 2. OpenSmalltalkVM / Cuis compatibility path

The end goal is two complementary Smalltalk paths rather than one compatibility implementation:

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
- [x] runtime-local instance IDs and private provider handles kept separate from durable ObjectRefs/capabilities
- [x] service shutdown closes the call gate, waits for accepted calls and owns normal runtime shutdown
- [ ] define artifact conventions for OpenSmalltalkVM runtime/build identity and compatible Smalltalk image artifacts
- [ ] implement an OpenSmalltalkVM provider over the generic foreign-runtime contract
- [ ] run a headless OpenSmalltalkVM + Cuis-compatible image as a managed foreign runtime, initially native/OCI
- [ ] install a small bridge package in the Smalltalk image with explicitly exported service/call interfaces
- [ ] invoke a real Smalltalk service from Lagrange Images through the common foreign-runtime/interface boundary
- [ ] define provider-specific lifecycle, restart and image/snapshot persistence behavior explicitly
- [ ] prove one useful existing Cuis package/library works without source-level reimplementation in Lagrange Images

Guardrails:

```text
Spur object memory != Lagrange image graph
Spur oop != durable ObjectRef
runtime instance != image object
provider handle != ObjectRef
runtime ID != capability
compatibility != mandatory migration
```

#### B. Real Smalltalk compiler/toolchain

- [ ] add an OpenSmalltalkVM/Cuis toolchain provider over `ToolchainService`
- [ ] treat VM/compiler-image version plus source/package artifacts and options as explicit deterministic toolchain inputs
- [ ] compile/load a real Cuis source/package set using the real Smalltalk compiler rather than a new compatibility compiler
- [ ] produce a reproducible runnable Smalltalk image artifact as the first useful derived output
- [ ] opt deterministic builds into toolchain result reuse where the runtime/compiler inputs make that honest
- [ ] expose compiler diagnostics/source mapping/provenance through the generic toolchain result contract

#### C. Structured export and migration bridge

- [ ] export classes, superclass relationships, methods/selectors and package/source relationships as structured artifacts
- [ ] export CompiledMethod/bytecode/literal information where stable/useful
- [ ] import those structures without treating foreign object pointers as durable identity
- [ ] allow image-native projects/tools to inspect and relate foreign Smalltalk code while it still executes on OpenSmalltalkVM
- [ ] prove a mixed project where an OpenSmalltalkVM service calls/uses a native Lagrange service or vice versa through explicit interfaces
- [ ] lower or recompile selected compatible methods/functions into native Lagrange representations when semantics are sufficiently understood
- [ ] measure which code benefits from native migration and leave the rest on the compatibility runtime

#### D. Longer-term WASM-hosted compatibility runtime

- [ ] identify/build the smallest headless interpreter-style OpenSmalltalk/Spur runtime suitable for a WASM port
- [ ] compile the interpreter/runtime implementation to `wasm-binary/v1` without requiring a native-code-generating JIT
- [ ] define a richer runtime/component interface for initialization, image loading, memory/string transport and exported Smalltalk services
- [ ] add controlled capability-aware host callbacks and async effects only through explicit interface contracts
- [ ] support runtime snapshot/export semantics without conflating guest heap state with image graph state
- [ ] compare native/OCI OpenSmalltalkVM against WASM-hosted OpenSmalltalkVM for compatibility, startup, placement, sandboxing and performance
- [ ] allow Lagrange placement of the WASM-hosted runtime where that produces a concrete benefit

Success: a real compatible Smalltalk application/library can remain on OpenSmalltalkVM, participate in Lagrange image projects/interfaces/history, and selectively move code or the runtime itself toward native/WASM execution without a flag-day port.

See ADR 0022 for the long-term Smalltalk architecture and ADR 0023 for the implemented generic foreign-runtime lifecycle.

### 3. Real package import and toolchain integration

- [x] generic artifact dependencies separate from provenance
- [x] generic external ToolchainProvider/ToolchainService contract
- [x] digest-pinned OCI runner
- [x] Cargo/rustc provider using existing compiler ecosystem
- [x] explicit Cargo manifest/lock/source artifacts
- [x] explicit vendored package config/files and SHA-256 validation
- [x] deterministic provider-opt-in result reuse
- [ ] crates.io `.crate` importer -> explicit vendor/package artifacts
- [ ] git/private-registry dependency import conventions
- [ ] real pinned-OCI integration job for the vendored Cargo fixture
- [ ] indexed durable lookup for toolchain result keys
- [ ] cross-install content-addressed reuse with truthful installation provenance

Success: import a normal ecosystem package/project, rebuild it without hidden network inputs, and reuse its immutable result across normal development iterations.

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

Symmetric Smalltalk should continue developing as the native language. Cuis compatibility no longer needs to be blocked on a hand-built native compatibility compiler because OpenSmalltalkVM is the preferred first compatibility path.

### Compatible Smalltalk via OpenSmalltalkVM

- [x] generic runtime registry/service + lifecycle contract
- [ ] OpenSmalltalkVM runtime adapter + explicit Smalltalk service boundary
- [ ] real Cuis-compatible image/package proof
- [ ] real Smalltalk compiler/toolchain provider
- [ ] structured class/method/package export
- [ ] mixed foreign/native Smalltalk project proof
- [ ] selective native lowering/compilation where useful
- [ ] optional headless interpreter/Spur-to-WASM runtime proof

The compatibility goal is to keep mature Smalltalk code useful while progressively exposing image identity/history/projects/capabilities and native Lagrange execution where it pays off.

### Common Lisp

- [ ] personality spike using common artifact/closure/toolchain substrate
- [ ] reader/macroexpansion representation
- [ ] dynamic bindings
- [ ] multiple values
- [ ] conditions/restarts
- [ ] integrate an existing Lisp compiler/runtime where useful rather than forcing Smalltalk semantics

### Rust

Implemented:

- explicit Cargo project/package graph
- existing Cargo/rustc compiler in OCI
- closed vendored third-party dependencies
- toolchain cache
- raw WASM import
- first callable scalar interface

Next:

- [ ] standard package importer
- [ ] Lagrange Rust SDK/crate for explicit host calls
- [ ] Component/WIT-style rich interface proof
- [ ] prove portable precompiled WASM/component dependency reuse
- [ ] document stable library artifacts vs compiler-private build caches

### Java

- [ ] Java source/class/JAR artifact conventions
- [ ] JAR/class importer and dependency reuse
- [ ] existing javac/JVM/AOT/Java-to-WASM toolchain spike
- [ ] JVM/OCI foreign-runtime compatibility spike over the generic lifecycle contract
- [ ] compare JVM compatibility vs deeper WASM/image integration on one realistic application

## Execution/runtime work

### Image-native Lagrange WASM

Implemented:

- `lagrange-value-handle/v0`
- tail language-send effects
- tail nested-Block effects
- language-neutral compilation groups
- shared multi-entry modules
- deterministic durable compiler reuse
- runtime-local compiled-module cache
- explicit `stateless-v0` instance pooling/rebinding

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
- transient runtime IDs separate from image object identity
- provider-private opaque runtime handles
- explicit start/call/stop protocol with canonical Value results
- stop gating/waiting for in-flight calls
- normal top-level runtime shutdown ownership

Next:

- [ ] object locator and placement policy
- [ ] capability handles separate from object refs
- [ ] capability/principal context on foreign calls
- [ ] local vs remote call semantics
- [ ] Lagrange WASM placement
- [ ] OCI foreign-runtime lifecycle/placement implementation
- [ ] OpenSmalltalkVM foreign-runtime implementation using the generic contract
- [ ] JVM foreign-runtime implementation using the generic contract
- [ ] routing between image-native, component/foreign WASM and live foreign runtimes
- [ ] explicit failure/retry/idempotency semantics
- [ ] durable runtime-definition/reconciliation contract where deployment requires it
- [ ] measured `ctx.call()` compute-near-object wins

Success: execution placement changes without changing object/artifact identity or pretending a foreign process heap is image state.

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

Success: an image project can mix editable source, compiled dependencies, foreign runtime artifacts, data and work/history without reducing itself to files or pretending every runtime heap is native image state.

## Graphical environment

- [ ] drawing/input substrate
- [ ] retained UI objects, widgets and layout
- [ ] surfaces/windows
- [ ] replaceable shell/window-manager policy
- [ ] inspectors, browsers and debugger as image-resident tools
- [ ] inspect/browse OpenSmalltalkVM-backed classes/methods/objects through explicit adapter handles without conflating their heap with the image graph

## Completed foundation

The following substrate is considered established enough to build on:

- language-neutral Value/ref/shape/object graph
- stable identity vs revision
- Block + LexicalEnvironment closure model
- language-owned dispatch + common activation execution
- semantic vs executable code separation
- internal Lagrange WASM backend
- artifact dependency/provenance graph
- generic external toolchain providers
- Cargo/rustc OCI integration with explicit package inputs
- deterministic external-toolchain result reuse
- first explicit foreign-WASM callable interface
- generic long-lived foreign-runtime lifecycle substrate

The OpenSmalltalkVM direction deliberately builds on these generic boundaries rather than adding a Smalltalk-specific storage/execution substrate.

See [decisions/README.md](decisions/README.md) for the ADRs grouped by topic.
