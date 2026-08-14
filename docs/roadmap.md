# Roadmap

Ordered so each phase produces something runnable and can falsify the abstractions above it.

## 0. Mock vertical slice — complete

- [x] backend contract and in-memory mock
- [x] image creation, history and snapshots
- [x] backend auto-detection
- [x] HTTP/demo surface
- [x] language registry and Symmetric Smalltalk profile

## 1. Language-neutral graph foundation — complete

- [x] ordinary object refs and pinned historical refs
- [x] tagged scalar Values
- [x] arbitrary-precision integers and exact float bits
- [x] immutable shape records
- [x] stable slot IDs independent of display names
- [x] separate shape and behavior refs
- [x] reject arbitrary JSON object state
- [x] explicit reference walker
- [x] cycle tests
- [x] prevent metadata from hiding graph refs
- [x] graph-aware runtime, HTTP surface and demo

Success: an image is an explicit language-neutral graph rather than language-shaped JSON records.

## 2. Durable Lagrange backend

- [ ] settle the public embedding seam with Lagrange
- [ ] map Values/refs/shapes/objects/history to durable schema
- [ ] atomic state + history writes
- [ ] conformance suite shared with mock
- [ ] restart and multi-node durability tests
- [ ] logical snapshot/revision frontiers
- [ ] measure partitioning/index choices on large graphs

Success: the same graph survives process/node restarts with no language/image semantic changes.

## 3. Graph services

- [ ] reachability traversal over backend indexes
- [ ] indexes by shape/project/name where justified
- [ ] revision-aware reads
- [ ] export/import graph format
- [ ] garbage-collection rules respecting history/pinned refs
- [ ] object migration between immutable shapes

## 4. Language-neutral execution and compilation kernel

- [x] code artifact contract
- [x] blocks/closures and lexical environments
- [x] message/call dispatch to transient activation requests
- [x] execution of activation requests
- [x] positional receiver/argument/captured-binding calling convention
- [x] pluggable code executor registry
- [x] first executable `neutral-expression/v0` representation
- [x] language-tagged nested message sends from neutral expressions
- [x] explicit `lagrange-code/v0` semantic representation
- [x] code compiler registry and immutable derivation service
- [x] semantic -> neutral-expression lowering
- [x] executable-artifact rebuildability invariant
- [x] `wasm-module/v1` and `wasm-function/v1` artifact contracts
- [x] first `lagrange-code/v0` -> WASM compiler
- [x] `lagrange-value-handle/v0` calling ABI
- [x] Node WebAssembly execution through the normal ActivationExecutor
- [x] interpreter/WASM differential tests
- [ ] WASM message-send host import
- [ ] WASM nested closure creation
- [ ] activations and debugger metadata
- [ ] exception/condition substrate
- [ ] capability-aware host/WASM FFI boundary

Success: semantic code is independent of execution representation and a useful pure subset executes interchangeably through the interpreter or real WASM.

## 5. Symmetric Smalltalk seed

- [x] first grammar/tokenizer/parser
- [x] unary/binary/keyword message precedence
- [x] outer Block compilation unit and positional parameters
- [x] source -> syntax -> semantic -> executable artifact provenance
- [x] compiler to language-neutral semantic representation
- [x] first image-resident behavior/method lookup convention
- [x] end-to-end compiled message sends through common dispatch/execution
- [x] runtime nested Block creation
- [x] automatic lexical capture analysis with stable binding IDs
- [x] lexical `self` capture across Block boundaries
- [x] ordinary `value*` sends to Blocks through the Smalltalk dispatcher
- [ ] assignments, temporaries, sequences and cascades
- [ ] Object/Behavior/Class/Metaclass bootstrap and inheritance
- [ ] immediate-value objects/primitives
- [ ] REPL/workspace
- [ ] bootstrap image

Success for the current seed: nested Smalltalk closures parse, compile into semantic code, materialize in the bootstrap interpreter and execute through ordinary message dispatch.

## 6. Projects and collaborative history

- [ ] project objects and relationships
- [ ] code + notes + tests + data + work items
- [ ] branches/working views and object-level diffs
- [ ] merge semantics
- [ ] Git import/export projection
- [ ] multi-author conflict UI/API

## 7. Compatibility kernels

- [ ] Cuis source/package importer
- [ ] Smalltalk compatibility library layer
- [ ] prove several useful Cuis libraries
- [ ] Common Lisp personality spike

## 8. Distributed execution

- [ ] object locator and activation policy
- [ ] capability handles separate from object refs
- [ ] local vs remote send semantics
- [ ] WASM code placement
- [ ] measured `ctx.call()` compute-near-object wins
- [ ] failure/retry/idempotency model

## 9. Graphical environment

- [ ] drawing/input substrate
- [ ] retained UI objects, widgets and layout
- [ ] surfaces/windows
- [ ] replaceable shell/window-manager policy
- [ ] inspectors, browsers and debugger as image-resident tools
