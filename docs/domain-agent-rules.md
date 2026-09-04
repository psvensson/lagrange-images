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
- Read [docs/runbook.md](docs/runbook.md) before running or debugging anything, and [docs/seams.md](docs/seams.md) before adding a representation, installer or executor.
- A green `npm test` is not a green suite: the real foreign-runtime and backend proofs skip silently without their environment. Run `npm run test:integration` when you touch `src/foreign-runtime/`, `src/wasm/` or `src/backend/`.
- Connected agents use GitHub `create_file` and `update_file` for ordinary text changes on the feature branch.
- GitHub Actions on the exact PR head is the merge authority. Local checks are supplementary.
- CI runs for pull requests to `main`, not for each intermediate `agent/**` contents commit; do not add a second noisy push validation path.
- Before merge, compare the branch with `main`, verify the PR is mergeable, and verify the current head has a successful `test` workflow.
- Squash-merge using the expected PR head SHA so `main` receives one semantic commit.
- After merge, read back the important changed files from `main`.
- If the normal connector write cannot perform a required change, report the blocker instead of silently changing remote-write mechanisms.
- Do not use broad span or regex replacements to delete code from guard-dense installer files. These files are mostly prerequisite checks that look alike, so a span chosen by its endpoints takes the checks between them with it and the suite stays green because those checks only fire on a half-installed image. Use exact-context patches, one edit per intended change, and read the resulting diff before committing.

`.github/workflows/test.yml` is the canonical repository validation path.

## Code

- JavaScript ES modules only; no TypeScript/build step without a concrete need.
- `src/runtime.js` re-exports its modules with `export *`. A duplicate export name breaks the whole package at import time with an error naming neither file, so grep before adding a shared constant and import an existing one rather than spelling it twice.
- Prefer Node core modules before dependencies.
- Keep image semantics language-neutral.
- Keep language personalities independent of Lagrange storage details.
- Never import `lagrange-server/src/...`; use the public package only.
- A mock behavior is not a production guarantee. Mark weaker semantics in docs/tests.
- Add a test before broadening the backend contract.

## Backend transactions

- Every backend implements `transaction(callback)`; the scoped transaction exposes only `get`, `put`, `scan`, `append`, `readStream` and `streamHead`. `streamHead` is the read-only direct head read of a stream's committed high-water revision (the backend owns stream persistence/head mechanics; it never scans/reconstructs the log).
- Commit a materialized image record and its corresponding history event in one backend transaction.
- Construct history events from the stored record inside the transaction when the assigned `_version` is part of the event.
- A transaction callback must use its scoped transaction object, not call the owning backend recursively.
- Transaction failure or optimistic version conflict commits no scoped operation.
- The mock proves API atomicity/rollback only. Do not describe it as crash-durable.
- Every durable backend must run the reusable backend conformance suite before adding backend-specific integration claims.

## Graph representation

Protect these invariants:

```text
shape != behavior
reference != authority
identity != revision
source != artifact boundary
dependency != provenance
durable representation != execution representation
semantic code != executable artifact
toolchain selection != toolchain identity
toolchain provider != language semantics
provider cache opt-in != inferred determinism
cache hit != replayed diagnostics
exact input provenance != cross-install content equivalence
build OCI != foreign-runtime OCI
raw foreign WASM != Lagrange WASM ABI
callable interface != authority
WASM handle != image identity
compilation group != source-language construct
shared module != function/Block identity
compiled host module != durable module identity
pooled instance != activation state
```

- Object slots contain only tagged Values; do not reintroduce arbitrary nested JSON state.
- Graph edges are refs in slots, shape, behavior, CodeArtifact dependencies/provenance and other explicit record fields. Metadata must not hide refs.
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

### Artifact dependency edges

- `CodeArtifact.dependencies` is the bootstrap generic artifact-dependency relation. Each entry is exactly `{role, artifact}`.
- Dependency `artifact` is an explicit unpinned ref to an existing CodeArtifact. Never hide artifact dependencies in metadata.
- Dependency roles are language/toolchain policy, not a platform enum. Do not teach the generic graph what `library`, `manifest`, `lock`, `runtime`, etc. mean.
- `dependencies` and `derivedFrom` are not interchangeable. Dependencies describe artifact relationships; `derivedFrom` describes immutable provenance.
- The graph walker must include dependency refs. Older stored CodeArtifacts without a `dependencies` field are treated as dependency-free.
- Do not add a second universal Artifact hierarchy until real Rust/Java/component integrations demonstrate that CodeArtifact is genuinely too narrow.

### Toolchain provider contract

- `ToolchainProviderRegistry` selection IDs are runtime/configuration policy. `provider.identity` is the stable implementation/version identity. Do not conflate them.
- `ToolchainService` must resolve only explicit CodeArtifact dependency edges from the supplied roots. Do not make `derivedFrom` history an implicit build input.
- Providers receive frozen root/transitive artifact snapshots plus target/options. The generic v0 provider context deliberately does not expose `ImageService` or another ambient artifact reader.
- Do not add ambient provider reads merely for convenience. External builds should declare the artifact graph they consume so provenance/cache keys can remain complete.
- `ToolchainService` owns output `derivedFrom` provenance; providers return output descriptions, not arbitrary provenance edges.
- Provider-declared output dependencies remain explicit dependency edges and must point at existing artifacts.
- Toolchain diagnostics are transient v0 results, not durable metadata by default.
- v0 supports several independent named outputs but not sibling output-to-output dependency refs or whole-invocation transactional persistence. Add those only if a real toolchain proves the need.

### Toolchain result reuse

- External-toolchain reuse is provider opt-in only. A provider is cacheable only when it implements `cacheKey(request, context)` in addition to a stable `identity`; never infer determinism from provider ID, output representation, filenames or past equal outputs.
- The OpenSmalltalk/Cuis provider has NO `cacheKey` by measurement (ADR 0083): snapshot bytes differ on every build from identical closed inputs. Do not add one from the semantic export or from any normalization that has not produced zero differing bytes over three independent builds with `scripts/measure-cuis-snapshot-reproducibility.mjs`.
- `lagrange-toolchain-derivation-key/v0` includes provider selection ID, stable identity, protocol, ordered roots, complete resolved artifact snapshots, target/options and provider-specific cache material.
- Artifact snapshots used by the cache include identity, representation, content, dependencies and metadata. Backend versions, timestamps and old `derivedFrom` history stay out of build equivalence.
- The first cache intentionally includes artifact/image identities. Reuse is exact to the same immutable input graph so the cached output's `derivedFrom` remains truthful. Do not remove identities for cross-install reuse without first adding an installation/provenance wrapper.
- Cacheable multi-output artifacts carry non-reference result-set metadata: derivation key, result ID, output name/index/count. Lookup may reuse only a complete set with unique names/indices and exact current provenance.
- Ignore incomplete cache result sets left by partial multi-output persistence; never fabricate missing outputs or treat a partial set as a hit.
- `ToolchainService.run({reuse:true})` is the default. `reuse:false` forces execution but still stamps a cacheable result so later compatible calls can reuse it.
- Requested `outputIds` are part of installation identity, not derivation equivalence. Reuse is allowed only when every explicitly requested ID matches the candidate result; different requested IDs cause a fresh provider run.
- Cache hits return existing immutable outputs with `reused: true` and the derivation key. Do not replay transient diagnostics; cache hits return an empty diagnostics array.
- Derivation-key lookup currently scans CodeArtifacts. Durable indexing is an optimization, not a semantic change.

### OCI Cargo/rustc provider

- Keep Rust/Cargo semantics inside `cargo-rustc-oci-provider.js`; do not teach generic `ToolchainService` about Cargo, source paths, Rust targets, vendor layouts or containers.
- OCI build images must be digest-pinned (`@sha256:...`). Tags alone are not reproducible provider identity.
- A Cargo invocation has exactly one `rust/cargo-manifest-v1` root, exactly one `rust/cargo-lock-v1`, and one or more `rust/source-v1` artifacts in the explicit dependency closure.
- A Cuis package's `metadata.identity` is provenance and stays in `metadata`: no consumer requires it to recover meaning (the foreign-runtime provider only echoes it into descriptive runtime output, with a ref-derived fallback; the toolchain ignores it). Do NOT promote it to a canonical field — the mol audit (lagrange-images-mol) confirmed it satisfies the ADR 0074/0079 provenance invariant as-is.
- A code artifact's materialization-relative path is the canonical `logicalPath` field (ADR 0079), NOT `metadata` — `metadata` is stripped, non-identity provenance (ADR 0074) and would not survive a portable release. `rust/source-v1`, Cargo vendor files and every Cuis image/changes/sources/package name their file through `logicalPath`; the CodeArtifact owner rejects absolute paths, backslashes, empty segments and `.`/`..` traversal, and consumers apply their own stricter rules (a Cuis name is a single-segment path with a required extension).
- Root-package source paths must not overlap `Cargo.toml`, `Cargo.lock`, `.cargo/...` or `vendor/...`; those paths belong to their explicit representations.
- Unknown dependency representations fail explicitly. Do not silently ignore imported crates/libraries the provider cannot materialize.
- Cargo builds stay closed-input: `cargo build --frozen` plus OCI network `none`. Do not enable registry/network fetches to make dependencies convenient.
- Vendored registry dependencies use explicit `rust/cargo-config-v1` plus `rust/cargo-vendor-file-v1` artifacts. Do not run `cargo vendor`, `cargo fetch` or another dependency acquisition step during compilation.
- The current Cargo config representation is intentionally exact: crates.io is replaced by the explicit `vendor/` directory source. Do not broaden it to arbitrary Cargo config that can redirect builds to hidden toolchain-image files without a separate contract.
- Vendor files must live under `vendor/<package-directory>/...`; package directories are immediate non-hidden children of `vendor/`.
- Every explicit vendor package requires `Cargo.toml` and `.cargo-checksum.json`. The checksum file must describe exactly all explicit package files other than itself, and every listed file SHA-256 must match before OCI execution.
- Vendor file content may be text or bytes. Do not force package assets into UTF-8 source form.
- New providers use stable identity `cargo-rustc-oci/v1/<image-digest>` because vendored dependency support changed the input contract. Preserve the older v0 constant only as historical identity.
- The public Cargo provider factory opts into generic toolchain result reuse. Its provider-specific cache material includes the full digest-pinned image reference because that full reference is also observable output metadata.
- A provider's cache contract names the computation a derivation stands for. Whenever what the provider executes for identical inputs changes (runner semantics, program selection, output extraction), bump the contract version (`cargo-rustc-oci-cache/v1` after ADR 0077, ADR 0078). Do not mix argv or other host-specific material into the derivation key instead.
- The pinned image must already contain Cargo/rustc and the requested target. Do not mutate/install the toolchain during a build unless a later explicit toolchain contract requires it.
- OCI runner argv is constructed without a shell. Keep the temporary workspace bind mount, explicit workdir/network and host uid/gid behavior where available.
- The executed program is always an explicit `--entrypoint`. An image's declared `ENTRYPOINT` is undeclared build input; never let it decide, wrap or prefix what a build runs.
- The Cargo/rustc boundary is proven by a real compiler, not only by an injected runner. Keep `test/cargo-rustc-oci-real.test.js` and its required CI lane green when changing provider materialization, argv or output extraction.
- Temporary workspaces are build machinery and must be removed in a `finally` path.
- Cargo-produced bytes are stored as `wasm-binary/v1`, never as a Lagrange module descriptor. `wasm-binary/v1` is the NEUTRAL raw-byte owner (ADR 0081): it holds exact bytes and nothing else, and is the implementation dependency of both `wasm-callable-interface/v1` and the compiled `wasm-module/v2`.
- Raw `wasm-binary/v1` may only enter ordinary activation through an explicit callable/component interface contract or a `wasm-module/v2` descriptor. Never relabel it merely because the header validates.
- Provider identity and output metadata must preserve the digest-pinned OCI toolchain identity.

### Foreign WASM callable interfaces

- `wasm-binary/v1` is implementation bytes. `wasm-callable-interface/v1` is callable identity/ABI. Keep them separate.
- A callable interface points to its raw implementation through exactly one explicit `dependencies` edge with role `implementation`; do not hide the implementation ref in interface metadata/content.
- `wasm-scalar-call/v0` is intentionally narrow: free synchronous function, no receiver, no lexical environment, no imports, one scalar result, and only `boolean/i32/i64/f32/f64` parameters/results.
- Scalar arguments must be canonical Values of the declared kind. Signed i32/i64 inputs are range checked; do not silently coerce unrelated Value kinds.
- Foreign scalar modules are compiled once per runtime but instantiated fresh per activation. Do not pool arbitrary foreign instances without a separate reset/reuse contract.
- The no-import rule is an authority boundary. Do not add WASI/host imports, callbacks or `ctx.call` to `wasm-scalar-call/v0`; define a new capability-aware ABI/interface contract.
- `installWasmScalarCallable()` creates the interface CodeArtifact plus an environment-free Block. Keep invocation on the ordinary InvocationService/ActivationExecutor path; do not create a second foreign-call runtime.
- Interface description is not capability. A ref to the interface or implementation does not grant permission to invoke it.
- Do not infer rich source-language semantics from raw WASM. Strings/memory, records, multiple values and Component/WIT interfaces belong in explicit later contracts.

### Compiler/toolchain derivation

- Add single-source lowering backends through `CodeCompilerRegistry` and grouped backends through `CompilationGroupCompilerRegistry`; external providers use `ToolchainProviderRegistry` / `ToolchainService`.
- A toolchain provider may run in-process, as WASM, in OCI, as a native process or remotely. Generic semantics describe artifact inputs/outputs, toolchain identity/options, diagnostics, interfaces and provenance rather than process location.
- OCI build/toolchain containers are reproducible compilation machinery. OCI foreign-runtime containers remain part of execution. Never conflate those lifecycles or imply that a foreign JVM/native/Python heap is automatically image object state.
- Compilation groups are transient compiler/planner values. The substrate may validate members/target/policy IDs but must not assume that a group is a Smalltalk Block tree, Java class, Rust crate or Lisp file.
- Physical module grouping belongs to compiler/toolchain policy. One logical group may produce one module, many modules or another executable representation.
- `CompilationService.compileGroup()` must keep every semantic/artifact member as an explicit `derivedFrom` edge on the grouped executable artifact.
- Reuse is allowed only when a compiler/toolchain explicitly declares a stable identity and deterministic cache key. Never infer cache equivalence from filenames, Block IDs, source-language names or target representation alone.
- Changing ABI/compiler/toolchain semantics or observable derived-artifact contracts requires changing compiler/toolchain identity or cache material.
- A reused immutable executable may be shared by distinct installations only when provenance/identity semantics remain explicit. Current toolchain v0 reuse deliberately stays within one exact input graph.
- Imported executable libraries/components need explicit callable/interface descriptions before invocation. Interface metadata is not authority; capability checks stay separate.
- Treat dependency linkage as tooling policy: static/link, dynamic component, foreign runtime, service and build-only dependencies must not become different generic object identities merely because execution differs.

## WASM

- WASM belongs in `wasm-module/v2` (+ its `wasm-binary/v1` implementation) / `wasm-function/v2` CodeArtifacts, not in Block/image identity fields.
- `wasm-module/v1` is FROZEN (ADR 0081): read it, never write it. The compiled module's executable contract `{abi, literals, functions[], sendSites, closureSites, effectSites}` is identity-bearing v2 CONTENT (canonical, key-order-independent JSON); the exact bytes are a separate `wasm-binary/v1` reached through exactly one `role: implementation` dependency, named nowhere else. Provenance metadata (`instanceReuse`, `continuations`, `semanticRepresentation`, group policy/layout) is never meaning-required; a contract field or a semantic mirror in v2 metadata is a defect, not a convenience.
- Every reader of a module's contract or bytes goes through `src/wasm/module-contract.js` (`readModuleContract`, `readModuleDescriptor`, `moduleFunctionOf`, `soleModuleEntry`). Executors, caches, pools, installers and builders never decode the representation themselves. Outside that module's frozen v1 decoder there are zero consumers recovering module semantics from metadata; keep it that way.
- Compilers return compilation FACTS `{languageId, bytes, contract, metadata}`. The module-contract owner describes the durable v2 graph once; the `CompilationService` result-graph path persists binary + descriptor + edge in ONE `createRecords` batch. Do not teach a compiler, installer or executor how to manufacture the pair, and do not add a WASM branch to the service.
- A shared `wasm-module/v2` may contain several exported entries, but each semantic member still gets its own `wasm-function/v2` and Block/prototype identity.
- `wasm-function/v1` is FROZEN (ADR 0082): read it, never write it. A v2 function's CONTENT is the canonical selection `{entry, closurePrototypes:[{blockId, siteIndex, derivedFromIndex}]}` and its module is exactly one `role: module` dependency; ABI, arity, captures and cellBindings are the MODULE's function-table entry and are never mirrored on the function. Every reader goes through `src/wasm/function-contract.js`; the dispatcher chooses an executor by the module's ABI.
- Module function descriptors may refer to semantic members by `derivedFrom` index only; do not hide graph refs in module metadata.
- A shared module's global import table does not grant ambient use of every host-effect site. The executor must select one entry descriptor and enable only that function's declared send/closure sites.
- Cache compiled host `WebAssembly.Module` objects only as runtime-local execution state keyed by immutable module-artifact identity. Never persist them or treat them as image/code identity.
- Default executor registries must own separate WASM module caches and instance pools; do not reintroduce public singleton execution caches shared across runtimes.
- Concurrent requests for one module should share one in-flight compilation. Failed compilation must evict its cache entry so a later activation can retry.
- Reuse `WebAssembly.Instance` objects only behind an explicit module reset/reuse contract. Absence of a contract means one-shot execution; unknown declared contracts fail explicitly.
- The same rule governs WASM Components (ADR 0036): transpilation and core-module compilation may be cached by immutable artifact identity, but a Component instance is created fresh per activation. Reusing one would let guest state, and later host authority, cross between activations.
- `stateless-v0` is currently the only supported internal instance-reuse contract. It promises no activation-persistent guest memory, mutable globals/tables, guest handles or activation-dependent start behavior.
- Built-in compiler output that starts/stops declaring an instance-reuse contract must advance its compiler identity so durable derivation reuse cannot silently return older artifacts with different metadata/lifetime promises.
- Pooled instance imports must be rebindable. Every checkout receives a fresh `ValueHandleArena`, active entry/effect-site sets, closure prototype map and pending-effect slot; all of that state must be unbound before the instance becomes idle.
- Return an instance to the pool only after the synchronous WASM entry and result/tail-effect contract completed successfully. Traps, invalid handles/types, inactive effects or other guest-boundary failures retire the lease.
- Async language sends/closure materialization happen after the instance is unbound/released under the current tail-effect ABI; later host-operation failures do not imply guest-instance corruption.
- Keep pool retention conservative and runtime-local. Pooling is execution machinery, never durable image state or language identity.
- Keep `lagrange-value-handle/v0` handles invocation-local. Never persist them, use them as object IDs, or treat them as capabilities.
- The generic WASM ABI must preserve canonical Value semantics; optimized/unboxed ABIs need explicit new contracts rather than silently narrowing Values.
- Graph refs may cross the internal WASM boundary through receiver/argument/capture handles. Do not hide ref literals or ref message descriptors inside artifact metadata.
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
- Keep interpreter/WASM differential or conformance tests for every semantic operation added to the internal WASM backend.

## Symmetric Smalltalk seed

- Keep parser/compiler/dispatch semantics in the language personality; do not teach the image backend what a selector, class or method is.
- Compile ordinary source sends through the shared language-tagged send path. Do not add compiler-only primitive semantics just to make examples easier.
- The current behavior-object selector-slot lookup is a bootstrap convention, not the final Class/Metaclass model.
- Nested Blocks use automatic lexical capture analysis; captured state is identified by stable binding ID rather than source name.
- `self` crossing a Block boundary is a lexical capture, not the Block object used as the `value*` message receiver.

### Object model

- The kernel is durable graph data found through `findSmalltalkKernel`, never refs a caller kept. Bootstrap state that lives only in a returned object dies with the process while the image survives (ADR 0044).
- A behavior record means what its own shape says. `smalltalk/behavior-shape/v1` gets ADR 0044 lookup; anything else is a legacy behavior and keeps its old lookup. Installing the kernel must never change what an already-stored record means — that is migration by interpretation, and it is forbidden here for the same reason it is forbidden for durable `{unbound}` captures.
- Selector-name uniqueness is a MethodDictionary invariant, not a generic Shape one. `normalizeShapeSlots` rejects duplicate slot *ids* and says nothing about names, so a `find`-based selector lookup would otherwise resolve by position.
- The metaclass chain is derived from the class chain (`C class superclass == S class`, with `Object class superclass == Class`), never written out per class, so the two hierarchies cannot drift apart.
- `putObject` validates the shape but neither `behavior` nor ref-valued slots, which is what lets the bootstrap create objects in any order and close the metaclass cycle. Do not add validation there without providing another way to build that cycle.
- Bootstrap writes are ensure-exact-or-create. `putObject` is an upsert and would silently replace an existing record; `putShape` is create-once and would reject a retry after a partial install. One rule covers both: an exact existing record is reused, a differing one is rejected, and an absent one is created — which is what makes installation safe to retry.
- A shape or slot reference is identity only together with its `imageId`. Cross-image refs are legal, so another image's `smalltalk/behavior-shape/v1` must not be mistaken for this image's.
- Structural validation and graph resolution are separate concerns. `readBehavior` checks that a record is a well-formed Behavior; it does not check that its `superclass` or `methods` refs resolve, because the metaclass cycle depends on forward references being writable. Dispatch must therefore keep three failures distinct: a malformed Behavior, a dangling superclass or method-dictionary edge (corrupt or incomplete graph state), and an ordinary selector miss.
- Lookup terminates by comparing a full ref against the current kernel's `nil`, never `objectId === 'smalltalk/nil'`. `nil` is the right object for absence in both the superclass and instanceShape roles; comparing by object id alone would reintroduce the cross-image identity bug class. That comparison is currently defence in depth rather than an active discriminator, because `readBehavior` requires a superclass to be a local ref — so cross-image inheritance is unsupported and a foreign `smalltalk/nil` is rejected before lookup could reach the terminator.
- The dispatch image is execution context, threaded through `execute` and `sendMessage` beside `depth` and `authority`. It never appears on a request, a Value, or in the durable graph.
- Language policy reaches the execution layer through a seam, never by the execution layer learning the language. `temporaryInitializer` is resolved once per activation before either lane runs, and receives the artifact's `languageId`; the execution layer never learns what `nil` is, and no executor learns it independently.
- A policy scoped to one language must key on the artifact's language, not on the image it lives in. An image can hold artifacts of several languages, so image-scoped policy silently extends one language's semantics to the rest.
- Do not memoize a durable-graph lookup without an invalidation contract. Bootstrap installs into an image that already exists, so caching "no kernel" makes execution depend on what the process observed first rather than on current graph state.
- Decision 10 preserves how a legacy behavior *fails*, not only how it succeeds. A selector miss on a legacy behavior still raises the pre-0044 `TypeError` with its original wording; only fixed-shape Behaviors get the ADR 0044 error classes.
- Invariants enforced by a builder must also be checked when the data is read. Generic graph writes can produce a MethodDictionary shape with duplicate selector names, and a `find` over that resurrects first-wins lookup — the defect decision 2 exists to remove.
- Anything with deterministic durable ids writes ensure-exact-or-create, not just the kernel installer. `defineClass` and `defineMethods` derive ids from class and selector, so a plain write would silently replace an existing class or method. Retry-safety has to cover *every* write in the sequence, including ones made by a helper you call: `compileWasmFunctionArtifact` writes its function artifact unconditionally, so the caller must reuse an existing one rather than collide with its own earlier output.
- A durable id derived from a collection must encode the collection, not its size. A MethodDictionary shape keyed on selector count makes an abandoned `foo` conflict with a later, unrelated `bar`. And the record must be *built* from the same canonicalization that names it — fingerprinting a sorted list while persisting insertion order gives one id two contents.
- Reuse checks must be as strict as the write they replace. Matching provenance is not matching output: a derived artifact with correct `derivedFrom` but stale content is stale, so resolve what a fresh build would produce and compare against that. Where an assembler builds a durable artifact, factor its description out so assembly and reuse-validation compare the same complete contract.
- Durable identity is injective, never probabilistic. A canonical array encodes directly; a truncated digest trades a real collision probability for shorter ids.
- Validate everything before publishing anything. Create-once artifacts at deterministic ids mean a rejected input can permanently occupy its own id, so a bad method body must be refused before its `:semantic` artifact is written.
- A publication sequence is proven recoverable by enumerating its writes, not by probing a few. `test/smalltalk-builder-recovery.test.js` interrupts at every write in both lanes, including a commit-then-throw that models a lost acknowledgement — after which an identical request must be idempotent, not a redefinition error.
- "Exact" for a code artifact includes `dependencies` and `derivedFrom`. Those are durable semantic and provenance edges, so an artifact differing there is a different artifact.

### Boolean bridge and control flow

- A boolean Value is never boxed and never gains graph identity. Symmetric Smalltalk nominates the dispatch image's `true`/`false` object as the *effective receiver* of one send (ADR 0045); the request still carries the boolean, and the same boolean comes back out.
- The bridge belongs to one dispatcher. Another language personality dispatching the same Value receives the boolean, so never move this into the invocation service or the Value layer.
- `effectiveReceiver` is an optional second key on a dispatch resolution, must be an unpinned object ref, and is transient in exactly the way the dispatch image is — it reaches an activation and never a record. Absence is the only spelling of "the original receiver".
- The bridge never changes the dispatch image. An immediate receiver's dispatch image is the sender's, and the nominated singleton lives in that image by construction.
- Control flow is dispatch, not syntax. The compiler recognizes no conditional selector, and the `if` op keeps its boolean-Value condition for other producers. Lowering `ifTrue:` to `if` would be a deliberate, named change — not an optimisation to slip in.
- `nil` on an untaken branch is an ordinary captured ref in the method's lexical environment. Do not add a Smalltalk `nil` operation to `lagrange-code`: absence is a language's answer, and the common IR is shared with every other personality.
- A method that carries captures adds a `putLexicalEnvironment` to the publication sequence, so it is written ensure-exact-or-create and enumerated by the recovery sweep like every other write there. `metadata` is a durable field of that record, so "exact" includes it — an environment matching only in its bindings is a different environment, exactly as it is for objects, Blocks and CodeArtifacts.
- The semantic program names captures but not their values, so a lost-acknowledgement check must compare the environment this definition *would* write: the Block points at the deterministic id, and that record satisfies the whole contract. A capture-free method carries no environment at all — accepting an arbitrary empty one makes two different Blocks the same method.
- A lexical environment is keyed by capture id, so matching capture *counts* is not matching bindings. Duplicate ids collapse into one binding and silently drop a value — and in the WASM lane two parameter positions then resolve to the same binding. Every path that builds an environment rejects a duplicate id, not only `createClosure`.

### Allocation and class protocol

- Language-owned execution policy enters through the composition root, never by making execution depend on language. `createRuntime()` registers the `smalltalk-kernel-primitive/v1` executor and supplies `temporaryInitializer`; `src/execution` imports nothing from `src/language`, and it must stay that way — `src/language` already imports `src/execution`, so the reverse edge closes a cycle that the `export *` barrel reports as an import-time failure naming neither file.
- "Registered executable representation" means registered by the *assembled runtime*, not by `createDefaultCodeExecutorRegistry()`. `test/steering-docs.test.js` checks `docs/seams.md` against the runtime for that reason.
- Host-sensitive Smalltalk semantics live behind language-owned primitive Blocks (ADR 0046), never as Smalltalk operations in `lagrange-code`. A method reaches one through an explicit captured ref, so the host effect rides the ordinary send path and neither lane needs a new ABI.
- A primitive's image is `activation.block.imageId` — its own Block's image, never the sender's. It is also the only image identity an executor has, since the dispatch image is deliberately not in the executor context. Both primitives reject a *ref* input from another image; an immediate Value carries no image, so a foreign `class-of` answers from its own kernel instead of failing. That is correct but silent, so the defence is that a method captures its own image's primitive Blocks — keep installation of the Blocks and of the methods naming them in one image.
- `instanceShape` of `nil` means not instantiable; an empty Shape means a valid zero-slot layout. Never collapse the two — a stored `nil` reinterpreted as "empty" changes the meaning of every Behavior ADR 0044 wrote, without rewriting a record.
- `instanceShape` is the complete instance layout including inherited slots, composed and validated by the class-definition path and compared by stable slot **id**. Allocation consumes it and never reconstructs it from superclasses.
- Slot completeness is forced by `assertObjectMatchesShape`, not chosen: an object whose slot set differs from its Shape in either direction is not a representable record. The only allocation policy is which Value fills them, and it is that image's `nil`.
- The allocation primitive mints its own candidate object id and writes create-once. Never let `putObject` generate it: an id the caller never saw cannot be reused on retry. Known collision means a fresh candidate; an uncertain outcome for one host operation means the same candidate; a new `basicNew` send always means a fresh one.
- A validation walk must not answer "nothing to check" for a corrupt graph. `nearestDeclaredInstanceShape` returns `null` only when it reaches the kernel `nil` terminator; a cycle, a dangling ancestor or a malformed one raises, because "no inherited layout" and "the chain is unreadable" are indistinguishable to a caller if both answer the same way — and a subclass would publish on the strength of an invariant that was never checked. Only the direct superclass is validated by the caller, so every ancestor above it is validated by the walk.
- An inheritance check walks to the nearest ancestor that actually declares a layout, not to the direct superclass. A class with `instanceShape` of `nil` declares nothing of its own but cancels nothing above it — its subclasses still inherit every ancestor's methods, so they still need every ancestor's slots. Stopping at the first link lets one `nil` erase the invariant for everything below it.
- Instance-shape slot **names** are unique, checked at class definition. `normalizeShapeSlots` rejects duplicate ids and deliberately permits duplicate names, so this is a Smalltalk invariant in the same way selector uniqueness is a MethodDictionary invariant — and name-based instance-variable access would otherwise resolve by position.
- Match a backend version conflict by `error?.name === 'VersionConflictError'`, never by class identity. An embedder may supply their own backend through `lagrangeFactory`, whose conflict is not this package's error class.
- A Block executor that is not a `lagrange-code` lane asserts direct invocation with `assertBlockApplicationReceiver`. Without it, a primitive Block ref written into a method-dictionary slot runs as a method with `self` silently discarded.
- Image-native allocation is not an ADR 0037 capability check. Closure materialization already creates durable records without a grant, so gating only `basicNew` would leave a no-authority program able to evaluate blocks but unable to construct objects. Exposing object creation to foreign code is a separate authorized boundary.

### Instance variables

- Names resolve in the defining class, the durable method carries the stable slot **id**, and execution checks the slot belongs to the activation's own `self` (ADR 0050). Those are three separate concerns; collapsing any two of them opens a hole.
- `compileSymmetricSmalltalkMethod` is a *sibling* of the Block compiler, not a stage above it. A Block still compiles with no class; the class arrives as an argument exactly as `captures` does. Never give the Block compiler ambient class state.
- The visible-layout walk is **one** implementation shared by the binder and the runtime check, and it is strict: a superclass cycle or a dangling instance Shape raises. Two implementations are two chances to disagree, and returning "no layout" for corrupt state launders structural failure into `unbound Symmetric Smalltalk name` at compile time and an ordinary denial at runtime.
- Permission uses the defining Behavior's **visible** layout — its nearest declared ancestor Shape — so an abstract intermediate class with a nil layout may still name ancestor-declared slots. A nil layout declares nothing of its own and cancels nothing above it, exactly as `nearestDeclaredInstanceShape` already encodes for class definition.
- Self-only is necessary and **not sufficient**. A method defined on Parent naming a Child-private slot passes both the receiver check and the object's-Shape check, so the defining Behavior's layout is a third, independent check. "May this method name this slot" and "does this object have it" are different questions.
- The frame propagates by callee kind, never by nesting: a method dispatch replaces it, a kernel-primitive send inherits it, a closure restores the frame it was created in, and anything else has none. An arbitrary Block invoked by a method must never borrow the invoker's `self`.
- The envelope must reach *every* dispatch path, not only nested sends. `sendMessage` returns the activation alone, so the frame is recorded against that activation and `execute` picks it up — otherwise the ordinary public `sendMessage` -> `execute` path resolves an ivar method correctly and then fails for want of a frame. Keying on the activation object is process memory, not graph data, so durable reuse and forged records cannot steer it.
- The frame reaches execution through a runtime-built transient envelope from `prepareDispatch`, never through the activation record and never by asking which dictionary holds a Block — that answer is neither unique nor trustworthy.
- Never persist a defining Behavior to make an escaped closure work. A lexical environment is forgeable durable data, so a persisted claim is the vector self-only exists to close; an ivar-using closure works within its execution and fails closed after it.
- A named-slot write preserves shape, behavior, other slots, the **indexed part** and metadata. ADR 0047's review found the mutation binding erasing an indexed part it did not carry forward.

### Method dictionaries

- A Behavior's `methods` edge points at either representation, and a record is read as what its own local Shape says it is (ADR 0049) — the ADR 0044 decision 10 rule again. Installing the hashed machinery migrates nothing.
- The hashed MethodDictionary is kernel representation, not a Smalltalk class: no behavior edge, no dynamic protocol. `behavior == null` is structural, because a record that acquired one would become dispatchable and its class could then override the very protocol dispatch depends on.
- Lookup uses only the pure `builtInHash`/`builtInEquals` helpers, never a `hash`/`=` send. That is why a MethodDictionary cannot be an ordinary Dictionary: a Dictionary must honour an override, and a dispatcher must not. Never "fix" this by reserving `Text >> hash` — separating the representations is the correct trade.
- Whole-table validation is `O(n)` and runs once per record `_version`, behind a transient per-runtime cache. It caches structure, never a lookup answer, so an addition or migration is visible immediately. The `_version` component is the invalidation contract that makes the cache permissible at all.
- Selector uniqueness and probe reachability are part of validation. Without them a corrupt table physically hides a method and reads as an ordinary selector miss — the ADR 0044 decision 2 defect in a new format.
- Migration seals the legacy dictionary first. Method addition guards on the *dictionary's* version and migration on the *Behavior's*, and those are disjoint — so without a shared serialization point a concurrent addition is silently lost. The seal governs writes only, so a crash between seal and swap leaves a class that still dispatches and whose writes stall visibly.
- The migration target id is deterministic per Behavior, because a Behavior has exactly one hashed dictionary ever. That is deliberately the opposite of ADR 0048's per-snapshot fresh identity, and for the opposite reason: here a retry must find its own previous output instead of leaving another orphan.
- Validate raw durable cells *before* handing them to a lenient shared parser. `bucketsFromIndexed` reads any non-Integer hash cell as an empty bucket — correct for a table this code built, wrong as a validation input, because the corruption erases its own evidence and an empty bucket ends a probe. Occupancy is decided from the cell's actual kind, and an empty bucket is all three cells holding this image's `nil`.
- Reuse at a deterministic id requires *proving* the existing record is what you would have written. "Not the new representation" is not a proof of "the old representation": an empty legacy dictionary is structurally an ordinary empty object, so the `smalltalk: 'method-dictionary'` tag is the discriminator that keeps an unrelated squatter from being adopted.
- Check the *target* representation's constraints in a migration's preflight, before any seal or write. A foreign method ref cannot exist in a hashed dictionary and is knowable in step 1; discovering it after sealing stalls the class for a reason that was reportable before anything changed.
- Nested Block publication is one implementation shared by standalone Block installation and method installation. Two recursive installers would eventually disagree about v0/v1, captures, deterministic ids or WASM, and the disagreement would show up as a Block that runs in one path and not the other.
- Ensure-exact-or-create is not a language concern: the WASM tree installers, both function assemblers and `CompilationService` write deterministic ids too, so the definition of "exact" lives once, neutrally, in `src/graph/ensure-records.js`. A caller-side guard is not a substitute — `ensureWasmFunction` protected the v0 assembler on the non-nested path while the nested tree called it directly and unprotected.
- A recovery sweep proves only the path its fixture takes. Sweeping the "widest" shape does not cover a *different* shape's code path: a v1 method never reaches the v0 WASM function assembler, so v0 needs its own sweep.
- A closure's trusted frame comes from the creation event, never from the artifact. Reusing a published prototype confers nothing, and a closure created inside a forged method gets *that* method's defining Behavior. Never reverse-look-up provenance from graph data to repair this.
- Anything reaching into a method dictionary should use `methodBlockRef()` rather than assuming a layout; two are legal at once. A representation-neutral reader owes the *same* corruption semantics as dispatch — a missing Shape is a dangling edge, duplicate selectors are refused — or it becomes a laxer way to read the same records.

### Equality, hashing and Dictionary

- `=` and `hash` are Smalltalk methods over language-owned primitives (ADR 0048). The `lagrange-code` `equals` op stays frozen and language-neutral; never redefine it to mean a Smalltalk send, and never let a container that exposes its elements turn it into deep object equality.
- The default relation is identity for refs — no record is read, so `_version`, Shape, behavior and slots never participate — and value equality for immediates, including exact Integer/Float equivalence derived from the Float's own value rather than from JavaScript's safe-integer range.
- The built-in hash is a **durable contract**: deterministic SHA-256 over a domain-tagged normal form, truncated to a non-negative 63-bit Integer. Bucket placement in stored tables depends on it, so replacing the algorithm is a migration decision, not an optimization. Equality and the hash share one normal form so `a = b => a hash = b hash` holds by construction rather than by maintaining two functions in parallel.
- NaN is the one deliberate split: stable hash, but unequal to itself. Dictionary does not repair a key whose own equality relation rejects it.
- A published `DictionaryTable` is immutable by language contract. A mutation builds a complete next snapshot, publishes it under fresh identity, and compare-and-sets the single `table` ref — so a reader sees one complete mapping or the other, never a half-published one.
- Bucket occupancy is the **hash** cell, not the key cell. That is what keeps `nil` a legal key instead of a stolen sentinel.
- General Dictionary lookup must really send `hash` and `=`, or user overrides are silently bypassed. Both results are type-checked before anything is published; a broken override fails the operation rather than corrupting a table.
- User `hash`/`=` code runs between the read and the write, so **every** exit from the operation is conditioned on the version observed before it ran — including the same-value no-op, which is a claim about durable state and would otherwise report false success over a mutation the user's own `hash` performed. A conflict is surfaced rather than retried — a retry would re-execute that user code and could duplicate its effects. A failed swap leaves an unreachable table, which is garbage, not corruption.
- Reinsertion after growth places entries by their **stored** hashes. Re-sending `hash` during a resize would run user code inside an internal operation, and a key whose hash had since changed would silently relocate.
- Image-native Dictionary mutation is not an ADR 0037 capability check, for the same reason `basicNew` and `at:put:` are not.
- A durable algorithm is pinned by **fixed vectors**, never by a self-comparison. `builtInHash(x) === builtInHash(x)` stays green if the digest, domain string, byte order or truncation changes — each of which relocates every key in every stored table.
- Rediscovering a record at a deterministic id validates the whole immutable definition, not one field. Carrying the right Shape is not the same as being that class; adopting a differently-defined Behavior then publishes methods onto it. Mutable parts — method dictionaries — are excluded, because their own installer owns their exactness.

### Image-resident library

- A library installer uses `ensureNamedClass`/`ensureSmalltalkShape` rather than rolling its own rediscovery. Accepting *any* record at a deterministic id adopts an unrelated object as that class or layout; `defineClass` alone is not enough for rediscovery, because it also ensures an empty method dictionary and conflicts once methods exist.
- Library classes are written in Smalltalk over the kernel protocols. When an idiom turns out to be inexpressible, the answer is to record the missing *general* language capability, not to add a collection-shaped primitive — a primitive added for one class hides the gap from every other.
- Source resolves global names through the ADR 0057 namespace: a name no lexical scope defines is looked up at compile time, becomes a capture on the binding's identity, and is dereferenced at runtime by an ordinary `value` send. A caller can still supply an explicit captured ref, and that remains the mechanism for anything not published. Compilation takes capture *declarations* (name -> stable id) and installation binds *values*, because a declaration is image-independent and a value is not. Every declaration becomes a binding whether or not the source mentions it, so every declaration needs a value — uniform, rather than a special case depending on whether the compiler kept the reference.
- Which captures are globals is *provenance*, not a property of the id: semantic compilation reports the binding ids it actually resolved (`globalBindingIdsUsed`, transient, never written to an artifact), and installation binds exactly those. Never infer it by testing a capture id against the published namespace — a caller's explicit capture may legitimately use an id that is also published, and substituting the binding object for the caller's value collapses two meanings onto one identity.
- Duplicate capture names or ids are refused, never resolved by position: a repeated name would make a source name mean whichever declaration came last. The binder's own capture names and ids are reserved for the same reason — they are spread after the caller's, so a collision would silently replace a caller declaration and its value.
- "Whole immutable definition" includes deterministically written `metadata`. Exclude a field from rediscovery only when it has a lifecycle of its own, as a method dictionary does; metadata has none. `compileSymmetricSmalltalkMethod` takes capture values for exactly this.
- Library source now names classes directly (`Array`, `IndexOutOfRange`), resolved through the image's namespace. If a method needs an explicit capture for a *class*, the global is probably just unpublished. Do not tidy them away without removing the underlying gap. Six signals are already gone because their gaps were closed rather than hidden: the recursive-helper spelling (ADR 0051), counting up to `tally + 1` to compare with `=` (ADR 0053), the unimplemented `errorIndexOutOfBounds:` refusal (ADR 0054), the `found` temporary carrying a search result out of its loop (ADR 0055), `1 = 2`/`1 = 1` spelling booleans plus the `NilObject` capture (ADR 0056), and the `ArrayClass`/`IndexError`/`EmptyError` captures standing in for a namespace (ADR 0057).
- Library protocol composes library protocol. `collect:`, `select:`, `detect:ifNone:` and `inject:into:` are built on `do:`, not on four more indexed loops — a new enumeration method that reaches for `contents` or `tally` is almost certainly the wrong shape.
- `self class new` is as far as the answer-class question goes for now. `Collection`, `species` and a collection factory are deliberately not invented ahead of needing them.
- A collection's bound is its own logical size, never its backing store's capacity. `contents at:` succeeds for any index up to capacity, so an accessor that delegates its bounds check to the Array will happily answer whatever slack the growth policy left behind.
- Traversals loop; they do not recurse. A recursive traversal is correct and unusable — every element costs an activation, and the limit is 256. `installSmalltalkLibrary` therefore requires the Block protocol, so an image missing it is refused at install rather than failing on first use.

### Block iteration

- `whileTrue:`/`whileFalse:` are two operations on the classless Block personality (ADR 0051), not a loop construct. The compiler recognizes no loop selector, `lagrange-code` gains no op, and there is no new executable representation. If a change here touches the compiler or the IR, it is the wrong change.
- The loop drives condition and body through ordinary `value` sends, never by executing their CodeArtifact. That is what makes frame restoration, authority attenuation, the dispatch image and cell arenas inherited rather than reimplemented — a direct execution would have to re-establish all four, and would get one of them subtly wrong.
- Each iteration returns before the next begins, so activation depth is constant in iteration count. Never implement looping recursively: it satisfies the protocol and preserves the exact defect the ADR removes. Only *iterations* are constant-stack — nesting and recursion still consume depth.
- The condition answers a canonical boolean. There is no truthiness, because a second looser notion of truth beside ADR 0045's polymorphism is how `nil`-is-false creeps into a language.
- The loop primitives are reached only by dispatching those two selectors. They are guarded structurally — receiver and argument must both be Blocks and neither a kernel-primitive Block — because `assertBlockApplicationReceiver` cannot apply when the activation receiver is the condition rather than the primitive.
- The dispatcher finds them through a discoverable Block protocol object and never knows an object id. Discovery validates what the slots *point at* — Block, CodeArtifact, `smalltalk-kernel-primitive/v1`, and the primitive name that slot claims — because the object is a routing authority whose target inherits the caller's frame. Absent is not corrupt: a missing protocol is an ordinary does-not-understand, and a damaged one is an explicit failure.
- The answered nil comes from kernel discovery in the condition Block's image at call time, never a host `null` and never a nil captured at install. A missing kernel is a kernel failure, not a does-not-understand.

### Integer ordering and arithmetic

- Ordering is protocol, not an instruction (ADR 0053). `lagrange-code` gains no comparison op; `<` is found by the same Behavior walk as `+`. If a change here touches the IR, it is the wrong change.
- One comparison primitive, three derived methods. Four primitives would be four chances for the set to disagree, and a `>=` that parts company with `<` at exactly one boundary is the classic form of that bug.
- A method never *is* a primitive: it captures the primitive Block and sends it `value:value:`.
- `//` floors and `\\` takes the divisor's sign. The distinguishing invariant is the remainder's *range* — `0 <= r < b` for `b > 0`, `b < r <= 0` for `b < 0` — because `(a // b) * b + (a \\ b) = a` holds for truncating division too and specifies nothing on its own. Host `BigInt` truncates toward zero, so the floor correction is the reason the primitive exists; test all four sign quadrants.
- The durable primitive is `integer-floor-divide`. A primitive name becomes durable CodeArtifact content, so it must not imply host semantics.
- Two Integers only, refused by name otherwise. Mixed *ordering* and *arithmetic* stay deferred; mixed *equality* is already decided by ADR 0048 and must keep working.
- Arbitrary precision throughout: never round-trip an Integer through a host number.

### Conditions and handlers

- A handler runs at the signal point, *before* unwinding (ADR 0054). Unwind-first would make `resume:` impossible: a suspended WASM activation's state lives in the instance, and the executor retires that instance on any escaping throw.
- One execution-wide condition runtime, owned beside the arena and living exactly as long. The three classless-Block operations only enter and leave scopes on it. There is no separate "WASM exception system" — WASM contributes only the suspend/resume/retire behaviour it already had.
- Resumption rides the existing resumable ABI: a handled signal answers the host effect and the guest resumes at its effect site. No new export, no ABI change, and no extra resumption is charged — the counter increments before the host effect.
- A handler's `self` is free (ADR 0050 restores the Block's creation frame); its **authority is not**. Authority propagates dynamically, so it must be captured at `on:do:` time and kept privately on the transient scope — never on the closure, never in a Value (ADR 0037). The same applies to `ensure:`/`ifCurtailed:` blocks.
- A running handler is disabled while it runs, so a re-signal delegates to an outer handler instead of recursing into itself. Without this it is an immediate infinite regress, not a slow one.
- `ensure:` answers the protected Block's value and discards the cleanup Block's own. It runs for *every* non-normal exit, including host failures that are not Smalltalk-catchable — protection that only fired for catchable failures would stop working exactly when something unexpected happened.
- A cleanup failure stays catchable: if it escapes it becomes the outward failure and retains the original as `duringUnwind`, so neither is lost.
- `resume:`/`return:` act on the receiver's currently *active* occurrence, and fail explicitly when there is none. A condition object carries no handling state — one object signalled twice has two independent occurrences.
- A condition object is an ordinary durable object. ADR 0054 adds no second category of object; only the signal occurrence is transient.

### Non-local return

- `^` is syntax the compiler learns, lowered to an ordinary send to `$nonLocalReturn` (ADR 0055). `lagrange-code` gains no return op and the compiler still recognizes no *selector*. A return is a statement, not an expression: `^` cannot appear mid-expression, and statements after it parse but do not run.
- The home is the ADR 0050 frame the Block was created in, matched by **object identity**. Two activations of one method on one receiver have equal `{self, definingBehavior}` and are different homes.
- **Ownership, not frame equality, decides where a return stops.** A kernel-primitive send inherits the frame and a closure restores it, so the return primitive itself and every intervening Block hold the very same object. Only the dispatch-created activation owns it, marks it live/dead, and catches a transfer naming it. Compute ownership alongside the existing `activeFrame` priority expression — do not refactor that expression.
- Liveness lives in an executor-owned **WeakMap** keyed by the frame, never as a frame field: the dispatch seam validates the shape as exactly `{self, definingBehavior}`. Three states, not two — a *missing* entry means this executor never ran that frame as a home, which is not the same as one that ran and returned. A dead entry is retained while the frame is reachable, which is what keeps "already returned" distinguishable from "no home available", and it carries the dispatch selector so the failure names the method rather than only its class.
- The frame is marked live *inside* the protected region, not when ownership is computed. A failure in between — temporary initialization, for instance — would otherwise leave a frame permanently live, and a later `^` naming it would be told its home is still running. The mutator is private: outside code must not be able to forge liveness.
- Returning to a dead home fails explicitly and is **never** converted into a local return — that would compute a wrong answer rather than stopping.
- A standalone Block containing `^` is refused at compile time; an escaped method Block fails at invocation. Different diagnoses for different mistakes.
- `[ ^ 1 ] ensure: [ ^ 2 ]` answers 2: a cleanup that transfers supersedes the transfer already unwinding, while an ordinary cleanup value is still discarded.

### Reserved literals and the Boolean protocol

- `true` and `false` compile to canonical boolean **Values**, never kernel singleton refs (ADR 0056). ADR 0045 makes the singleton a *dispatch personality*, so `true class` reaches `True` while storing `true` stores the Value. A boolean-answering method answers the Value.
- `nil` is a language-owned image object, so it lowers to the reserved `smalltalk/intrinsic/nil` binding and installation supplies that image's kernel nil. The semantic artifact must never contain an image-specific ref, and the generic Value model must never gain a nil kind.
- The nil intrinsic is owned by the semantic compiler and offered to every compilation; wrappers must not declare it. A caller may add intrinsics but may not replace `$nil`, and both `$nil` and `smalltalk/intrinsic/nil` are reserved at every programmatic capture entry point — reserving the name without the id would let a caller bind the id under another name and shadow `nil` from outside the compiler.
- The intrinsic is requested lazily on first use. A program without `nil` carries no binding for it and its installer writes no environment — preserve that path exactly.
- For a standalone Block, the intrinsic environment **parents** any caller-supplied environment; it never copies its bindings. The chain walk is the composition mechanism, and a copy is a second answer that can drift.
- `true`, `false`, `nil` and `self` are reserved words, enforced in one place (`isReservedWord`) for all four sites: block parameters, temporaries, assignment targets and explicit captures. They had already drifted once — `self` was refused as a temporary but accepted as a block parameter.
- `not`/`and:`/`or:` are ordinary methods in the existing control-flow table, not a second publication surface. `and:`/`or:` are lazy because their short-circuit arm answers a literal without naming the argument; never make them eager, and never give them an IR op or primitive.

### Global names

- Three things stay apart: the **name** is a key in the namespace mapping, the **binding identity** is a `GlobalBinding` object stable across rename and rebinding, and the **current value** is what it holds now (ADR 0057).
- **A GlobalBinding ref identifies the binding; it does not grant authority to rebind it.** Every reader necessarily holds that ref, so `GlobalBinding` answers `value` and has no `value:`. Rebinding goes through the namespace-management seam, never Smalltalk protocol.
- A global read resolves the binding at **compile time** and dereferences it at runtime with an ordinary `value` send. Never capture the current value; never look the name up at runtime. An unknown global is a compile-time failure.
- Globals resolve **last** — after parameters, temporaries, captures, inherited captures and instance variables — for reads *and* writes, so a lexical name of the same spelling shadows a global consistently.
- The global capture is keyed by the **binding id**, not the source name. Keying by name makes the capture shadow the global on the second read in the same method, and makes an alias emit a duplicate capture id.
- **Class existence is not publication.** `ensureNamedClass` publishes nothing; publication is an explicit call. A class may exist and be unnameable.
- The namespace is a language-owned image object with a fixed Shape and a canonical indexed name/binding mapping — never Shape slots (which would make every publication a structural migration), and never a host-side map. Reached through one discoverable protocol root; the compiler knows the protocol, never a class name or a deterministic class id.
- Installers that publish must be re-runnable: publishing an existing name to the same binding is a no-op that **keeps the current value**, since re-running an installer must not undo a legitimate rebind. The namespace object itself is created-if-absent for the same reason.

### Mutable lexical state

- Assignment mutates an activation-visible cell (ADR 0043). Never a canonical Value, never a Block, and never the durable lexical-environment graph. If an assignment causes a `putLexicalEnvironment` call or a history event, it is wrong.
- A cell is keyed by (lexical frame, static binding ID), never by binding ID alone. Binding IDs are static slot identity and every compilation unit restarts them at `root:`, so keying by ID alone makes recursion, repeated invocation and unrelated artifacts all share one variable.
- Frame identity and frame lifetime are different. Different lexical invocation means a different frame; a frame stays reachable after its own call returns if a closure holds one of its cells; the arena dies with the root execution.
- A live-cell capture persists `{name, cell: true}` and no value, deliberately. Do not add a `snapshot()` route: a durable value would let a later invocation quietly restart a counter, which ADR 0043 rules out in favour of `EscapingMutableClosureError`.
- `UNBOUND` is a host sentinel. It must never reach `canonicalizeValue` or be observable as a Value, and it is not `nil`. In a bootstrapped image a declared temporary starts holding that image's `nil` ref instead (ADR 0044 decision 8); elsewhere it starts `UNBOUND` and reading it raises, exactly as ADR 0043 decided.
- The lexical substrate lives in the common execution layer (`src/execution/lexical-cells.js`) and both lanes consume it. A second, lane-private implementation of mutable lexical state is the architecture to avoid.
- `lagrange-code/v0` and `neutral-expression/v0` are frozen closed grammars. New executable semantics get a new version and the front end selects between them from semantic need, not from a syntax check.
- A shared cell is never a WASM local, and never continuation state. The closure that writes it is a separate activation with its own frame, so cells live host-side behind synchronous `cell_get`/`cell_set`. A Value already read from a cell may cross a suspension; a future read or write may not.
- A cell capture occupies no Value-handle position in either WASM ABI. Closure-site arity counts snapshot captures only — that is what makes a cell snapshot structurally unrepresentable rather than merely avoided.
- Cell slot indices are function-local, resolved through the active function descriptor. A shared module holds several Blocks whose static binding ids all start at `root:`, so a module-global table would confuse unrelated slots.
- Every WASM metadata normalizer branches on the declared `metadata.abi`. Never teach an old normalizer to accept a new shape; add a sibling that requires the new one.
- A sibling ABI reader must be no laxer than the one it sits beside. When adding one, port every validation from the frozen reader — duplicate index rejection, non-empty function tables, reference-free metadata — even where another layer happens to catch the case first.
- The two lanes must agree on *which* failure a program gets, not merely that it fails. An absent cell means `EscapingMutableClosureError` when its binding is a capture and `MissingLexicalCellError` when it is a temporary; the WASM side derives that from `cellBindings.source` rather than consulting the durable record.

### Failure conformance

- Two implementations of one abstraction owe conformance on failures as well as values. `success conformance` is `lane A value == lane B value`; `failure conformance` is that equivalent invalid programs or operations fail *for the same semantic reason*, not merely that both threw. `test/failure-conformance.test.js` holds these.
- Assert the shared reason with one regex applied to both lanes. That permits lane-specific prefixes without inventing an error taxonomy, and still rejects a lane that fails for a different reason.
- A guest-facing error must explain the program, never the transport. Reporting "invalid handle" where the program read an absent receiver is a conformance defect even though both lanes stop.
- Constructing an "equivalent operation" takes care when the lanes take different parameters. A malformed version token rejected before an object lookup is a *different* operation, not a different answer to the same one — check before recording a divergence.

## Authority

- Authority is execution context, never program data (ADR 0037). It is passed as `execute(activation, {authority})` and must never become a Value, a slot, a lexical capture, an `interface-composite/v0` payload, metadata, or part of Block identity or a derivation key.
- Executors receive only a check-only `require(demand)`. Never place an `AuthorityService`, an authority context, a returned grant or a principal into an executor context.
- Attenuation is requested through `sendMessage(request, {attenuate})` and performed by `ActivationExecutor`; an executor never receives the resulting context. `attenuate` narrows only, so escalation is impossible by construction.
- Absent authority means no capabilities, never all. New capability-bearing surfaces must fail closed.
- An execution context does not outlive its activation. Everything handed to an executor expires when that activation finishes, on exceptional exits too, so a retained closure cannot keep authorizing. Any new activation-scoped capability must join that guard rather than escaping it.
- `issue`, `revoke` and root grant configuration are control-plane APIs. `require` is the execution-time API.
- v0 grants are exact-match `{operation, resource}` pairs. Do not add wildcards, inheritance, resource trees or deny rules without a new decision.
- Authority belongs to the individual call, never to a long-lived runtime instance. A shared foreign runtime may serve many authorities; a host operation resolves against the active call's context, and no active context means no host authority.

### Component host imports

- A binding declaration decides which host interfaces are *wired*; it never decides authorization (ADR 0038). `undeclared != unauthorized`.
- An undeclared required import is a linking failure at instantiation. A declared import is present even when the caller holds no grants, and each concrete operation calls `require(demand)` at use time.
- Never precompute `declared ∩ granted` or enumerate grants. Precomputing would snapshot authority at instantiation and silently defeat revocation.
- A `wasm-component-binding/v2` declaration carries interface names only: no principal, grants, resources, secrets, service objects or authority contexts.
- The host-import registry is runtime-local and never part of artifact identity. Providers receive only `require`.
- Keep the jco adapter authority-agnostic: it reports required imports and instantiates with what it is handed.

### Image object projection

- Never name an authority resource by concatenating identifiers. `imageId`/`objectId` do not forbid a separator, so `a/b` + `c` and `a` + `b/c` collide. Build every object resource with `objectResource()` (ADR 0039).
- The same rule applies to *every* keyed lookup on a multi-part identity, not just to authority resource names. Image ids, object ids, representations, policy ids, roles and authority operations are all arbitrary non-empty text, so NUL is no safer a separator than `/` — and a raw NUL in source renders as a space in most tools, which is how three of these survived review. For an in-memory key, use `TupleMap`/`TupleSet` from `src/support/tuple-map.js`; never join and never `split` a composite key back apart. Reach for `objectResource()` only when a single *durable* string is genuinely required.
- `object/read` is whole-object authority. A projection's field mapping is typing policy, not a field-level capability, and does not attenuate anything.
- A projection never follows a ref: authority for one object must not imply authority for what it points at. A mapped ref slot is rejected.
- `image-projection-binding/v1` is structural by stable slot ID. Shape identity is not part of compatibility; a nominal restriction would be a later version with an explicit shape edge.
- The image comes from the binding, never the caller. An object-id argument is lane addressing: not a ref, not a capability, and knowing one grants nothing.

### Foreign resource handles

- A WIT resource handle carries image identity only (ADR 0040). Never put an authority context, principal, grant or cached authorization decision on one, and never treat a handle as a cached `require`: every method re-authorizes.
- Handle lifetime is the activation, sharing the existing execution-context lifetime record. Do not add a second expiry mechanism. A trapping guest does not drop its handles, so guest `drop` is never the cleanup path.
- `own` owns the transient handle; `drop` releases it and mutates nothing durable — no deletion, no revocation, no history. Revocation and destruction stay distinct.
- A handle is lane-local: never a Value, an InterfaceValue or an `interface-composite/v0` payload, never stored in a slot, never returned from an ordinary Block.
- Handles that outlive an activation need an explicit lease abstraction, not `own<T>`.

### Inter-activation state survival

- An activation is the default lifetime boundary (ADR 0041). State dies with it unless an explicit contract says otherwise; there is no survival by omission, convenience, or a mechanism merely being capable of it.
- A survival contract must name all eight of: what survives, who owns it, how it is identified, when it expires, how it is explicitly released, how forced cleanup works, whether it is runtime-local or durable, and how a later activation reacquires it. Forced cleanup is mandatory, because a trapping guest drops nothing.
- Surviving state must never retain an `AuthorityContext`, a `require` or `sendMessage` closure, an activation-scoped handle, a principal, or a cached authorization result.
- Later use always re-enters through a new activation and re-authorizes there. Never inherit authorization from the activation that created the surviving state.
- A survival identifier is not a capability: possession must not grant access. Surviving state may remember *what*, never *who-may-do-what*.
- Do not build a generic lease or survival framework. Component reuse, persistent resources and async callbacks are separate specializations that must each satisfy the constraint their own way.

### Object mutation

- `object/write` authorizes causing a mutation; `object/read` authorizes observing state. The host-internal read-for-write a partial mutation needs is not `object/read`, so a write-only capability is real (ADR 0042).
- Optimistic-concurrency tokens are opaque and **object-scoped**. Build them only with `objectVersionToken()`; an unscoped token would succeed against a different object at the same version. Callers may compare and round-trip tokens, never interpret them.
- Never propagate the backend `VersionConflictError` outward — it carries `expectedVersion`, `actualVersion`, `collection` and `key`. Translate it, and do not attach it as `cause`.
- Authorize, then validate the token, then fetch. A caller without authority must learn nothing, including whether the object exists. (The Project rename lane, ADR 0080, treats the expected token as static input validated together with the other non-storage arguments *before* authorization — the parse is purely over caller-supplied ids and discloses nothing; the fetch still comes last.)
- A mutation never follows or writes through a ref, and v1 cannot create a graph edge at all. Future edge mutation is not assumed to fall under `object/write`.
- `drop` is never a commit.

## Architecture

```text
tools -> languages/runtime -> image graph -> backend -> Lagrange
```

Do not reverse the dependency direction. Projects, source, binary dependencies, notes and work items should tend toward objects/artifacts in the image model; files/Git are interoperability views. Distributed execution is later runtime policy, not an excuse to make every object send an RPC.

## Documentation

When a design is exploratory, say so. Keep current, next and possible-later distinct. Avoid describing planned capabilities as implemented.

### ADR status is a claim, and it is checked

Every ADR's third line is a `Status:` line beginning with one of exactly these tokens:

```text
proposed      considered, not decided
accepted      decided; may or may not be built yet
implemented   built and exercised by tests in this repository
superseded    replaced; must name the replacing ADR
```

A free-form sentence may follow the token on the same line.

An `implemented` ADR must also carry a `Proven by:` line listing test paths that exist.
`test/steering-docs.test.js` enforces both rules, so an ADR cannot claim to be built
without pointing at the thing that proves it.

This matters because a visiting agent reads ADRs as a description of the code. Writing
"the executor uses X" when nothing implements X is worse than writing nothing: it converts
a missing feature into a false belief that costs the next agent a day. If a decision is
made but unbuilt, `accepted` is the honest token.
