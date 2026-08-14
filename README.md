# Lagrange Images

A persistent image service and language platform built to sit on Lagrange.

An image is a durable object graph, not a VM memory dump and not a pile of source files. Languages are personalities over that graph. Program meaning is kept separately from derived execution artifacts so interpreters, WASM and future optimized runtimes can change without changing image semantics.

## What is here now

- stable image and object identities
- canonical tagged scalar Values and ordinary/pinned refs
- immutable shapes plus generic objects with separate physical shape and language behavior
- immutable CodeArtifacts, versioned LexicalEnvironments and durable Blocks
- transient message dispatch and activation requests
- `CodeCompilerRegistry` / `CompilationService`
- language-neutral `lagrange-code/v0` semantic code
- `neutral-expression/v0` reference interpreter
- first real `lagrange-code/v0 -> wasm-module/v1` backend
- `lagrange-value-handle/v0` WASM calling ABI
- `wasm-function/v1` execution through the normal ActivationExecutor
- interpreter/WASM differential tests
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

The executable forms are derived state. The bootstrap interpreter currently materializes nested closures as Block + LexicalEnvironment records, while future optimized/WASM paths may stack-allocate, inline or eliminate nonescaping closures.

## First WASM backend

The first backend compiles a useful pure subset of `lagrange-code/v0` to real WebAssembly bytes and executes it with Node's built-in `WebAssembly` runtime.

Supported now:

```text
literal
argument
receiver
captured binding
integer-add
equals
if
```

Message sends and nested Block creation are deliberately rejected by the WASM compiler for now. Requesting WASM never silently falls back to the interpreter.

The calling ABI is `lagrange-value-handle/v0`. WASM sees invocation-local `i32` handles rather than image Values or object addresses:

```text
run(receiverHandle,
    argumentHandle0, ...,
    captureHandle0, ...)
  -> resultHandle
```

Handle `0` means no receiver/value in an ABI slot. Positive handles exist only for the current activation. They are not object IDs, capabilities or persistent references.

Host imports currently provide `literal`, `integer_add`, `equals`, and `is_true`. Operations resolve handles back to canonical tagged Values on the host, so arbitrary-precision image integers remain arbitrary precision instead of being narrowed to WASM `i64`.

Object refs can cross as receiver/argument/capture handles without putting graph identities in WASM memory or metadata. Reference literals are intentionally not embedded in module metadata because graph edges must remain explicit.

The artifact chain is:

```text
lagrange-code/v0
      -> wasm-module/v1   # bytes + ABI/literal metadata
      -> wasm-function/v1 # module ref + entry/signature metadata
      -> Block
```

The interpreter remains the reference oracle. Differential tests compile the same semantic artifact to interpreter and WASM forms and require the same canonical Value result.

See ADR 0008.

## Values and objects

The durable Value union remains deliberately small:

```text
boolean | integer | float64 | text | bytes | ref | pinned-ref
```

There is no generic inline map/array and no platform `nil`. Language collections, closures and other semantic structures live in the graph.

A generic object contains physical shape separately from language behavior. Smalltalk currently uses `behavior` as its dispatch hook; the image layer still does not know what a class is.

Generic objects have no `classId` or `source`. Source, syntax, semantic code, executable artifacts and provenance live in CodeArtifacts and linked graph objects.

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
