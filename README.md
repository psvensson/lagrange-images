# Lagrange Images

A persistent image service and language platform built to sit on Lagrange.

An image is a durable object graph, not a VM memory dump and not a pile of source files. Languages are personalities over that graph. Program meaning is kept separately from derived execution artifacts so interpreters, WASM and future optimized runtimes can change without changing image semantics.

## What is here now

- stable image and object identities
- canonical tagged scalar Values and ordinary/pinned refs
- immutable shapes plus generic objects with separate physical shape and language behavior
- immutable CodeArtifacts, versioned LexicalEnvironments and durable Blocks
- transient message dispatch and activation requests
- single-artifact and grouped compiler registries/services
- language-neutral transient compilation groups
- compiler-declared derivation keys and immutable executable reuse
- language-neutral `lagrange-code/v0` semantic code
- `neutral-expression/v0` reference interpreter
- real `lagrange-code/v0 -> wasm-module/v1` backend
- multi-function shared WASM modules for compilation groups
- runtime-local compiled `WebAssembly.Module` cache
- `lagrange-value-handle/v0` WASM calling ABI
- WASM tail message sends through normal language dispatch
- WASM tail nested-Block materialization with ordinary lexical captures
- automatic recursive WASM installation of complete nested Block trees
- shared-module reuse across equivalent independent tree installations
- `wasm-function/v1` execution through the normal ActivationExecutor
- executable Symmetric Smalltalk parser/compiler/dispatcher with nested lexical Blocks
- reference walking, optimistic versions, history and snapshots
- in-memory mock backend plus optional `lagrange-server` probing

Core invariants:

```text
shape != behavior
reference != authority
identity != revision
semantic code != executable artifact
WASM handle != image identity
compilation group != source-language construct
shared module != function/Block identity
compiled host module != durable module identity
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

The executor now compiles an immutable `wasm-module/v1` to a host `WebAssembly.Module` once per runtime and reuses that compiled module for later activations, including activations of different entries in one shared module:

```text
wasm-module/v1 bytes
      -> WebAssembly.compile() once
      -> runtime-local WasmModuleCache
           |-> fresh instance for activation A
           |-> fresh instance for activation B
           `-> fresh instance for activation C
```

Instances are deliberately still fresh. Their imports close over the activation's Value-handle arena, active host-effect sites and pending-effect state.

Concurrent misses for the same module share one in-flight compilation promise. Failed compilation is evicted so a later activation can retry.

The default WASM executor exposes runtime-only cache diagnostics through:

```js
const wasmExecutor = runtime.codeExecutors.get(WASM_FUNCTION_V1);
wasmExecutor.moduleCache.stats();
// {entries, hits, misses, compilations, failures}
```

These host cache objects/counters are not image state and are never persisted.

## Compilation groups and reuse

A transient compilation group says only:

```text
policyId
targetRepresentation
semantic member refs
compiler-policy options
```

The generic compilation layer has separate registries for single-artifact and grouped compilers. `CompilationService.compileGroup()` resolves the members, makes them explicit provenance edges, applies compiler-declared cache semantics and persists the grouped artifact.

The substrate does not assume that a group means a Smalltalk Block tree. Java may later group classes/packages, Rust codegen units/crates, Lisp compilation units, etc. A logical group may map to one physical module or several according to compiler policy.

The current WASM tree policy is `wasm-nested-block-tree/v0` with `physicalLayout: shared-module`.

The shared module contains one entry descriptor per group member:

```text
entry
memberIndex
parameters
captures
sendSiteIndices
closureSiteIndices
```

At execution, only the active entry's host-effect sites are enabled. Being colocated in one WASM module does not grant one function another function's send/closure boundary.

Derived-artifact reuse is compiler-owned. A compiler must opt in with a stable identity plus deterministic `cacheKey()`. Equivalent independent tree installations therefore reuse one immutable multi-function module while keeping separate semantic artifacts, `wasm-function/v1` wrappers, Blocks and runtime closures.

There are therefore two distinct reuse layers:

```text
durable derivation reuse: semantic group -> shared wasm-module/v1 CodeArtifact
runtime execution reuse:  wasm-module/v1 -> shared compiled WebAssembly.Module
```

Neither merges language/image identity.

See ADR 0012, ADR 0013 and ADR 0014.

## Values and objects

The durable Value union remains deliberately small:

```text
boolean | integer | float64 | text | bytes | ref | pinned-ref
```

There is no generic inline map/array and no platform `nil`. Language collections, closures and other semantic structures live in the graph.

A generic object contains physical shape separately from language behavior. Smalltalk currently uses `behavior` as its dispatch hook; the image layer still does not know what a class is.

## References are not capabilities

`{kind:'ref', imageId, objectId}` means only "this object identity". It grants no right to read, mutate or invoke that object. Authorization is resolved separately. WASM Value handles similarly grant no ambient authority.

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
