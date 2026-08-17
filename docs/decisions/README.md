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

## Reading rule

The current model is summarized in [../architecture.md](../architecture.md) and [../language-platform.md](../language-platform.md). ADRs explain why the model reached that shape and may describe limitations that later ADRs have since extended.
