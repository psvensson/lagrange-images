# Progressive native import

This document describes the current convergence direction for importing existing language ecosystems into Lagrange Images. ADR 0085 records the decision; this file is the operational model.

## Goal

The goal is not merely to run an existing VM under Lagrange management. The goal is to import an existing application's source/package graph so that, as far as the language semantics permit, its executable structures and authoritative application state become native Lagrange image structures.

For the first forcing ecosystem:

```text
existing Cuis application
        |
        v
source/packages + real Cuis package semantics
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

A successfully native-imported application should not need OpenSmalltalkVM or a Spur heap for ordinary execution or authoritative domain persistence.

## Why Cuis is first

Cuis already supplies the strongest end-to-end pressure:

- a real OpenSmalltalkVM/Cuis toolchain and package loader;
- real multi-package dependency graphs;
- deterministic package/class/method semantic export;
- source text suitable for native Smalltalk compilation;
- a mature reference implementation that can act as an oracle.

Lagrange Images already supplies the target substrate:

- native Behavior/Class/Metaclass and Shapes;
- native allocation, instance slots, class variables and class-instance state;
- native collections and conditions;
- Blocks and lexical state;
- semantic `lagrange-code` plus Lagrange-WASM compilation/execution;
- durable ObjectRefs, graph state, history, Projects and portable releases.

The work is therefore convergence between existing owners, not another runtime architecture.

## Import stages

### 0. Canonical ecosystem input

Use the real Cuis toolchain to resolve packages and emit deterministic semantic facts. The current `smalltalk/cuis-semantic-export-v2` export adds ordered, locally declared instance-variable names to the frozen v1 package/class/method contract; superclass composition remains native-owner work.

The toolchain owns extraction only. It does not create native image classes or objects.

### 1. Native class construction

Translate imported class declarations into the existing native Smalltalk class and Shape owners.

Needed semantic facts are added under pressure, starting with instance-variable definitions and any class-side layout required by the target package.

```text
Cuis class declaration
      |
      v
Cuis import adapter
      |
      +-> existing class builder
      +-> existing Shape owner
      +-> existing namespace/class-state owners
```

Do not create an importer-local executable class representation.

M1 and M2 are now implemented by `importCuisNativePackage()`. It consumes the canonical v2 manifest
directly, preflights its schema/semantic identities/dependency topology, and delegates each ordered
local declaration to `ensureClassFromDeclaration()`. Native declaration legality remains in that
class owner: the adapter neither duplicates inherited-slot rules nor promises a new batch
transaction, and a corrected retry reuses any already-valid immutable ancestor. Its external
compatibility mapping is a closed table of exact semantic identities, each declared for the
POSITION it is proved in — see "Extension methods on classes the package does not define" below;
a class merely named `Object` or `Integer` is not equivalent. Import results are transient
semantic-identity/native-ref associations, not a durable side table.

The real proof obtains v2 from OpenSmalltalkVM/Cuis, closes that build runtime, then imports into a
separate runtime with no Cuis toolchain or foreign-runtime provider. Exact replay is write-free, and
the native allocation owner creates an ordinary ObjectRef whose inherited/local slots persist
ordinary Values/refs. `CuisExport*` materialization is not used.

### 2. Native method compilation

Compile imported Cuis method source through the existing Smalltalk semantic/compiler path.

```text
Cuis method source
      |
      v
Cuis syntax/compatibility adaptation where required
      |
      v
native Smalltalk semantic compilation
      |
      v
lagrange-code
      |
      v
Lagrange WASM
```

M2 translates each canonical full Cuis method definition into the selector plus Block-form source
accepted by the existing class-scoped compiler. The adapter validates method identity, target and
side, supports ordinary unary, binary and keyword headers, and makes Cuis's implicit receiver
return explicit because native Blocks otherwise answer their last expression. The native compiler
remains the sole owner of body syntax, slot binding and semantic lowering.
`reconcileMethodsFromSource()` and `reconcileMethods()` install or reconcile the result in the
target native Class or Metaclass with the WASM lane, so
an imported method is an ordinary native method/Block backed by `wasm-function/v2` and installed in
the ordinary method dictionary. The importer chooses no method or revision id and stores no method
table or previous source.

The real two-runtime proof now exports inherited and local accessors, closes Cuis, imports them, and
performs native `basicNew` -> imported mutation sends -> imported read sends. Exact replay is
write-free.

### 2.1 Native imported-method reconciliation

ADR 0086 proves the deliberately separate A -> A -> B -> B transition before M3. Native
Class/Metaclass plus selector is the logical method position. The initial method uses the existing
class-plus-selector Block identity; changed compiled native semantics receive an immutable
class-builder-derived revision identity for the semantic artifact, Block and derived executable
artifact. The old revision remains durable.

The ordinary MethodDictionary binding is the sole mutable current-method authority. Exact A or B
replay writes nothing. B publication persists its immutable material and then advances that
dictionary once with its expected record version. A lost CAS is classified by the class builder:
an identical semantic winner converges, while a different winner is a Smalltalk method conflict and
is never overwritten. Raw backend version conflicts do not escape.

The Cuis adapter merely calls the native operation with its resolved class, side, selector and
translated current source. It neither compares source strings nor owns history. Project
`versionToken`, membership, releases and managed installation do not participate.

The real proof records the transition in the repository's durable vocabulary:

| Stage | native Class ObjectRef | MethodDictionary `value` binding | semantic/executable identity | authoritative movement |
| --- | --- | --- | --- | --- |
| A import | same Class ref | initial class+selector Block ref | initial `:semantic` + `wasm-function/v2` artifacts | dictionary version +1 |
| A replay | same Class ref | same A Block ref | same A artifacts | none |
| B import | same Class ref | class-builder revision Block ref | new immutable B `:semantic` + `wasm-function/v2` artifacts | dictionary version +1 |
| B replay | same Class ref | same B Block ref | same B artifacts | none |

The unchanged `stable` selector keeps its original Block ref throughout. The Behavior and Class
records do not move.

### 3. Compatibility library closure

Existing applications depend on Cuis base semantics. Map or implement those semantics only when a real imported application requires them.

A shared name is never enough to claim equivalence. `Array`, `Dictionary`, `String`, `Symbol`, streams, exceptions and other base protocols map to existing native classes only when their required behavior is explicitly compatible and tested.

Missing semantics are explicit failures, not reasons to silently execute in Cuis.

#### The M3 forcing harness

M3 has one fixed consumer: the pinned upstream Cuis JSON package that
`scripts/integration-setup.sh` already downloads (Cuis-Smalltalk-Dev
`6bcee3f38ce037c9714b997ccd3b5b3ff62965c8`, `Packages/Features/JSON.pck.st`, git blob
`47fab65d0d9017d706aa07d39ab0451619488ccd`). Its source is never edited and none of its methods
are copied into a fixture.

`test/cuis-json-native-import-real.test.js` drives the whole path in one direction:

```text
pinned upstream JSON package
      |
      v
real Cuis toolchain -> canonical smalltalk/cuis-semantic-export-v2
      |
      v
importCuisNativePackage()  (no toolchain, no foreign-runtime provider)
      |
      v
native Smalltalk class/method owners
```

Nothing between the canonical export and the adapter edits the manifest, and `CuisExport*`
materialization is not part of the path. The live VM is used for extraction and as a reference
oracle only; the provider's `json/render` operation records what real Cuis answers, and native
execution never calls it.

The M3 acceptance target is one behavior of the package's own public protocol —
`Json render: <native integer>` answers the decimal text — not "all of JSON imports". The loop is:
run the complete import, classify the first causally necessary unsupported semantic, repair it at
its own owner in its own change, rerun the same JSON pressure. Compatibility work that the
acceptance target does not demand is not started, and an unsupported semantic is always an explicit
refusal rather than a silent skip or a live-VM fallback.

Because a real package is imported progressively, `importCuisNativePackage()` takes a
caller-declared import scope over the **unmodified** canonical manifest: the caller names the
semantic identities one import covers. Manifest-wide schema, canonical identity and uniqueness are
still checked for every declaration; native target legality and source translation apply to the
covered subset, because a real package's source reaches semantics this image does not support yet
and an import that does not cover them must not be blocked by them. An omitted required superclass,
an out-of-scope method target and an unsupported semantic inside the scope are all explicit
refusals — nothing is widened silently, and nothing covered is skipped as though it had succeeded.
Omitting the scope imports the whole manifest, which is what M1/M2 proved.

With that, the pinned package's own `Json` class imports natively from the canonical export with
Cuis gone, keeping its declared `stream`/`ctorMap` layout, while `JsonObject` and `JsonSyntaxError`
stay absent; exact replay of the scoped import is write-free. An ADAPTER refusal leaves the native
image's frontier unchanged, which is the preflight-before-first-write rule: every adapter-owned
defect is decided before the first native call. That is not the same promise as "a failed import
writes nothing" — once preflight passes, a NATIVE owner may still reject a later declaration, and
the valid immutable ancestors admitted before it legitimately remain (an ordinary retry converges
through their own admission rules). The real acceptance-target import is exactly that case today.

### Extension methods on classes the package does not define

Most of a real Cuis package's behavior lives in extension methods on classes it does not define, so
the adapter owns one seam that corresponds a **complete** Cuis semantic class identity to an
already-proven native class. It is a closed table, keyed by full identity and never by class name,
and every entry also declares the POSITIONS it is proved in, because "this identity denotes that
native class" is two independently justified claims rather than one:

| Cuis semantic identity | Native class | Proved position |
| --- | --- | --- |
| `cuis-class/Cuis-Base/Object` | kernel `Object` | superclass only (the ADR 0085 M1 structural root) |
| `cuis-class/Cuis-Base/Integer` | kernel `Integer` | instance-side method target only |

Every other identity — including `cuis-class/Cuis-Base/Dictionary`, whose name this image really
does have, and `cuis-class/Other/Integer` — stays refused. There is no name fallback and no
caller-supplied alias. The positions are enforced in both directions: a method declared on
`cuis-class/Cuis-Base/Object` is refused, because installing a package's selector on the root of
the whole native image is a far larger claim than M1 made and no consumer has demanded it; and a
class declaring `cuis-class/Cuis-Base/Integer` as its superclass is refused, because native
integers are Values whose dispatch class is fixed by their kind, so such a class would be inert.
A manifest may not itself DECLARE a mapped identity either — one identity, one authority.

The Integer entry claims only what is proved: that identity denotes the class an ordinary native
integer's Behavior resolves to, so the package's `Integer>>jsonWriteOn:` extension is reached by
real native integer receivers. It is *not* a claim that native Integer implements every Cuis
Integer protocol. Importing that method installs it through the existing kernel Integer's existing
MethodDictionary owner — no second Integer, no proxy subclass, no importer-owned extension store,
no behavior attached to a package object — and the Class record does not move. Sending
`jsonWriteOn:` to an ordinary native integer then dispatches into the real upstream method and
fails on that method's own `printOn:base:` requirement, which is a separate native-library gap the
harness will classify in its turn rather than something the mapping papers over.

The harness's current recorded first blocker for the acceptance target is `Json class>>render:`,
which opens with `WriteStream on: String new`. That one is not an adapter refusal: `WriteStream`
and `String` are global name references inside imported method source, resolved by the native
compiler through this image's global namespace, so the gap belongs to the native library and
namespace owners rather than to the Cuis mapping seam.

### 4. Native application state

Application roots, globals/class state and domain objects must become ordinary image state when they are part of the native application domain.

```text
identity       ObjectRef
layout         Shape
state          Values + refs
persistence    image/backend
history        image history
execution      Blocks/Lagrange WASM
placement      Lagrange policy
```

There is no transparent mirrored authoritative state between the Lagrange graph and a Spur heap.

### 5. Real application import

The first application-level proof uses an independently authored, nontrivial Cuis application/package set.

The application source should remain unchanged for Lagrange. Import metadata, package mappings or explicit foreign-interface declarations may be added outside the application's core source.

Success means a fresh Image can install the Project/release and execute useful application behavior with native classes, native methods and native domain objects without a Cuis runtime in the ordinary execution path.

### 6. Distribution

Only after the same application is native should distribution become an application acceptance condition.

Placement and routing remain generic Lagrange concerns. The Cuis importer and application source do not learn node addresses, partition placement or remote-call branches.

## Role of OpenSmalltalkVM after this decision

OpenSmalltalkVM remains valuable, but its role is bounded:

```text
importer/toolchain    resolve real Cuis ecosystem semantics
reference oracle     compare native behavior with real Cuis
foreign escape hatch explicit services/FFI that deliberately remain foreign
```

It is not an automatic fallback executor.

A native import failure must identify unsupported semantics or the responsible owner. This keeps convergence measurable and prevents split object/storage authority.

## Role of Common Lisp/SBCL

ADR 0084 proved that SBCL can use the generic foreign-runtime contracts without contaminating generic layers. That is sufficient for now.

Further Lisp-native work is intentionally sequenced behind the Cuis forcing path. Once native class/object/state import has been proven, Common Lisp can pressure the same architecture with genuinely different semantics such as reader/macroexpansion, CLOS, dynamic bindings, multiple values and conditions/restarts.

Do not pre-generalize the Cuis importer for Lisp. Extract common owners only when the second ecosystem demonstrates that the concern is truly shared.

## Object Environment boundary

Lagrange Object Environment owns human interaction over imported content: import commands/progress, browsers, source editing, inspectors, diagnostics and provenance presentation.

Once imported natively, a Cuis-origin class or object is navigated and edited through the same public Images APIs as any other native class or object. The environment may show that it originated from Cuis, but it must not create a shadow Cuis object database or runtime-specific identity model.

## Non-goals

This path does not require:

- arbitrary Spur heap import;
- preserving Spur oops;
- byte-for-byte Cuis image compatibility;
- reimplementing the entire Cuis VM;
- silently falling back to a live Cuis VM;
- making every FFI/native dependency image-native;
- generalizing for Java/Lisp before Cuis proves the owner boundaries.

The rule is simple: move existing software onto native Lagrange semantics in explicit, testable increments, and keep any remaining foreign boundary explicit.
