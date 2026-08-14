# Roadmap

The roadmap is ordered by architectural pressure, not by language popularity. Completed implementation detail lives in the ADRs; this file should make the current frontier obvious.

## Current frontier

The substrate can now do these paths end to end:

```text
image-native Smalltalk
        -> semantic code -> neutral executor / Lagrange WASM -> ordinary activation

external Rust/Cargo project
        -> explicit source/lock/vendor artifact graph
        -> digest-pinned OCI Cargo/rustc provider
        -> deterministic toolchain-result reuse
        -> wasm-binary/v1
        -> wasm-callable-interface/v1
        -> ordinary Block activation

long-lived foreign runtime
        -> durable runtime-definition artifact
        -> runtime-local provider binding
        -> ForeignRuntimeService
        -> lazy start -> canonical-Value calls -> stop

real compatible Smalltalk toolchain/runtime
        -> explicit base image/changes/sources/package artifact graph
        -> ToolchainService + real OpenSmalltalkVM/Cuis tooling
        -> derived runnable .image + .changes artifacts
        -> durable Cuis runtime definition
        -> foreign-runtime-callable-interface/v1
        -> ordinary Block activation

mixed program
        -> Symmetric Smalltalk captures ordinary Blocks
        -> foreign WASM Block + live Cuis Block
        -> one expression composes both implementation lanes
```

The real Cuis proof still uses the unchanged upstream JSON package and verifies that the package survives in the toolchain-produced image without reinstalling it at runtime. The mixed proof then composes a foreign-WASM add Block with a Cuis `proof/add` Block from Symmetric Smalltalk.

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
- [x] durable artifact-backed Cuis runtime definitions separate from running instances
- [x] runtime-local definition -> provider binding and lazy reusable runtime instances
- [x] ordinary Block/ActivationExecutor invocation of a Cuis-backed service
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
runtime definition != provider installation
package host path != package identity
package basename != package identity
exported service != arbitrary perform:
provider control plane != guest package state
compatibility != mandatory migration
```

#### B. Real Smalltalk compiler/toolchain

- [x] add an OpenSmalltalkVM/Cuis toolchain provider over `ToolchainService`
- [x] define explicit `smalltalk/cuis-build-v1`, image, changes, sources and package artifact conventions
- [x] keep OpenSmalltalkVM identity as provider material while making the compiler-bearing base Cuis image an explicit input
- [x] make base image/changes/sources and package bytes explicit build/provenance inputs
- [x] compile/load a real upstream Cuis package set using the real Smalltalk environment
- [x] produce derived runnable Cuis image + changes artifacts
- [x] launch the toolchain-produced image in a fresh runtime and prove the package is already installed
- [x] expose build stdout/stderr diagnostics plus generic complete-graph provenance
- [ ] prove whether identical closed-input Cuis snapshots are byte-reproducible or define a safe normalization contract
- [ ] opt into generic toolchain result reuse only after snapshot determinism is demonstrated
- [ ] support several dependent Cuis packages and their actual Feature/package ordering rules
- [ ] decide whether image/changes should gain an explicit sibling-result relationship once a real consumer needs it

The toolchain deliberately has no `cacheKey()` yet. Closed inputs are necessary but not sufficient evidence that a saved Smalltalk image is deterministic.

#### C. Structured export and migration bridge

- [ ] export classes, superclass relationships, methods/selectors and package/source relationships as structured artifacts
- [ ] export CompiledMethod/bytecode/literal information where stable/useful
- [ ] import those structures without treating foreign object pointers as durable identity
- [ ] inspect/relate foreign Smalltalk code from image-native projects/tools while it still runs on OpenSmalltalkVM
- [x] prove image-native Symmetric Smalltalk can compose OpenSmalltalkVM and foreign-WASM Blocks through ordinary interfaces
- [ ] prove a first-class project that relates native and OpenSmalltalkVM-backed code/artifacts explicitly
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

See ADR 0022 for the end state, ADR 0026 for the real Cuis toolchain, ADR 0027 for durable runtime definitions, ADR 0028 for callable runtime Blocks and ADR 0029 for mixed composition.

### 2. Richer foreign/component interfaces

- [x] separate raw `wasm-binary/v1` from callable interface identity
- [x] first `wasm-callable-interface/v1`
- [x] first `wasm-scalar-call/v0` for boolean/i32/i64/f32/f64
- [x] ordinary Block/ActivationExecutor invocation of foreign scalar WASM
- [x] runtime-local compiled foreign module cache with fresh instance per activation
- [x] first `foreign-runtime-callable-interface/v1` over durable runtime definitions
- [x] language-level Block sends can invoke both foreign WASM and foreign-runtime callables
- [x] one language program composes two implementation lanes through ordinary Blocks
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
- [x] first explicit Cuis build/image/changes/sources/package artifact conventions
- [x] real Cuis toolchain provider deriving a runnable package-bearing image
- [ ] Cuis multi-package dependency/Feature conventions
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
- captured foreign Blocks invoked with ordinary `value:`/`value:value:` sends
- mixed neutral-executor orchestration over foreign WASM and live Cuis

Next:

- [ ] create/use nested Block inside one WASM activation
- [ ] assignments, temporaries, sequences and cascades
- [ ] Object/Behavior/Class/Metaclass bootstrap and inheritance
- [ ] immediate-value objects/primitives
- [ ] REPL/workspace
- [ ] bootstrap image

The mixed proof currently uses `neutral-expression/v0`: its nested foreign call is a non-tail async send. General non-tail continuation/effect support remains necessary for the same composition through the Lagrange-WASM backend.

### Compatible Smalltalk via OpenSmalltalkVM

- [x] generic runtime registry/service + lifecycle contract
- [x] real OpenSmalltalkVM runtime adapter + explicit proof service boundary
- [x] real pinned Cuis image execution in CI
- [x] existing unchanged Cuis package compatibility proof using upstream JSON package
- [x] explicit package identities separate from host paths and provider identity
- [x] real OpenSmalltalkVM/Cuis `ToolchainService` provider
- [x] explicit compiler-bearing base image/support/package artifact graph
- [x] derived runnable Cuis image verified in a fresh runtime
- [x] durable runtime-definition and callable Block path
- [x] mixed image-native/compatible Smalltalk execution proof through ordinary Blocks
- [ ] multi-package dependency proof with a larger third-party package
- [ ] structured class/method/package export
- [ ] first-class mixed project representation
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

Implemented: explicit Cargo graph, Cargo/rustc in OCI, closed vendored dependencies, toolchain cache, raw WASM import, scalar callable interface, and composition as an ordinary Block from Symmetric Smalltalk.

Next:

- [ ] real pinned-OCI Cargo integration proof in CI
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
- durable artifact-backed runtime definitions
- runtime-local definition/provider bindings
- lazy/coalesced reusable runtime instances for callable definitions
- ordinary Block callable interface over live foreign runtimes
- first real local-process OpenSmalltalkVM/Cuis provider
- process-line runner with no shell
- pinned real-runtime integration proof in PR CI
- explicit Cuis package startup inputs with immutable identities and safe basenames
- provider bridge bootstrap before guest package installation
- unchanged upstream package execution and toolchain-produced-image proof
- local mixed routing between image-native Smalltalk, foreign WASM and live Cuis through Block dispatch

Next:

- [ ] object locator and placement policy
- [ ] capability handles separate from object refs
- [ ] capability/principal context on foreign calls
- [ ] local vs remote call semantics
- [ ] Lagrange WASM placement
- [ ] OCI foreign-runtime lifecycle/placement implementation
- [ ] JVM foreign-runtime implementation using the generic contract
- [ ] distributed routing between image-native, component/foreign WASM and live foreign runtimes
- [ ] explicit failure/retry/idempotency semantics
- [ ] durable deployment/reconciliation contract above runtime definitions
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
- explicit foreign-WASM callable interface
- generic long-lived foreign-runtime lifecycle
- durable artifact-backed runtime definitions
- foreign-runtime callable Blocks with lazy runtime reuse
- real OpenSmalltalkVM/Cuis runtime/toolchain/package proofs
- mixed Symmetric Smalltalk composition over foreign WASM and live Cuis Blocks

See [decisions/README.md](decisions/README.md) for ADRs grouped by topic.
