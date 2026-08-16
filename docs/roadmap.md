# Roadmap

The roadmap is ordered by architectural pressure, not by language popularity. Completed implementation detail lives in the ADRs; this file should make the current frontier obvious.

## Current frontier

The substrate can now do these paths end to end:

```text
image-native Smalltalk
        -> lagrange-code/v0
        -> neutral executor OR hybrid Lagrange WASM
        -> ordinary activation

hybrid Lagrange WASM
        -> lagrange-value-handle/v0 for simple/tail effects
        -> lagrange-value-handle-resumable/v1 when a host effect is non-tail
        -> compiler-generated resume entries
        -> multiple sequential send/closure effects

external Rust/Cargo project
        -> explicit source/lock/vendor artifact graph
        -> Cargo/rustc provider
        -> wasm-binary/v1
        -> wasm-callable-interface/v1
        -> ordinary Block activation

long-lived foreign runtime
        -> durable runtime-definition artifact
        -> runtime-local provider binding
        -> lazy transient runtime
        -> ordinary callable Block

real compatible Smalltalk
        -> OpenSmalltalkVM/Cuis toolchain
        -> derived runnable image
        -> durable Cuis runtime definition
        -> ordinary callable Block

mixed program
        -> one Symmetric Smalltalk semantic artifact
        -> foreign WASM Block + live Cuis Block
        -> neutral and resumable Lagrange-WASM executions agree
```

The real PR-only proof builds a Cuis image containing the unchanged upstream JSON package, starts that image without reinstalling JSON, and then runs the mixed Smalltalk orchestration through resumable Lagrange WASM against the same live Cuis runtime.

## Next

### 1. Richer foreign/component interfaces

The scalar callable proofs have now done their job. The next interface work should expand useful data without turning the v0 scalar ABI into an ad-hoc memory protocol.

- [x] separate raw `wasm-binary/v1` from callable interface identity
- [x] `wasm-scalar-call/v0` over boolean/i32/i64/f32/f64
- [x] ordinary Block invocation of foreign scalar WASM
- [x] `foreign-runtime-callable-interface/v1` over durable runtime definitions
- [x] language-level Block sends invoke both foreign WASM and live foreign runtimes
- [x] one semantic program composes both implementation lanes
- [ ] choose explicit string/bytes ABI vs moving directly to Component/WIT values
- [ ] records/arrays and multiple results
- [ ] WASM Component/WIT-style callable artifact contract
- [ ] map the same interface shape to at least two implementation lanes
- [ ] capability-aware imported host functions
- [ ] async foreign callbacks/effects only through explicit contracts
- [ ] reusable foreign instance/reset contracts where a toolchain can prove safety

Success: a nontrivial external library exposes structured values through an implementation-independent interface usable from multiple language personalities.

### 2. OpenSmalltalkVM / Cuis compatibility depth

#### Runtime/toolchain

- [x] generic foreign-runtime lifecycle
- [x] real OpenSmalltalkVM/Cuis provider
- [x] pinned real-runtime CI
- [x] unchanged upstream JSON package load/execution
- [x] real Cuis `ToolchainService` provider
- [x] derived runnable image + changes artifacts
- [x] durable artifact-backed Cuis runtime definitions
- [x] runtime-local provider binding + lazy instance reuse
- [x] ordinary Cuis-backed callable Blocks
- [x] mixed image-native/compatible execution through ordinary Blocks
- [ ] explicit dependency graph/order for several Cuis packages
- [ ] prove a larger third-party package with real dependencies
- [ ] snapshot byte reproducibility/normalization investigation
- [ ] opt into toolchain result reuse only if determinism is demonstrated
- [ ] richer explicit Cuis service interfaces without ambient eval
- [ ] OCI foreign-runtime launcher/placement
- [ ] restart/reconciliation and snapshot persistence behavior

#### Structured export and migration

- [ ] export package/class/superclass/method/selector/source relationships as structured artifacts
- [ ] export useful CompiledMethod/bytecode/literal information where stable
- [ ] inspect/relate those structures from image-native tools without foreign oop identity
- [ ] first-class project that explicitly relates native and OpenSmalltalkVM-backed artifacts
- [ ] selective native lowering/recompilation where useful
- [ ] measure which code benefits from migration and leave the rest on the compatibility runtime

Success: a real compatible Smalltalk project can remain on OpenSmalltalkVM while participating in Lagrange image projects/history/interfaces and selectively migrate only beneficial pieces.

### 3. Real package import and compiler ecosystem integration

- [x] generic artifact dependencies separate from provenance
- [x] generic ToolchainProvider/ToolchainService contract
- [x] digest-pinned OCI runner
- [x] Cargo/rustc provider
- [x] explicit Cargo manifest/lock/source/vendor artifacts
- [x] deterministic provider-opt-in toolchain reuse
- [x] Cuis package/toolchain conventions
- [ ] real pinned-OCI Cargo integration proof in CI
- [ ] crates.io `.crate` importer -> explicit package/vendor artifacts
- [ ] git/private-registry dependency import conventions
- [ ] indexed durable lookup for derivation keys
- [ ] cross-install content-addressed reuse with truthful installation provenance

### 4. Durable Lagrange backend

The mock backend remains the default for local bootstrap work, but the real Lagrange adapter now owns a durable five-table schema and consumes the public embedded application-session API.

- [x] settle the public Lagrange embedding seam
- [x] map Values/refs/shapes/objects/artifacts/history to durable schema
- [x] atomic state + history writes through the backend transaction contract
- [x] reusable backend conformance suite running against the mock
- [x] run the reusable backend conformance suite against the Lagrange SQL adapter
- [x] prove schema and atomic state/history against the real public package
- [x] prove mapping restart behavior with a file-backed compatibility runtime
- [ ] real Lagrange process-restart durability test
- [ ] multi-node failure/recovery durability tests
- [ ] logical snapshot/revision frontiers
- [ ] indexes for graph reachability and derivation lookup
- [ ] measure partitioning/index choices on large images

Success: the same image and artifact graph survives process/node failure without semantic changes.

## Language work

### Symmetric Smalltalk

Implemented:

- parser/tokenizer with unary/binary/keyword precedence
- source -> syntax -> `lagrange-code/v0`
- image-resident bootstrap dispatch
- nested lexical Blocks and stable binding IDs
- lexical `self` capture
- neutral + Lagrange-WASM execution
- automatic nested Block-tree WASM installation
- shared physical modules with separate Block/function identity
- captured foreign Blocks via ordinary `value:`/`value:value:` sends
- mixed foreign-WASM/live-Cuis orchestration
- resumable non-tail host effects in the Lagrange-WASM lane

Next:

- [ ] assignments, temporaries, sequences and cascades
- [ ] Object/Behavior/Class/Metaclass bootstrap and inheritance
- [ ] immediate-value objects/primitives
- [ ] exception/condition substrate
- [ ] REPL/workspace
- [ ] bootstrap image

The PR32 mixed expression is no longer a neutral-only proof: the same persistent semantic artifact now compiles to resumable WASM and produces the same result.

### Compatible Smalltalk via OpenSmalltalkVM

- [x] runtime/toolchain/package proofs
- [x] durable runtime-definition + callable Block path
- [x] mixed native/compatible execution proof
- [ ] multi-package dependency proof
- [ ] structured class/method/package export
- [ ] first-class mixed project representation
- [ ] selective native lowering where useful
- [ ] optional longer-term headless interpreter/Spur-to-WASM runtime proof

### Common Lisp

- [ ] personality spike using the common artifact/closure/toolchain substrate
- [ ] reader/macroexpansion representation
- [ ] dynamic bindings
- [ ] multiple values
- [ ] conditions/restarts
- [ ] reuse an existing Lisp compiler/runtime where useful

### Rust

Implemented: explicit Cargo graph, Cargo/rustc provider, closed vendored dependencies, toolchain cache, raw WASM import, scalar callable interface and composition as an ordinary Block.

Next:

- [ ] real pinned-OCI Cargo CI proof
- [ ] standard package importer
- [ ] Lagrange Rust SDK/crate for explicit host calls
- [ ] Component/WIT-style rich interface proof
- [ ] portable precompiled WASM/component dependency reuse

### Java

- [ ] Java source/class/JAR artifact conventions
- [ ] JAR/class importer and dependency reuse
- [ ] javac/JVM/AOT/Java-to-WASM toolchain spike
- [ ] JVM/OCI foreign-runtime compatibility spike over the generic lifecycle
- [ ] compare JVM compatibility vs deeper WASM/image integration on one realistic application

## Execution/runtime work

### Image-native Lagrange WASM

Implemented:

- `lagrange-value-handle/v0`
- tail message-send / nested-Block effects
- hybrid compiler fallback to `lagrange-value-handle-resumable/v1`
- compiler-generated resume exports with explicit Value-handle continuation state
- multiple sequential non-tail effects
- non-tail nested Block creation
- shared multi-entry modules using the same hybrid rule
- deterministic compiler reuse
- module cache
- `stateless-v0` instance pooling/rebinding

Next:

- [ ] tighter live-handle analysis at suspension points
- [ ] module-size/budget splitting of logical groups
- [ ] direct optimized calls between entries in one shared module
- [ ] exception/condition unwinding across suspension points
- [ ] debugger activation/resumption metadata
- [ ] optimized/non-materialized closure representations
- [ ] explicit cancellation semantics for suspended activations

Do not conflate compiler-generated resumption with durable continuation state, retry or distributed recovery.

### Distributed and foreign-runtime execution

Implemented:

- generic provider/service start-call-stop lifecycle
- transient runtime IDs/private provider handles
- durable artifact-backed runtime definitions
- runtime-local definition/provider bindings
- lazy/coalesced reusable runtime instances
- ordinary callable Blocks over live runtimes
- real local-process OpenSmalltalkVM/Cuis provider
- local mixed routing between image-native Smalltalk, foreign WASM and live Cuis

Next:

- [ ] object locator and placement policy
- [ ] capability handles separate from object refs
- [ ] capability/principal context on foreign calls
- [ ] local vs remote call semantics
- [ ] Lagrange WASM placement
- [ ] OCI foreign-runtime lifecycle/placement
- [ ] JVM foreign-runtime implementation
- [ ] distributed routing between image-native, component/foreign WASM and live runtimes
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
- [ ] manifest/lock/runtime-image artifacts as project members
- [ ] projects mixing native and OpenSmalltalkVM-backed code through explicit interfaces
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
- [ ] inspect OpenSmalltalkVM-backed structures through explicit adapter identities

## Completed foundation

Established substrate now includes:

- language-neutral Value/ref/shape/object graph
- atomic graph state + history mutation contract with reusable backend conformance
- public-session Lagrange backend with image-owned schema and real-package proof
- Block + LexicalEnvironment closure model
- language-owned dispatch + common activation execution
- semantic vs executable code separation
- hybrid image-native Lagrange-WASM backend with resumable non-tail effects
- artifact dependency/provenance graph
- generic external toolchains + deterministic reuse
- Cargo/rustc integration with explicit package inputs
- foreign-WASM callable interface
- generic long-lived foreign-runtime lifecycle
- durable runtime definitions + callable Blocks
- real OpenSmalltalkVM/Cuis runtime/toolchain/package proofs
- mixed Symmetric Smalltalk composition over foreign WASM and live Cuis through both neutral and Lagrange-WASM execution

See [decisions/README.md](decisions/README.md) for ADRs grouped by topic.
