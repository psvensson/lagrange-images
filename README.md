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
interpreter | Lagrange WASM | foreign WASM | foreign runtimes
              |
image backend
mock now | Lagrange durable/distributed backend
```

Programs are also artifact graphs, not source-only pipelines:

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
- tagged Values, refs and pinned refs
- immutable shapes with language behavior kept separate
- immutable CodeArtifacts, LexicalEnvironments and Blocks
- message dispatch and transient activation execution
- executable Symmetric Smalltalk seed with lexical nested Blocks

### Compilation and WASM

- language-neutral semantic `lagrange-code/v0`
- reference `neutral-expression/v0` executor
- Lagrange WASM backend using `lagrange-value-handle/v0`
- shared multi-entry WASM modules for compilation groups
- runtime-local compiled-module cache
- explicit stateless instance pooling/rebinding
- tail message-send and nested-Block effects

### Artifact/toolchain graph

- explicit role-tagged artifact dependencies
- generic `ToolchainProviderRegistry` / `ToolchainService`
- provider-opt-in deterministic result reuse
- digest-pinned Docker/Podman-style OCI build runner
- Cargo/rustc provider without implementing a Rust compiler
- explicit Cargo manifest/lock/source artifacts
- explicit vendored Cargo config/files with checksum validation
- raw external WASM stored as `wasm-binary/v1`

### Foreign WASM callable boundary

Raw external WASM is not automatically treated as Lagrange WASM.

The first callable path is explicit:

```text
wasm-binary/v1
       ^
       | implementation dependency
wasm-callable-interface/v1
       ^
       |
     Block
```

The first ABI is `wasm-scalar-call/v0`:

- one named exported function
- no WASM imports
- no receiver
- no lexical environment
- fresh instance per activation
- scalar parameters/results only: `boolean`, signed `i32`, signed `i64`, `f32`, `f64`

Example shape:

```js
const {block} = await installWasmScalarCallable({
  images: runtime.images,
  wasm: objectRef(imageId, wasmArtifact.id),
  exportName: 'add',
  parameters: ['i32', 'i32'],
  result: 'i32',
});

const activation = await runtime.invocations.invokeBlock(
  objectRef(imageId, block.id),
  [integerValue(2), integerValue(3)],
);

const value = await runtime.executor.execute(activation);
```

This is intentionally small. WASI, strings/memory, callbacks, imported host functions, async operations and capabilities need later explicit ABI contracts.

## Two WASM lanes

This distinction is central.

### Image-native/Lagrange WASM

```text
language semantics
      -> lagrange-code/v0
      -> wasm-module/v1
      -> wasm-function/v1
      -> ActivationExecutor
```

`wasm-module/v1` means the Lagrange Value-handle/import/effect contract.

### External/foreign WASM

```text
existing source/binary ecosystem or runtime port
      -> external toolchain
      -> wasm-binary/v1
      -> explicit callable/component/runtime interface
      -> ActivationExecutor / later placement
```

`wasm-binary/v1` only means validated external WASM bytes. A callable interface says how those bytes may be invoked. Neither the binary nor the interface grants authority.

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

Cuis/Squeak-style compatible Smalltalk
  -> OpenSmalltalkVM foreign runtime / toolchain
  -> later optional structured migration or WASM-hosted runtime
```

OpenSmalltalkVM is the preferred first compatibility path because it lets established Smalltalk code keep using its real runtime/compiler semantics. Its Spur heap remains foreign runtime state rather than becoming the Lagrange image graph.

The long-term goal is coexistence: native Symmetric Smalltalk and OpenSmalltalkVM-backed compatible Smalltalk should share projects, artifacts, interfaces and tools, with selective native migration only where useful.

Compiled libraries and runtime images can remain compiled artifacts when that is the useful canonical form. A JAR does not need to be decompiled; a WASM component does not need to become source; a vendored crate can remain explicit package bytes/files; a compatible Smalltalk runtime image can remain an external runtime artifact.

See [ADR 0022](docs/decisions/0022-opensmalltalkvm-compatibility-direction.md) for the Smalltalk compatibility end state.

## Deterministic toolchain reuse

External providers opt in explicitly with `cacheKey(request, context)`.

The derivation key covers the provider identity, target/options and the complete explicit build-relevant artifact graph. For Cargo that includes manifest, lock, source, config, vendor metadata and every vendor byte plus the pinned OCI image identity.

Repeated compatible builds can therefore return the existing immutable output without rematerializing a workspace or running Docker/Podman/Cargo again.

The current cache is conservative: it reuses against the same explicit artifact identities so `derivedFrom` provenance remains truthful. Cross-install content-addressed reuse needs a later installation/provenance wrapper.

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
foreign heap != image graph
raw foreign WASM != Lagrange WASM ABI
callable interface != authority
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

The default backend is the in-memory mock. `LAGRANGE_BACKEND=lagrange` requires the compatible public `lagrange-server` seam; there is no private-source import fallback.

## Where to read next

Start with [docs/README.md](docs/README.md).

The short path is:

1. [Architecture](docs/architecture.md) — layers and boundaries
2. [Image model](docs/image-model.md) — durable graph records
3. [Language platform](docs/language-platform.md) — how multiple languages fit
4. [Roadmap](docs/roadmap.md) — current frontier and later work
5. [Decision index](docs/decisions/README.md) — ADRs grouped by topic

Useful focused docs:

- [Value/reference/object model](docs/value-model.md)
- [Security boundary](docs/security.md)
- [Lagrange integration](docs/lagrange-integration.md)

The ADRs contain detailed implementation history. The README and main docs describe the current model rather than repeating that chronology.
