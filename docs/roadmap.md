# Roadmap

This roadmap is deliberately limited to **image/Project semantics, language/execution and generic graph primitives**. Graphical presentation and human-facing collaboration UX live in [Lagrange Object Environment](https://github.com/psvensson/lagrange-object-environment); see [object-environment-boundary.md](object-environment-boundary.md) and ADR 0058.

The ordering is by architectural pressure, not language popularity. Completed implementation detail belongs in the ADRs and tests; this file preserves the remaining frontier.

## Primary convergence directive

ADR 0085 makes **progressive native import of an existing application** the main language-convergence path.

The platform has enough horizontal proof. Do not spend roadmap time accumulating additional foreign-runtime, package-depth or language-spike demonstrations unless they advance this vertical path or expose a concrete generic owner needed by it.

Cuis is the first forcing ecosystem:

```text
existing Cuis application
        |
        v
source/package graph + real Cuis semantics
        |
        v
canonical semantic import
        |
        v
native Classes / Shapes / methods / Blocks / roots
        |
        v
lagrange-code -> Lagrange WASM
        |
        v
Lagrange objects / storage / history / placement
```

OpenSmalltalkVM remains importer/toolchain, semantic oracle and explicit foreign-service escape hatch. It is **not** an automatic fallback executor for unsupported native import.

See [native-import.md](native-import.md) for the current model and ADR 0085 for the decision.

## Current foundation

The substrate already proves:

- stable language-neutral Value/ref/Shape/object identity and history;
- atomic current-state + history mutation through the backend transaction contract;
- public Lagrange durable backend and restart-compatible mapping;
- CodeArtifacts, LexicalEnvironments, Blocks and language-owned dispatch;
- a substantial Symmetric Smalltalk object/class/kernel/library model;
- neutral + hybrid resumable Lagrange-WASM execution;
- explicit artifact dependency/provenance graphs and toolchain providers;
- real Cargo/rustc closed-input builds in digest-pinned OCI;
- raw/callable/Component WASM lanes with structured interface values;
- transient execution authority and authorized object read/mutation/creation/observation lanes;
- real OpenSmalltalkVM/Cuis runtime, toolchain and multi-package dependency proofs;
- deterministic Cuis package/class/method semantic export and ordinary-object materialization;
- real SBCL through the unchanged generic foreign-runtime contracts (ADR 0084);
- mixed native/foreign-WASM/live-runtime composition;
- durable Project working state, portable releases and managed install/restart recovery;
- Node-independent portable runtime closure and public Object Environment bindings.

## 1. Symmetric Smalltalk substrate

Keep language work here when it is language semantics or execution substrate rather than editor/REPL UX. From ADR 0085 onward, broaden the language primarily under pressure from imported Cuis application code.

Next pressures:

- [ ] primitive-backed methods only where M1-M5 imported code requires them;
- [ ] broaden the standard image only from real imported library/application pressure;
- [ ] debugger-grade activation/resumption metadata without putting debugger UI here;
- [ ] preserve the current owner boundaries for classes, Shapes, method dictionaries, instance/class state, namespaces and object residency as native import begins using them.

Already established foundations include cascades, collection/species conventions, nested namespaces (ADR 0061) and transient-to-durable object residency/promotion (ADR 0060).

The REPL, source browser, inspector and debugger presentation belong in Lagrange Object Environment; this repository exposes the semantic/compiler/execution APIs they need.

## 2. Callable Component and authority refinements

The structured foreign/component boundary is functionally closed for current needs. Keep only refinements with concrete application pressure:

- [ ] per-call resource reads once async-capable host imports work;
- [ ] async foreign callbacks/effects only through explicit contracts, including delegated/attenuated authority semantics;
- [ ] reusable foreign Component instance/reset contracts only if measurements justify them;
- [ ] per-call authority transport for long-lived foreign runtimes when an explicit foreign service requires it.

The portable graphics capability boundary remains an Object Environment concern as recorded in ADR 0063 and the environment repository. Images stays renderer-agnostic.

Do not put principals, grants or cached authorization decisions into durable artifacts, refs or resource handles.

## 3. Image-native Lagrange WASM

The hybrid tail/resumable execution model is established. Optimize only under measured native-application pressure:

- [ ] tighter live-Value-handle analysis at suspension points;
- [ ] module-size/budget splitting of logical compilation groups;
- [ ] direct optimized calls between entries in one shared module;
- [ ] condition/exception unwinding across suspension points;
- [ ] debugger activation/resumption metadata;
- [ ] optimized/non-materialized closure representations;
- [ ] explicit cancellation semantics for suspended activations.

Do not conflate compiler-generated resumption with durable continuation state, retry or distributed recovery.

## 4. Cuis progressive native import

This is the primary language roadmap. Milestones are ordered and should be treated as irreversible movement toward native execution/storage rather than independent proofs.

### M1 — native class import

Starting from `smalltalk/cuis-semantic-export-v1` (ADR 0072):

- [ ] extend the canonical export with instance-variable definitions and only the additional class-side layout facts required by the target package;
- [ ] add the Cuis native-import adapter that routes class declarations through the existing native Smalltalk class/Shape/state owners;
- [ ] import an unchanged multi-class Cuis package as executable native classes/metaclasses;
- [ ] instantiate an imported class as an ordinary Lagrange object with durable native slots;
- [ ] prove no OpenSmalltalkVM participates after import in construction or slot access.

`CuisExportClass`/`CuisExportMethod` remain inspection/proof representations. They are not the executable native-import destination.

### M2 — native method compilation

- [ ] translate/compile imported Cuis method source through the existing Smalltalk semantic compiler;
- [ ] install imported methods as ordinary native methods/Blocks in ordinary native method dictionaries;
- [ ] execute an imported create -> mutate -> read behavior through native dispatch and Lagrange WASM;
- [ ] make unsupported semantics explicit import/compile failures; no silent live-Cuis fallback.

### M3 — Cuis compatibility-library closure

Use one increasingly realistic imported package/application as the pressure source:

- [ ] map Cuis base classes/protocols to existing native classes only when required behavior is explicitly equivalent and tested;
- [ ] add missing native library/kernel semantics only for real imported consumers;
- [ ] use real OpenSmalltalkVM/Cuis as a semantic oracle where differential proof is useful;
- [ ] keep FFI or other deliberately non-native facilities behind explicit interfaces rather than heap mirroring.

### M4 — native application state and restart

- [ ] establish imported application roots, globals/class state and domain objects as ordinary Lagrange image state;
- [ ] create a linked application domain graph through imported/native application code;
- [ ] restart Images and recover the same ObjectRefs, state and relationships;
- [ ] resume behavior without a Cuis snapshot/Spur heap as authoritative persistence;
- [ ] prove one authority for native state: the Lagrange image graph.

### M5 — one real independently authored Cuis application

- [ ] choose a nontrivial existing application/package set;
- [ ] keep its core application source unchanged for Lagrange;
- [ ] represent the complete source/package closure in a Project/release;
- [ ] install into a fresh Image;
- [ ] run useful existing application behavior/tests using native classes, methods and domain objects;
- [ ] require neither OpenSmalltalkVM nor a Cuis image in the ordinary execution path after import;
- [ ] expose any remaining foreign dependency as an explicit, inspectable boundary.

### M6 — distribution without language rewrites

- [ ] run the same M5 application with application objects placed across Lagrange nodes;
- [ ] keep placement/routing entirely out of the Cuis importer and application semantics;
- [ ] prove generic Lagrange owners decide object location and execution placement;
- [ ] measure useful compute-near-object/distributed behavior without rewriting the application as a hand-authored distributed program.

### Support work, not parallel goals

The existing OpenSmalltalkVM/Cuis runtime/toolchain remains supported. Additional work is justified only when it advances M1-M6, serves as an oracle, or supports an explicit foreign boundary:

- [ ] opt into Cuis snapshot toolchain result reuse only if ADR 0083's determinism revisit condition is actually met;
- [ ] broader Cuis ecosystem inputs/support files only when required by the target application;
- [ ] explicit Cuis service interfaces only for deliberately foreign application boundaries;
- [ ] runtime placement/reconciliation only when an explicit retained foreign service needs it.

Do not add arbitrary `perform:`, eval, oop export or transparent heap synchronization.

Inspecting, editing and navigating imported structures belongs to Lagrange Object Environment through public Images APIs.

## 5. Package and compiler ecosystems

### Generic import/toolchain work

Keep generic work only when it directly supports the native-import application closure or another shipping path:

- [ ] package/archive importer conventions with explicit immutable dependency artifacts;
- [ ] git/private-registry dependency import conventions;
- [ ] indexed durable lookup for derivation keys;
- [ ] cross-install content-addressed reuse with truthful installation provenance.

### Rust

Rust remains the mature existing-compiler -> WASM path:

- [ ] standard package importer built on explicit artifact/dependency semantics when a real Project needs it;
- [ ] Lagrange Rust SDK/crate for explicit host calls under concrete pressure;
- [ ] portable precompiled WASM/Component dependency reuse.

### Common Lisp

ADR 0084 completed the required neutrality proof: real SBCL executes through unchanged generic foreign-runtime/callable/release contracts.

Park substantive native Lisp work until the Cuis path has proved native objects and authoritative state through at least M4, preferably under M5 application pressure:

- [ ] ASDF/package import and source closure;
- [ ] reader/macroexpansion representation;
- [ ] CLOS/native object mapping;
- [ ] dynamic bindings and multiple values;
- [ ] conditions/restarts;
- [ ] native semantic compilation where the proven import architecture genuinely applies.

Do not pre-generalize the Cuis importer for Lisp. Extract shared owners only when Lisp demonstrates a genuinely shared concern.

### Java and additional runtimes

Java/JAR/JVM and other runtime spikes are parked as roadmap priorities. Resume them only for a concrete product need or when they falsify a generic owner required by the main native-import path.

A package/Project UI is not part of this layer; portable artifact and Project relationship semantics are.

## 6. Execution, authority and distribution

M6 depends on the generic distribution owners, not on language-specific routing:

- [ ] object locator and placement policy;
- [ ] local vs remote call semantics;
- [ ] Lagrange WASM placement;
- [ ] distributed routing for native Blocks and explicitly retained foreign/component boundaries;
- [ ] explicit failure/retry/idempotency semantics;
- [ ] durable deployment/reconciliation contract for intentionally foreign runtime definitions;
- [ ] measured `ctx.call()` / compute-near-object wins using the imported application as a realistic workload.

OCI/JVM foreign-runtime lifecycle/placement is not a prerequisite for Cuis M1-M5.

Authority remains transient execution context. Project structure must not imply transitive authority accidentally.

## 7. Durable graph and backend

The native-import path depends on the image graph becoming the authoritative application store:

- [ ] real Lagrange process-restart durability proof;
- [ ] multi-node failure/recovery durability tests;
- [ ] logical snapshot/revision frontiers beyond the first `GraphImageService.frontier()` seam;
- [ ] revision-aware reads;
- [ ] indexed graph reachability and derivation lookup;
- [ ] garbage-collection rules respecting history and pinned refs;
- [ ] object migration between immutable Shapes when real imported class evolution requires it;
- [ ] measure partitioning/index choices on large application images.

Already established: generic graph bundle export/import (ADR 0074), portable Project release materialization (ADR 0075) and durable managed Project installation/recovery (ADR 0076).

## 8. Projects and collaborative history semantics

Project remains image-level because it is useful without a graphical environment.

- [x] Project objects and relationships over ordinary image objects/refs;
- [x] first-class package/binary/component/runtime relationships;
- [x] manifest/lock/runtime-image artifacts as Project members;
- [x] mixed native/foreign implementation Projects and portable managed install/recovery;
- [ ] use Projects/releases as the complete closure for the M5 imported application;
- [ ] code + notes + tests + data + work items;
- [ ] nested/related Project and namespace conventions;
- [ ] branch/working-frontier semantics;
- [ ] object/Project diff representation;
- [ ] merge semantics and conflict data model;
- [ ] Git/file import/export as projection rather than canonical storage;
- [ ] multi-author conflict API/data, without prescribing UI.

Project membership remains organization, not authority.

Lagrange Object Environment owns Project browsers, import/progress interaction, working-view/history/diff presentation, merge/conflict-resolution interaction, Git projection UX and multi-author activity/presence.

## 9. Generic versioning pressure

Project collaboration and imported-application evolution may expose generic primitives that should be reusable outside either concern:

- [ ] graph/frontier diffs independent of one Project UI;
- [ ] branch/working-frontier primitives useful to headless clients;
- [ ] merge/conflict primitives that stay language/UI neutral;
- [ ] Shape/class evolution primitives only when a real imported application requires them.

Do not move semantic state into the UI merely because the first pressure came from a UI. Do not add a storage-level Project record kind merely because Project is image-level; ordinary objects/refs remain the default.

## Moved to Lagrange Object Environment

Human-facing concerns remain in the Lagrange Object Environment roadmap:

- drawing/input/rendering substrate and concrete GPU/surface providers;
- retained presentation/view composition;
- surfaces/windows/world/compositor policy;
- Perspectives and Session behavior;
- inspectors, browsers, editors, REPL and debugger UI;
- import commands/progress and provenance presentation;
- visual inspection/editing of native-imported classes/methods/objects;
- Project/history/diff/merge/conflict interaction;
- Git/file projection UX;
- invitations, multi-author activity and presence UX.

The Project data model, import semantics, native language/object semantics, Project history semantics, generic debugging/runtime metadata and headless projection services stay here.
