# Lagrange integration

## Current state

`lagrange-images` consumes Lagrange as a library rather than starting another daemon or importing private source paths. The backend loader probes the side-effect-free public `lagrange-server` package and otherwise uses the mock during bootstrap work.

The image-side persistence and transaction semantics are now explicit and covered by a reusable conformance suite. The remaining integration gap is a deliberately small application-facing Lagrange session/factory plus the durable schema mapping.

## Handshake

The backend contract is intentionally small:

```text
lifecycle
  start / stop

ordinary operations
  get / put / scan
  append / readStream

atomic work
  transaction(callback)
    -> get / put / scan
    -> append / readStream
```

A transaction callback commits all scoped operations or none of them. Scoped reads see staged writes, optimistic version conflicts abort the transaction, and the scoped object expires when the callback settles.

This is an image-side abstraction, not a request for Lagrange to reproduce collections and streams as its database API. A Lagrange adapter may implement the contract over an embedded SQL/session transaction.

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
  record_kind       # shape | object | code-artifact | lexical-environment | block
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

The portable codec uses tagged records, but the Lagrange adapter may normalize them efficiently. Integer, float and ref fields do not need to remain JSON blobs if typed columns/indexes help. The observable semantics remain identical: refs mean identity, pinned refs include historical revision, and backend row versions are not object identity.

## Transactions

Image creation and every versioned graph mutation commit the materialized record and its history event through one `backend.transaction()`. The event is constructed after `put()`, inside the same transaction, so it records the actual assigned version.

The mock implements rollback and transaction-local visibility with isolated in-memory drafts. That proves the backend API contract but not process-crash durability.

`test/support/backend-conformance.js` is the reusable acceptance suite. Every durable adapter must pass the same ordinary-operation, atomic-commit, callback-rollback and version-conflict-rollback cases. Real restart and multi-node tests remain separate because an in-memory backend cannot prove them.

Snapshots currently write one snapshot record and do not append an event. Logical revision-frontier semantics remain later work.

## Compute moves inward later

Start with boring durable storage. After access patterns are measured, move locality-sensitive work into placed WASM where it helps: graph traversals, project/index queries, history reductions, compiler passes over many code objects, and distributed activations that genuinely belong near data.

That is where `ctx.call()` and Lagrange placement become useful; not every object send should become distributed execution.

## No private imports

Never import `lagrange-server/src/...`. If integration requires a private class, expose the missing public seam deliberately.

## Integration checklist

1. [ ] Decide the smallest public Lagrange primitive: embedded SQL/session or image-side adapter.
2. [ ] Map Values, shapes, objects, artifacts and refs to a durable schema.
3. [x] Make state write + history append atomic.
4. [x] Add a reusable backend conformance suite and run it against the mock.
5. [ ] Run the same conformance suite against the Lagrange adapter.
6. [ ] Add restart and multi-node durability tests.
7. [ ] Define logical snapshot/revision frontiers.
8. [ ] Only then move selected runtime work into distributed WASM.
