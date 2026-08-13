# Lagrange integration

## Current state

`lagrange-images` consumes Lagrange as a library rather than starting another daemon or importing private source paths. The backend loader probes the side-effect-free public `lagrange-server` package and otherwise uses the mock during bootstrap work.

The missing piece remains a deliberately small application-facing persistence seam. The image graph semantics should not depend on whether that seam is an embedded SQL/session API or a convenience adapter.

## Handshake

The bootstrap backend contract remains intentionally small:

```text
start / stop
get / put / scan
append / readStream
```

This is an image-side abstraction, not a request for Lagrange to reproduce it as a database API.

## Likely durable schema

The mock collection layout should not be copied literally. A real mapping should preserve the neutral graph model, roughly:

```text
images
  image_id
  root_object_id
  language_id
  metadata

image_records
  image_id
  object_id
  record_kind       # shape | object
  shape_image_id?   # object records
  shape_object_id?
  behavior_image_id?
  behavior_object_id?
  payload / normalized slots
  version

image_events
  image_id
  revision
  event_type
  object_id?
  payload

image_snapshots
  image_id
  snapshot_id
  revision_frontier
  metadata
```

The schema must not reintroduce `class_id` or generic source columns as substrate semantics. Language class/type/code objects are graph data above this layer.

Partitioning should make ordinary image/object operations local without forcing a large image into one partition. `(image_id, object_id)` naturally leaves room for object-level distribution; history and graph indexes may need different placement/index strategies.

## Values and refs

The portable codec uses tagged records, but the Lagrange adapter may normalize them efficiently. For example, integer, float and ref fields do not need to remain JSON blobs if typed columns/indexes help. The observable semantics must remain identical: refs mean identity, pinned refs include historical revision, and backend row versions are not object identity.

## Transactions

A real backend should make current-state changes plus history append one logical transaction. The mock's separate in-memory operations are development semantics, not the durability reference.

## Compute moves inward later

Start with boring durable storage. After access patterns are measured, move locality-sensitive work into placed WASM where it helps: graph traversals, project/index queries, history reductions, compiler passes over many code objects, and distributed activations that genuinely belong near data.

That is where `ctx.call()` and Lagrange placement become useful; not every object send should become distributed execution.

## No private imports

Never import `lagrange-server/src/...`. If integration requires a private class, expose the missing public seam deliberately instead.

## Integration checklist

1. Decide the smallest public Lagrange primitive: embedded SQL/session or image-side adapter.
2. Map Values, shapes, objects and refs to durable schema.
3. Make state write + history append atomic.
4. Add a conformance suite shared by mock and Lagrange.
5. Add restart and multi-node durability tests.
6. Define logical snapshot/revision frontiers.
7. Only then move selected runtime work into distributed WASM.
