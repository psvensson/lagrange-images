# Lagrange Images

A persistent image service and language platform built to sit on Lagrange.

An image is a durable graph of objects, code, artifacts and history. It is not a heap dump and it is not a directory of source files. Languages sit on top as personalities; execution representations such as WASM are derived or imported artifacts rather than the identity of the program.

## The model in 30 seconds

```text
projects / tools / REPL / browser
              |
language personalities
Smalltalk | Lisp | Java | Rust | ...
              |
objects + Blocks + artifact graph
              |
execution
neutral | Lagrange WASM | foreign WASM | foreign runtimes
              |
image backend
mock | Lagrange durable/distributed backend
```

Programs are artifact graphs, not source-only pipelines:

```text
source / IR / JAR / runtime image / manifest / lock / package / WASM
                               |
                               v
                      compiler / toolchain
                               |
                               v
                        derived artifacts
```

`dependencies` says what an artifact uses. `derivedFrom` says how an immutable artifact was produced. They are deliberately different graph edges.

## What works today

### Image and language substrate

- stable image/object identity and history
- atomic current-state + history mutation through a shared backend transaction contract
- public-package Lagrange backend over embedded application database sessions
- five-table durable schema with primary-key range routing
- real-package schema/transaction proof and file-backed mapping restart coverage
- tagged Values, refs and pinned refs
- immutable shapes with language behavior kept separate
- immutable CodeArtifacts, LexicalEnvironments and Blocks
- message dispatch and transient activation execution
- executable Symmetric Smalltalk seed with lexical nested Blocks
- mixed Block composition across image-native Smalltalk, foreign WASM and live foreign runtimes

### Image-native compilation and Lagrange WASM

Semantic code is stored as `lagrange-code/v0`. It can currently execute through the reference `neutral-expression/v0` backend or be compiled into Lagrange WASM.

The WASM compiler is deliberately hybrid:

```text
lagrange-code/v0
      |
      +-> lagrange-value-handle/v0
      |      simple/pure/tail-effect path
      |
      `-> lagrange-value-handle-resumable/v1
             only when a host effect is non-tail
```

The established v0 ABI remains the small fast path. If compilation fails specifically because a message send or nested Block creation occurs in non-tail position, the compiler emits the resumable v1 ABI instead. Other compile errors remain errors; there is no silent neutral-executor fallback.

The resumable ABI uses compiler-generated WASM resume entries. At a non-tail host effect the compiled function yields an explicit request plus the activation-local Value handles needed later. The host performs the ordinary effect, puts the returned canonical Value into the same `ValueHandleArena`, and re-enters the same leased WASM instance through the resume entry. Resume entries and saved handles are transient execution machinery, not durable Blocks or continuations.

Implemented WASM machinery includes:

- shared multi-entry modules for compilation groups
- runtime-local compiled-module cache
- explicit `stateless-v0` instance pooling/rebinding
- message-send and nested-Block host effects
- non-tail suspension/resumption and multiple sequential effects
- non-tail nested Block creation in shared modules

The mixed PR32 program now proves backend agreement from the same persistent semantic artifact:

```smalltalk
[ :x | cuis value: (rust value: x value: x) value: x ]
```

For `x = 14`, both neutral execution and resumable Lagrange WASM produce `42`: the inner Rust/foreign-WASM Block returns `28`, Lagrange WASM resumes, and the Cuis Block adds the original `14`.

### Artifact/toolchain graph

- explicit role-tagged artifact dependencies
- generic `ToolchainProviderRegistry` / `ToolchainService`
- provider-opt-in deterministic result reuse
- digest-pinned Docker/Podman-style OCI build runner
- Cargo/rustc provider without implementing a Rust compiler
- explicit Cargo manifest/lock/source artifacts
- explicit vendored Cargo config/files with checksum validation
- OpenSmalltalkVM/Cuis toolchain provider using the real Smalltalk compiler/package loader
- explicit Cuis build/image/changes/sources/package artifact conventions
- raw external WASM stored as `wasm-binary/v1`

The Cuis toolchain path is artifact-first:

```text
smalltalk/cuis-build-v1
   +-> base .image
   +-> base .changes / .sources
   `-> ordered .pck.st packages
          |
          v
OpenSmalltalkVM + real Cuis tooling
          |
          +-> derived .image
          `-> derived .changes
```

The VM executable path is deployment machinery. Its stable version is provider identity; the compiler-bearing base Cuis image is an explicit build input. The first Cuis snapshot provider does **not** opt into deterministic result reuse because closed inputs do not by themselves prove byte-identical snapshots.

### Foreign runtime lifecycle and callable Blocks

Long-lived external runtimes have a language-neutral transient lifecycle:

```text
ForeignRuntimeProviderRegistry
        -> ForeignRuntimeService
        -> start -> many calls -> stop
```

Durable runtime definitions sit above that lifecycle:

```text
runtime-definition CodeArtifact
        -> explicit artifact graph
        -> runtime-local definition/provider binding
        -> lazy transient runtime instance
```

Provider selection is deployment state, not durable program identity. The first concrete definition is `smalltalk/cuis-runtime-definition-v1`.

Foreign-runtime services are ordinary Blocks:

```text
Block
  -> foreign-runtime-callable-interface/v1
       -> runtime-definition artifact
            -> lazy/reused transient runtime
```

`ForeignRuntimeDefinitionInstanceCache` coalesces concurrent first use and reuses one live instance. `runtime.close()` still owns normal shutdown.

The first real provider is OpenSmalltalkVM + Cuis. `createArtifactBackedOpenSmalltalkCuisProvider()` materializes a durable definition privately and delegates to the same narrow Cuis bridge used by the configured-image proof. Host paths never become durable identity.

The unchanged-package proof uses upstream `JSON.pck.st`. The real toolchain derives a new Cuis image containing JSON, and the artifact-backed runtime launches that derived image **without reinstalling the package**.

The bridge protocol, `lagrange-cuis-stdio/v0`, remains deliberately narrow. It exports named proof services such as `proof/add`, recursive `proof/factorial` and package-backed `json/package-proof`; it is not remote Smalltalk eval or arbitrary `perform:`.

A separate PR-only CI job downloads and verifies the pinned OpenSmalltalkVM 2026.06 Linux x64 Cog/Spur runtime, Cuis 7.9-8090 image and pinned upstream JSON package. It now proves the toolchain-produced image and the mixed program through the **resumable Lagrange-WASM** orchestration lane.

### Foreign WASM callable boundary

Raw external WASM is not automatically treated as Lagrange WASM.

```text
wasm-binary/v1
       ^
       | implementation dependency
wasm-callable-interface/v1
       ^
       |
     Block
```

The first ABI, `wasm-scalar-call/v0`, supports one named no-import function over boolean/i32/i64/f32/f64 Values. A callable Block accepts direct invocation (`receiver = null`) or a language-level Block send whose receiver is exactly that Block. Arbitrary foreign receiver semantics remain out of scope.

## Two WASM lanes

### Image-native Lagrange WASM

```text
language semantics
      -> lagrange-code/v0
      -> wasm-module/v1
      -> wasm-function/v1
      -> ActivationExecutor
```

`wasm-module/v1` means a Lagrange-owned Value-handle/effect ABI. It may use the tail-only v0 contract or the resumable v1 contract without changing the semantic artifact or Block identity.

### External/foreign WASM

```text
existing ecosystem / imported binary
      -> external toolchain
      -> wasm-binary/v1
      -> explicit callable/component/runtime interface
      -> ActivationExecutor / later placement
```

`wasm-binary/v1` only means validated external WASM bytes. A callable interface says how those bytes may be invoked. Neither binary nor interface grants authority.

## Existing language ecosystems

Lagrange Images should not grow replacement compilers or runtimes for mature languages merely to support them.

```text
Rust source + Cargo graph
  -> Cargo/rustc in pinned OCI
  -> wasm-binary/v1

Java source + JARs
  -> existing Java/JVM/AOT/WASM tooling
  -> bytecode/WASM/foreign runtime
```

Smalltalk deliberately has two complementary paths:

```text
Symmetric Smalltalk
  -> image-native language designed here

Cuis/Squeak-compatible Smalltalk
  -> OpenSmalltalkVM foreign runtime / toolchain
  -> later optional structured migration or WASM-hosted runtime
```

The compatibility path has now proved a pinned Cuis runtime, unchanged upstream package execution, a real `ToolchainService` build producing a runnable package-bearing image, durable runtime definitions, callable Blocks, and composition from Symmetric Smalltalk alongside foreign WASM.

Compiled libraries and runtime images can remain compiled artifacts when useful. A JAR need not be decompiled; a WASM component need not become source; a compatible Smalltalk runtime image may remain an external runtime artifact.

See ADRs [0022](docs/decisions/0022-opensmalltalkvm-compatibility-direction.md), [0026](docs/decisions/0026-opensmalltalkvm-cuis-toolchain-provider.md), [0027](docs/decisions/0027-artifact-backed-foreign-runtime-definitions.md), [0028](docs/decisions/0028-foreign-runtime-callable-blocks.md), [0029](docs/decisions/0029-mixed-implementation-block-composition.md) and [0030](docs/decisions/0030-resumable-non-tail-wasm-effects.md).

## Deterministic toolchain reuse

External providers opt in explicitly with `cacheKey(request, context)`. The derivation key covers provider identity, target/options and the complete explicit build-relevant artifact graph.

The current cache is conservative: reuse is tied to the same explicit input artifact identities so `derivedFrom` provenance remains truthful. Cross-install content-addressed reuse needs a later installation/provenance wrapper.

## Core invariants

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
runtime definition != running instance
provider handle != ObjectRef
runtime ID != capability
foreign heap != image graph
Spur oop != ObjectRef
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

## Run it

Requires Node.js 22 or newer.

```sh
npm test
npm run demo
npm start
```

The default backend remains the in-memory mock. With `lagrange-server >= 0.1.0`
installed, select the durable backend through configuration or the environment:

```js
import {createRuntime} from 'lagrange-images';

const runtime = await createRuntime({
  backend: {
    mode: 'lagrange',
    configuration: {storage: {dataDir: './data/lagrange-images'}},
  },
});
```

```sh
LAGRANGE_BACKEND=lagrange npm start
```

The adapter uses only `createEmbeddedLagrange()` and
`openApplicationDatabase()` from the public package. Lagrange currently permits
one embedded runtime start per process lifetime, so a stopped runtime is not
restartable in-process. The default namespace labels SQL sessions; it is not a
tenant or authorization boundary.

## Where to read next

Start with [docs/README.md](docs/README.md).

1. [Architecture](docs/architecture.md)
2. [Image model](docs/image-model.md)
3. [Language platform](docs/language-platform.md)
4. [Roadmap](docs/roadmap.md)
5. [Decision index](docs/decisions/README.md)
