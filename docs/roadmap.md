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

The first of those is delivered: `authorizedDescribeSmalltalkClass` / `authorizedDescribeSmalltalkMethod` (ADR 0087, [seams](seams.md#authorized-native-smalltalk-browsing)) let a class or method browser read ordinary native facts under independent Class `object/read` and exact logical-position `smalltalk-method/read` checks, with a Cuis-imported class browsing exactly as an ordinary native one. The method-position resource is nameable from `{imageId, Class/Metaclass, selector}` before the current immutable Block is known and remains stable across replacements; direct Block reads still require Block `object/read`. It is READ-ONLY on purpose: durable native method source, protocol/category and Cuis provenance are reported as absent because Images owns no such association yet, and edit/rename/recompile semantics wait for a consumer that actually needs them.

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

Starting from the frozen `smalltalk/cuis-semantic-export-v1` identity contract and its native-class declaration successor `smalltalk/cuis-semantic-export-v2` (ADRs 0072 and 0085):

- [x] extend the canonical export with ordered locally declared instance-variable names under v2, keeping v1 frozen; the M1 fixture requires no class-side layout facts;
- [x] add the Cuis native-import adapter that routes class declarations through the existing native Smalltalk class/Shape/state owners;
- [x] import an unchanged multi-class Cuis package as executable native classes/metaclasses;
- [x] instantiate an imported class as an ordinary Lagrange object with durable native slots;
- [x] prove no OpenSmalltalkVM participates after import in construction or slot access.

`CuisExportClass`/`CuisExportMethod` remain inspection/proof representations. They are not the executable native-import destination.

### M2 — native method compilation

- [x] translate/compile imported Cuis method source through the existing Smalltalk semantic compiler;
- [x] install imported methods as ordinary native methods/Blocks in ordinary native method dictionaries;
- [x] execute an imported create -> mutate -> read behavior through native dispatch and Lagrange WASM;
- [x] make unsupported semantics explicit import/compile failures; no silent live-Cuis fallback.

M2 deliberately stopped before method replacement. ADR 0086 completes the separate native
method-history proof between M2 and M3:

- [x] real Cuis A import -> exact A replay -> changed B import -> exact B replay;
- [x] Class/Metaclass + selector remains the logical position while B receives new immutable native
  semantic/Block/`wasm-function/v2` identities;
- [x] only the native MethodDictionary binding/version advances, exactly once for B;
- [x] identical concurrent B converges and divergent C wins visibly without overwrite or backend
  conflict leakage;
- [x] the importer owns no previous-source/revision table and Project tokens do not participate.

### M3 — Cuis compatibility-library closure

The pressure source is fixed: the pinned upstream Cuis JSON package that the integration setup
already downloads, imported through the existing canonical export and native import adapter. The
acceptance target is one behavior of its own public protocol — `Json render: <native integer>` —
executing entirely natively after Cuis is gone, not "all of JSON imports". Every compatibility
feature must be demanded by that consumer and repaired at its own owner
(`docs/native-import.md`, "The M3 forcing harness").

- [x] drive the pinned package through toolchain -> canonical export -> native import as a real
  forcing harness, record the real-Cuis oracle for the acceptance target, and classify the first
  unsupported semantic instead of pretending it succeeded;
- [x] import a caller-declared scope of the unmodified canonical manifest, so one useful behavior
  can be imported without first satisfying declarations it never uses; the package's own `Json`
  class now imports natively with Cuis gone;
- [x] correspond complete Cuis semantic class identities to already-proven native classes through
  one closed, name-independent mapping seam whose entries each declare the position they are proved
  in, so the package's own `Integer>>jsonWriteOn:` extension installs through the existing kernel
  Integer's existing MethodDictionary and real native integer receivers dispatch into it;
- [ ] map Cuis base classes/protocols to existing native classes only when required behavior is explicitly equivalent and tested;
- [x] add a native `WriteStream` (`class>>on:`, `contents`, plus the instance-side `on:` initializer
  those two need) at the ordinary Smalltalk class/library owner
  and publish it through the ordinary global namespace, because the pinned package's own
  `Json class>>render:` names it; its semantics are anchored to a recorded real-Cuis oracle rather
  than to Squeak/Pharo recollection, and the acceptance path now compiles past `WriteStream`;
- [x] translate the one proven Cuis dialect idiom the acceptance path needs (`String new` -> an
  empty native Text value) at the import boundary that already owns dialect translation, measured
  rather than assumed: the seed is never mutated, compared or kept, and only its species reaches
  the result. With it the acceptance target's whole scope IMPORTS natively for the first time.
  Executing it still needed `printOn:base:` and then a result for a written stream, each at the
  native library owner (the second turned out NOT to need a Text that answers `species` — see
  below);
- [x] add native `Integer >> printOn:base:` at the native Integer owner, because the pinned
  package's own `Integer>>jsonWriteOn:` sends it; base-10 output is proved against real Cuis for
  positive, zero, negative and 30-digit integers, and it composes existing arithmetic and the
  byte/text conversion rather than adding a primitive;
- [x] add the one native `WriteStream >> nextPutAll:` execution named, and let `contents` BUILD its
  answer from what was written, preserving the backing's class — upstream's own shape, since its
  `contents` is a class-preserving copy that never sends `species`, and `species new` could never
  have worked for a text backing because a native text Value is not allocatable;
- [x] **M3 acceptance behaviour green**: `Json render: <native integer>` from the pinned upstream
  Cuis JSON package executes entirely natively with Cuis absent and matches the recorded real-Cuis
  oracle for 3, 0, -3 and the 30-digit integer, asserted as result kind and value;
- [ ] add missing native library/kernel semantics only for real imported consumers;
- [ ] use real OpenSmalltalkVM/Cuis as a semantic oracle where differential proof is useful;
- [ ] keep FFI or other deliberately non-native facilities behind explicit interfaces rather than heap mirroring.

### M4 — native application state and restart

The pressure source changes here, deliberately: the pinned upstream Cuis **YAXO** package replaces
JSON, because JSON's parse result is a tree of base collections while YAXO's is a graph of instances
of classes the package itself defines — which is what an M4 restart proof has to be about
(`docs/native-import.md`, "The M4 forcing application").

- [x] pin YAXO and its own upstream test package by Git blob hash from the distribution commit the
  JSON harness already pins, record their identity and MIT license, and drive them through
  toolchain -> canonical export -> scoped native import as a real forcing harness;
- [x] measure the smallest useful public parsing path against real pinned Cuis rather than reading it
  off the source, and record that oracle: `XMLDOMParser class>>parseDocumentFrom:` answers an
  `XMLDocument`, children are `OrderedCollection`s of `XMLElement`s reached by name, text is an
  `XMLStringNode` child, and `attributeAt:put:` interns its key so the package's smallest mutation
  replaces the parsed attribute in place and leaves every identity alone;
- [x] import the declared M4 minimum class scope natively with Cuis gone — nine classes, upstream
  layouts, three levels of real inheritance, write-free exact replay;
- [x] classify the first unsupported native semantic on that vertical instead of pretending it
  succeeded: a `super` send, consumed by the entry point itself
  (`^(super parseDocumentFrom: aStream) document`), owned by the Symmetric Smalltalk personality and
  proven there rather than at the import boundary;
- [x] implement `super` at the native language owner (bead `lagrange-images-xxm.1`, ADR 0089): a
  reserved pseudo-variable rather than a Value, `self` unchanged, lookup starting above the running
  method's DEFINING Behavior taken from the ADR 0050 trusted dispatch frame, lowered to an ordinary
  send of a language-owned primitive that delegates to the existing lookup and invocation owners —
  so the unedited upstream entry point and the class-side implementation its super send names now
  import natively with Cuis gone, with no importer rewrite;
- [x] measure and repair Cuis's legacy assignment arrow before widening name resolution (bead
  `lagrange-images-xxm.3`): preserve the pinned oracle's legal underscore identifier forms, emit a
  distinct token refused by direct native syntax, translate only at the Cuis adapter, share one
  drift-free replacement plan with `String new`, and execute a real pinned YAXO setter/read-back;
- [x] make a natively imported class's NAME resolvable (bead `lagrange-images-xxm.2`): when the
  native global-namespace protocol is present, publish every scoped Cuis declaration into its root
  namespace through the existing global owner before method compilation; prove sibling lookup by
  execution, write-free replay, and explicit collision refusal rather than a silent rebind;
- [ ] classify and repair the next freshly measured YAXO RED (bead `lagrange-images-xxm.9`):
  `unbound Symmetric Smalltalk name: UnicodeString` from upstream
  `XMLTokenizer>>initialize`, with an oracle before choosing a native-library or adapter owner;
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
