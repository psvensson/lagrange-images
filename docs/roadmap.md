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

## 4. Language-neutral execution kernel

- [x] code artifact contract
- [x] blocks/closures and lexical environments
- [ ] message/call dispatch
- [ ] activations and debugger metadata
- [ ] exception/condition substrate
- [ ] host/WASM FFI boundary

Success: a tiny language executes without adding its semantics to image persistence.

## 5. Symmetric Smalltalk seed

- [ ] grammar and parser
- [ ] tiny interpreter
- [ ] map language-visible blocks onto the neutral block/environment records
- [ ] Object/Behavior/Class/Metaclass mapping
- [ ] compiler to first executable IR
- [ ] REPL/workspace
- [ ] bootstrap image

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
