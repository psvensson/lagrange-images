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
- WASM tail nested-Block materialization with ordinary lexical captures
- automatic recursive WASM compilation/installation of complete nested Block trees
- `wasm-function/v1` execution through the normal ActivationExecutor
- interpreter/WASM differential and closure conformance tests
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

The executable forms are derived state. Both bootstrap execution paths can materialize a returned nested closure as the ordinary `Block + LexicalEnvironment` image representation. Future optimized paths may still stack-allocate, inline or eliminate nonescaping closures.

## WASM backend

The backend compiles a useful subset of `lagrange-code/v0` to real WebAssembly bytes and executes it with Node's built-in `WebAssembly` runtime.

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

The calling ABI is `lagrange-value-handle/v0`. WASM sees invocation-local `i32` handles rather than image Values or object addresses:

```text
run(receiverHandle,
    argumentHandle0, ...,
    captureHandle0, ...)
  -> resultHandle
```

Handle `0` is reserved. Positive handles exist only for the current activation. They are not object IDs, capabilities or persistent references.

Host imports resolve handles back to canonical tagged Values, so arbitrary-precision image integers remain arbitrary precision instead of being narrowed to WASM `i64`. Object refs can cross as receiver/argument/capture handles without putting graph identities in WASM memory or metadata.

### Tail host effects

Language dispatch and closure materialization may require asynchronous image work, but ordinary WASM imports are synchronous. The bootstrap bridge therefore lets WASM record one final host effect and return before the runtime performs it.

For a tail send:

```text
WASM -> send_site_N -> return 0 -> normal language dispatch -> Value
```

For a returned nested Block:

```text
WASM -> make_block_site_N -> return 0 -> create LexicalEnvironment + Block -> ObjectRef
```

A closure site's module metadata contains only its semantic block ID and capture IDs/names. Prototype Block refs are explicit `derivedFrom` graph edges on `wasm-function/v1`; metadata only records their indices. No prototype ref is hidden in module metadata.

The prototype may be interpreted or WASM-backed. Once materialized, the closure is an ordinary Block and receives `value`, `value:`, etc. through the normal Symmetric Smalltalk dispatcher.

### Compile a complete nested tree

`installWasmBlockTree()` takes one root semantic artifact and recursively builds all nested WASM functions and prototype Blocks for you:

```js
import {
  installWasmBlockTree,
  objectRef,
} from 'lagrange-images';

const installed = await installWasmBlockTree({
  images: runtime.images,
  compilation: runtime.compilation,
  semanticRef: objectRef(imageId, semanticArtifact.id),
  id: 'compiled-service',
});

// installed.block is the root WASM-backed Block.
```

For a semantic tree corresponding to:

```smalltalk
[ :x | [ :y | [ :z | x ] ] ]
```

the installer compiles the deepest Block first, creates its WASM prototype, wires that prototype into its parent function, and continues upward until the root Block is complete. No caller-supplied `blockPrototypes` map is needed.

The whole semantic tree is preflighted before derived tree writes begin. If a deep descendant uses unsupported WASM semantics, installation fails without leaving a partially assembled executable tree.

The low-level `compileWasmFunctionArtifact()` API remains available when mixed interpreter/WASM prototypes or custom assembly are useful.

This is still rejected inside one WASM activation:

```smalltalk
[ :x | [ :y | x ] value: 1 ]
```

because closure materialization is an intermediate asynchronous effect. A future continuation/trampoline or other async-WASM contract can lift that restriction explicitly.

The interpreter remains the reference oracle. Tests exercise identical stable capture IDs and results across interpreter-backed and WASM-backed closure prototypes and complete recursively compiled WASM trees.

See ADR 0008, ADR 0009, ADR 0010 and ADR 0011.

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
- [ADR 0010: WASM tail closure effects](docs/decisions/0010-wasm-tail-closure-effects.md)
- [ADR 0011: automatic WASM Block tree installation](docs/decisions/0011-automatic-wasm-block-tree-installation.md)
