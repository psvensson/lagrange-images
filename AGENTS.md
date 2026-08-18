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

- Every backend implements `transaction(callback)`; the scoped transaction exposes only `get`, `put`, `scan`, `append` and `readStream`.
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
- `rust/source-v1` uses `metadata.path` only as a non-reference portable project path. Reject absolute paths, backslashes, empty segments and `.`/`..` traversal.
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
- The pinned image must already contain Cargo/rustc and the requested target. Do not mutate/install the toolchain during a build unless a later explicit toolchain contract requires it.
- OCI runner argv is constructed without a shell. Keep the temporary workspace bind mount, explicit workdir/network and host uid/gid behavior where available.
- Temporary workspaces are build machinery and must be removed in a `finally` path.
- Cargo-produced bytes are stored as `wasm-binary/v1`, not `wasm-module/v1`. The latter is reserved for the current Lagrange Value-handle/import/effect ABI.
- Raw `wasm-binary/v1` may only enter ordinary activation through an explicit callable/component interface contract. Never relabel it as `wasm-module/v1` merely because the header validates.
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

- WASM belongs in `wasm-module/v1` / `wasm-function/v1` CodeArtifacts, not in Block/image identity fields.
- A shared `wasm-module/v1` may contain several exported entries, but each semantic member still gets its own `wasm-function/v1` and Block/prototype identity.
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
- Decision 10 preserves how a legacy behavior *fails*, not only how it succeeds. A selector miss on a legacy behavior still raises the pre-0044 `TypeError` with its original wording; only fixed-shape Behaviors get the ADR 0044 error classes.
- Invariants enforced by a builder must also be checked when the data is read. Generic graph writes can produce a MethodDictionary shape with duplicate selector names, and a `find` over that resurrects first-wins lookup — the defect decision 2 exists to remove.
- Anything with deterministic durable ids writes ensure-exact-or-create, not just the kernel installer. `defineClass` and `defineMethods` derive ids from class and selector, so a plain write would silently replace an existing class or method. Retry-safety has to cover *every* write in the sequence, including ones made by a helper you call: `compileWasmFunctionArtifact` writes its function artifact unconditionally, so the caller must reuse an existing one rather than collide with its own earlier output.
- A durable id derived from a collection must encode the collection, not its size. A MethodDictionary shape keyed on selector count makes an abandoned `foo` conflict with a later, unrelated `bar`. And the record must be *built* from the same canonicalization that names it — fingerprinting a sorted list while persisting insertion order gives one id two contents.
- Reuse checks must be as strict as the write they replace. Matching provenance is not matching output: a derived artifact with correct `derivedFrom` but stale content is stale, so resolve what a fresh build would produce and compare against that.
- "Exact" for a code artifact includes `dependencies` and `derivedFrom`. Those are durable semantic and provenance edges, so an artifact differing there is a different artifact.

### Mutable lexical state

- Assignment mutates an activation-visible cell (ADR 0043). Never a canonical Value, never a Block, and never the durable lexical-environment graph. If an assignment causes a `putLexicalEnvironment` call or a history event, it is wrong.
- A cell is keyed by (lexical frame, static binding ID), never by binding ID alone. Binding IDs are static slot identity and every compilation unit restarts them at `root:`, so keying by ID alone makes recursion, repeated invocation and unrelated artifacts all share one variable.
- Frame identity and frame lifetime are different. Different lexical invocation means a different frame; a frame stays reachable after its own call returns if a closure holds one of its cells; the arena dies with the root execution.
- A live-cell capture persists `{name, cell: true}` and no value, deliberately. Do not add a `snapshot()` route: a durable value would let a later invocation quietly restart a counter, which ADR 0043 rules out in favour of `EscapingMutableClosureError`.
- `UNBOUND` is a host sentinel. It must never reach `canonicalizeValue` or be observable as a Value, and it is not `nil` — there is no `nil` yet.
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
- Authorize, then validate the token, then fetch. A caller without authority must learn nothing, including whether the object exists.
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
