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
  later: projects / work / UI objects
```

It is not a VM heap dump. Physical execution layout may change without changing durable identity.

The graph may eventually be distributed across Lagrange, but distribution is placement policy rather than part of object identity.

## 2. Layers

```text
tools / REPL / browser / graphical shell
                    |
language personalities
Smalltalk | Lisp | Java | Rust | ...
                    |
compiler/tooling
artifact graph | toolchain providers | derivation reuse
                    |
execution
Blocks | dispatch | activations | executable interfaces | foreign-runtime service
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

The dependency direction matters. The image graph does not learn Smalltalk classes, Cargo packages, Java JAR semantics or container lifecycles.

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
compiled host module != durable code identity
pooled instance != activation state
```

A ref identifies an object/artifact; capability/principal context controls authority. `CodeArtifact.dependencies` says what an artifact uses, while `derivedFrom` records immutable provenance. Source is only one artifact kind: JARs, manifests, lock files, runtime images and WASM may remain first-class artifacts.

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

Roles are tooling policy, not a platform enum. Examples include Rust source/manifests/vendor files, Cuis image/package/support files, future Java JARs, raw foreign WASM and internal Lagrange WASM artifacts.

## 5. Compilation/toolchain seams

```text
source representation + target
        -> CodeCompilerRegistry

group policy + target
        -> CompilationGroupCompilerRegistry

provider selection ID
        -> ToolchainProviderRegistry
        -> ToolchainService
```

The first two are in-process compiler seams. The third is mechanism-neutral and may run an existing compiler in-process, in WASM, in OCI, natively or remotely.

`ToolchainService` resolves only explicit artifact dependencies and gives providers frozen build-relevant snapshots. Providers do not receive ambient ImageService access. Persisted outputs get explicit input provenance.

Two mature compiler ecosystems now exercise that seam:

```text
Cargo/Rust graph -> Cargo/rustc in OCI -> raw WASM
Cuis build graph -> OpenSmalltalkVM + Cuis -> derived runnable image
```

## 6. Deterministic toolchain reuse

A provider is cacheable only if it explicitly implements `cacheKey(request, context)`. The derivation key covers provider selection/identity/protocol, ordered roots, complete build-relevant artifact snapshots, target/options and provider-specific material.

Multi-output results are cached as complete sets. The current cache intentionally includes input artifact identities so a reused output keeps truthful `derivedFrom` provenance.

The Cargo provider opts in. The first Cuis snapshot provider deliberately does not: all inputs are closed, but byte-level Smalltalk snapshot determinism has not yet been proven.

## 7. Two WASM execution lanes

### Image-native Lagrange WASM

```text
language meaning
   -> lagrange-code/v0
   -> wasm-module/v1
   -> wasm-function/v1
   -> ActivationExecutor
```

This path uses `lagrange-value-handle/v0`, explicit host effects, shared multi-entry modules, a runtime-local compiled-module cache and opt-in stateless instance pooling.

### Foreign/external WASM

```text
existing language ecosystem or runtime port
   -> external compiler/toolchain
   -> wasm-binary/v1
   -> explicit callable/component/runtime interface
   -> ActivationExecutor / later placement
```

`wasm-binary/v1` does not imply the Lagrange Value-handle ABI.

## 8. First foreign callable interface

```text
Block
  -> wasm-callable-interface/v1
       dependency(implementation)
          -> wasm-binary/v1
```

The first ABI, `wasm-scalar-call/v0`, is a no-import synchronous free-function boundary over boolean/i32/i64/f32/f64 Values. Foreign modules are compiled once per runtime but instantiated fresh per activation. Interface identity is not authority.

## 9. Cargo/rustc external compiler ecosystem

```text
Cargo.toml + Cargo.lock + source + explicit vendor artifacts
          -> ToolchainService
          -> Cargo/rustc in digest-pinned OCI
          -> wasm-binary/v1
```

Builds stay closed-input (`cargo build --frozen`, OCI network disabled), and deterministic calls may reuse persisted results.

## 10. OpenSmalltalkVM/Cuis external compiler ecosystem

The compatible Smalltalk path now uses the real Cuis environment as both runtime and toolchain, through separate generic contracts.

Toolchain input representations:

```text
smalltalk/cuis-build-v1
smalltalk/cuis-image-v1
smalltalk/cuis-changes-v1
smalltalk/cuis-sources-v1
smalltalk/cuis-package-v1
```

A build root explicitly depends on one base image, optional matching changes/sources support files and ordered packages:

```text
build
  +-> base-image
  +-> base-changes
  +-> base-sources
  `-> package ...
        |
        v
ToolchainService
        |
        v
OpenSmalltalkVM + real Cuis package/compiler machinery
        |
        +-> derived image
        `-> derived changes
```

The VM executable path is transient host installation state. `vmIdentity` determines provider identity. The compiler-bearing base Cuis image remains an explicit input, so changing it changes the build graph rather than silently changing provider behavior.

The derived image keeps the unchanged base sources artifact as an explicit dependency. Real CI then launches the derived image without reinstalling the package and requires package code to run.

See ADR 0026.

## 11. Language personalities

A language personality owns syntax, lookup, exceptions/conditions, package conventions and compiler/runtime adapters—not image storage mechanics.

Symmetric Smalltalk owns its compiler because the language is designed here. Rust reuses Cargo/rustc. Java should reuse JVM/AOT/WASM tooling. Mature Smalltalk compatibility reuses OpenSmalltalkVM and Cuis tooling.

## 12. Smalltalk: native language plus compatibility ecosystem

```text
                         Smalltalk
                            |
              +-------------+-------------+
              |                           |
              v                           v
      Symmetric Smalltalk          Cuis/Squeak compatibility
      image-native model                  |
              |                           v
              |                    OpenSmalltalkVM
              |                           |
              +-------------+-------------+
                            |
                            v
                  shared project/artifact
                     infrastructure
```

OpenSmalltalkVM/Cuis now has three concrete/intended roles:

1. **foreign runtime** — implemented; run real compatible images/packages behind explicit interfaces;
2. **toolchain host** — implemented for explicit base-image/support/package graphs producing runnable derived images;
3. **migration/bootstrap engine** — next; export classes/methods/packages so selected code can later be represented or compiled natively.

Compatibility is not a forced migration. The OpenSmalltalk heap remains its own object memory and runtime oops never become durable ObjectRefs.

A longer-term target is an interpreter-style OpenSmalltalk/Spur runtime compiled to WASM. That is separate from the current native compatibility/toolchain proofs.

See ADRs 0022, 0025 and 0026.

## 13. Foreign runtime lifecycle

Long-lived external runtimes use a separate transient execution seam from toolchains:

```text
ForeignRuntimeProviderRegistry
          -> ForeignRuntimeService
          -> start(spec)
          -> call(runtimeId, interface, Values)
          -> stop(runtimeId)
```

The protocol is `lagrange-foreign-runtime-provider/v0`. Provider selection and stable provider identity are separate. `ForeignRuntimeService` owns runtime-local UUIDs while provider process/transport/VM handles remain private.

Provider-specific start/interface data is frozen plain data. Calls accept and return canonical Values. `stop()` rejects new calls, waits for accepted calls, then invokes provider shutdown. `createRuntime.close()` owns normal foreign-runtime shutdown before backend shutdown.

See ADR 0023.

## 14. Real foreign runtime: OpenSmalltalkVM + Cuis

`createOpenSmalltalkCuisProvider()` is the first real consumer of that lifecycle:

```text
ForeignRuntimeService
   -> smalltalk/opensmalltalk-cuis
   -> local headless OpenSmalltalkVM process
   -> pinned Cuis image
   -> provider bridge
   -> optional explicit Cuis packages
   -> canonical Value
```

The provider launches without a shell using the current headless Cuis convention:

```text
-vm-sound-null -vm-display-null <image> -s <bridge-script>
```

Its stable identity is derived from explicit upstream VM/image identities rather than local paths. A runtime-private `LineProcessRunner` manages the child process and line-framed stdin/stdout protocol.

The bridge, `lagrange-cuis-stdio/v0`, is deliberately whitelisted. Current proof services include `proof/add`, `proof/factorial` and package-backed `json/package-proof`. It transports only integer/boolean tagged Values and exposes no arbitrary `perform:`, source eval or oop lookup.

A dedicated PR-only CI job downloads a SHA-256-pinned OpenSmalltalkVM 2026.06 Linux x64 Cog/Spur archive, a commit/blob-pinned Cuis 7.9-8090 image and the pinned upstream JSON package. It proves both live package execution and a toolchain-produced derived image containing that package.

See ADRs 0024 and 0025.

## 15. Build process vs foreign-runtime placement

```text
build/toolchain process
  artifacts -> compiler tooling -> derived artifacts -> exits

foreign runtime
  interface/call -> live runtime process -> remains active
```

Cargo currently uses OCI build execution; Cuis currently uses a local shell-free process for both toolchain and runtime proofs. OCI foreign-runtime/toolchain placement remains provider/deployment work. Physical placement does not become generic runtime/toolchain semantics.

## 16. Distribution and capabilities later

A future call may route to local image-native activation, Lagrange WASM, foreign/component WASM, OpenSmalltalkVM/JVM/native runtime, or distributed execution. Location, failure/retry policy and authority remain explicit concerns; not every object send becomes RPC.

## 17. Current frontier

The substrate has now been pressured by:

- a real external compiler producing WASM (Cargo/rustc);
- a real long-lived image runtime (OpenSmalltalkVM/Cuis);
- an unchanged upstream Cuis package;
- the real Cuis compiler/package environment producing a fresh runnable image through `ToolchainService`.

The next high-value steps are:

- a multi-package Cuis dependency graph / larger third-party package;
- structured class/method/package export from OpenSmalltalkVM/Cuis;
- a mixed native/compatible Smalltalk project through explicit interfaces;
- richer Component/WIT-style foreign interfaces;
- standard Cargo package import;
- Java/JAR and Common Lisp ecosystem proofs;
- capability-aware foreign calls;
- OCI/distributed foreign-runtime placement;
- durable Lagrange backend.

See [docs/README.md](README.md) for navigation and [decisions/README.md](decisions/README.md) for topic-grouped ADRs.
