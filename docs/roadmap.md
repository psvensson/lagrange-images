# Roadmap

This roadmap is deliberately limited to **image/project semantics, language/execution and generic graph primitives**. Graphical presentation and human-facing collaboration UX moved to [Lagrange Object Environment](https://github.com/psvensson/lagrange-object-environment); see [object-environment-boundary.md](object-environment-boundary.md) and ADR 0058.

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
- [ ] nested namespace semantics, including how language namespaces relate to Projects
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
- [ ] relate exported structures into image-level mixed-language Projects
- [ ] selective native lowering/recompilation where useful
- [ ] measure which code benefits from migration and leave the rest on the compatibility runtime

Inspecting and navigating those structures belongs to Lagrange Object Environment.

## 3. Package/toolchain ecosystem

- [ ] real pinned-OCI Cargo integration proof in CI
- [ ] crates.io `.crate` importer -> explicit package/vendor artifacts
- [ ] git/private-registry dependency import conventions
- [ ] indexed durable lookup for derivation keys
- [ ] cross-install content-addressed reuse with truthful installation provenance
- [ ] Java source/class/JAR artifact conventions and JVM/AOT/WASM spike
- [ ] Common Lisp compiler/runtime personality spike over the common artifact/closure substrate

A package/Project UI is not part of this layer; portable artifact and Project relationship semantics are.

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

Authority remains transient execution context. Identity/contact pickers and invitation UX live above this repository. The semantics needed for a Project-wide grant remain a lower authority question because Project structure must not imply transitive authority accidentally.

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

## 6. Projects and collaborative history semantics

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

## 7. Generic versioning pressure

Project collaboration may expose generic primitives that should be reusable outside Projects too. Prefer such primitives when the semantics genuinely generalize:

- [ ] graph/frontier diffs independent of one Project UI
- [ ] branch/working-frontier primitives useful to headless clients
- [ ] merge/conflict primitives that stay language/UI neutral

Do not move semantic state into the UI merely because the first pressure came from a UI. Conversely, do not add a storage-level Project record kind merely because Project is image-level; ordinary objects/refs should carry it unless real pressure proves otherwise.

## Moved out of this roadmap

The former **Graphical environment** section now lives entirely in the Lagrange Object Environment roadmap.

Moved upward:

- drawing/input/rendering substrate
- retained presentation/view composition
- surfaces/windows/world policy
- Perspectives and Session behavior
- inspectors, browsers, editors and debugger UI
- visual inspection of exported OpenSmalltalkVM structures
- Project/history/diff/merge/conflict interaction
- Git/file projection UX
- invitations, multi-author activity and presence UX

The Project data model, Project history semantics and headless projection services stay here.
