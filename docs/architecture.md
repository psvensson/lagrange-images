# Architecture

## Core idea

An image is a long-lived graph of objects with stable identity, code, state and history. It may be active on one machine, spread across a cluster, asleep, snapshotted, branched or inspected without changing what an object is.

The architecture separates five concerns:

1. image semantics — values, identity, refs, shapes, roots, history, snapshots, projects
2. language semantics — behavior, syntax, language-specific meaning, debugging, compatibility layers
3. compiler/tooling substrate — artifacts, dependencies, grouping policy, toolchains, derivation/reuse, executable representations
4. execution — dispatch, activations, scheduling, local/remote execution, capability context
5. substrate — durable records, transactions, placement, replication and compute

Only the fifth layer should know it is running on Lagrange. Compiler grouping, artifact kinds and toolchain execution must not assume a particular source language.

## Layers

```text
tools / REPL / browser / graphical shell / HTTP
                    |
language personalities: Smalltalk | Lisp | Java | Rust | ...
                    |
compiler/tooling substrate: artifact graph | groups | toolchains | derivation cache
                    |
language-neutral runtime: callables/Blocks | dispatch | activations
                    |
image graph: Values | refs | shapes | objects | history | roots
                    |
backend contract: mock | Lagrange adapter
                    |
Lagrange: distributed data + WASM compute
```

A language may skip or specialize parts of this stack. Rust does not need Smalltalk lookup semantics; Java may have its own class/interface dispatch; Lisp may retain macro-expanded semantic artifacts. They can still share artifact identity/history, compilation groups, external toolchain orchestration, executable-artifact reuse, activation infrastructure and WASM backends where useful.

## Boundaries worth protecting

**Shape is not behavior.** Shape describes durable physical slots. Behavior is an optional language/runtime ref. Smalltalk can map behavior to Class/Behavior without teaching storage what a class is.

**Reference is not authority.** A ref identifies an object. Read/mutate/invoke rights come from principal/capability context.

**Identity is not revision.** Ordinary refs name evolving object identities. Pinned refs add historical revision. Backend row versions are concurrency metadata.

**Source is not the artifact boundary.** Source is one important artifact representation, especially when it is the editable meaning the image owns. Bytecode, JARs, WASM components/modules, precompiled libraries, manifests and other imported binary artifacts may also be legitimate durable program/dependency artifacts. The platform must not require source it does not possess.

**Dependency is not provenance.** `CodeArtifact.dependencies` describes role-tagged artifact relationships. `derivedFrom` describes how an immutable result was produced. Build/runtime/library relationships must not be hidden in metadata or overloaded into provenance.

**Semantic code is not executable code.** When editable/semantic meaning exists in the image, interpreters, WASM and future optimized executors are derived products. Removing rebuildable executable artifacts must not erase the program meaning needed to inspect/rebuild them. A third-party binary-only dependency may itself be the canonical artifact we possess rather than rebuildable output.

**Toolchain selection is not toolchain identity.** A runtime/provider ID chooses an implementation. The provider's stable identity names its implementation/version for provenance and future cache equivalence.

**Toolchain is not language semantics.** A Java or Rust personality does not imply that this project implements `javac`, a JVM, `rustc` or Cargo. Language/runtime semantics and project conventions may be integrated while compilation is delegated to an existing in-process, WASM, OCI, native or remote toolchain.

**Compilation group is not a language construct.** The compiler/tooling layer decides whether a useful unit is a Smalltalk Block tree, Lisp compilation unit, Java package/class set, Rust codegen unit or something else. The group does not prescribe one physical module.

**Physical module is not function identity.** Several semantic members may share one `wasm-module/v1`, but each keeps separate semantic provenance, function artifact, Block/callable identity and entry-level effect policy.

**Build container is not foreign runtime.** OCI may host a reproducible compiler/toolchain and disappear after producing artifacts, or it may host a live JVM/native/Python/etc. compatibility runtime. Those are separate integration roles with different identity and lifecycle semantics.

**Reuse is compiler/toolchain-declared.** The substrate only reuses an immutable derived artifact when the compiler/toolchain explicitly provides a stable identity and deterministic cache key. It does not guess equivalence from names or source-language structure.

**Compiled host module is not durable code identity.** A runtime `WebAssembly.Module` is a host-engine cache of one immutable `wasm-module/v1`, not an image object or source of program meaning.

**Pooled instance is not activation state.** A retained `WebAssembly.Instance` is execution machinery only. It may be reused only under an explicit reset/reuse contract, and every activation must receive fresh Value handles, entry/effect permissions, lexical/prototype context and pending-effect state. Language/image state does not live in the idle pool.

## Durable artifact graph

The programming model is a durable **artifact/dependency graph**, not a source-code-only pipeline.

Conceptually:

```text
source -------------------+
semantic / IR ------------+
bytecode / package -------+
precompiled library ------+----> toolchain/provider
WASM component/module ----+            |
manifest / lock / config -+            v
                                    derived artifacts
                                    + callable interfaces
```

`CodeArtifact` is currently the bootstrap generic artifact carrier. It has explicit role-tagged dependency edges:

```text
CodeArtifact
  representation
  content
  dependencies:
    role
    artifact ref
  derivedFrom
  metadata
```

Dependency roles belong to language/tooling policy rather than the generic graph. The image substrate does not interpret `library`, `manifest`, `lock`, `runtime`, `build` or similar roles.

The graph should record what we actually possess. An editable source crate can remain canonical source with derived executable caches; an imported third-party JAR may remain a JAR dependency; an imported WASM component may remain the portable component itself.

Dependency participation is tooling policy rather than generic identity. A dependency may be static/link-time, dynamic/component-based, foreign-runtime-based, service-based or build-only.

## Compiler and toolchain substrate

There are now three related compiler/toolchain seams:

```text
source representation + target
  -> CodeCompilerRegistry

group policy + target
  -> CompilationGroupCompilerRegistry

provider selection ID
  -> ToolchainProviderRegistry
  -> ToolchainService
```

The first two feed `CompilationService` and already use compiler-declared derivation reuse.

`ToolchainService` is the first external-toolchain orchestration contract. It accepts root artifact refs, resolves only their explicit transitive `dependencies`, and passes frozen snapshots to the selected provider together with target/options.

The generic v0 provider request deliberately has no `ImageService` or ambient artifact reader. A provider should consume the declared graph it was given rather than quietly fetch hidden inputs.

A provider returns one or more named output artifact descriptions plus transient diagnostics. `ToolchainService` owns persistence/provenance:

```text
resolved input graph
  -> provider.run(...)
  -> output descriptions
  -> CodeArtifacts
       derivedFrom = every resolved input
       dependencies = provider-declared output dependencies
       metadata includes provider selection/identity/protocol
```

This preserves the distinction between build provenance and runtime/library relationships.

The current provider implementation is mechanism-neutral but the repository only proves it with an in-process provider. OCI/native/remote execution providers are still follow-up work.

For mature languages the normal expectation is to reuse their existing toolchains. Rust support should normally orchestrate Cargo/`rustc`; Java support should normally orchestrate existing Java/JVM/AOT/WASM tooling. The image owns artifact identity/history and the integration contract, not a replacement compiler ecosystem.

A group compiler may emit one executable artifact containing several entries. The first implementation maps one nested WASM tree group to one multi-function `wasm-module/v1`; this is policy, not a generic requirement.

The built-in WASM compiler also declares the current `stateless-v0` instance-reuse contract. That declaration is a compiler/runtime promise about generated guest state, not a property of Smalltalk or of compilation groups in general.

### Toolchain provenance and future reuse

Toolchain output currently preserves the resolved artifact graph as explicit `derivedFrom` edges and records provider ID/identity/protocol in non-reference metadata.

`ToolchainService` does not yet cache results. A later derivation key must include every declared input that can change output, including provider/toolchain identity, target/options, dependency fingerprints, manifest/lock artifacts and OCI image digest/version when an OCI build provider is used.

Diagnostics are transient in v0. Multi-output toolchain calls support several independent outputs, but not sibling output-to-output dependency refs or atomic whole-invocation persistence yet.

## OCI integration roles

OCI has two useful but distinct positions in this architecture.

### Build/toolchain OCI

```text
artifact inputs
  -> compiler/package manager in OCI
  -> derived WASM / bytecode / native artifacts
```

The OCI image is reproducible build machinery. A toolchain cache/provenance key should include the relevant image digest/version and all other declared inputs that affect output.

### Foreign-runtime OCI

```text
image callable/interface
  -> foreign-runtime adapter
  -> live OCI JVM / native runtime / Python / ...
```

This is a compatibility layer, not deep image integration. Objects in the foreign runtime heap are not automatically durable image objects. An explicit callable/interface boundary, capability policy and lifecycle/placement policy are required.

Both modes may coexist for a language: Java could use JVM/OCI for maximum compatibility and Java-to-WASM/AOT for code that benefits from deeper image/Lagrange execution.

## Compiled libraries and interfaces

Precompiled libraries should be reusable when their format/runtime/ABI permits it.

A Java personality should be able to retain JAR/class dependencies as byte artifacts rather than decompile/rewrite them. Rust should normally favor source crates or portable/stable outputs, while compiler-private intermediate formats remain build-cache material tied to compiler/target details. WASM components are especially attractive as cross-language library boundaries.

Imported executable artifacts need explicit callable/interface descriptions before image code invokes them. The eventual interface contract should name exports/callables, argument/result representation, ABI/component contract, required host capabilities and version/provenance. Interface description remains separate from authority.

The WASM Component Model/WIT-style boundary is a good fit for these outer library/foreign-language interfaces; it should not be imposed on every internal Smalltalk send.

## Unified graph identity

Shape and object records share one `(imageId, objectId)` namespace. Refs therefore do not encode backend collection/type routing. Shapes are the bootstrap record kind needed to describe object layout without a meta-shape regress.

## Portable vs execution representation

The durable graph format is explicit and inspectable, but does not dictate runtime layout. A compiler/WASM layer may use unboxed values, tagged words, local handles, eliminated closures and direct calls while preserving graph semantics.

Likewise, two language/image installations may share one immutable compiled module without sharing their function, Block or object identity. One runtime may also reuse a compiled host module or a proven-stateless host instance without making either object durable language state.

## Runtime execution caches

The current WASM executor has two runtime-local reuse layers:

```text
wasm-module/v1
  -> WasmModuleCache -> WebAssembly.Module
  -> WasmInstancePool -> reusable WebAssembly.Instance (only when explicitly allowed)
```

The module cache is safe by immutable artifact identity. Instance pooling is stricter and requires a supported `metadata.instanceReuse` contract.

The current `stateless-v0` path rebinds activation-local imports before a synchronous entry call, unbinds them immediately after a clean result/tail-effect boundary, and retires an instance after traps or host-boundary contract failures.

These caches/pools are not durable graph records and are not replicated image state.

## Backend contract

The mock boundary remains intentionally small: lifecycle, get/put with optimistic version, scan, and append/read history. It exists so image semantics can progress before the Lagrange mapping is settled; it must not grow into a second database API.

Current compiler derivation-cache lookup scans CodeArtifacts. A durable backend can index compiler/toolchain identity + derivation key later without changing compilation semantics.

## Active execution later

```text
message/call
    |
receiver + capability context
    |
object locator / foreign-runtime adapter
    |---- local optimized activation
    |---- WASM/component activation
    |---- foreign OCI runtime
    |
    +---- distributed activation ----> ctx.call / placed WASM
```

Not every object send becomes RPC and not every foreign call becomes an image object send. Distribution and foreign-runtime placement remain runtime policy with explicit failure and authority semantics.

Projects should be object graphs with Git/files as interoperability projections. Project graphs should eventually relate source, binary dependencies, manifests, notes, tests and work items without forcing every dependency into source form. The graphical system should follow the same layering: drawing/input substrate, widgets/surfaces, then replaceable shell/window-manager policy.

See ADR 0016 for the broad artifact/toolchain/foreign-runtime direction and ADR 0017 for the implemented dependency/provider substrate.
