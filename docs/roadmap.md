# Roadmap

Ordered so each phase produces something runnable and can falsify the abstractions above it.

## 0. Mock vertical slice — complete

- [x] backend contract and in-memory mock
- [x] image creation, history and snapshots
- [x] backend auto-detection
- [x] HTTP/demo surface
- [x] language registry and Symmetric Smalltalk profile

## 1. Language-neutral graph foundation — complete

- [x] ordinary object refs and pinned historical refs
- [x] tagged scalar Values
- [x] arbitrary-precision integers and exact float bits
- [x] immutable shapes with stable slot IDs
- [x] separate shape and behavior refs
- [x] reject arbitrary JSON object state
- [x] explicit reference walker and cycle tests
- [x] prevent metadata from hiding graph refs
- [x] graph-aware runtime, HTTP surface and demo

Success: an image is an explicit language-neutral graph rather than language-shaped JSON records.

## 2. Durable Lagrange backend

- [ ] settle the public embedding seam with Lagrange
- [ ] map Values/refs/shapes/objects/history to durable schema
- [ ] atomic state + history writes
- [ ] conformance suite shared with mock
- [ ] restart and multi-node durability tests
- [ ] logical snapshot/revision frontiers
- [ ] measure partitioning/index choices on large graphs

Success: the same graph survives process/node restarts with no language/image semantic changes.

## 3. Graph services

- [ ] reachability traversal over backend indexes
- [ ] indexes by shape/project/name where justified
- [ ] revision-aware reads
- [ ] export/import graph format
- [ ] garbage-collection rules respecting history/pinned refs
- [ ] object migration between immutable shapes

## 4. Language-neutral execution, artifacts and compilation kernel

Implemented execution/compiler foundation:

- [x] code artifact contract
- [x] blocks/closures and lexical environments
- [x] message/call dispatch to transient activation requests
- [x] execution of activation requests
- [x] positional receiver/argument/captured-binding calling convention
- [x] pluggable code executor registry
- [x] first executable `neutral-expression/v0` representation
- [x] language-tagged nested message sends from neutral expressions
- [x] explicit `lagrange-code/v0` semantic representation
- [x] code compiler registry and immutable derivation service
- [x] semantic -> neutral-expression lowering
- [x] executable-artifact rebuildability invariant
- [x] `wasm-module/v1` and `wasm-function/v1` artifact contracts
- [x] first `lagrange-code/v0` -> WASM compiler
- [x] `lagrange-value-handle/v0` calling ABI
- [x] Node WebAssembly execution through the normal ActivationExecutor
- [x] interpreter/WASM differential tests
- [x] tail-position WASM message-send host effects through normal dispatch
- [x] tail-position WASM closure materialization through normal Block/LexicalEnvironment semantics
- [x] explicit closure prototype graph edges on `wasm-function/v1`
- [x] automatic recursive WASM compilation/installation of complete nested Block trees
- [x] whole-tree WASM preflight before derived installation writes
- [x] language-neutral transient compilation groups
- [x] compiler-declared derivation identities/cache keys
- [x] language-neutral compilation-group compiler registry/service
- [x] shared physical WASM module containing several compilation-group members
- [x] per-entry signature/effect metadata and separate `wasm-function/v1` identities
- [x] immutable shared-module reuse across independent tree installations
- [x] runtime-local compiled `WebAssembly.Module` cache with concurrent-miss coalescing
- [x] explicit `stateless-v0` WASM instance-reuse contract
- [x] runtime-local stateless instance pool with activation rebinding and failure retirement

Artifact/toolchain generalization:

- [x] bootstrap generic artifact dependency model on immutable CodeArtifacts
- [x] explicit role-tagged artifact dependency refs separate from `derivedFrom` provenance
- [x] graph traversal sees artifact dependencies; old artifacts without the field read as dependency-free
- [x] imported binary/package artifacts can remain canonical binary dependencies instead of requiring source reconstruction
- [x] language-neutral `ToolchainProviderRegistry` and `ToolchainService`
- [x] stable provider identity separate from runtime/configuration provider selection ID
- [x] provider receives frozen explicit root/transitive artifact graph plus target/options, not ambient `ImageService`
- [x] provider may return multiple named output artifacts plus transient diagnostics
- [x] toolchain service owns output provenance and persists every resolved input as `derivedFrom`
- [x] provider-declared runtime/library output dependencies remain separate graph edges
- [x] provider result/dependency preflight before output writes
- [ ] external-toolchain derivation keys include compiler/toolchain identity plus dependency/manifest/lock fingerprints
- [ ] OCI-backed build/toolchain provider using pinned image digest/version
- [ ] native-process or equivalent trusted external-toolchain provider where useful
- [ ] remote build provider if a real deployment needs it
- [ ] callable/interface artifact contract for imported executable libraries/components
- [ ] interface contract keeps exported calls/ABI/capabilities/version separate from authority
- [ ] WASM Component-style imported library/callable boundary
- [ ] dependency-role policy for static/link, dynamic component, foreign runtime, service and build-only dependencies
- [ ] transactional/multi-output artifact installation if real toolchains require sibling output dependencies or atomicity

Execution/compiler follow-ups:

- [ ] reset/reuse contracts for WASM modules with mutable guest state
- [ ] module-size/budget driven splitting of one logical group
- [ ] direct optimized calls between entries in one shared module
- [ ] indexed derivation-key lookup in the durable backend
- [ ] general non-tail asynchronous WASM effects/continuations
- [ ] transient/non-materialized optimized closure representation
- [ ] activations and debugger metadata
- [ ] exception/condition substrate
- [ ] capability-aware host/WASM/foreign-call boundary

Success: source is one artifact representation rather than the platform boundary; the explicit artifact graph can already be handed to a language-neutral provider and turned into derived artifacts with preserved provenance. The next proof is to run a real existing toolchain through this contract rather than changing the image model again.

## 5. Symmetric Smalltalk seed

- [x] first grammar/tokenizer/parser
- [x] unary/binary/keyword message precedence
- [x] outer Block compilation unit and positional parameters
- [x] source -> syntax -> semantic -> executable artifact provenance
- [x] compiler to language-neutral semantic representation
- [x] first image-resident behavior/method lookup convention
- [x] end-to-end compiled message sends through common dispatch/execution
- [x] runtime nested Block creation
- [x] automatic lexical capture analysis with stable binding IDs
- [x] lexical `self` capture across Block boundaries
- [x] ordinary `value*` sends to Blocks through the Smalltalk dispatcher
- [x] tail Smalltalk sends from WASM back into ordinary language dispatch
- [x] returned nested Smalltalk Blocks materialized from WASM with ordinary lexical captures
- [x] complete nested Smalltalk semantic Block trees installable as WASM without manual prototype maps
- [x] nested Block tree functions share one physical WASM module while retaining ordinary Block identity
- [x] sequential nested-Block activations reuse a stateless WASM instance with fresh lexical/Value state
- [ ] create/use a nested Block inside one WASM activation
- [ ] assignments, temporaries, sequences and cascades
- [ ] Object/Behavior/Class/Metaclass bootstrap and inheritance
- [ ] immediate-value objects/primitives
- [ ] REPL/workspace
- [ ] bootstrap image

Success for the current seed: Smalltalk is the first group/reuse-policy consumer and the first in-process compiler, not a constraint on the artifact/toolchain/runtime substrate.

## 6. Projects and collaborative history

- [ ] project objects and relationships
- [ ] code + notes + tests + data + work items
- [ ] first-class project relationships to binary/package/component dependencies
- [ ] manifest and lock artifacts as project members/inputs where applicable
- [ ] branches/working views and object-level diffs
- [ ] merge semantics
- [ ] Git import/export projection for source-oriented views
- [ ] binary/artifact dependency import/export without pretending Git text files are canonical
- [ ] multi-author conflict UI/API

Success: a project can own/edit source where appropriate while also referring explicitly to imported binary libraries, components and reproducible toolchain inputs.

## 7. Languages and compatibility kernels

Smalltalk/Lisp:

- [ ] Cuis source/package importer
- [ ] Smalltalk compatibility library layer
- [ ] prove several useful Cuis libraries
- [ ] Common Lisp personality spike

Rust — next external-toolchain proof:

- [ ] Rust source/manifest/lock artifact conventions using the generic dependency edges
- [ ] OCI-backed Cargo/`rustc` provider over `ToolchainService`, not a new Rust compiler
- [ ] pin toolchain/container identity and include it in reproducible derivation/cache inputs
- [ ] compile one ordinary Cargo project with at least one third-party crate to WASM
- [ ] preserve source/manifest/lock/dependency provenance on the produced WASM artifact
- [ ] Lagrange Rust SDK/crate for explicit host/call interfaces
- [ ] prove reuse of source crates plus at least one portable precompiled WASM/component or stable-ABI dependency
- [ ] document/compiler-test which Rust intermediate/binary formats are only build caches versus stable imported dependencies

Java:

- [ ] Java artifact conventions for source/class/JAR without teaching generic graph storage what Java means
- [ ] Java JAR/class importer and dependency reuse spike
- [ ] Java personality/toolchain spike using existing `javac`/JVM/AOT/Java-to-WASM tooling rather than a new compiler
- [ ] JVM/OCI foreign-runtime compatibility spike
- [ ] compare JVM/OCI compatibility path with deeper Java-to-WASM/image integration on one realistic library/application

Cross-language libraries:

- [ ] WASM Component-style library interface spike callable from two language personalities
- [ ] prove the same imported component can be depended on without exposing implementation-language semantics

Success: mature languages reuse their existing compiler/runtime ecosystems and compiled libraries while gaining image identity/history, project relationships, capabilities and Lagrange execution where useful.

## 8. Distributed and foreign-runtime execution

- [ ] object locator and activation policy
- [ ] capability handles separate from object refs
- [ ] local vs remote send semantics
- [ ] WASM code placement
- [ ] foreign-runtime adapter contract separate from image object identity
- [ ] OCI foreign-runtime lifecycle/placement policy
- [ ] callable routing between image/WASM execution and JVM/native/etc. foreign runtimes
- [ ] explicit failure/retry/idempotency semantics across foreign runtime boundaries
- [ ] capability checks for foreign/runtime/component calls
- [ ] measured `ctx.call()` compute-near-object wins
- [ ] measured tradeoff between foreign-runtime compatibility and WASM/image integration

Success: executable placement can choose image-native/WASM or explicit foreign runtimes without pretending that foreign heaps/processes are automatically image objects.

## 9. Graphical environment

- [ ] drawing/input substrate
- [ ] retained UI objects, widgets and layout
- [ ] surfaces/windows
- [ ] replaceable shell/window-manager policy
- [ ] inspectors, browsers and debugger as image-resident tools

See ADR 0016 for the broader artifact/toolchain/foreign-runtime direction and ADR 0017 for the implemented dependency/provider substrate.
