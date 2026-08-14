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
Blocks | dispatch | activations | executable interfaces
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
build OCI != foreign-runtime OCI
raw foreign WASM != Lagrange WASM ABI
callable interface != authority
compiled host module != durable code identity
pooled instance != activation state
```

### Reference is not authority

A ref says which object/artifact. Capability or principal context says whether the caller may read, mutate or invoke it.

### Dependency is not provenance

A CodeArtifact has two different kinds of graph edge:

```text
dependencies[]   what this artifact uses

derivedFrom[]   which immutable inputs produced this artifact
```

Neither belongs hidden in metadata.

### Source is not the platform boundary

Source is one artifact kind. JARs, manifests, lock files, vendored packages, WASM and other imported binaries can be first-class graph artifacts too.

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

Roles are tooling policy, not a platform enum.

Examples:

```text
rust/cargo-manifest-v1
rust/cargo-lock-v1
rust/source-v1
rust/cargo-vendor-file-v1
java/jar-v1                    # future convention
wasm-binary/v1
wasm-callable-interface/v1
wasm-module/v1
wasm-function/v1
```

The same graph machinery handles all of them; language/toolchain adapters interpret their representations.

## 5. Three compilation/toolchain seams

```text
source representation + target
        -> CodeCompilerRegistry

group policy + target
        -> CompilationGroupCompilerRegistry

provider selection ID
        -> ToolchainProviderRegistry
        -> ToolchainService
```

The first two are in-process compiler seams. The third is mechanism-neutral and can run an existing toolchain in-process, in WASM, in OCI, natively or remotely.

`ToolchainService` resolves only explicit artifact dependencies and gives the provider frozen build-relevant snapshots. The provider receives no ambient ImageService.

```text
explicit input graph
      -> provider
      -> output descriptions
      -> ToolchainService persists outputs
           derivedFrom = resolved inputs
           dependencies = provider-declared runtime/library edges
```

## 6. Deterministic toolchain reuse

A provider is cacheable only if it explicitly implements:

```js
cacheKey(request, context)
```

The generic derivation key includes:

```text
provider selection + stable identity + protocol
ordered root identities
complete artifact snapshots
  identity
  representation
  content
  dependencies
  metadata
target
options
provider-specific cache material
```

Backend versions, timestamps and old provenance are excluded.

Multi-output results are cached as complete sets. Partial sets are ignored. Cache hits return existing immutable outputs and do not replay transient diagnostics.

The current cache deliberately includes input identities so reused outputs keep truthful `derivedFrom` provenance. Cross-install content-addressed reuse needs a later installation/provenance wrapper.

## 7. The two WASM execution lanes

### A. Image-native Lagrange WASM

```text
language meaning
   -> lagrange-code/v0
   -> wasm-module/v1
   -> wasm-function/v1
   -> ActivationExecutor
```

This path uses `lagrange-value-handle/v0`. Invocation-local i32 handles refer to canonical Values. Host effects such as sends and closure materialization use explicit contracts.

Compilation groups may produce shared physical WASM modules while each semantic member keeps separate function/Block identity.

Runtime reuse has two host-only layers:

```text
wasm-module/v1 -> cached WebAssembly.Module
stateless module -> optionally pooled WebAssembly.Instance
```

Neither is durable image state.

### B. Foreign/external WASM

```text
existing language ecosystem
   -> external compiler/toolchain
   -> wasm-binary/v1
   -> explicit callable/component interface
   -> ActivationExecutor / later distributed placement
```

`wasm-binary/v1` means validated external WASM bytes. It does not imply the Lagrange Value-handle ABI.

## 8. First foreign callable interface

The first executable foreign-WASM boundary is:

```text
Block
  -> wasm-callable-interface/v1
       dependency(implementation)
          -> wasm-binary/v1
```

One implementation binary may later have several interface artifacts for several exports/contracts.

The first ABI is `wasm-scalar-call/v0`:

```text
export: named function
parameters/result:
  boolean | i32 | i64 | f32 | f64
receiver: none
environment: none
imports: none
instance lifetime: one fresh instance per activation
```

The executor compiles immutable `wasm-binary/v1` once per runtime, but instantiates a fresh guest instance for every activation. That avoids assuming that arbitrary foreign guest memory/globals are reset-safe.

No-imports is important: v0 cannot silently acquire WASI, filesystem, network, callbacks or another host capability. Those require new explicit ABI/interface contracts.

The interface artifact describes invocation shape. It is not authority.

## 9. Cargo/rustc as the first external ecosystem

Rust proves that mature languages can reuse their own compilers:

```text
Cargo.toml + Cargo.lock + source + optional explicit vendor artifacts
          -> ToolchainService
          -> Cargo/rustc in digest-pinned OCI
          -> wasm-binary/v1
```

Builds stay closed-input:

```text
cargo build --frozen
OCI network = none
```

Vendored registry-style packages are explicit graph artifacts. The provider validates package file sets and SHA-256 checksums before starting OCI.

The build container is compiler machinery and disappears afterward. That is separate from a future live OCI foreign runtime.

## 10. Language personalities

A language personality owns language semantics, not storage/toolchain mechanism.

It may provide:

```text
parser / editor conventions
semantic objects and dispatch
package/project conventions
existing-toolchain adapter
compiled-library adapter
foreign-runtime adapter
```

Symmetric Smalltalk currently owns its compiler because the language itself is being designed here. Rust should use Cargo/rustc. Java should reuse Java/JVM/AOT/WASM tooling. Common Lisp can reuse its own compiler/runtime semantics above the common graph.

## 11. Distribution and capabilities later

The future execution decision can look like:

```text
call
 |
callable/interface + capability context
 |
runtime placement policy
 |---- local image-native activation
 |---- Lagrange WASM activation
 |---- foreign/component WASM activation
 |---- foreign OCI runtime
 `---- distributed activation via Lagrange
```

Not every object send becomes RPC. Not every foreign call becomes an object message. Location, failure/retry policy and authority remain explicit runtime concerns.

## 12. Current frontier

Implemented substrate now reaches from durable source/package artifacts through existing Cargo/rustc tooling to reusable raw WASM and a first explicit callable interface.

The next architectural pressure points are:

- richer foreign-WASM/component ABIs: strings, memory, records and WASI-like capabilities
- WASM Component/WIT-style interfaces
- standard Cargo `.crate` importer
- real pinned-OCI integration fixture
- Java/JAR and Common Lisp ecosystem proofs
- capability-aware foreign calls
- durable Lagrange backend and distributed placement

See [docs/README.md](README.md) for the documentation map and [decisions/README.md](decisions/README.md) for topic-grouped ADRs.
