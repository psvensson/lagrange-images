# Lagrange Images

A persistent image service and language platform built to sit on Lagrange.

An image is a durable object graph, not a VM memory dump and not a pile of source files. Languages are personalities over that graph. Program meaning is kept separately from derived execution artifacts so interpreters, WASM and future optimized runtimes can change without changing image semantics.

## What is here now

- stable image and object identities
- canonical tagged scalar values (`boolean`, arbitrary-precision `integer`, exact-bit `float64`, `text`, `bytes`)
- ordinary object refs and revision-pinned refs
- immutable shapes plus generic objects with separate physical shape and language behavior
- immutable CodeArtifacts, versioned LexicalEnvironments and durable Blocks
- transient message dispatch and activation requests
- `CodeCompilerRegistry` / `CompilationService` for immutable code derivation
- language-neutral `lagrange-code/v0` semantic code
- pluggable representation executors plus `neutral-expression/v0`
- reserved `wasm-module/v1` and `wasm-function/v1` artifact contracts
- executable Symmetric Smalltalk parser/compiler/dispatcher with nested lexical Blocks
- reference walking, optimistic versions, history and snapshots
- in-memory mock backend plus optional `lagrange-server` probing
- executable demo and tests

Core invariants:

```text
shape != behavior
reference != authority
identity != revision
semantic code != executable artifact
```

## Run it

Requires Node.js 22 or newer.

```sh
npm test
npm run demo
npm start
```

## First Symmetric Smalltalk seed

The language runs through the common image/dispatch/execution substrate rather than a separate Smalltalk VM:

```js
import {
  createRuntime,
  evaluateSymmetricSmalltalkBlock,
  integerValue,
} from 'lagrange-images';

const runtime = await createRuntime({backend: {mode: 'mock'}});
await runtime.images.createImage({id: 'playground'});

const result = await evaluateSymmetricSmalltalkBlock({
  runtime,
  imageId: 'playground',
  source: '[ :x | [ :y | x ] value: 99 ]',
  arguments: [integerValue(7)],
});
```

The seed supports integer/string literals, names, `self`, parentheses, Blocks, and unary/binary/keyword message sends with Smalltalk precedence. Nested Blocks automatically capture free lexical bindings by stable binding ID; `self` is captured lexically when it crosses a Block boundary.

Compilation preserves separate immutable artifacts:

```text
Smalltalk source
  -> Smalltalk syntax
  -> lagrange-code/v0 semantic code
  -> neutral-expression/v0 executable artifact
  -> Block
```

The final executable artifact is derived state. Recompiling the semantic artifact produces the same executable meaning, and a future WASM backend can derive a different executable artifact from the same semantic code.

The bootstrap interpreter currently materializes nested closures as Block + LexicalEnvironment records. That is not a language requirement: an optimized/WASM executor may stack-allocate, inline or eliminate a nonescaping closure.

The first image-resident lookup convention uses a receiver's `behavior` object as a method table: selector names are behavior-shape slot names and corresponding slot Values are Block refs. Block refs themselves receive ordinary `value`, `value:`, `value:value:`, ... sends through the same dispatcher. This is intentionally a bootstrap convention before Object/Behavior/Class/Metaclass is designed.

## Code artifacts and WASM

`CodeArtifact.representation` identifies what the content means. The compiler registry currently knows:

```text
lagrange-code/v0 -> neutral-expression/v0
```

The next backend can add:

```text
lagrange-code/v0 -> wasm-module/v1 / wasm-function/v1
```

without changing Smalltalk source, semantic code, Blocks, dispatch, or image identity.

The reserved WASM contracts are:

```text
wasm-module/v1
  content: bytes

wasm-function/v1
  content: ref -> wasm module CodeArtifact
  metadata.entry: entry name
```

WASM is therefore an execution product, not the canonical program representation.

## Values and objects

The durable Value union remains deliberately small:

```text
boolean | integer | float64 | text | bytes | ref | pinned-ref
```

There is no generic inline map/array and no platform `nil`. Language collections, closures and other semantic structures live in the graph.

A generic object contains physical shape separately from language behavior. Smalltalk currently uses `behavior` as its dispatch hook; the image layer still does not know what a class is.

Generic objects have no `classId` or `source`. Source, syntax, semantic code, executable artifacts and provenance live in CodeArtifacts and linked graph objects.

## References are not capabilities

`{kind:'ref', imageId, objectId}` means only "this object identity". It grants no right to read, mutate or invoke that object. Authorization is resolved separately.

A pinned reference adds a historical revision; ordinary refs continue to mean the same evolving identity.

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
