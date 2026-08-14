# Agent notes

Keep this repository small and semantic.

## Repository workflow

Use one repository path for every change:

```text
main -> agent/<task> -> pull request -> GitHub Actions -> squash merge -> main
```

- Never make feature changes directly on `main`.
- Start each task from current `main` on a fresh `agent/<task>` branch.
- Keep one semantic task per branch and pull request.
- Read this file and the relevant design documents before editing.
- Connected agents use GitHub `create_file` and `update_file` for ordinary text changes on the feature branch.
- GitHub Actions on the exact PR head is the merge authority. Local checks are supplementary.
- CI runs for pull requests to `main`, not for each intermediate `agent/**` contents commit; do not add a second noisy push validation path.
- Before merge, compare the branch with `main`, verify the PR is mergeable, and verify the current head has a successful `test` workflow.
- Squash-merge using the expected PR head SHA so `main` receives one semantic commit.
- After merge, read back the important changed files from `main`.
- If the normal connector write cannot perform a required change, report the blocker instead of silently changing remote-write mechanisms.

`.github/workflows/test.yml` is the canonical repository validation path.

## Code

- JavaScript ES modules only; no TypeScript/build step without a concrete need.
- Prefer Node core modules before dependencies.
- Keep image semantics language-neutral.
- Keep language personalities independent of Lagrange storage details.
- Never import `lagrange-server/src/...`; use the public package only.
- A mock behavior is not a production guarantee. Mark weaker semantics in docs/tests.
- Add a test before broadening the backend contract.

## Graph representation

Protect these invariants:

```text
shape != behavior
reference != authority
identity != revision
source != artifact boundary
durable representation != execution representation
semantic code != executable artifact
toolchain != language semantics
build OCI != foreign-runtime OCI
WASM handle != image identity
compilation group != source-language construct
shared module != function/Block identity
compiled host module != durable module identity
pooled instance != activation state
```

- Object slots contain only tagged Values; do not reintroduce arbitrary nested JSON state.
- Graph edges are refs in slots, shape or behavior. Metadata must not hide refs.
- Keep `(imageId, objectId)` as stable identity independent of backend row/version/location.
- Use `pinned-ref` when a historical state is meant.
- Shape records are immutable; structural change gets a new shape identity.
- Preserve stable slot IDs across renames when semantics are continuous.
- Do not add `classId`, `source` or another language-specific shortcut to generic objects.
- A ref grants no access rights. Capability/authorization state stays separate.

## Artifacts, toolchains and code derivation

- Preserve language source -> syntax -> semantic code -> derived execution artifacts where source/semantic meaning is actually owned by the image.
- Do not turn that chain into a source-code-only platform rule. Source is one artifact representation; bytecode/packages, precompiled libraries, WASM components/modules, manifests/locks and other imported binary artifacts may be legitimate durable dependencies.
- Do not reconstruct or decompile a third-party binary dependency merely to make it look source-native. Preserve the artifact we actually possess plus its provenance/interface contract.
- Executable artifacts are rebuildable state when their semantic/source inputs exist, never the sole surviving meaning of such a program. Binary-only imported dependencies are not rebuildable merely because other code is.
- Language personality does not imply compiler ownership. Do not implement a new Rust/Java/etc. compiler just to integrate the language when an existing mature toolchain can be adapted cleanly.
- Add single-source lowering backends through `CodeCompilerRegistry` and grouped backends through `CompilationGroupCompilerRegistry`; future external toolchain/provider work must preserve the same explicit-input/provenance/cache principles rather than create an opaque second build path.
- A future toolchain/provider may run in-process, as WASM, in OCI, as a native process or remotely. Generic compilation semantics should describe artifact inputs/outputs, toolchain identity/options, diagnostics, interfaces and provenance rather than process location.
- OCI build/toolchain containers are reproducible compilation machinery. OCI foreign-runtime containers remain part of execution. Never conflate those lifecycles or imply that a foreign JVM/native/Python heap is automatically image object state.
- Compilation groups are transient compiler/planner values. The substrate may validate members/target/policy IDs but must not assume that a group is a Smalltalk Block tree, Java class, Rust crate or Lisp file.
- Physical module grouping belongs to compiler/toolchain policy. One logical group may produce one module, many modules or another executable representation.
- `CompilationService.compileGroup()` must keep every semantic/artifact member as an explicit `derivedFrom` edge on the grouped executable artifact.
- Reuse is allowed only when a compiler/toolchain explicitly declares a stable identity and deterministic cache key. Never infer cache equivalence from filenames, Block IDs, source-language names or target representation alone.
- External-toolchain derivation keys must cover every declared input that can change output, including toolchain/compiler version, OCI image digest where applicable, target/ABI/options, dependency fingerprints and manifest/lock artifacts.
- Changing ABI/compiler semantics or observable derived-artifact contracts requires changing compiler/toolchain identity or key material.
- A reused immutable executable may be shared by distinct installations, but function/Block/image identity must remain distinct unless language semantics explicitly say otherwise.
- Keep current-installation provenance explicit in wrapper/function artifacts even when a lower-level module artifact is reused from an earlier equivalent derivation.
- Imported executable libraries/components need explicit callable/interface descriptions before invocation. Interface metadata is not authority; capability checks stay separate.
- Treat dependency linkage as tooling policy: static/link, dynamic component, foreign runtime, service and build-only dependencies must not become different generic object identities merely because execution differs.
- Derivation-key lookup is currently a scan; backend indexing is an optimization, not a semantic change.

## WASM

- WASM belongs in `wasm-module/v1` / `wasm-function/v1` CodeArtifacts, not in Block/image identity fields.
- A shared `wasm-module/v1` may contain several exported entries, but each semantic member still gets its own `wasm-function/v1` and Block/prototype identity.
- Module function descriptors may refer to semantic members by `derivedFrom` index only; do not hide graph refs in module metadata.
- A shared module's global import table does not grant ambient use of every host-effect site. The executor must select one entry descriptor and enable only that function's declared send/closure sites.
- Cache compiled host `WebAssembly.Module` objects only as runtime-local execution state keyed by immutable module-artifact identity. Never persist them or treat them as image/code identity.
- Default executor registries must own separate WASM module caches and instance pools; do not reintroduce public singleton execution caches shared across runtimes.
- Concurrent requests for one module should share one in-flight compilation. Failed compilation must evict its cache entry so a later activation can retry.
- Reuse `WebAssembly.Instance` objects only behind an explicit module reset/reuse contract. Absence of a contract means one-shot execution; unknown declared contracts fail explicitly.
- `stateless-v0` is currently the only supported instance-reuse contract. It promises no activation-persistent guest memory, mutable globals/tables, guest handles or activation-dependent start behavior.
- Built-in compiler output that starts/stops declaring an instance-reuse contract must advance its compiler identity so durable derivation reuse cannot silently return older artifacts with different metadata/lifetime promises.
- Pooled instance imports must be rebindable. Every checkout receives a fresh `ValueHandleArena`, active entry/effect-site sets, closure prototype map and pending-effect slot; all of that state must be unbound before the instance becomes idle.
- Return an instance to the pool only after the synchronous WASM entry and result/tail-effect contract completed successfully. Traps, invalid handles/types, inactive effects or other guest-boundary failures retire the lease.
- Async language sends/closure materialization happen after the instance is unbound/released under the current tail-effect ABI; later host-operation failures do not imply guest-instance corruption.
- Keep pool retention conservative and runtime-local. Pooling is execution machinery, never durable image state or language identity.
- Keep `lagrange-value-handle/v0` handles invocation-local. Never persist them, use them as object IDs, or treat them as capabilities.
- The generic WASM ABI must preserve canonical Value semantics; optimized/unboxed ABIs need explicit new contracts rather than silently narrowing Values.
- Graph refs may cross the WASM boundary through receiver/argument/capture handles. Do not hide ref literals or ref message descriptors inside artifact metadata.
- WASM language sends use explicit tail effects: `send_site_N` records one pending request, WASM returns reserved handle `0`, then the executor resumes normal asynchronous dispatch outside WASM.
- WASM nested Block materialization likewise uses `make_block_site_N` as a tail effect. Closure-site metadata contains only semantic block/capture descriptors.
- Prototype Block refs for WASM closure sites must be explicit `wasm-function/v1.derivedFrom` edges; metadata may contain only indices/descriptors, never hidden refs.
- WASM-created closures must use the common `ActivationExecutor.createClosure` path and return ordinary Block refs. Do not create a WASM-specific closure identity or invocation path.
- Use `installWasmBlockTree()` for normal complete-tree WASM installation. It must preflight the semantic tree and multi-entry module before derived writes, compile/reuse one grouped module, then assemble per-entry function/prototype Blocks bottom-up.
- Automatically created nested semantic artifacts remain `lagrange-code/v0` derived from their immediate semantic parent; do not make WASM artifacts the only surviving copy of nested meaning.
- `compileWasmFunctionArtifact()` remains the low-level single-function/custom assembly seam; `assembleWasmFunctionArtifact()` is the low-level seam for binding a semantic member to an existing module entry.
- Do not compile non-tail asynchronous WASM sends or closure materialization by replaying, blocking or silently falling back. Add an explicit continuation/async ABI before broadening that contract.
- Host send effects must still use the normal language dispatcher/ActivationExecutor. Closure prototypes may use any registered execution representation.
- Unsupported WASM semantic operations must fail explicitly; do not silently fall back to another executor when WASM was requested.
- Keep interpreter/WASM differential or conformance tests for every semantic operation added to the WASM backend.

## Symmetric Smalltalk seed

- Keep parser/compiler/dispatch semantics in the language personality; do not teach the image backend what a selector, class or method is.
- Compile ordinary source sends through the shared language-tagged send path. Do not add compiler-only primitive semantics just to make examples easier.
- The current behavior-object selector-slot lookup is a bootstrap convention, not the final Class/Metaclass model.
- Nested Blocks use automatic lexical capture analysis; captured state is identified by stable binding ID rather than source name.
- `self` crossing a Block boundary is a lexical capture, not the Block object used as the `value*` message receiver.

## Architecture

```text
tools -> languages/runtime -> image graph -> backend -> Lagrange
```

Do not reverse the dependency direction. Projects, source, binary dependencies, notes and work items should tend toward objects/artifacts in the image model; files/Git are interoperability views. Distributed execution is later runtime policy, not an excuse to make every object send an RPC.

## Documentation

When a design is exploratory, say so. Keep current, next and possible-later distinct. Avoid describing planned capabilities as implemented.
