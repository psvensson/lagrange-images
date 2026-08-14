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
- real `lagrange-code/v0 -> wasm-module/v1` backend
- `lagrange-value-handle/v0` WASM calling ABI
- WASM tail message sends through normal language dispatch
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

## WASM backend

The backend compiles a useful subset of `lagrange-code/v0` to real WebAssembly bytes and executes it with Node's built-in `WebAssembly` runtime.

Supported directly in WASM now:

```text
literal
argument
receiver
captured binding
integer-add
equals
if
tail message send
```

Nested Block creation and non-tail asynchronous sends remain unsupported. Requesting WASM never silently falls back to the interpreter.

The calling ABI is `lagrange-value-handle/v0`. WASM sees invocation-local `i32` handles rather than image Values or object addresses:

```text
run(receiverHandle,
    argumentHandle0, ...,
    captureHandle0, ...)
  -> resultHandle
```

Handle `0` is reserved. Positive handles exist only for the current activation. They are not object IDs, capabilities or persistent references.

Host imports resolve handles back to canonical tagged Values, so arbitrary-precision image integers remain arbitrary precision instead of being narrowed to WASM `i64`. Object refs can cross as receiver/argument/capture handles without putting graph identities in WASM memory or metadata.

### Tail message sends

Language dispatch may require asynchronous image work, but ordinary WASM imports are synchronous. The first bridge therefore treats a message send as a tail host effect.

For a source block such as:

```smalltalk
[ :target | target echo: 42 ]
```

the generated module contains a typed `lagrange.send_site_N` import. Calling it records the receiver/arguments from their Value handles and returns reserved handle `0`. The WASM entry returns immediately; the executor then asynchronously performs the ordinary language send through `InvocationService` and executes the resolved Block.

```text
WASM caller
  -> send_site_N
  -> return 0
  -> normal Smalltalk dispatch
  -> interpreted or WASM callee
  -> canonical Value
```

Pure WASM control flow may choose a final send, so tail sends in `if` branches work. Sends needed as intermediate expression results are rejected until an explicit continuation/async WASM design exists.

The interpreter remains the reference oracle. Differential tests compile the same semantic artifact to interpreter and WASM forms and require the same canonical Value result.

See ADR 0008 and ADR 0009.

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
- [ADR 0009: WASM tail message effects](docs/decisions/0009-wasm-tail-message-effects.md)
