# Roadmap

This is ordered to keep the architecture falsifiable. Each phase should produce something runnable before the next abstraction layer is added.

## 0. Mock vertical slice — now

- [x] backend contract
- [x] in-memory mock with optimistic versions
- [x] image creation and object storage
- [x] image history
- [x] snapshots
- [x] backend auto-detection
- [x] tiny HTTP service
- [x] language registry
- [x] Symmetric Smalltalk design profile

Success: we can exercise image semantics without waiting for Lagrange integration.

## 1. Durable Lagrange backend

- [ ] settle the public embedding seam with Lagrange
- [ ] create image/object/history schema
- [ ] atomic state + history writes
- [ ] conformance suite shared with mock
- [ ] restart tests
- [ ] multi-node durability tests
- [ ] measure partitioning choices with large object graphs

Success: the demo survives process/node restarts with no image-layer code changes.

## 2. Real object graph

- [ ] explicit object-reference encoding
- [ ] immediates/value objects
- [ ] class/object shape records
- [ ] reachability traversal
- [ ] indexes by class/project/name
- [ ] logical snapshots/revision frontiers
- [ ] garbage-collection rules that respect history

Success: an image can be browsed as a graph rather than a bag of JSON records.

## 3. Language-neutral execution kernel

- [ ] code object contract
- [ ] blocks/closures
- [ ] lexical environments
- [ ] message/call dispatch
- [ ] activations and debugger metadata
- [ ] exception/condition substrate
- [ ] host/WASM FFI boundary

Success: a tiny language can execute without adding language semantics to the image backend.

## 4. Symmetric Smalltalk seed

- [ ] grammar sketch
- [ ] parser
- [ ] tiny interpreter
- [ ] block representation
- [ ] objects/classes/metaclasses
- [ ] compiler to first executable IR
- [ ] REPL/workspace
- [ ] bootstrap image

Success: build a fresh image, edit code inside it, save it, restart and continue.

## 5. Projects and collaborative history

- [ ] project objects and relationships
- [ ] code + notes + tests + data + work items in one model
- [ ] branches/working views
- [ ] object-level diffs
- [ ] merge semantics
- [ ] Git import/export projection
- [ ] multi-author conflict UI/API

Success: day-to-day development does not require files as the canonical workspace, while Git remains a good interoperability surface.

## 6. Compatibility kernels

- [ ] Cuis source/package importer
- [ ] Smalltalk compatibility library layer
- [ ] prove several useful Cuis libraries
- [ ] Common Lisp personality spike
- [ ] identify which runtime pieces truly generalize

Success: compatibility work validates the substrate instead of accreting special cases into it.

## 7. Distributed execution

- [ ] object locator and activation policy
- [ ] capability-bearing remote references
- [ ] local vs remote send semantics
- [ ] WASM code placement
- [ ] use `ctx.call()` for measured compute-near-object wins
- [ ] failure/retry/idempotency model

Success: distribution is useful and observable without making ordinary local object code look like RPC plumbing.

## 8. Graphical environment

- [ ] drawing/input substrate
- [ ] retained UI objects
- [ ] widgets/layout
- [ ] surfaces/windows
- [ ] replaceable shell/window-manager policy
- [ ] inspectors, browsers and debugger as image-resident tools

Success: the graphical environment is built from the same inspectable object model rather than glued on as a separate application framework.
