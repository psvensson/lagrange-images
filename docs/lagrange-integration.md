# Lagrange integration

## Current state

`lagrange-images` is designed to consume Lagrange as a library, not to start a Lagrange daemon or import private source paths.

The backend loader tries:

```js
await import('lagrange-server')
```

The current Lagrange package already has a side-effect-free public entry point. That gives this project the right dependency direction.

What is missing is a deliberately small application-facing storage adapter for this image service. Until that exists, `auto` mode records that Lagrange was found and falls back to the mock. `lagrange` mode fails clearly.

## Handshake

The bootstrap handshake is intentionally tiny. A Lagrange-backed provider must implement the backend contract:

```text
start
stop
get
put
scan
append
readStream
```

`createBackend()` accepts an injected `lagrangeFactory` now. It will also use `lagrange-server.createImageBackend` if Lagrange eventually chooses to expose that exact convenience API.

The name `createImageBackend` is not a demand on Lagrange's architecture. If a more general embedded SQL/session API is the better public primitive, this repository should implement its own adapter on top of that and keep the image contract here.

## Likely durable schema

The mock's collection abstraction should not be copied literally into SQL. A first real schema will probably look more like:

```text
images
  image_id PK
  language_id
  root_object_id
  metadata
  revision
  ...

image_objects
  image_id
  object_id
  class_id
  slots/blob or normalized state
  source/code_ref
  version
  ...

image_events
  image_id
  revision
  event_type
  object_id?
  payload
  ...

image_snapshots
  image_id
  snapshot_id
  revision/frontier
  metadata
  ...
```

Partition keys should be selected to make ordinary image/object operations local without making large images single-partition bottlenecks. `image_id + object_id` gives room for object-level distribution; history and project indexes may need separate strategies.

## Transactions

Operations that change current state and append history should become one logical transaction on the real backend. The mock currently performs these as separate in-memory operations because it is a development aid, not the durability reference implementation.

The Lagrange adapter should be the first place where the stronger invariant is enforced.

## Compute moves inward later

The first Lagrange integration should be boring SQL/storage. Do not begin by scattering every message send across WASM functions.

After object layout and access patterns are measured, move the operations that benefit from locality into placed WASM:

- traversals over large object sets
- project/index queries
- reference graph operations
- history reductions
- language/compiler passes over many code objects
- distributed object activations that genuinely belong near data

That is where `ctx.call()` and Lagrange's placement model become interesting.

## No private imports

Never do this:

```js
import Something from 'lagrange-server/src/...';
```

If an integration requires a private class, that is evidence of a missing public seam. Fix the seam deliberately in one project or the other.

## Integration checklist

1. Decide the smallest public Lagrange primitive: embedded SQL/session or image-specific provider.
2. Implement durable tables and migrations here.
3. Make state write + history append atomic.
4. Add conformance tests and run them against mock and Lagrange.
5. Add restart/durability tests.
6. Add multi-node tests before claiming distributed image semantics.
7. Only then move selected runtime work into distributed WASM.
