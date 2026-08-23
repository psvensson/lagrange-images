# Roadmap

This roadmap is now deliberately limited to **image substrate, language/execution and generic graph primitives**. Project/workspace UX, collaboration UX and the graphical environment moved to [Lagrange Object Environment](https://github.com/psvensson/lagrange-object-environment); see [object-environment-boundary.md](object-environment-boundary.md) and ADR 0058.

The ordering is by architectural pressure, not language popularity.

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

The ADR index is the source of truth for why these pieces have their current shape.

## 1. Symmetric Smalltalk substrate

Keep language work here when it is language semantics or execution substrate rather than editor/REPL UX.

Next pressures:

- [ ] cascades and remaining surface syntax gaps
- [ ] finish the basic collection hierarchy and `species` conventions
- [ ] primitive-backed methods beyond the current kernel minimum where real library code demands them
- [ ] nested namespace semantics; Project-to-namespace policy belongs above this repository
- [ ] decide general object residency/promotion: execution-local mutable graphs vs immediately durable allocation
- [ ] broaden the standard image only from real library/tool pressure
- [ ] debugger-grade activation/resumption metadata without putting debugger UI here

The REPL, source browser, inspector and debugger presentation belong in Lagrange Object Environment; this repository must expose the semantic/compiler/execution APIs they need.

## 2. OpenSmalltalkVM / Cuis compatibility depth

Runtime/toolchain:

- [ ] explicit dependency graph/order for several Cuis packages
- [ ] prove a larger third-party package with real dependencies
- [ ] snapshot byte reproducibility/normalization investigation
- [ ] richer explicit Cuis service interfaces without ambient eval
- [ ] OCI foreign-runtime launcher/placement
- [ ] restart/reconciliation and snapshot persistence behavior

Structured export/migration:

- [ ] export package/class/superclass/method/selector/source relationships as structured image artifacts
- [ ] export useful CompiledMethod/bytecode/literal information where stable
- [ ] selective native lowering/recompilation where useful
- [ ] measure which code benefits from migration and leave the rest on the compatibility runtime

Relating those exported structures into a mixed-language **Project**, and inspecting them in browsers, belongs to Lagrange Object Environment.

## 3. Package/toolchain ecosystem

- [ ] real pinned-OCI Cargo integration proof in CI
- [ ] crates.io `.crate` importer -> explicit package/vendor artifacts
- [ ] git/private-registry dependency import conventions
- [ ] indexed durable lookup for derivation keys
- [ ] cross-install content-addressed reuse with truthful installation provenance
- [ ] Java source/class/JAR artifact conventions and JVM/AOT/WASM spike
- [ ] Common Lisp compiler/runtime personality spike over the common artifact/closure substrate

A package/project UI is not part of this layer; portable artifact and dependency semantics are.

## 4. Execution, authority and distribution

- [ ] per-call host-call transport for authority-aware long-lived foreign runtimes; ADR 0037 already fixes the semantics
- [ ] delegated/attenuated authority semantics for future async callbacks/effects
- [ ] reusable foreign Component instance/reset contracts only if measurements justify them
- [ ] object locator and placement policy
- [ ] local vs remote call semantics
- [ ] Lagrange WASM placement
- [ ] OCI/JVM foreign-runtime lifecycle and placement
- [ ] distributed routing across image-native, Component/WASM and live foreign runtimes
- [ ] explicit failure/retry/idempotency semantics
- [ ] durable deployment/reconciliation contract above runtime definitions
- [ ] measured compute-near-object wins

Authority remains transient execution context. Identity/contact pickers, invitations and "share this Project" UX live above this repository.

## 5. Durable graph and backend

- [ ] real Lagrange process-restart durability proof
- [ ] multi-node failure/recovery durability tests
- [ ] logical snapshot/revision frontiers
- [ ] revision-aware reads
- [ ] indexed graph reachability and derivation lookup
- [ ] export/import graph format
- [ ] garbage-collection rules respecting history and pinned refs
- [ ] object migration between immutable Shapes
- [ ] measure partitioning/index choices on large images

## 6. Generic versioning primitives — only under real pressure

The old roadmap mixed Project collaboration with generic image history. The split is now explicit.

Potential Lagrange Images work:

- [ ] object/graph diff representation independent of one UI
- [ ] branch/working-frontier semantics if useful to headless clients
- [ ] merge primitive/conflict data model if it can stay language/UI neutral

Lagrange Object Environment owns:

- Project objects/relationships and work-item organization
- working-view/history/diff presentation
- merge/conflict interaction
- Git import/export projection
- multi-author collaboration UX

Do not add a Project record kind merely to make the environment convenient. Add only generic primitives whose usefulness survives removing the environment entirely.

## Moved out of this roadmap

The former sections **Projects and collaborative history** and **Graphical environment** now live in the Lagrange Object Environment roadmap.

Moved upward:

- project objects/relationships, code + notes + tests + data + work items
- Project relationships to package/binary/component/runtime artifacts
- mixed native/OpenSmalltalk Project organization
- working views and multi-author conflict UX
- Git projection
- drawing/input/rendering substrate
- retained presentation/view composition
- surfaces/windows/world policy
- inspectors, browsers, editors and debugger UI
- inspection of exported OpenSmalltalkVM structures through environment adapters

That move is a responsibility change, not a claim that these objects cannot be durable. They may live in an image as ordinary objects while their meaning stays above the generic image substrate.
