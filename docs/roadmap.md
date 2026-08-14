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
```

The first foreign callable ABI, `wasm-scalar-call/v0`, supports pure synchronous no-import scalar functions.

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

### 2. Real package import and toolchain integration

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

### 3. Durable Lagrange backend

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
- [ ] Cuis source/package importer and compatibility layer

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
- [ ] JVM/OCI foreign-runtime compatibility spike
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

- [ ] object locator and placement policy
- [ ] capability handles separate from object refs
- [ ] local vs remote call semantics
- [ ] Lagrange WASM placement
- [ ] foreign-runtime adapter contract
- [ ] OCI foreign-runtime lifecycle/placement
- [ ] routing between image-native, component/foreign WASM and JVM/native runtimes
- [ ] explicit failure/retry/idempotency semantics
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
- [ ] first-class package/binary/component dependency relationships
- [ ] manifest/lock artifacts as project members
- [ ] branches/working views and object-level diffs
- [ ] merge semantics
- [ ] Git import/export as projection rather than canonical storage
- [ ] multi-author conflict UI/API

Success: an image project can mix editable source, compiled dependencies, data and work/history without reducing itself to files.

## Graphical environment

- [ ] drawing/input substrate
- [ ] retained UI objects, widgets and layout
- [ ] surfaces/windows
- [ ] replaceable shell/window-manager policy
- [ ] inspectors, browsers and debugger as image-resident tools

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

See [decisions/README.md](decisions/README.md) for the ADRs grouped by topic.
