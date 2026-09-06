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
defect is decided before the first native call.

That is deliberately NOT the promise that a failed import writes nothing. Once preflight passes,
a NATIVE owner may still reject a later declaration, and everything the owners already admitted
legitimately remains. The real acceptance-target import is exactly that case, and its residue is
worth stating exactly, because it is more than newly created material: the canonical manifest is
sorted by identity, so `cuis-method/JSON/Integer/instance/jsonWriteOn:` is reconciled — into the
PRE-EXISTING kernel Integer's method dictionary — before `cuis-method/JSON/Json/class/render:`
reaches the compiler and fails. A partial import can therefore leave an added selector on a base
class the package did not define, not only an unreferenced new class. Nothing is corrupt and an
ordinary corrected retry converges through the owners' own admission rules (the already-installed
method is exact-replay write-free), but a caller that needs all-or-nothing must not read the
adapter's preflight rule as providing it.

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

### Dialect idioms

`Json class>>render:` opens with `WriteStream on: String new`, and neither name resolved. Both are
global NAME references inside imported method source, resolved by the native compiler through the
image's global namespace — not method targets and not superclasses — so neither belonged to the
mapping seam above. They were answered differently, and the difference is the point.

`WriteStream` became an ordinary native class published as an ordinary global (bead
lagrange-images-nv1.4), because a stream is a facility any native code can want.

`String` did not. Native `Text` is a Value and a Cuis `String` is a mutable collection class, so
publishing one as the other would claim an equivalence nothing had established. What the adapter
owns instead is a CLOSED table of Cuis DIALECT IDIOMS translated inside method bodies — today
exactly one entry, the unary `String new`, translated to an empty native Text value. The claim is
not about the class but about the ROLE that expression plays, and it was measured against the
pinned Cuis image before it was written (bead lagrange-images-nv1.5): the seed is empty; writing
through the stream never mutates it, because being empty the first write grows the stream onto a
new collection and the original still reads `''`; the only message `on:` sends it answers with
itself, so no identity is established and nothing is copied; and swapping it for an empty
`UnicodeString` changes the result's species while leaving its textual value identical. The seed
contributes no content, no behavior and no observable identity — only the species of the result.

The table is matched on the TOKEN stream, so `'String new'` inside a literal and `"String new"`
inside a comment are untouched. It does not fire when the package means its own thing: a parameter,
temporary or block parameter named `String`, or a class named `String` the manifest itself
declares. Nor does it fire on a cascade — in `String new; yourself` the later messages go to the
class, so substituting a literal would change which object they reach. (The binding scan
deliberately over-detects: `|` is also a binary selector, so an odd expression can mark the name
bound and skip the adaptation. Erring that way leaves a visible unbound name, while missing a
binding would silently rewrite a legitimate variable.)

This table is keyed by a source token, which is an honest asymmetry with the class mapping above —
that one is keyed by complete semantic identity precisely so a class merely *spelled* `Integer`
elsewhere is not this image's Integer. A name inside a method body carries no package attribution,
so identity keying is not available here. What stands in for it is the narrowness of the claim (one
expression, not a class), the exclusions just listed, and the rule that every entry must be
justified by a recorded measurement that the object contributes nothing observable to the path. `String new: 16` is a different expression the measurement does not
cover and stays unbound, as does every other use of the name. No `String` global is published, no
Cuis String class identity is mapped, and native `Text` is unchanged.

With that, the acceptance target's whole scope — the package's own class-side `render:` and its own
`Integer>>jsonWriteOn:` extension — imports natively from the canonical export with Cuis gone, and
exact replay stays write-free. The first missing semantic is no longer a name the compiler cannot
bind but a method no native class implements: running `Json render: <native integer>` reaches
`printOn:base:`, which is native Integer printing protocol and belongs to that owner.

Both gaps that once sat on that path are now closed at their own owners, and how the second one
closed matters for reading the substitution above. `printOn:base:` was the first, and it is native
Integer printing protocol. Behind it was the seed's *species* role — the reason the substitution is
justified at all — and the repair was not what this paragraph once predicted: it is not that a Text
learned to answer `species`. Measurement showed upstream's own `contents` is a class-preserving
copy that never sends `species`, and that `Text new` is not instantiable, so the stream now builds
its result itself, preserving the backing's class. The substitution's claim — that the seed
contributes only the result's representation — survives intact; what changed is that the stream,
not the seed, is what realises it.

With that, `Json render: <native integer>` executes entirely natively with Cuis absent and matches
the recorded real-Cuis oracle.

### 4. Native application state

#### The M4 forcing application

M4's pressure source changes, and the change is the point. M3's pinned JSON package answers base
image collections, so an M4 restart proof over it would be a proof about base collections rather
than about an imported application's own objects. The M4 forcing application is therefore the pinned
upstream Cuis **YAXO** package (Cuis-Smalltalk-Dev `6bcee3f38ce037c9714b997ccd3b5b3ff62965c8`,
`Packages/Features/YAXO.pck.st` git blob `67d670ed38cc136d88afdf7e0df5bf8bc6519087`, and its own
upstream test package `Packages/Features/Tests-YAXO.pck.st` git blob
`8c50cbe6f29f3f4b25c883511eb905e44120ec5e`, MIT). That is the same distribution commit the JSON
harness already pins, so no new upstream trust anchor is introduced, and `scripts/integration-setup.sh`
fetches both by Git blob hash exactly as it does JSON. Its source is never edited and none of its
methods are copied into a fixture. It was selected and validated by bead `lagrange-images-moq`.

The property that earns it the milestone: `XMLDOMParser class>>parseDocumentFrom:` answers a graph of
instances of classes THE PACKAGE ITSELF DEFINES — `XMLDocument` -> `XMLElement` -> `XMLStringNode` —
constructed by the imported code, so what M4 eventually restarts is an application object graph.

`test/cuis-yaxo-native-import-real.test.js` drives the same one-directional path the M3 harness does,
and the live VM is again extraction plus reference oracle only. The provider's `yaxo/measure`
operation records what real Cuis answers for the smallest useful parsing path, and native execution
never calls it. That oracle is deliberately narrow — which public operation parses, what class the
root is, how a child is reached, how text and one attribute are read, and what the package's own
smallest mutation does. It is not a claim about XML correctness.

The M4 MINIMUM IMPORT SCOPE is the nine classes the measured path instantiates and dispatches to
(`SAXHandler`, `XMLDOMParser`, `XMLTokenizer`, `SAXDriver`, `XMLNode`, `XMLNodeWithElements`,
`XMLDocument`, `XMLElement`, `XMLStringNode`) plus the one public entry point. Those nine classes
already import natively with Cuis gone, keeping their upstream declared layouts and three levels of
real inheritance, and exact replay is write-free. The DTD, namespace, writer and exception classes
stay out, and with them the unmapped `Error`/`Warning` superclass identities.

The first unsupported native semantic on that vertical was a **`super` send**, and the consumer was
the entry point itself: `XMLDOMParser class>>parseDocumentFrom:` is `^(super parseDocumentFrom:
aStream) document`. ADR 0006 deferred `super` explicitly and nothing had implemented it since, so it
belonged to the Symmetric Smalltalk personality — not to the export and not to the import adapter.
The harness proved that at the right seam rather than at the messenger: it also hands an ORDINARY
native method body with no Cuis provenance to the native method compiler.

**ADR 0089 implemented it there**, and the import adapter is unchanged by it. `super` is a reserved
pseudo-variable and not a Value; `self` is unchanged and only lookup moves, starting above the running
method's DEFINING Behavior. Nothing about a super send is translated, rewritten or special-cased at
this boundary: the canonical manifest carries the source verbatim, the adapter translates the header
faithfully, and the native compiler now has a binding for the word. The entry point and the class-side
implementation its super send resolves to (`SAXHandler class>>parseDocumentFrom:`, in the same
manifest and the same scope) both import natively with Cuis gone, and exact replay stays write-free.

The next unsupported semantic after the assignment repair was that **a natively imported class's
NAME never became resolvable**:

    unbound Symmetric Smalltalk name: SAXDriver

from unedited upstream `SAXHandler class>>on:` (`driver _ SAXDriver on: aStream`). `SAXDriver` was
in the minimum scope and already imported as an ordinary native class; only its binding was missing.

Bead `lagrange-images-xxm.2` repairs that adapter-owned arrow without adding another name owner.
After every scoped declaration is constructed and before any scoped method compiles, the adapter
passes all scoped names to the existing `publishSmalltalkClassGlobals()` owner when the native image
has installed its global-namespace protocol. Cuis class names are image-global and the canonical
manifest declares no lexical package namespace, so the existing root namespace is the exact target;
inventing a child namespace would change source visibility and cannot represent a package dependency
DAG with one parent. A kernel-only image can still admit unnameable class structures, preserving the
M1 structural seam when no namespace protocol exists.

Publication therefore inherits ADR 0057 behavior instead of duplicating it: the canonical binding
identity is stable, exact replay writes nothing and preserves a legitimate rebind, while a different
existing binding is an explicit `SmalltalkGlobalConflictError`. A focused execution proof compiles a
package method naming a sibling, allocates that sibling through ordinary behavior and checks its
native class; another proof seeds a conflicting binding and observes its value unchanged. As with
other later native-owner refusals, this is recoverable ordered admission rather than an invented
all-or-nothing adapter transaction.

Re-running the unchanged M4 forcing scope now compiles through `SAXDriver` and exposes the next RED
afresh in unedited upstream `XMLTokenizer>>initialize`:

    unbound Symmetric Smalltalk name: UnicodeString

`UnicodeString` is a Cuis base-image dependency, not a YAXO declaration. Bead
`lagrange-images-xxm.9` owns an oracle-first classification; this slice does not assume it aliases a
native text or stream class and adds no global fallback.

The legacy assignment finding is now repaired at its two exact owners. The pinned Cuis scanner/parser
oracle established that `_` is the legacy arrow only at a token boundary and only when its following
character is not a letter, digit, underscore or colon. Thus `a _ b` assigns, while `a_b`, `_foo`,
`foo_`, `_7`, `__`, `_:` and `foo_:` are identifier/keyword forms, and strings/comments keep `_` as
data. A bare `_` has no legitimate selector meaning. The native tokenizer therefore emits a distinct
legacy-arrow token for exactly the measured form, and the native parser refuses it explicitly:
direct Symmetric Smalltalk still has only `:=`. The Cuis adapter translates that token to `:=` and
does nothing else — assignment target validity, right-hand-side resolution, bindings and execution
remain ordinary native semantics. Its arrow and `String new` replacements are collected against one
original token stream and applied right-to-left, so neither can invalidate the other's offsets.

That repair exposed why the earlier description was too weak. The defect was not merely a later `_`
message-not-understood: the unary-send parse turned `SAXDriver` into a selector and suppressed the
compile-time name-resolution refusal above. Re-running the exact same YAXO forcing scope now stops at
that masked occurrence rather than at the later `XMLDocument` occurrence. A second real proof imports
unchanged `SAXHandler>>document:` (`document _ aDocument`) plus its getter, executes the setter on a
native instance and reads back the assigned Value. M3's three arrow methods remain outside its
accepted execution scope, and M4's first slice imported `methods: []`; neither merged claim changes.
The lesson for future method-bearing slices is narrower: admission is not success when a foreign
dialect token can be absorbed into another valid native parse.

Two facts worth recording because they were predicted to block first and measurably do not — they sit
BEHIND all of the above on the executable vertical, and none of it is scheduled by this slice:

- the canonical v2 export carries **no class-variable facts**. YAXO's `XMLTokenizer` declares four
  class variables that its class-side `initialize` builds and its tokenizer cannot scan without, and
  the manifest's class declaration has no field for them. That is the EXPORT owner's gap, not YAXO's.
  The native side already has the concept: `src/language/smalltalk-class-variables.js` owns
  hierarchy-scoped class variables and the semantic compiler resolves them.
- the canonical v2 export carries **no package load-time expressions**. The package file ends with
  five top-level `... initialize!` chunks that run those initializers at load; the manifest
  represents packages, classes and methods only. Also the EXPORT owner's gap.

#### The durable root M4 will reacquire through — audited, not invented

M4's restart proof needs ONE durable application root reacquired through a locator a real application
could use, and the rule is to reuse the authoritative owner rather than build a YAXO-specific
registry. The audit's answer is that a suitable generic owner already exists, so no new one is
needed:

- **The Project working-state owner** (`src/project/working-state.js`) is the generic, language-neutral
  one. `project/<projectId>` is a deterministic id derived from caller-chosen text; a member is
  `{key, role, target}` where `target` is an arbitrary unpinned `ObjectRef`, and `readProjectDescriptor`
  rebuilds the whole descriptor from records alone. Its own "restart" test admits it only re-reads
  rather than restarting, so M4 would be the first proof that it survives a real one.
- **The ProjectInstallation deterministic head** (`src/project/installation-state.js`,
  `lagrange-project-installation/<projectId>/head`) is the same shape and IS restart-proven:
  `test/mixed-language-project-real.test.js` closes a runtime over a real backend and reacquires
  members from `(targetImageId, projectId)` alone, and `test/project-installation-state.test.js`
  asserts the read sequence is head -> snapshot -> members with no scan and no retained handle. It is
  release/installation-shaped and replaced wholesale rather than rebound, which is why the working-state
  owner is the better fit for a live mutable application root.
- **The Smalltalk global namespace** (`src/language/smalltalk-globals.js`, ADR 0057/0061) is the only
  true name -> arbitrary object facility: `publishGlobal` stores any Value and `resolveGlobal` finds it
  from `(imageId, namespaceId, name)`. It is generic in mechanism but Smalltalk-scoped by placement
  (it requires a kernel), it answers the binding rather than the value, and every existing test binds
  a kernel class rather than an application instance.
- `ImageService.setRoot` / `image.rootObjectId` is the only thing literally shaped like "the image's
  root object" and is not a candidate: single-valued, unnamed, and called by no production code.

Two recorded gaps that are ownership defects rather than M4 blockers: `docs/ownership.md` names no
owner for "durable named/application roots", and has no row for the global namespace at all.

#### The state rule

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
