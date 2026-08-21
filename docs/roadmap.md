# Roadmap

The roadmap is ordered by architectural pressure, not by language popularity. Completed implementation detail lives in the ADRs; this file should make the current frontier obvious.

## Current frontier

The substrate can now do these paths end to end:

```text
image-native Smalltalk
        -> lagrange-code/v0
        -> neutral executor OR hybrid Lagrange WASM
        -> ordinary activation

hybrid Lagrange WASM
        -> lagrange-value-handle/v0 for simple/tail effects
        -> lagrange-value-handle-resumable/v1 when a host effect is non-tail
        -> compiler-generated resume entries
        -> multiple sequential send/closure effects

external Rust/Cargo project
        -> explicit source/lock/vendor artifact graph
        -> Cargo/rustc provider
        -> wasm-binary/v1
        -> wasm-callable-interface/v1
        -> ordinary Block activation

long-lived foreign runtime
        -> durable runtime-definition artifact
        -> runtime-local provider binding
        -> lazy transient runtime
        -> ordinary callable Block

real compatible Smalltalk
        -> OpenSmalltalkVM/Cuis toolchain
        -> derived runnable image
        -> durable Cuis runtime definition
        -> ordinary callable Block

mixed program
        -> one Symmetric Smalltalk semantic artifact
        -> foreign WASM Block + live Cuis Block
        -> neutral and resumable Lagrange-WASM executions agree

implementation-independent callable interface
        -> callable-interface/v1 (no implementation, no dependencies)
        -> wasm-component-binding/v1   -> wasm-component/v1
        -> foreign-runtime-binding/v1  -> cuis-runtime-definition/v1
        -> both bound to ONE interface artifact, typed by it

two-lane structured interface proof
        -> real Rust Component (wit-bindgen + wasm-tools + jco canonical ABI)
        -> live Cuis image through lagrange-cuis-stdio/v1
        -> text, bytes, float64 and f32 agree bit for bit across both lanes
```

The real PR-only proof builds a Cuis image containing the unchanged upstream JSON package, starts that image without reinstalling JSON, and then runs the mixed Smalltalk orchestration through resumable Lagrange WASM against the same live Cuis runtime.

## Next

### 1. Richer foreign/component interfaces — closed

This arc is finished rather than paused. Structured values, per-activation instance lifetime,
transient authority, capability-aware host imports, authorized object projection and mutation,
and activation-scoped resource handles are all implemented and proven through real lanes
(ADRs 0034-0042). What remains below is deliberately deferred refinement, and none of it
currently justifies more substrate work.

The highest-leverage gap is now in the first language rather than in the foreign boundary:
Symmetric Smalltalk still cannot express an ordinary multi-statement program with local mutable
state. See the Symmetric Smalltalk section.


The scalar callable proofs have now done their job. The next interface work should expand useful data without turning the v0 scalar ABI into an ad-hoc memory protocol.

- [x] separate raw `wasm-binary/v1` from callable interface identity
- [x] `wasm-scalar-call/v0` over boolean/i32/i64/f32/f64
- [x] ordinary Block invocation of foreign scalar WASM
- [x] `foreign-runtime-callable-interface/v1` over durable runtime definitions
- [x] language-level Block sends invoke both foreign WASM and live foreign runtimes
- [x] one semantic program composes both implementation lanes
- [x] choose explicit string/bytes ABI vs moving directly to Component/WIT values
- [x] `callable-interface/v2` structural type grammar + normalization/fingerprint
- [x] `interface-composite/v0` codec and `list<string>` through both lanes
- [x] named records through both lanes, in both directions
- [x] `list<item>` — the first recursive composite proof
- [x] WASM Component/WIT-style callable artifact contract
- [x] map the same interface shape to at least two implementation lanes
- [x] bytes and float64 fidelity through both lanes
- [x] transient authority/principal/capability substrate (`require` seam, attenuation, exact-match v0 grants)
- [x] capability-aware imported host functions (`wasm-component-binding/v2`)
- [x] authorized object projection (`image-projection-binding/v1`)
- [x] WIT `resource` handles for continuing image access (prebound, activation-scoped)
- [x] inter-activation survival constraint (ADR 0041): survival is explicit, host-owned and carries no authority
- [x] authorized object mutation (`object/write`, object-scoped opaque version token)
- [x] version-aware projection, closing the optimistic read/modify/write loop
- [ ] per-call resource reads once async-capable host imports work; ADR 0040's preloaded record is a tooling limit, not the intended contract and not persistence
- [ ] async foreign callbacks/effects only through explicit contracts (a future ADR 0041 specialization; the delegated-authority question is open)
- [x] Component instance lifetime settled: fresh per activation, compilation cached separately
- [ ] reusable foreign instance/reset contracts (a future ADR 0041 specialization; little pressure, since fresh instantiation costs ~0.85 ms)

Success: a nontrivial external library exposes structured values through an implementation-independent interface usable from multiple language personalities.

### 2. OpenSmalltalkVM / Cuis compatibility depth

#### Runtime/toolchain

- [x] generic foreign-runtime lifecycle
- [x] real OpenSmalltalkVM/Cuis provider
- [x] pinned real-runtime CI
- [x] unchanged upstream JSON package load/execution
- [x] real Cuis `ToolchainService` provider
- [x] derived runnable image + changes artifacts
- [x] durable artifact-backed Cuis runtime definitions
- [x] runtime-local provider binding + lazy instance reuse
- [x] ordinary Cuis-backed callable Blocks
- [x] mixed image-native/compatible execution through ordinary Blocks
- [ ] explicit dependency graph/order for several Cuis packages
- [ ] prove a larger third-party package with real dependencies
- [ ] snapshot byte reproducibility/normalization investigation
- [ ] opt into toolchain result reuse only if determinism is demonstrated
- [ ] richer explicit Cuis service interfaces without ambient eval
- [ ] OCI foreign-runtime launcher/placement
- [ ] restart/reconciliation and snapshot persistence behavior

#### Structured export and migration

- [ ] export package/class/superclass/method/selector/source relationships as structured artifacts
- [ ] export useful CompiledMethod/bytecode/literal information where stable
- [ ] inspect/relate those structures from image-native tools without foreign oop identity
- [ ] first-class project that explicitly relates native and OpenSmalltalkVM-backed artifacts
- [ ] selective native lowering/recompilation where useful
- [ ] measure which code benefits from migration and leave the rest on the compatibility runtime

Success: a real compatible Smalltalk project can remain on OpenSmalltalkVM while participating in Lagrange image projects/history/interfaces and selectively migrate only beneficial pieces.

### 3. Real package import and compiler ecosystem integration

- [x] generic artifact dependencies separate from provenance
- [x] generic ToolchainProvider/ToolchainService contract
- [x] digest-pinned OCI runner
- [x] Cargo/rustc provider
- [x] explicit Cargo manifest/lock/source/vendor artifacts
- [x] deterministic provider-opt-in toolchain reuse
- [x] Cuis package/toolchain conventions
- [ ] real pinned-OCI Cargo integration proof in CI
- [ ] crates.io `.crate` importer -> explicit package/vendor artifacts
- [ ] git/private-registry dependency import conventions
- [ ] indexed durable lookup for derivation keys
- [ ] cross-install content-addressed reuse with truthful installation provenance

### 4. Durable Lagrange backend

The mock backend remains the default for local bootstrap work, but the real Lagrange adapter now owns a durable five-table schema and consumes the public embedded application-session API.

- [x] settle the public Lagrange embedding seam
- [x] map Values/refs/shapes/objects/artifacts/history to durable schema
- [x] atomic state + history writes through the backend transaction contract
- [x] reusable backend conformance suite running against the mock
- [x] run the reusable backend conformance suite against the Lagrange SQL adapter
- [x] prove schema and atomic state/history against the real public package
- [x] prove mapping restart behavior with a file-backed compatibility runtime
- [ ] real Lagrange process-restart durability test
- [ ] multi-node failure/recovery durability tests
- [ ] logical snapshot/revision frontiers
- [ ] indexes for graph reachability and derivation lookup
- [ ] measure partitioning/index choices on large images

Success: the same image and artifact graph survives process/node failure without semantic changes.

## Language work

### Symmetric Smalltalk

Implemented:

- parser/tokenizer with unary/binary/keyword precedence
- source -> syntax -> `lagrange-code/v0`, or `lagrange-code/v1` when the program needs mutable
  lexical state
- image-resident bootstrap dispatch
- nested lexical Blocks and stable binding IDs
- lexical `self` capture
- neutral + Lagrange-WASM execution
- automatic nested Block-tree WASM installation
- shared physical modules with separate Block/function identity
- captured foreign Blocks via ordinary `value:`/`value:value:` sends
- mixed foreign-WASM/live-Cuis orchestration
- resumable non-tail host effects in the Lagrange-WASM lane
- temporaries, statement sequences and assignment, with mutable lexical cells identical across the
  neutral executor, ordinary WASM, pooled WASM instances, suspension/resumption and nested closures
  (ADR 0043)
- Object/Behavior/Class/Metaclass with inheritance, the metaclass knot as durable graph data,
  immediate Values dispatching by kind under a transient dispatch image, `3 + 4` as an ordinary
  message send, and `nil`-initialized temporaries in bootstrapped images (ADR 0044)
- conditionals as ordinary message sends: a boolean Value nominates that image's `true`/`false`
  object as the effective receiver of one send, and `ifTrue:`, `ifFalse:`, `ifTrue:ifFalse:` and
  `ifFalse:ifTrue:` are methods on True and False, proven in both execution lanes including a
  non-tail block invocation (ADR 0045)
- a first image-resident library: `Association` and a minimal `OrderedCollection`, written in
  Smalltalk over the kernel facilities with no collection-specific primitive
- allocation and class introspection as ordinary message sends: `basicNew`, `new`, `initialize` and
  `class` are methods over two language-owned primitive Blocks, instance layout is explicit durable
  class data, and instances get fresh opaque identities with every slot starting at that image's
  `nil` (ADR 0046)

The four ADRs above are one arc: 0043 gave the language state, 0044 gave it objects, 0045 let objects
themselves supply control flow, and 0046 let a program make objects of its own. That is the point at
which "symmetric Smalltalk" stops being architectural scaffolding and starts being visible in
ordinary programs.

### What writing the first library exposed

`Association` and a minimal `OrderedCollection` are now ordinary Smalltalk classes, written over
allocation, instance variables, `Array`, equality, conditionals and Blocks, with no collection
primitive added. Writing them was a substrate test, and it found the following. None of these is a
collection concern; each is a general language capability that is missing.

```text
no ordering comparison    Integer has =, and nothing else. Loops must count *up* and stop on `=`,
                          and an indexed read cannot bounds-check, so `at:`, `first`, `last` and
                          `removeLast` are omitted rather than written incorrectly
no general subtraction    `integer-add` is the only arithmetic op, and `lagrange-code/v0` is frozen
no loop construct         CLOSED by ADR 0051. A Block now answers `whileTrue:`/`whileFalse:`, so
                          iteration costs no activation depth. Before it, `do:` succeeded over 50
                          elements and exceeded the depth limit by 100
no true/false/nil literal a Boolean false is spelled `1 = 2`
no and:/or:/not           deferred with the rest of the Boolean protocol; nested `ifTrue:ifFalse:`
                          stands in
no global namespace       a class cannot be named in source. `Array` is an explicitly captured ref,
                          which this work plumbed through the class-scoped compiler
no conditions             a collection cannot report a range error, which is why the operations that
                          would need one are absent rather than faked
no ^ return, no cascades  surface syntax, already known
```

The two with the most leverage are **ordering comparison** and a **loop construct**: between them they
are the difference between a collection that is correct-but-crippled and one that is ordinary. Both
are language decisions rather than library ones — ordering because `lagrange-code/v0` is a frozen
grammar with no comparison op, and looping because Blocks were not yet objects that could answer
`whileTrue:`. Looping is now closed by ADR 0051, which in turn exposed the closure-identity cost
listed below: removing the depth ceiling made a pre-existing per-evaluation allocation observable.

Next, ordered by architectural pressure rather than convenience:

- [x] global name resolution (**ADR 0057**): a compile-time lookup to a first-class
      `GlobalBinding`, dereferenced at runtime by an ordinary `value` send. The library's last
      scaffolding is gone — the `ArrayClass`, `IndexError` and `EmptyError` captures — and
      `OrderedCollection` says `Array` where it means `Array`. A binding needs only the kernel and
      the instance-variable protocol, not `Association`. What remains here is a namespace that is
      Smalltalk-visible, nested/project namespaces, and whether global assignment is admitted at
      all — deferred with its authority contract, since a compiled method must hold the binding to
      read it
- [x] closure identity (**ADR 0052**). A closure instance is execution-local and becomes durable only
      when it escapes, so 100,000 non-escaping closure evaluations produce **zero** durable records
      and wall-clock is linear in iteration count (1k/10k/100k at 0.97s/8.8s/87.6s).
      What it fixed, in the past tense it now belongs in: every evaluation of a Block that created a
      closure *used to* publish a new durable Block, so a loop grew the image without bound — about
      2.1 records per closure-creating iteration, strictly linear and never converging, against ~0
      for a closure-free body. ADR 0051 is what exposed it; recursion had hidden it, because the
      256-activation limit stopped any program before the growth mattered. That is also why this took
      the 0052 slot ahead of Integer ordering: unbounded durable image growth was a substrate and
      operational problem, where a missing `<` is missing functionality. The rejected alternatives
      were per-creation-site ids and durable collection; ADR 0052 records why
- [x] Integer ordering and arithmetic (**ADR 0053**). `<`/`<=`/`>`/`>=` and `-`/`*`/`//`/`\\` are
      ordinary methods over language-owned primitives, `lagrange-code/v0` is unchanged, and
      `OrderedCollection` gained `at:`, `first`, `last` and `removeLast` with real bounds checks.
      The count-up-and-compare-with-`=` idiom is retired
- [x] non-local return (**ADR 0055**). `^` becomes syntax compiled to an ordinary send, so
      `lagrange-code` stays frozen and the compiler still recognizes no selector. The target is the
      ADR 0050 frame the Block was created in — the identity already exists — with liveness in an
      executor-owned side table, and returning to an activation that has already returned is an
      explicit failure rather than a local return. `includes:` now answers from inside its loop and
      its `found` temporary is gone
- [ ] general object residency: should a newly allocated image object begin execution-local and
      become durable only on crossing a durability boundary, as ADR 0052 made closures? One object
      kind and one ObjectRef, with residency as a lifetime state. ADR 0054 raised it by declining
      it — a handled condition allocates a durable object per occurrence, and the tempting fix would
      generalise ADR 0052 from closures to arbitrary mutable graphs. Closures were tractable because
      their durable projection is deliberately narrow; a mutable object's is the whole reachable
      graph, so this must first answer aliasing, cycles, promotion atomicity, identity across
      promotion, and whether persisting one object persists everything it reaches. Potentially a
      large simplification of the image model, potentially too expensive
- [ ] basic collections, at which point a MethodDictionary can stop being represented by a Shape.
      Higher-order enumeration is no longer part of this frontier: `collect:`, `select:`,
      `detect:ifNone:` and `inject:into:` are ordinary image-resident Smalltalk built on `do:`, with
      no primitive, no compiler change and no ADR — they fell out of the language ADRs 0051 to 0055
      already decided. `detect:ifNone:` in particular is `^` from a predicate Block returning through
      `do:` and its loop, which is ADR 0055 doing ordinary library work. What remains here is the
      *shape* of the hierarchy — `Collection`, `species`, and how `collect:` chooses its answer's
      class — rather than whether the language can express enumeration
- [x] conditions and handlers (**ADR 0054**). The decision is that a handler runs at the
      signal point *before* unwinding, so it may `resume:` the signalling computation or `return:`
      through its `on:do:` — which is the only shape under which resumption works in the WASM lane,
      since a retired instance's frames are gone for good. Resumption rides the existing resumable
      ABI unchanged. `OrderedCollection >> at:` now signals a catchable `IndexOutOfRange` instead of
      the `errorIndexOutOfBounds:` placeholder, and `at:ifAbsent:` is written in ordinary Smalltalk
      by handling that signal rather than needing a second primitive
- [x] **ADR 0056**: `not`/`and:`/`or:` as ordinary lazy methods through ADR 0045's bridge,
      plus `true`/`false`/`nil` as reserved source literals. The bridge question it once posed is
      answered — a boolean-answering method answers the canonical *Value*, and the singleton is only
      ever a transient dispatch receiver. It retires the `1 = 2` spellings and the NilObject-only
      captures. `Association >> =` now reads `(key = other key) and: [ value = other value ]`
- [ ] primitive-backed methods beyond `+`. ADR 0044 decides how immediate Values dispatch and how
      a primitive-backed method is written; the remaining work is which primitives the kernel needs
- [x] ADR 0051's constant-stack `whileTrue:`/`whileFalse:`. `OrderedCollection`'s traversals are
      loops rather than recursion, so `do:` and `includes:` work past the old ~100-element ceiling
- [ ] a way to name a class from source; today a method captures one explicitly
- [ ] cascades, and `true`/`false`/`nil` as source literals — both surface syntax rather than
      semantic decisions, and both cheap once the decisions above are made
- [ ] REPL/workspace, once conditionals, allocation and a few collections make interactive
      Symmetric Smalltalk genuinely useful
- [ ] bootstrap image

The PR32 mixed expression is no longer a neutral-only proof: the same persistent semantic artifact now compiles to resumable WASM and produces the same result.

### Compatible Smalltalk via OpenSmalltalkVM

- [x] runtime/toolchain/package proofs
- [x] durable runtime-definition + callable Block path
- [x] mixed native/compatible execution proof
- [ ] multi-package dependency proof
- [ ] structured class/method/package export
- [ ] first-class mixed project representation
- [ ] selective native lowering where useful
- [ ] optional longer-term headless interpreter/Spur-to-WASM runtime proof

### Common Lisp

- [ ] personality spike using the common artifact/closure/toolchain substrate
- [ ] reader/macroexpansion representation
- [ ] dynamic bindings
- [ ] multiple values
- [ ] conditions/restarts
- [ ] reuse an existing Lisp compiler/runtime where useful

### Rust

Implemented: explicit Cargo graph, Cargo/rustc provider, closed vendored dependencies, toolchain cache, raw WASM import, scalar callable interface, implementation-independent callable contract with a real Component lane, and composition as an ordinary Block.

Next:

- [ ] real pinned-OCI Cargo CI proof
- [ ] standard package importer
- [ ] Lagrange Rust SDK/crate for explicit host calls
- [x] two-lane structured interface proof through Rust Component + Cuis
- [ ] portable precompiled WASM/component dependency reuse

### Java

- [ ] Java source/class/JAR artifact conventions
- [ ] JAR/class importer and dependency reuse
- [ ] javac/JVM/AOT/Java-to-WASM toolchain spike
- [ ] JVM/OCI foreign-runtime compatibility spike over the generic lifecycle
- [ ] compare JVM compatibility vs deeper WASM/image integration on one realistic application

## Execution/runtime work

### Image-native Lagrange WASM

Implemented:

- `lagrange-value-handle/v0`
- tail message-send / nested-Block effects
- hybrid compiler fallback to `lagrange-value-handle-resumable/v1`
- compiler-generated resume exports with explicit Value-handle continuation state
- multiple sequential non-tail effects
- non-tail nested Block creation
- shared multi-entry modules using the same hybrid rule
- deterministic compiler reuse
- module cache
- `stateless-v0` instance pooling/rebinding

Next:

- [ ] tighter live-handle analysis at suspension points
- [ ] module-size/budget splitting of logical groups
- [ ] direct optimized calls between entries in one shared module
- [ ] exception/condition unwinding across suspension points
- [ ] debugger activation/resumption metadata
- [ ] optimized/non-materialized closure representations
- [ ] explicit cancellation semantics for suspended activations

Do not conflate compiler-generated resumption with durable continuation state, retry or distributed recovery.

### Distributed and foreign-runtime execution

Implemented:

- generic provider/service start-call-stop lifecycle
- transient runtime IDs/private provider handles
- durable artifact-backed runtime definitions
- runtime-local definition/provider bindings
- lazy/coalesced reusable runtime instances
- ordinary callable Blocks over live runtimes
- real local-process OpenSmalltalkVM/Cuis provider
- local mixed routing between image-native Smalltalk, foreign WASM and live Cuis

Next:

- [ ] object locator and placement policy
- [x] capability handles separate from object refs — a WIT `resource` handle carries image
      identity only, never authority (ADR 0040); a `ref` still never crosses a foreign interface
- [x] capability/principal context on foreign calls — authority travels beside the activation and
      every host operation re-authorizes at use time (ADRs 0037, 0038)
- [ ] per-call authority for the long-lived foreign-runtime transport. ADR 0037 decision 12
      already fixes the semantics — authority belongs to the call, never to the shared runtime
      instance — so what remains is only the bridge wire mechanism, likely request-scoped
      host-call frames
- [ ] delegated authority for resumed activations, which async callbacks will force (ADR 0037
      leaves it open on purpose)
- [ ] local vs remote call semantics
- [ ] Lagrange WASM placement
- [ ] OCI foreign-runtime lifecycle/placement
- [ ] JVM foreign-runtime implementation
- [ ] distributed routing between image-native, component/foreign WASM and live runtimes
- [ ] explicit failure/retry/idempotency semantics
- [ ] durable deployment/reconciliation contract above runtime definitions
- [ ] measured `ctx.call()` compute-near-object wins

## Graph and project work

### Graph services

- [ ] indexed reachability traversal
- [ ] revision-aware reads
- [ ] export/import graph format
- [ ] garbage-collection rules respecting history/pinned refs
- [ ] object migration between immutable shapes

### Projects and collaborative history

- [ ] project objects and relationships
- [ ] code + notes + tests + data + work items
- [ ] first-class package/binary/component/runtime dependency relationships
- [ ] manifest/lock/runtime-image artifacts as project members
- [ ] projects mixing native and OpenSmalltalkVM-backed code through explicit interfaces
- [ ] branches/working views and object-level diffs
- [ ] merge semantics
- [ ] Git import/export as projection rather than canonical storage
- [ ] multi-author conflict UI/API

## Graphical environment

- [ ] drawing/input substrate
- [ ] retained UI objects, widgets and layout
- [ ] surfaces/windows
- [ ] replaceable shell/window-manager policy
- [ ] inspectors, browsers and debugger as image-resident tools
- [ ] inspect OpenSmalltalkVM-backed structures through explicit adapter identities

## Completed foundation

Established substrate now includes:

- language-neutral Value/ref/shape/object graph
- atomic graph state + history mutation contract with reusable backend conformance
- public-session Lagrange backend with image-owned schema and real-package proof
- Block + LexicalEnvironment closure model
- language-owned dispatch + common activation execution
- semantic vs executable code separation
- hybrid image-native Lagrange-WASM backend with resumable non-tail effects
- artifact dependency/provenance graph
- generic external toolchains + deterministic reuse
- Cargo/rustc integration with explicit package inputs
- foreign-WASM callable interface
- implementation-independent callable contract (`callable-interface/v1`) with per-lane implementation bindings
- two-lane structured interface proof (real Rust Component + live Cuis, one shared interface)
- text/bytes/float64/f32 fidelity proven across both lanes
- composite interface values (`list<T>`, named records, `list<record>`) as ephemeral InterfaceValues carried as schema-directed bytes, with no new canonical Value kind
- generic long-lived foreign-runtime lifecycle
- durable runtime definitions + callable Blocks
- real OpenSmalltalkVM/Cuis runtime/toolchain/package proofs
- mixed Symmetric Smalltalk composition over foreign WASM and live Cuis through both neutral and Lagrange-WASM execution

See [decisions/README.md](decisions/README.md) for ADRs grouped by topic.
