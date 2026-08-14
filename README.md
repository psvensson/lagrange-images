# Lagrange Images

A persistent image service and language platform built to sit on Lagrange.

An image is a durable object graph, not a VM memory dump and not a pile of source files. Languages are personalities over that graph. Program meaning is kept separately from derived execution artifacts so interpreters, WASM and future optimized runtimes can change without changing image semantics.

The programming model is also **not source-code-only**: source, bytecode/packages, precompiled libraries, WASM components/modules, manifests and other imported artifacts can participate in one durable dependency graph. Mature languages should normally reuse their existing compilers/package managers/runtimes through explicit toolchain adapters rather than require new compilers implemented here.

## What is here now

- stable image and object identities
- canonical tagged scalar Values and ordinary/pinned refs
- immutable shapes plus generic objects with separate physical shape and language behavior
- immutable CodeArtifacts, versioned LexicalEnvironments and durable Blocks
- explicit role-tagged CodeArtifact dependency edges separate from `derivedFrom` provenance
- graph traversal of artifact dependencies/provenance
- generic `ToolchainProviderRegistry` / `ToolchainService`
- frozen transitive artifact-graph requests for toolchain providers
- multi-output toolchain results persisted with automatic input provenance and transient diagnostics
- transient message dispatch and activation requests
- single-artifact and grouped compiler registries/services
- language-neutral transient compilation groups
- compiler-declared derivation keys and immutable executable reuse
- language-neutral `lagrange-code/v0` semantic code
- `neutral-expression/v0` reference interpreter
- real `lagrange-code/v0 -> wasm-module/v1` backend
- multi-function shared WASM modules for compilation groups
- runtime-local compiled `WebAssembly.Module` cache
- explicit `stateless-v0` WASM instance-reuse contract and runtime-local instance pool
- `lagrange-value-handle/v0` WASM calling ABI
- WASM tail message sends through normal language dispatch
- WASM tail nested-Block materialization with ordinary lexical captures
- automatic recursive WASM installation of complete nested Block trees
- shared-module reuse across equivalent independent tree installations
- `wasm-function/v1` execution through the normal ActivationExecutor
- executable Symmetric Smalltalk parser/compiler/dispatcher with nested lexical Blocks
- reference walking, optimistic versions, history and snapshots
- in-memory mock backend plus optional `lagrange-server` probing

Planned, not implemented yet, includes OCI/native/remote toolchain execution providers, toolchain derivation caching, Cargo/rustc and Java/JAR adapters, WASM Component callable interfaces and explicit OCI foreign-runtime adapters.

Core invariants:

```text
shape != behavior
reference != authority
identity != revision
source != artifact boundary
dependency != provenance
semantic code != executable artifact
toolchain selection != toolchain identity
toolchain provider != language semantics
build OCI != foreign-runtime OCI
WASM handle != image identity
compilation group != source-language construct
shared module != function/Block identity
compiled host module != durable module identity
pooled instance != activation state
```

## Run it

Requires Node.js 22 or newer.

```sh
npm test
npm run demo
npm start
```

## Symmetric Smalltalk seed

The language runs through the common image/dispatch/execution substrate rather than a separate Smalltalk VM. Nested Blocks automatically capture free lexical bindings by stable binding ID; `self` is captured lexically when it crosses a Block boundary.

Compilation preserves separate immutable artifacts:

```text
Smalltalk source
  -> Smalltalk syntax
  -> lagrange-code/v0 semantic code
       |-> neutral-expression/v0
       `-> WASM derived execution
  -> Block
```

The executable forms are derived state. Runtime closures still materialize as ordinary `Block + LexicalEnvironment` records regardless of whether their code entry is interpreted or lives in a shared WASM module.

## Artifact graph and toolchains

`CodeArtifact` is currently the bootstrap generic artifact carrier. It now has explicit dependency edges:

```js
{
  representation: 'example/source-v1',
  content: textValue('...'),
  dependencies: [
    {role: 'manifest', artifact: objectRef(imageId, manifestId)},
    {role: 'library', artifact: objectRef(imageId, libraryId)},
  ],
  derivedFrom: [],
}
```

`dependencies` means package/build/runtime relationships. `derivedFrom` means immutable provenance. Both are real graph edges; neither belongs hidden in metadata.

Roles are compiler/tooling policy rather than a platform enum. Imported JARs, manifests, lock data, WASM modules/components and other binary artifacts can therefore remain artifacts in their own representations instead of being converted to source.

### Generic toolchain provider contract

The first generic provider substrate is implemented now:

```js
const runtime = await createRuntime({
  backend: {mode: 'mock'},
  toolchainProviders: [['example/default', {
    identity: 'example-toolchain/v1',
    async run(request) {
      // request.roots / request.artifacts are frozen artifact snapshots.
      return {
        outputs: [{
          name: 'module',
          representation: 'example/executable-v1',
          content: textValue('compiled'),
        }],
        diagnostics: [],
      };
    },
  }]],
});

const result = await runtime.toolchains.run({
  providerId: 'example/default',
  imageId,
  roots: [objectRef(imageId, sourceId)],
  target: {representation: 'example/executable-v1'},
  options: {optimize: true},
});
```

`ToolchainService` resolves the transitive explicit dependency graph, deduplicates shared dependencies and passes frozen snapshots to the provider. The provider does not receive `ImageService`, so the generic contract does not encourage undeclared artifact reads.

Every persisted output automatically gets all resolved input artifacts as `derivedFrom` provenance. A provider may separately declare output dependencies such as runtime libraries. Diagnostics are returned to the caller but remain transient.

Selection and implementation identity are distinct:

```text
providerId          example/default
provider.identity   example-toolchain/v1
```

The first protocol is `lagrange-toolchain-provider/v0`.

This PR does **not** yet run external processes or containers. The next intended proof is an OCI-backed Cargo/rustc provider over this same substrate.

### Existing language ecosystems

For mature languages the expected approach remains to reuse their ecosystems:

```text
Rust source + Cargo metadata + dependencies
  -> Cargo/rustc provider
  -> WASM/component/other executable artifacts

Java source + JAR dependencies
  -> javac/JVM/AOT/Java-to-WASM tooling
  -> bytecode/WASM/other executable artifacts
```

There should not be a requirement to implement new Rust or Java compilers here.

Compiled libraries can remain first-class imported dependencies. A Java JAR need not be decompiled to participate in an image; a WASM component can remain a component; a Rust/native binary dependency can be reused when its compiler/target/ABI contract makes that safe.

WASM Component-style interfaces remain especially attractive as language-neutral library boundaries:

```text
Smalltalk caller ---+
Rust caller --------+--> shared component/library
Java caller --------+
```

The implementation language can become irrelevant at that outer interface while internal language semantics remain untouched.

### OCI still has two roles

OCI as a **build environment**:

```text
artifact inputs -> compiler/package manager in OCI -> derived artifacts
```

OCI as a **foreign runtime**:

```text
image callable/interface -> adapter -> live JVM/native/Python/etc. container
```

These are deliberately separate. Build containers are reproducible toolchain machinery; foreign-runtime containers remain part of execution and have a stronger compatibility boundary. Objects in a JVM or other foreign heap do not automatically become durable image objects.

See [ADR 0016](docs/decisions/0016-artifacts-external-toolchains-and-foreign-runtimes.md), [ADR 0017](docs/decisions/0017-artifact-dependencies-and-toolchain-providers.md) and the [language platform](docs/language-platform.md).

## WASM backend

Supported directly now:

```text
literal
argument
receiver
captured binding
integer-add
equals
if
tail message send
tail nested Block creation
```

General non-tail asynchronous effects remain unsupported. Requesting WASM never silently falls back to the interpreter.

The generic calling ABI is `lagrange-value-handle/v0`. WASM sees invocation-local `i32` handles rather than image Values or object addresses:

```text
entry(receiverHandle,
      argumentHandle0, ...,
      captureHandle0, ...)
  -> resultHandle
```

Handle `0` is reserved. Positive handles exist only for the current activation. They are not object IDs, capabilities or persistent references.

### Tail host effects

```text
WASM -> send_site_N       -> return 0 -> normal language dispatch -> Value
WASM -> make_block_site_N -> return 0 -> create environment+Block -> ObjectRef
```

A closure site's metadata contains only semantic block/capture descriptors. Prototype Block refs remain explicit `derivedFrom` edges on `wasm-function/v1`.

### Complete trees use one physical module

`installWasmBlockTree()` takes one root semantic artifact, preflights the full tree, persists nested semantic artifacts, compiles/reuses one grouped module, then assembles separate function/prototype Blocks bottom-up:

```js
const installed = await installWasmBlockTree({
  images: runtime.images,
  compilation: runtime.compilation,
  semanticRef: objectRef(imageId, semanticArtifact.id),
  id: 'compiled-service',
});
```

For:

```smalltalk
[ :x | [ :y | [ :z | x ] ] ]
```

the executable shape is:

```text
semantic root  ----\
semantic child -----+--> one wasm-module/v1
semantic grandchild/

run_0 -> root wasm-function/v1       -> root Block
run_1 -> child wasm-function/v1      -> child prototype Block
run_2 -> grandchild wasm-function/v1 -> grandchild prototype Block
```

All three function/Block identities remain separate. Sharing a module is only physical executable grouping.

### Compiled host-module cache

The executor compiles an immutable `wasm-module/v1` to a host `WebAssembly.Module` once per runtime and reuses that compiled module for later activations, including activations of different entries in one shared module:

```text
wasm-module/v1 bytes
      -> WebAssembly.compile() once
      -> runtime-local WasmModuleCache
```

Concurrent misses for the same module share one in-flight compilation promise. Failed compilation is evicted so a later activation can retry.

### Stateless instance pool

Compiled-module reuse no longer implies that every activation must instantiate from scratch. Modules may opt into a separate execution contract:

```text
metadata.instanceReuse = "stateless-v0"
```

The built-in Lagrange-code WASM compilers emit that marker because their generated modules have no activation-persistent guest memory, mutable globals/tables or other guest runtime state.

For those modules execution is now:

```text
compiled WebAssembly.Module
      -> checkout pooled WebAssembly.Instance
      -> bind fresh activation state
           ValueHandleArena
           active entry/effect sites
           closure prototypes
           pending tail effect
      -> execute entry
      -> validate/copy result or tail-effect request
      -> unbind activation state
      -> return instance to pool
      -> perform asynchronous send/closure effect, if any
```

The same instance can therefore execute different entries and different lexical captures on later calls without retaining the old handles or permissions.

The default pool keeps at most one idle instance per module and does not queue concurrent activations: extra concurrent demand creates extra instances, of which only the configured idle budget is retained afterward.

A guest trap or host-boundary contract failure retires the checked-out instance instead of returning it. Modules without `instanceReuse` remain valid and execute one-shot. Unknown reuse contracts fail explicitly.

Future Java/Rust/Lisp/etc. backends with mutable linear memory, heaps, TLS or runtime globals must **not** inherit `stateless-v0`; they can stay one-shot or define a later reset contract.

Runtime-only diagnostics are available through the default WASM executor:

```js
const wasmExecutor = runtime.codeExecutors.get(WASM_FUNCTION_V1);

wasmExecutor.moduleCache.stats();
// {entries, hits, misses, compilations, failures}

wasmExecutor.instancePool.stats();
// {modules, idle, inUse, hits, misses, created, retired, discarded}
```

These host cache/pool objects and counters are not image state and are never persisted.

## Compilation groups and reuse

A transient compilation group says only:

```text
policyId
targetRepresentation
artifact/semantic member refs
compiler-policy options
```

The generic compilation layer has separate registries for single-artifact and grouped compilers. `CompilationService.compileGroup()` resolves the members, makes them explicit provenance edges, applies compiler-declared cache semantics and persists the grouped artifact.

The substrate does not assume that a group means a Smalltalk Block tree. Java may group classes/packages, Rust codegen units/crates, Lisp compilation units, etc. A logical group may map to one physical module or several according to compiler/toolchain policy.

Compiler-derived artifact reuse is implemented through stable compiler identity + deterministic cache keys. `ToolchainService` does **not** yet cache external-toolchain results; that later contract must include toolchain identity plus target/options and dependency/manifest/lock fingerprints, and OCI-backed providers must include their pinned build-image identity/digest.

There are now three implemented WASM reuse layers:

```text
durable derivation reuse: semantic group -> shared wasm-module/v1 CodeArtifact
runtime compile reuse:     wasm-module/v1 -> shared compiled WebAssembly.Module
runtime instance reuse:    stateless module -> rebound pooled WebAssembly.Instance
```

None merges language/image identity or invocation-local Value/capability state.

See ADR 0012 through ADR 0017.

## Values and objects

The durable Value union remains deliberately small:

```text
boolean | integer | float64 | text | bytes | ref | pinned-ref
```

There is no generic inline map/array and no platform `nil`. Language collections, closures and other semantic structures live in the graph.

A generic object contains physical shape separately from language behavior. Smalltalk currently uses `behavior` as its dispatch hook; the image layer still does not know what a class is.

## References are not capabilities

`{kind:'ref', imageId, objectId}` means only "this object identity". It grants no right to read, mutate or invoke that object. Authorization is resolved separately. WASM Value handles similarly grant no ambient authority. Imported interfaces and foreign-runtime adapters must preserve the same separation.

## Backend selection

`LAGRANGE_BACKEND` accepts `auto`, `mock`, or `lagrange`.

- `mock`: always use the in-memory backend.
- `auto` (default): try `lagrange-server`; otherwise use mock.
- `lagrange`: require a compatible public Lagrange adapter and fail rather than silently falling back.

Do not import `lagrange-server/src/...`; use public package seams only.

## Documentation

- [Architecture](docs/architecture.md)
- [Image model](docs/image-model.md)
- [Value/reference/object model](docs/value-model.md)
- [Language platform](docs/language-platform.md)
- [Lagrange integration](docs/lagrange-integration.md)
- [Security boundary](docs/security.md)
- [Roadmap](docs/roadmap.md)
- [ADR 0001: backend boundary](docs/decisions/0001-backend-boundary.md)
- [ADR 0002: language-neutral graph representation](docs/decisions/0002-language-neutral-graph-representation.md)
- [ADR 0003: code artifacts and closures](docs/decisions/0003-code-artifacts-and-closures.md)
- [ADR 0004: invocation and message dispatch](docs/decisions/0004-invocation-and-message-dispatch.md)
- [ADR 0005: calling convention and neutral executor](docs/decisions/0005-calling-convention-and-neutral-executor.md)
- [ADR 0006: Symmetric Smalltalk seed](docs/decisions/0006-symmetric-smalltalk-seed.md)
- [ADR 0007: semantic code and derived execution](docs/decisions/0007-semantic-code-and-derived-execution.md)
- [ADR 0008: first WASM backend and Value-handle ABI](docs/decisions/0008-wasm-backend-and-value-handle-abi.md)
- [ADR 0009: WASM tail message effects](docs/decisions/0009-wasm-tail-message-effects.md)
- [ADR 0010: WASM tail closure effects](docs/decisions/0010-wasm-tail-closure-effects.md)
- [ADR 0011: automatic WASM Block tree installation](docs/decisions/0011-automatic-wasm-block-tree-installation.md)
- [ADR 0012: language-neutral compilation groups and reuse](docs/decisions/0012-language-neutral-compilation-groups-and-reuse.md)
- [ADR 0013: shared multi-function WASM modules](docs/decisions/0013-shared-multifunction-wasm-modules.md)
- [ADR 0014: runtime-local compiled WASM module cache](docs/decisions/0014-runtime-wasm-module-cache.md)
- [ADR 0015: runtime-local WASM instance pooling](docs/decisions/0015-runtime-wasm-instance-pooling.md)
- [ADR 0016: artifact graphs, external toolchains and foreign runtimes](docs/decisions/0016-artifacts-external-toolchains-and-foreign-runtimes.md)
- [ADR 0017: artifact dependencies and toolchain providers](docs/decisions/0017-artifact-dependencies-and-toolchain-providers.md)
