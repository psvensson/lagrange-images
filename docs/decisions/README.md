# Decision index

ADRs are the detailed design history. Read them by topic rather than as a prerequisite sequence.

## Read the status line first

An ADR records a decision. It is not automatically a description of the code, so every ADR
declares which it is on its third line:

```text
Status: proposed | accepted | implemented | superseded by NNNN
Proven by: <test paths>        (required when the status is "implemented")
```

- `accepted` means decided. It may not be built.
- `implemented` means built, and the `Proven by:` tests demonstrate it.

`test/steering-docs.test.js` enforces the vocabulary and checks that every cited test file
exists, so an ADR cannot claim to be built while pointing at nothing.

Most ADRs here say `accepted` because that is what their text supports on its own. If you
verify that an accepted ADR is in fact implemented, upgrading its status and adding a
`Proven by:` line is a welcome change — that is the direction this convention is meant to
move in. Never move it the other way to make a claim easier to write.

## Foundation and durable image model

- [0001 — backend boundary](0001-backend-boundary.md): keep image semantics above a small storage seam.
- [0002 — language-neutral graph representation](0002-language-neutral-graph-representation.md): tagged Values, refs, shapes and explicit graph edges.
- [0003 — code artifacts and closures](0003-code-artifacts-and-closures.md): immutable code, lexical environments and Blocks.
- [0004 — invocation and message dispatch](0004-invocation-and-message-dispatch.md): transient invocation protocol and language-owned lookup.
- [0005 — calling convention and neutral executor](0005-calling-convention-and-neutral-executor.md): receiver/arguments/environment activation frame.
- [0031 — one runtime composition path](0031-one-runtime-composition-path.md): keep one runtime, graph ImageService and HTTP projection instead of parallel object models.
- [0032 — atomic backend transactions](0032-atomic-backend-transactions.md): commit current state and its history event through one backend transaction and shared conformance contract.
- [0033 — durable Lagrange backend](0033-durable-lagrange-backend.md): map the backend contract to the public embedded SQL session and five image-owned tables.

## First language and semantic compilation

- [0006 — Symmetric Smalltalk seed](0006-symmetric-smalltalk-seed.md): first executable language personality.
- [0007 — semantic code and derived execution](0007-semantic-code-and-derived-execution.md): keep semantic meaning separate from executable artifacts.

## Lagrange WASM backend

- [0008 — WASM backend and Value-handle ABI](0008-wasm-backend-and-value-handle-abi.md): invocation-local Value handles and first backend.
- [0009 — WASM tail message effects](0009-wasm-tail-message-effects.md): asynchronous language sends as explicit tail effects.
- [0010 — WASM tail closure effects](0010-wasm-tail-closure-effects.md): nested Block creation as an explicit tail effect.
- [0011 — automatic WASM Block tree installation](0011-automatic-wasm-block-tree-installation.md): recursively install complete nested semantic trees.
- [0012 — language-neutral compilation groups and reuse](0012-language-neutral-compilation-groups-and-reuse.md): compiler-owned grouping and deterministic derivation reuse.
- [0013 — shared multi-function WASM modules](0013-shared-multifunction-wasm-modules.md): several semantic entries may share one physical module.
- [0030 — resumable non-tail WASM effects](0030-resumable-non-tail-wasm-effects.md): compiler-generated resume entries preserve one activation across non-tail message/closure host effects without making continuations durable objects.

## Runtime-only WASM reuse

- [0014 — runtime WASM module cache](0014-runtime-wasm-module-cache.md): cache compiled `WebAssembly.Module` objects per runtime.
- [0015 — runtime WASM instance pooling](0015-runtime-wasm-instance-pooling.md): explicit stateless instance-reuse contract and activation rebinding.

## Artifact graphs and existing ecosystems

- [0016 — artifacts, external toolchains and foreign runtimes](0016-artifacts-external-toolchains-and-foreign-runtimes.md): source is not the platform boundary; existing ecosystems should be reused.
- [0017 — artifact dependencies and toolchain providers](0017-artifact-dependencies-and-toolchain-providers.md): explicit dependency edges plus generic external-toolchain orchestration.
- [0018 — OCI Cargo/rustc provider](0018-oci-cargo-rustc-provider.md): first real existing compiler ecosystem through digest-pinned OCI.
- [0019 — explicit vendored Cargo dependencies](0019-explicit-vendored-cargo-dependencies.md): closed third-party package inputs without network discovery.
- [0020 — deterministic toolchain result reuse](0020-toolchain-result-reuse.md): provider-opt-in external build cache over the explicit artifact graph.
- [0022 — OpenSmalltalkVM compatibility direction](0022-opensmalltalkvm-compatibility-direction.md): native Symmetric Smalltalk plus real OpenSmalltalkVM compatibility/runtime/toolchain/migration paths.
- [0026 — OpenSmalltalkVM + Cuis toolchain provider](0026-opensmalltalkvm-cuis-toolchain-provider.md): compile explicit Cuis image/package graphs with the real Smalltalk environment into derived runnable image artifacts.

## Foreign executable and runtime interfaces

- [0021 — foreign WASM callable interface](0021-foreign-wasm-callable-interface.md): separate raw WASM implementation identity from an explicit scalar callable ABI.
- [0023 — foreign runtime lifecycle substrate](0023-foreign-runtime-lifecycle-substrate.md): language-neutral start/call/stop lifecycle with transient runtime IDs and provider-private handles.
- [0024 — OpenSmalltalkVM + Cuis runtime proof](0024-opensmalltalkvm-cuis-runtime-proof.md): first real long-lived foreign runtime using a pinned headless Cuis image and whitelisted stdio service bridge.
- [0025 — existing Cuis package proof](0025-existing-cuis-package-proof.md): load and exercise an unchanged upstream Cuis package with explicit package identity through the real runtime.
- [0027 — artifact-backed foreign runtime definitions](0027-artifact-backed-foreign-runtime-definitions.md): keep runtime definitions durable in the artifact graph while provider choice and running instances remain transient.
- [0028 — foreign runtime callable Blocks](0028-foreign-runtime-callable-blocks.md): place durable foreign-runtime services behind ordinary Block/ActivationExecutor invocation with runtime-local provider binding and lazy instance reuse.
- [0029 — mixed implementation Block composition](0029-mixed-implementation-block-composition.md): compose foreign WASM and live foreign-runtime Blocks from Symmetric Smalltalk without implementation-specific calls.
- [0034 — rich callable component interface](0034-rich-callable-component-interface.md): WIT-backed structured callable boundary with Component/WIT WASM lane and Cuis bridge v1, while canonical Value and wasm-scalar-call/v0 remain unchanged.
- [0035 — interface composite values](0035-interface-composite-values.md): WIT composites become transient ref-free InterfaceValues carried as one schema-directed `interface-composite/v0` bytes Value; `callable-interface/v2` adds a structural type grammar while v1 stays frozen, so no collection Value kind appears and personalities own projection.

- [0036 — foreign Component instance lifetime](0036-foreign-component-instance-lifetime.md): cache transpilation/compilation by artifact identity but instantiate a Component fresh per activation, so guest state and later host authority cannot cross activations.

- [0037 — transient execution authority](0037-transient-execution-authority.md): authority travels beside an activation as execution context rather than inside it, executors get a check-only `require` rather than a grant, guest authority is the intersection of declared imports and caller grants, and authority belongs to the individual call rather than to a long-lived runtime instance.

- [0038 — capability-aware Component host imports](0038-capability-aware-component-host-imports.md): `wasm-component-binding/v2` declares which host interfaces may be wired, while every concrete host operation is authorized at use time, so nothing is precomputed and revocation stays live.

- [0039 — authorized object projection](0039-authorized-object-projection.md): make the image a third implementation lane so a projected object crosses as an ordinary composite argument, authorized per object at use time, with the ref never crossing.

- [0040 — activation-scoped image resource handles](0040-activation-scoped-resource-handles.md): a WIT resource over an image object carries identity only, re-authorizes every method, lives for exactly one activation, and `own`/`drop` govern the handle rather than the object.

- [0041 — inter-activation state survival](0041-inter-activation-state-survival.md): state may outlive an activation only under an explicit host-owned contract, and authority never survives with it; a constraint on future Component reuse, persistent resources and async callbacks rather than a framework for them.

- [0042 — authorized object mutation](0042-authorized-object-mutation.md): `object/write` as a fourth implementation lane, authorizing the whole object, requiring a caller-supplied expected version, and surfacing conflicts explicitly rather than resolving them.

- [0043 — mutable lexical state and assignment](0043-mutable-lexical-state.md): assignment mutates an activation-scoped binding cell rather than the durable lexical-environment graph, and a closure captures the cell rather than a snapshot.
- [0044 — Object, Behavior, Class and Metaclass bootstrap](0044-object-behavior-class-metaclass.md): a Behavior with a fixed shape and a superclass chain, the metaclass knot as a real graph cycle, immediate Values taking their class from their kind, and `+` as an ordinary method over the existing `integer-add` op.
- [0045 — the Boolean bridge and message-send control flow](0045-boolean-bridge-and-control-flow.md): a boolean Value nominates the `true`/`false` singleton as the effective receiver of one send, so `ifTrue:`/`ifFalse:` are ordinary methods on True and False rather than a compiler or IR primitive.
- [0046 — allocation, initialization and class introspection](0046-allocation-initialization-and-class-introspection.md): keep `basicNew`, `new` and `class` as ordinary messages backed by language-owned primitive Blocks; an explicit instance Shape defines allocatability and layout, and image-native allocation remains intrinsic language semantics rather than an ADR 0037 capability check.
- [0047 — indexed object parts and Arrays](0047-indexed-object-parts-and-arrays.md): Shapes declare an optional indexed canonical-Value part, indexed refs are first-class graph edges everywhere, and `Array` is a fixed-size class over that part with growth left to ordinary Smalltalk above it.
- [0048 — Smalltalk equality, hashing and durable Dictionary](0048-smalltalk-equality-hashing-and-dictionary.md): define stable default `=`/`hash` semantics and a copy-on-write hashed Dictionary whose immutable table snapshots are suitable for a later O(1)-ish MethodDictionary fast path without recursive Smalltalk execution during dispatch.
- [0049 — the hashed MethodDictionary](0049-hashed-method-dictionary.md): selector lookup moves to a fixed-Shape hashed MethodDictionary that is kernel representation rather than a Smalltalk class, uses only the pure built-in Text hash and equality so dispatch can never re-enter itself, and arrives by explicit per-Behavior migration.
- [0050 — class-scoped instance-variable binding and self-only slot access](0050-instance-variable-binding-and-self-only-slots.md): an instance-variable name is bound to a stable Shape slot id by a class-scoped binder, the durable method carries the id rather than the name, and a language-owned primitive proves at execution that the slot belongs to the activation's effective Smalltalk `self`.
- [0051 — constant-stack Block iteration](0051-constant-stack-block-iteration.md): `whileTrue:` and `whileFalse:` are two more operations on the classless Block personality, dispatched to language-owned primitives that drive the condition and body through ordinary `value` sends, so iteration costs no activation depth.
- [0052 — closure instance lifetime and identity](0052-closure-instance-lifetime-and-identity.md): a closure instance is execution-local by default and acquires a durable Block and LexicalEnvironment only when it crosses a durability boundary, so evaluating a Block literal costs no graph write unless the closure escapes.
- [0053 — Integer ordering and arithmetic](0053-integer-ordering-and-arithmetic.md): `<`, `<=`, `>`, `>=` and the remaining arithmetic are ordinary Smalltalk methods backed by language-owned Integer primitives, so `lagrange-code/v0` stays frozen and the neutral IR never learns Smalltalk's numeric protocol.
- [0054 — conditions and handlers](0054-conditions-and-handlers.md): a condition is an ordinary object and signalling an ordinary send; a handler runs at the signal point before unwinding, so it may resume the signalling computation or unwind to its `on:do:`.
- [0055 — non-local return](0055-non-local-return.md): `^` is syntax compiled to an ordinary send to a language-owned primitive, unwinding to the home method activation identified by the ADR 0050 frame the Block was created in.
- [0056 — Boolean protocol and reserved literals](0056-boolean-protocol-and-reserved-literals.md): `true`/`false` are source spellings of the canonical boolean Values, `nil` lowers to an image-bound intrinsic binding so the artifact stays image-independent, and `not`/`and:`/`or:` are ordinary lazy methods on True and False.

## Reading rule

The current model is summarized in [../architecture.md](../architecture.md) and [../language-platform.md](../language-platform.md). ADRs explain why the model reached that shape and may describe limitations that later ADRs have since extended.
