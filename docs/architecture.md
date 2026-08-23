# Architecture

This document describes the current model. Historical design detail lives in the ADRs.

## 1. One durable graph

An image is a long-lived graph of objects and artifacts with stable identity, state and history.

```text
Image
  Values / refs
  Shapes / objects
  CodeArtifacts
  LexicalEnvironments / Blocks
  roots / history / snapshots
  arbitrary higher-level objects through ordinary shapes/refs
```

It is not a VM heap dump. Physical execution layout may change without changing durable identity. Distribution is placement policy rather than part of object identity.

Project, Perspective and UI semantics are intentionally not image record kinds. They live in [Lagrange Object Environment](https://github.com/psvensson/lagrange-object-environment) and can still be persisted as ordinary image objects. See [object-environment-boundary.md](object-environment-boundary.md).

## 2. Layers

```text
higher-level clients
Object Environment | headless services | alternate tools
                    |
language personalities / client adapters
Smalltalk | Lisp | Java | Rust | ...
                    |
compiler/tooling
artifact graph | toolchain providers | derivation reuse
                    |
execution
Blocks | dispatch | activations | Lagrange WASM | foreign interfaces/runtimes
                    |
image graph
Values | refs | objects | artifacts | history
                    |
backend
mock | Lagrange adapter
                    |
Lagrange
storage / placement / distributed WASM compute
```

The dependency direction matters. The image graph does not learn Smalltalk classes, Cargo packages, Java JAR semantics, Project/Perspective semantics, GUI constructs or container lifecycles.

## 3. Boundaries to protect

```text
shape != behavior
reference != authority
identity != revision
source != artifact boundary
dependency != provenance
semantic code != executable artifact
toolchain selection != toolchain identity
provider cache opt-in != inferred determinism
build OCI != foreign-runtime OCI
foreign runtime lifecycle != toolchain lifecycle
VM path != VM/provider identity
VM identity != compiler-bearing base image
runtime definition != running instance
provider handle != ObjectRef
runtime ID != capability
foreign heap != image graph
Spur oop != ObjectRef
package host path != package identity
package basename != package identity
snapshot bytes != assumed deterministic output
exported service != arbitrary perform:
raw foreign WASM != Lagrange WASM ABI
callable interface != authority
Block self receiver != arbitrary foreign receiver
implementation lane != language-level Block identity
semantic continuation != durable Block
resume entry != public callable interface
saved Value handle != durable Value identity
resumption != retry
compiled host module != durable code identity
pooled instance != activation state
```

A ref identifies an object/artifact; capability/principal context controls authority. `CodeArtifact.dependencies` says what an artifact uses, while `derivedFrom` records immutable provenance.

A JVM, OpenSmalltalkVM or another foreign runtime may own a real heap. That heap does not become durable Lagrange image state merely because the runtime is integrated.

## 4. Durable artifact graph

The generic carrier today is `CodeArtifact`:

```text
CodeArtifact
  representation
  content: Value
  dependencies[]: role + artifact ref
  derivedFrom[]
  metadata
```

Roles are tooling policy, not a platform enum. Source is only one artifact kind: JARs, manifests, lock files, runtime images, packages and WASM may remain first-class artifacts.

## 5. Compilation and toolchain seams

```text
source representation + target
        -> CodeCompilerRegistry

group policy + target
        -> CompilationGroupCompilerRegistry

provider selection ID
        -> ToolchainProviderRegistry
        -> ToolchainService
```

The first two are image-native compiler seams. `ToolchainService` is mechanism-neutral and may reuse an existing compiler in-process, in WASM, in OCI, natively or remotely.

`ToolchainService` resolves only explicit artifact dependencies and gives providers frozen build-relevant snapshots. Providers do not receive ambient `ImageService` access. Persisted outputs get explicit input provenance.

Two mature compiler ecosystems exercise that seam:

```text
Cargo/Rust graph -> Cargo/rustc in OCI -> raw WASM
Cuis build graph -> OpenSmalltalkVM + Cuis -> derived runnable image
```

## 6. Image-native Lagrange WASM

```text
language meaning
   -> lagrange-code/v0
   -> wasm-module/v1
   -> wasm-function/v1
   -> ActivationExecutor
```

The semantic artifact is independent of the physical WASM ABI. The default compiler currently chooses between two internal contracts.

### Tail-only value handles

```text
lagrange-value-handle/v0
```

The established v0 ABI uses invocation-local Value handles, explicit host imports, shared multi-entry modules, a runtime-local compiled-module cache and opt-in `stateless-v0` instance pooling. Message-send and nested-Block effects are allowed when their result is also the activation result.

### Resumable value handles

```text
lagrange-value-handle-resumable/v1
```

If the v0 compiler rejects a program specifically because a send or nested-Block creation is non-tail, the compiler emits resumable v1 instead. Other errors do not trigger fallback.

The compiler splits the semantic expression into WASM segments:

```text
entry
  -> compute effect request
  -> effect import(saved Value handles...)
  -> return reserved handle 0

resume_N(saved handles..., effect-result handle)
  -> continue compiled computation
```

The host keeps the activation-local `ValueHandleArena` alive, unbinds the leased WASM instance while awaiting the host effect, then rebinds it and invokes the compiler-private resume export with the returned Value handle.

Continuation state is explicit and transient. There is no durable WASM stack snapshot, first-class continuation object or hidden graph identity. Several sequential non-tail effects are allowed, with a hard execution resumption bound.

The same hybrid rule applies to shared nested-Block modules. One member requiring resumption moves that physical module to the resumable ABI; semantic entry/Block identity remains unchanged.

See ADR 0030.

## 7. Foreign/external WASM

```text
existing ecosystem or imported binary
   -> external compiler/toolchain
   -> wasm-binary/v1
   -> explicit callable/component/runtime interface
   -> ActivationExecutor / later placement
```

`wasm-binary/v1` does not imply either Lagrange Value-handle ABI.

The first callable interface is:

```text
Block
  -> wasm-callable-interface/v1
       dependency(implementation)
          -> wasm-binary/v1
```

`wasm-scalar-call/v0` is a no-import synchronous free-function boundary over boolean/i32/i64/f32/f64 Values. Foreign modules are compiled once per runtime but instantiated fresh per activation. Interface identity is not authority.

Callable Blocks accept direct `invokeBlock()` or a language-level Block application whose receiver is exactly that Block. Arbitrary receiver semantics remain invalid.

## 8. Mixed implementation composition

The execution model now proves that implementation lane is below language-level Block identity.

Symmetric Smalltalk captures two ordinary Block refs:

```text
rust Block -> wasm-callable-interface/v1 -> wasm-binary/v1
cuis Block -> foreign-runtime-callable-interface/v1 -> Cuis runtime definition
```

and evaluates:

```smalltalk
[ :x | cuis value: (rust value: x value: x) value: x ]
```

For `x = 14`, foreign WASM returns 28 and Cuis returns 42. The Smalltalk source knows neither implementation lane.

PR33 compiles that **same persistent semantic artifact** into a resumable `wasm-function/v1`. Both the neutral executor and the Lagrange-WASM executor must produce the same canonical Values. The real PR-only integration proof runs the WASM orchestration against a toolchain-produced Cuis image.

See ADRs 0029 and 0030.

## 9. Deterministic compilation/toolchain reuse

An internal compiler/toolchain provider is cacheable only when it explicitly supplies derivation-key material. The key covers compiler/provider identity and complete build-relevant inputs.

The Cargo provider opts in. The first Cuis snapshot provider deliberately does not: all inputs are closed, but byte-level snapshot determinism has not yet been proven.

The Lagrange-WASM compiler identity is versioned. The v3 hybrid compiler includes the choice of the tail-only or resumable ABI in the immutable derived module metadata.

## 10. OpenSmalltalkVM/Cuis ecosystem

Compatible Smalltalk uses the real Cuis environment as both runtime and toolchain, through separate generic contracts.

Toolchain representations include:

```text
smalltalk/cuis-build-v1
smalltalk/cuis-image-v1
smalltalk/cuis-changes-v1
smalltalk/cuis-sources-v1
smalltalk/cuis-package-v1
```

A build root explicitly depends on its base image/support files/packages, and `ToolchainService` produces a derived `.image` + `.changes` pair. The VM executable path is transient host installation state; the compiler-bearing image is explicit durable input.

Real CI launches the derived image without reinstalling the upstream JSON package and requires package code to execute.

## 11. Foreign runtime lifecycle

Long-lived external runtimes remain separate from build/toolchain processes:

```text
ForeignRuntimeProviderRegistry
          -> ForeignRuntimeService
          -> start(spec)
          -> call(runtimeId, interface, Values)
          -> stop(runtimeId)
```

Provider handles and runtime IDs are transient. `runtime.close()` owns normal shutdown.

A durable definition describes what should run:

```text
runtime-definition CodeArtifact
        -> explicit artifact dependency closure
        -> runtime-local provider binding
        -> transient runtime instance
```

`ForeignRuntimeDefinitionService` resolves only `dependencies`, not `derivedFrom`. Provider selection stays runtime-local.

A service may then be persisted as `foreign-runtime-callable-interface/v1` and installed as an ordinary Block. The runtime-local instance cache starts lazily, coalesces concurrent first use and reuses the live instance.

## 12. Real foreign runtime: OpenSmalltalkVM + Cuis

```text
smalltalk/cuis-runtime-definition-v1
   -> artifact-backed provider
   -> local headless OpenSmalltalkVM
   -> pinned/derived Cuis image
   -> narrow provider bridge
   -> canonical Value
```

The bridge `lagrange-cuis-stdio/v0` is deliberately whitelisted. Current proof services include `proof/add`, `proof/factorial` and package-backed `json/package-proof`. It exposes no arbitrary `perform:`, source eval or oop lookup.

A dedicated PR-only CI job downloads pinned OpenSmalltalkVM/Cuis/package inputs and proves toolchain, package, callable-runtime and mixed resumable-WASM execution together.

## 13. Language personalities

A language personality owns syntax, lookup, conditions/exceptions, package conventions and compiler/runtime adapters—not image storage mechanics or Object Environment presentation semantics.

Symmetric Smalltalk owns its compiler because the language is designed here. Rust reuses Cargo/rustc. Java should reuse JVM/AOT/WASM tooling. Mature Smalltalk compatibility reuses OpenSmalltalkVM and Cuis tooling.

Compatibility is not forced migration. OpenSmalltalkVM's Spur heap stays foreign runtime state and runtime oops never become durable `ObjectRef`s.

## 14. Distribution and capabilities later

A future call may route to local image-native activation, distributed Lagrange WASM, foreign/component WASM, OpenSmalltalkVM/JVM/native runtime or another placement target.

Location, failure/retry policy and authority remain explicit concerns. A compiler-generated resumption after a local host effect is **not** a retry, RPC protocol, capability or deployment object.

## 15. Current frontier

The substrate has now been pressured by:

- a real external compiler/toolchain seam producing WASM artifacts;
- a real long-lived image runtime;
- an unchanged upstream Cuis package;
- a toolchain-produced runnable Cuis image;
- durable artifact-backed runtime definitions and callable foreign-runtime Blocks;
- mixed Symmetric Smalltalk composition over foreign WASM and live Cuis;
- the same mixed semantic program running through neutral and resumable Lagrange-WASM execution;
- multiple sequential non-tail WASM effects and non-tail closure creation in shared modules;
- the public Lagrange application-session seam with atomic image state/history,
  real-package compatibility and file-backed mapping restart coverage.

Higher-level Project, collaboration and graphical-environment pressure now belongs in Lagrange Object Environment. Missing generic primitives discovered there should feed back here through the public boundary.

See [docs/README.md](README.md), [object-environment-boundary.md](object-environment-boundary.md) and [decisions/README.md](decisions/README.md).
