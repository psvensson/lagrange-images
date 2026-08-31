# Ownership registry

This is the authoritative map of architectural ownership for Lagrange Images.

The rule is strict:

> Every major subsystem has one owner. Every interaction between subsystems has one owner.

An owner is one architectural code locus — a service, module, registry, adapter, composition root, or lower/external layer. It is not a claim about a human maintainer.

The owner owns the concern's semantic decisions, state-transition/public contract and primary proof surface. Other components may call, observe or adapt it; they may not independently decide the same rule.

A planned owner reserves responsibility but does not claim implementation exists yet.

## Subsystem owners

| Responsibility | Single owner | Location/status | Notes |
| --- | --- | --- | --- |
| Runtime composition and package-wide assembly | `createRuntime()` composition root | `src/runtime.js` | Wires owners together; must not absorb their semantic policy. |
| Durable image graph operations and history publication | `GraphImageService` | `src/image/graph-image-service.js` | Owns image-record operations above the backend seam. |
| Canonical Value semantics | Value model | `src/value/` | Smallest common value layer; language semantics do not leak into it. |
| Generic Shape/Object representation | Object model | `src/object/` | Owns language-neutral object layout/validation. |
| CodeArtifact representation and graph semantics | Code artifact model | `src/code/` | Owns durable code/artifact identity, dependencies and provenance fields. |
| Storage transaction contract | Backend contract | `src/backend/` | Mock and durable adapters implement one transaction/storage seam. |
| Durable Lagrange storage mapping | Lagrange backend adapter | `src/backend/create-backend.js` plus Lagrange backend implementation | Owns translation from the backend contract to public Lagrange application sessions. |
| Invocation construction and language dispatch entry | `InvocationService` | `src/dispatch/invocation-service.js` | Turns a language-level application/send into an activation through the selected dispatcher. |
| Activation lifetime, recursive execution and execution context | `ActivationExecutor` | `src/execution/executor.js` | Owns activation lifetime, recursive sends, lexical execution context and executor invocation. |
| Executable representation selection | Code executor registry | `src/execution/` | Selects exactly one executor by CodeArtifact representation. |
| Transient authority algebra and contexts | `AuthorityService` | `src/authority/authority-service.js` | Owns issue/attenuate/revoke/require semantics; authority never becomes program data. |
| Image-native compilation orchestration | `CompilationService` | `src/compilation/` | Owns compiler/group-compiler invocation and derived executable publication. |
| External toolchain orchestration and derivation reuse | `ToolchainService` | `src/toolchain/` | Owns explicit input resolution, provider invocation, result provenance and reuse policy. |
| Foreign runtime lifecycle | `ForeignRuntimeService` | `src/foreign-runtime/` | Owns transient start/call/stop lifecycle and provider-private runtime handles. |
| Durable foreign-runtime definition resolution | `ForeignRuntimeDefinitionService` | `src/foreign-runtime/` | Owns durable definition -> runtime-local provider/startable-definition resolution. |
| Callable/interface and implementation-binding contracts | Callable layer | `src/callable/` | Owns language-neutral callable/interface/binding representations and authorized image bindings. |
| Internal and foreign WASM execution machinery | WASM layer | `src/wasm/` | Owns Value-handle ABIs, module/component adapters, caches and WASM-specific execution contracts. |
| Symmetric Smalltalk language semantics | Symmetric Smalltalk personality | `src/language/` | Owns syntax, lookup, class/kernel/library semantics and language-specific compilation policy. |
| Image-level Project working-state semantics | Project image library/service | current: `src/project/working-state.js` | Durable Project objects (`lagrange-project/project/v1`), member objects (`lagrange-project/member/v1`) and the create/add/read translation over ordinary image objects/refs; no special backend record type. Member key is identity (target is a mutable slot); membership conveys no authority. Reads hand the assembled record to `normalizeProjectDescriptor` — the pure model stays the sole owner of descriptor semantics. Owns `authorizedReadProjectDescriptor`, the single authorized semantic Project read: ONE authorized `object/read` on the Project object authorizes reading the Project's own backing member records (they are the Project's storage representation, NOT independent authority units — this does NOT follow member targets, whose content still needs its own `object/read`), authorized before existence disclosure (no-existence-oracle), returning the canonical descriptor with no backing/Shape/slot ids escaping. Working-frontier/diff/merge and human Project interaction remain above this slice. |
| Project release/deployment semantic contracts | Project model | current: `src/project/model.js` (ADR 0073) | Owns portable `projectId` and Project-local member keys, explicit DeploymentProfile selection, canonical release identity, separate source provenance/frontier map, target-specific ProjectInstallation mapping and effect-free upgrade planning. Does not persist Project objects, materialize releases or perform deployment effects. |
| Agent work/dependency graph | Beads | `.beads`/Dolt after `bd init` | Authoritative operational task tracker; no parallel Markdown TODO tracker. |
| Short durable agent discoveries | Beads memory | `bd remember` | Promote architectural/behavioral truth into tests/docs/ADRs as well. |
| Architecture decision history | ADR set | `docs/decisions/` | Owns why durable architectural decisions were made. |
| Current ownership map | Ownership registry | this file | Must change whenever a major owner or boundary changes. |

## Interaction owners

Endpoint owners do not jointly own an interaction. Each boundary has one owner responsible for the protocol/translation, sequencing, error semantics, lifecycle and integration proof appropriate to that boundary.

| Interaction | Single interaction owner | Status | Responsibility |
| --- | --- | --- | --- |
| Public caller -> assembled Images runtime | `createRuntime()` / public runtime surface | current: `src/runtime.js` | Owns package composition and public assembly without duplicating subsystem policy. |
| Graph/image semantics -> backend transaction seam | `GraphImageService` | current | Owns semantic record/history sequencing over backend transactions. |
| Backend contract -> Lagrange application session | Lagrange backend adapter | current | Sole translation between image backend operations and public Lagrange storage/session APIs. |
| Invocation request -> language dispatch resolution | `InvocationService` | current | Owns dispatcher invocation and construction of the activation envelope. |
| Activation -> executable representation | `ActivationExecutor` | current | Reads the code representation and delegates through the executor registry; executors do not self-select. |
| Activation -> transient authority checks | `ActivationExecutor` | current | Owns authority lifetime/propagation/attenuation plumbing; `AuthorityService` remains owner of the grant algebra. |
| WASM host effect -> ordinary message/closure execution | `ActivationExecutor` | current | Host effects re-enter the ordinary execution/send/closure path; WASM does not create a second language runtime. |
| Symmetric Smalltalk language policy -> generic execution | `createRuntime()` composition root | current | Registers language-owned primitives/temporary initialization without making `src/execution` depend on `src/language`. |
| CompilationService -> compiler registries | `CompilationService` | current | Owns compiler selection request, compilation-group orchestration and publication of derived artifacts. |
| ToolchainService -> artifact graph/provider | `ToolchainService` | current | Owns explicit input closure, provider boundary, diagnostics/result installation and provenance/reuse. |
| Durable runtime definition -> live foreign runtime | `ForeignRuntimeDefinitionService` | current | Resolves durable definitions/provider bindings and starts/reuses transient runtimes through `ForeignRuntimeService`. |
| Foreign runtime provider -> external VM/process | Concrete foreign-runtime provider | current per provider | Provider owns its transport/process protocol; generic service owns lifecycle semantics above it. |
| Callable binding -> concrete implementation lane | Representation-specific callable executor | current: `src/callable/` + execution registry | Owns decoding one binding and invoking its declared implementation lane. |
| Component binding -> host imports/authority check | Component binding executor | current | Wires only declared imports and performs use-time checks through the activation's `require`. |
| Authorized image projection/mutation/creation/read -> GraphImageService | Image projection/mutation/creation/object-read binding executor | current: `src/callable/` | Owns boundary typing/version-token/error translation and the create-lane authority/id-minting; GraphImageService owns the image write/read itself. |
| Authorized image observation -> private history stream | Image observation binding executor | current: `src/callable/` | Owns the metadata-only invalidation feed: per-event `object/read` filtering inside the substrate, the opaque (AES-256-GCM) cursor contract, and the no-payload/no-raw-revision guarantee; GraphImageService owns the private history stream itself. |
| Cargo toolchain provider -> OCI process | Cargo/rustc OCI provider | current: `src/toolchain/` | Owns Cargo-specific materialization, closed-input OCI invocation and output extraction. |
| OpenSmalltalk/Cuis definitions/toolchain -> VM bridge | OpenSmalltalk/Cuis provider(s) | current: `src/foreign-runtime/`, `src/toolchain/` | Own provider-specific Cuis transport/toolchain protocol; generic lifecycle/toolchain services remain authoritative above it. |
| Cuis semantic export (extraction) -> `smalltalk/cuis-semantic-export-v1` artifact | OpenSmalltalk/Cuis toolchain provider | current: `src/toolchain/opensmalltalk-cuis-toolchain-provider.js` | Owns the fixed, provider-owned export `.st` script (run toolchain-stage before `saveAndQuitAs:`), the canonical manifest schema/sorting/normalization, and the semantic identity model (ADR 0072). Crosses the heap boundary as TEXT only — semantic Package/Class/Method identities, never a Spur oop. |
| Cuis semantic export manifest -> ordinary image objects | Image creation-batch binding executor (ADR 0067) | current: `src/callable/` (lane) + `src/language/cuis-export-materialization.js` (Cuis-adapter pure translator + representation-class schema) | Owns materializing the manifest into ordinary objects via the authorized atomic creation batch; the toolchain does not create image objects. The Cuis adapter (`src/language/cuis-export-materialization.js`) owns only the pure manifest->member-list translation and the `CuisExportPackage`/`CuisExportClass`/`CuisExportMethod` representation-class schema (language-owned, behaviorally boring — an instance REPRESENTS a Cuis entity, never the executable Lagrange Class). Semantic identity stays string data; ObjectRef is server-minted. `Cuis-Base` refs stay reserved identity strings, never materialized. |
| Project working descriptor -> release/provenance/installation/reconciliation descriptors | Project model (`src/project/model.js`) | current (ADR 0073) | Owns pure validation/canonicalization and translation across the Project deployment boundary. Representation-specific content materialization, authorization, durable install/recovery, migration/drift handling, graph export/import and Git effects remain separate future owners. |
| Lagrange Object Environment -> Lagrange Images | `ImageClientAdapter` in `lagrange-object-environment` | external/planned | One cross-repository interaction owner; this repository supplies public image semantics and must not create a competing UI adapter. |
| Beads task/memory -> agent work session | `bd prime` workflow | current/tool-owned | Operational context injection/work discovery; project-specific governance remains in `AGENTS.md`. |

## Ownership change protocol

Before implementing a new major subsystem or interaction:

1. identify the responsibility in the plan/Bead
2. name exactly one owner here
3. identify which existing owner loses or delegates responsibility, if any
4. state the boundary contract/invariants
5. identify the primary proof/tests
6. only then implement

A proposal that says responsibility is `shared`, `co-owned`, `handled on both sides`, or leaves the interaction owner implicit is incomplete.

## Detecting ownership drift

Treat these as defects:

- two services persist competing versions of the same semantic state
- two endpoints independently retry/reconcile the same interaction
- language policy is duplicated in generic execution or storage
- backend adapters start deciding image semantics
- lane-specific executors invent a second invocation/closure/authority model
- two registries select implementations for the same extension point
- a toolchain/provider bypasses the explicit artifact graph and reads ambient image state
- an integration test cannot say which component is responsible for a boundary failure

When drift is found, do not synchronize duplicate implementations. Restore one owner and make the other side consume it.