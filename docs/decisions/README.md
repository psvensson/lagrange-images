# Decision index

ADRs are the detailed design history. Read them by topic rather than as a prerequisite sequence.

## Foundation and durable image model

- [0001 — backend boundary](0001-backend-boundary.md): keep image semantics above a small storage seam.
- [0002 — language-neutral graph representation](0002-language-neutral-graph-representation.md): tagged Values, refs, shapes and explicit graph edges.
- [0003 — code artifacts and closures](0003-code-artifacts-and-closures.md): immutable code, lexical environments and Blocks.
- [0004 — invocation and message dispatch](0004-invocation-and-message-dispatch.md): transient invocation protocol and language-owned lookup.
- [0005 — calling convention and neutral executor](0005-calling-convention-and-neutral-executor.md): receiver/arguments/environment activation frame.

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

## Foreign executable and runtime interfaces

- [0021 — foreign WASM callable interface](0021-foreign-wasm-callable-interface.md): separate raw WASM implementation identity from an explicit scalar callable ABI.
- [0023 — foreign runtime lifecycle substrate](0023-foreign-runtime-lifecycle-substrate.md): language-neutral start/call/stop lifecycle with transient runtime IDs and provider-private handles.
- [0024 — OpenSmalltalkVM + Cuis runtime proof](0024-opensmalltalkvm-cuis-runtime-proof.md): first real long-lived foreign runtime using a pinned headless Cuis image and whitelisted stdio service bridge.

## Reading rule

The current model is summarized in [../architecture.md](../architecture.md) and [../language-platform.md](../language-platform.md). ADRs explain why the model reached that shape and may describe limitations that later ADRs have since extended.
