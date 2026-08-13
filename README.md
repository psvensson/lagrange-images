# Lagrange Images

A persistent image service and language platform built to sit on Lagrange.

An image is a durable object graph, not a VM memory dump and not a pile of source files. Languages are personalities over that graph. The image substrate now has an explicit language-neutral value/reference/object representation; Lagrange can later provide distributed persistence, placement, transactions and compute underneath it without changing those semantics.

## What is here now

- stable image and object identities
- canonical tagged scalar values (`boolean`, arbitrary-precision `integer`, exact-bit `float64`, `text`, `bytes`)
- ordinary object refs and revision-pinned refs
- immutable shape records with stable slot IDs
- generic object records with separate `shape` and optional `behavior` refs
- slot state restricted to tagged Values; arbitrary nested JSON is not object state
- reference walking for reachability/dependency work
- optimistic object versions, image history and snapshots
- in-memory mock backend plus optional `lagrange-server` probing
- Symmetric Smalltalk as the first language profile
- a small HTTP surface, demo and tests

Three invariants are deliberate:

```text
shape     != behavior
reference != authority
identity  != revision
```

## Run it

Requires Node.js 22 or newer.

```sh
npm test
npm run demo
npm start
```

The service listens on port `7331` by default.

## JavaScript example

```js
import {
  createRuntime,
  integerValue,
  objectRef,
} from 'lagrange-images';

const runtime = await createRuntime({backend: {mode: 'mock'}});
const image = await runtime.images.createImage({id: 'playground'});

const shape = await runtime.images.putShape(image.id, {
  id: 'counter-shape-v1',
  slots: [{id: 'slot-value', name: 'value'}],
});

const counter = await runtime.images.putObject(image.id, {
  id: 'counter',
  shape: objectRef(image.id, shape.id),
  slots: {'slot-value': integerValue(0)},
});

await runtime.images.setRoot(image.id, counter.id);
```

A structural shape change gets a new shape identity. A rename can preserve the stable slot ID:

```text
shape-v1: slot-postal -> "postalCode"
shape-v2: slot-postal -> "postcode"
```

## HTTP example

```sh
curl -X POST http://127.0.0.1:7331/images \
  -H 'content-type: application/json' \
  -d '{"id":"playground"}'

curl -X PUT http://127.0.0.1:7331/images/playground/shapes/workspace-v1 \
  -H 'content-type: application/json' \
  -d '{"slots":[{"id":"slot-title","name":"title"}]}'

curl -X PUT http://127.0.0.1:7331/images/playground/objects/root \
  -H 'content-type: application/json' \
  -d '{
    "shape":{"kind":"ref","imageId":"playground","objectId":"workspace-v1"},
    "slots":{"slot-title":{"kind":"text","value":"hello"}}
  }'
```

`GET /images/playground/records` returns both substrate shape records and ordinary objects.

## Values are deliberately small

The durable Value union is currently:

```text
boolean | integer | float64 | text | bytes | ref | pinned-ref
```

There is no generic inline array/map value. Language-level collections, cons cells, closures and similar structures are objects in the graph. There is also deliberately no platform `nil`: a Smalltalk personality can map `nil` to a normal object ref, while Lisp can choose its own semantics.

The durable representation is not the execution representation. A compiler may unbox integers, collapse non-escaping blocks, or use compact runtime handles while preserving the same image semantics.

## Objects are not classes

A generic object contains physical shape separately from language behavior:

```js
{
  kind: 'object',
  id: 'counter',
  imageId: 'playground',
  shape: {kind: 'ref', imageId: 'playground', objectId: 'counter-shape-v1'},
  behavior: null,
  slots: {
    'slot-value': {kind: 'integer', value: '0'}
  },
  metadata: {}
}
```

Smalltalk may use `behavior` as its Class/Behavior hook. Another language may use a prototype/type/dispatch object or leave it null. The image layer does not know what a class is.

Generic objects no longer have `classId` or `source`. Source/code belongs in ordinary referenced code objects once that layer is introduced.

## References are not capabilities

`{kind:'ref', imageId, objectId}` means only "this object identity". It grants no right to read, mutate or invoke that object. Authorization is resolved separately from the reference.

A pinned reference adds a revision for history/debugger use:

```js
{kind: 'pinned-ref', imageId: 'playground', objectId: 'counter', revision: 'snapshot:one'}
```

Ordinary refs continue to mean the same object as it evolves.

## Backend selection

`LAGRANGE_BACKEND` accepts `auto`, `mock`, or `lagrange`.

- `mock`: always use the in-memory backend.
- `auto` (default): try to import `lagrange-server`; use a compatible adapter when one exists, otherwise fall back to the mock.
- `lagrange`: require the library and a compatible adapter; fail instead of silently falling back.

For local integration work:

```sh
npm install --no-save ../lagrange
```

Do not import from `lagrange-server/src/...`. The image service should use a public Lagrange seam only.

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
