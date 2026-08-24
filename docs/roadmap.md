# Roadmap

This roadmap is deliberately limited to **image/Project semantics, language/execution and generic graph primitives**. Graphical presentation and human-facing collaboration UX live in [Lagrange Object Environment](https://github.com/psvensson/lagrange-object-environment); see [object-environment-boundary.md](object-environment-boundary.md) and ADR 0058.

The ordering is by architectural pressure, not language popularity. Completed implementation detail belongs in the ADRs and tests; this file should preserve the remaining frontier without becoming a second history log.

## Current foundation

The substrate already proves:

- stable language-neutral Value/ref/Shape/object identity and history
- atomic current-state + history mutation through the backend transaction contract
- public Lagrange durable backend and restart-compatible mapping
- CodeArtifacts, LexicalEnvironments, Blocks and language-owned dispatch
- Symmetric Smalltalk with mutable lexical state, object/class model, control flow, allocation, indexed Arrays, hashed Dictionary/MethodDictionary, conditions/non-local return, globals and a canonical standard image
- neutral + hybrid resumable Lagrange-WASM execution
- explicit artifact dependency/provenance graphs and toolchain providers
- Cargo/rustc closed-input builds and deterministic toolchain reuse
- raw/callable/Component WASM lanes with structured interface values
- transient execution authority, capability-aware imports, authorized object projection/mutation and activation-scoped resource handles
- long-lived foreign-runtime lifecycle with real OpenSmalltalkVM/Cuis runtime/toolchain/package proofs
- mixed image-native/foreign-WASM/live-Cuis composition

## 1. Symmetric Smalltalk substrate

Keep language work here when it is language semantics or execution substrate rather than editor/REPL UX.

Next pressures:

- [x] cascades: `receiver m1; m2; m3` sends every message to the receiver of the first message and
      answers the first message's value. The parser keeps receiver and messages apart; the compiler
      lowers the cascade to hidden temporaries, a sequence and ordinary sends, so `lagrange-code`
      gains no op and no selector is recognized
- [x] finish the basic collection hierarchy and `species` conventions: `Collection` holds the shared
      enumeration written against `do:` and `species`, with `species` answering the receiver's class
      by default, so `collect:`/`select:` make their answer from `self species new`. A subclass
      redirects its derived collections by overriding `species`, not the enumeration methods. `OrderedCollection` is its first concrete subclass
- [ ] primitive-backed methods beyond the current kernel minimum where real library code demands them
- [x] decide nested namespace semantics (**ADR 0061**): a namespace is a mapping onto flat, shared
      bindings; nesting is parent-linked *visibility* (inner shadows outer, walked at compile time,
      acyclic to the root), never containment. A Project designates a namespace as organization —
      the parent chain is not the §8 Project graph and confers no authority. No path syntax, no
      private names, no runtime cost. Implementation is its own task with its own proof list
- [x] decide and implement general object residency/promotion (**ADR 0060**): an allocated object
      begins transient in the arena and promotes to a durable record only when a reference crosses a
      durability boundary. Decided and implemented — aliasing (one durable object, memoized), cycles
      (preassigned ids, staged before edges resolve, with write-through so a mutation during
      promotion is not lost), promotion atomicity (one central operation riding the ADR 0032
      transaction), stable identity (fresh at allocation, derived durable id), reachable-graph
      persistence (traverse transient refs only; durable refs are edges), and a slot/indexed write
      that promotes only when the receiver is durable. A handled condition and a built-and-discarded
      collection now write no durable record; proof lives in `test/object-residency.test.js`
- [ ] broaden the standard image only from real library/tool pressure
- [ ] debugger-grade activation/resumption metadata without putting debugger UI here

The REPL, source browser, inspector and debugger presentation belong in Lagrange Object Environment; this repository must expose the semantic/compiler/execution APIs they need.

## 2. Callable Component and authority refinements

The structured foreign/component boundary is functionally closed for current needs. Keep only refinements with concrete pressure:

- [ ] per-call resource reads once async-capable host imports work; ADR 0040's preloaded record is tooling limitation, not intended persistence semantics
- [ ] async foreign callbacks/effects only through explicit contracts, including delegated/attenuated authority semantics
- [ ] reusable foreign Component instance/reset contracts only if measurements justify them; fresh-per-activation remains the safe default
- [ ] per-call authority transport for long-lived foreign runtimes; ADR 0037 already fixes authority as call-scoped rather than runtime-scoped

Do not put principals, grants or cached authorization decisions into durable artifacts, refs or resource handles.

## 3. Image-native Lagrange WASM

The hybrid tail/resumable execution model is established. Remaining optimization and runtime pressure:

- [ ] tighter live-Value-handle analysis at suspension points
- [ ] module-size/budget splitting of logical compilation groups
- [ ] direct optimized calls between entries in one shared module
- [ ] condition/exception unwinding across suspension points
- [ ] debugger activation/resumption metadata
- [ ] optimized/non-materialized closure representations
- [ ] explicit cancellation semantics for suspended activations

Do not conflate compiler-generated resumption with durable continuation state, retry or distributed recovery.

## 4. OpenSmalltalkVM / Cuis compatibility depth

Runtime/toolchain:

- [ ] explicit dependency graph/order for several Cuis packages
- [ ] prove a larger third-party package with real dependencies
- [ ] snapshot byte reproducibility/normalization investigation
- [ ] opt into toolchain result reuse only if snapshot determinism is demonstrated
- [ ] richer explicit Cuis service interfaces without ambient eval
- [ ] OCI foreign-runtime launcher/placement
- [ ] restart/reconciliation and snapshot persistence behavior

Structured export/migration:

- [ ] export package/class/superclass/method/selector/source relationships as structured image artifacts
- [ ] export useful CompiledMethod/bytecode/literal information where stable
- [ ] relate exported structures into image-level mixed-language Projects
- [ ] selective native lowering/recompilation where useful
- [ ] measure which code benefits from migration and leave the rest on the compatibility runtime

Inspecting and navigating those structures belongs to Lagrange Object Environment.

## 5. Package and compiler ecosystems

### Generic import/toolchain work

- [ ] real pinned-OCI Cargo integration proof in CI
- [ ] crates.io `.crate` importer -> explicit package/vendor artifacts
- [ ] git/private-registry dependency import conventions
- [ ] indexed durable lookup for derivation keys
- [ ] cross-install content-addressed reuse with truthful installation provenance

### Rust

- [ ] standard package importer built on explicit artifact/dependency semantics
- [ ] Lagrange Rust SDK/crate for explicit host calls
- [ ] portable precompiled WASM/Component dependency reuse

### Java

- [ ] Java source/class/JAR artifact conventions
- [ ] JAR/class importer and dependency reuse
- [ ] javac/JVM/AOT/Java-to-WASM toolchain spike
- [ ] JVM/OCI foreign-runtime compatibility spike over the generic lifecycle
- [ ] compare JVM compatibility with deeper WASM/image integration on one realistic application

### Common Lisp

- [ ] personality spike using the common artifact/closure/toolchain substrate
- [ ] reader/macroexpansion representation
- [ ] dynamic bindings
- [ ] multiple values
- [ ] conditions/restarts
- [ ] reuse an existing Lisp compiler/runtime where useful rather than growing a replacement compiler by default

A package/Project UI is not part of this layer; portable artifact and Project relationship semantics are.

## 6. Execution, authority and distribution

- [ ] object locator and placement policy
- [ ] local vs remote call semantics
- [ ] Lagrange WASM placement
- [ ] OCI foreign-runtime lifecycle/placement
- [ ] JVM foreign-runtime implementation
- [ ] distributed routing across image-native, Component/foreign WASM and live runtimes
- [ ] explicit failure/retry/idempotency semantics
- [ ] durable deployment/reconciliation contract above runtime definitions
- [ ] measured `ctx.call()` / compute-near-object wins

Authority remains transient execution context. Identity/contact pickers and invitation UX live above this repository. The semantics needed for a Project-wide grant remain a lower authority question because Project structure must not imply transitive authority accidentally.

## 7. Durable graph and backend

- [ ] real Lagrange process-restart durability proof
- [ ] multi-node failure/recovery durability tests
- [ ] logical snapshot/revision frontiers
- [ ] revision-aware reads
- [ ] indexed graph reachability and derivation lookup
- [ ] export/import graph format
- [ ] garbage-collection rules respecting history and pinned refs
- [ ] object migration between immutable Shapes
- [ ] measure partitioning/index choices on large images

## 8. Projects and collaborative history semantics

Project remains an image-level concept because it is useful without a graphical environment.

- [ ] Project objects and relationships over ordinary image objects/refs
- [ ] code + notes + tests + data + work items
- [ ] first-class package/binary/component/runtime relationships
- [ ] manifest/lock/runtime-image artifacts as Project members
- [ ] Projects mixing image-native and OpenSmalltalkVM-backed code through explicit interfaces
- [ ] nested/related Project and namespace conventions
- [ ] branch/working-frontier semantics
- [ ] object/Project diff representation
- [ ] merge semantics and conflict data model
- [ ] Git/file import/export as projection rather than canonical storage
- [ ] multi-author conflict API/data, without prescribing UI

Lagrange Object Environment owns Project browsers, working-view/history/diff presentation, merge/conflict-resolution interaction, Git projection UX and multi-author activity/presence.

## 9. Generic versioning pressure

Project collaboration may expose generic primitives that should be reusable outside Projects too. Prefer such primitives when the semantics genuinely generalize:

- [ ] graph/frontier diffs independent of one Project UI
- [ ] branch/working-frontier primitives useful to headless clients
- [ ] merge/conflict primitives that stay language/UI neutral

Do not move semantic state into the UI merely because the first pressure came from a UI. Conversely, do not add a storage-level Project record kind merely because Project is image-level; ordinary objects/refs should carry it unless real pressure proves otherwise.

## Moved to Lagrange Object Environment

The former **Graphical environment** section now lives entirely in the Lagrange Object Environment roadmap. The human-facing half of Project/collaboration work moved with it.

Moved upward:

- drawing/input/rendering substrate
- retained presentation/view composition
- surfaces/windows/world/compositor policy
- Perspectives and Session behavior
- inspectors, browsers, editors, REPL and debugger UI
- visual inspection of exported OpenSmalltalkVM structures
- Project/history/diff/merge/conflict interaction
- Git/file projection UX
- invitations, multi-author activity and presence UX

The Project data model, Project history semantics, generic debugging/runtime metadata and headless projection services stay here.
