# Lagrange integration

## Current state

`lagrange-images` consumes Lagrange as a library rather than starting another daemon or importing private source paths. The backend loader probes the side-effect-free public `lagrange-server` package and constructs `LagrangeBackend` over `createEmbeddedLagrange()` and `openApplicationDatabase()`.

The image-side persistence and transaction semantics are explicit and covered by one reusable conformance suite running against both the mock and the SQL adapter. The mock remains the `auto` fallback when the package is absent.

## Handshake

The backend contract is intentionally small:

```text
lifecycle
  start / stop

ordinary operations
  get / put / scan
  append / readStream / streamHead

atomic work
  transaction(callback)
    -> get / put / scan
    -> append / readStream / streamHead
```

A transaction callback commits all scoped operations or none of them. Scoped reads see staged writes, optimistic version conflicts abort the transaction, and the scoped object expires when the callback settles.

This is an image-side abstraction, not a request for Lagrange to reproduce collections and streams as its database API. A Lagrange adapter may implement the contract over an embedded SQL/session transaction.

## Durable schema

The adapter owns five tables rather than copying the mock's in-memory maps literally:

```text
lagrange_images_images
  id / record_key / version / payload

lagrange_images_records
  id / record_key / version / payload

lagrange_images_snapshots
  id / record_key / version / payload

lagrange_images_stream_heads
  id / revision

lagrange_images_events
  id / stream_id / revision / payload
```

Every table has an `id` primary key for Lagrange routing. Identities use tagged composite keys whose variable parts are UTF-8 hex. Delimiters therefore cannot collide with image/object IDs, and collection scans become bounded primary-key ranges rather than unqualified table scans.

The schema does not reintroduce `class_id` or generic source columns as substrate semantics. Language class/type/code objects remain graph data above this layer. Composite record IDs retain both image locality and object-level distribution; measured split/index policy remains later work.

## Values and refs

The first durable codec stores the normalized graph record as JSON payload text. Canonical bytes are already base64 Values, integers are decimal Values, and refs remain explicit tagged records, so this preserves observable semantics. Later typed projections may accelerate measured queries without changing the graph contract. Backend row versions are not object identity.

## Transactions

Image creation and every versioned graph mutation commit the materialized record and its history event through one `backend.transaction()`. The event is constructed after `put()`, inside the same transaction, so it records the actual assigned version.

The mock implements rollback and transaction-local visibility with isolated in-memory drafts. That proves the backend API contract but not process-crash durability.

`test/support/backend-conformance.js` is the reusable acceptance suite. It runs against both backends for ordinary operations, atomic commit, callback rollback and version-conflict rollback. Adapter-specific tests cover key encoding, range scans, graph/history round trips and scoped-handle expiry.

The PR-only integration lane installs the pinned public Lagrange package and
proves the owned schema plus one atomic state/history round trip through its
embedded session. M6.3 contains a candidate second real-Lagrange proof using the same public
`createEmbeddedLagrange()` handle and two
`LagrangeBackend({runtime, ownsRuntime: false})` adapters. Each adapter opens its
own application session for an independent Images runtime without taking server
lifecycle authority.

That acceptance is currently **BLOCKED by Lagrange**, not by adapter semantics.
Against the exact landed Lagrange merge `edf20e39b0014d5d2a63a2ecea990712f0349153`
(merged PR #65), implicit single-node fallback reaches target/minimum replica
count 1 and the one-shot public CREATE+INSERT round trip becomes visible, but
table partition provisioning then keeps refusing the single admissible node:
`required=1, provisionable=0, target=1` with `readiness_planning_identity_unavailable`
and `readiness_planning_identity_changed` rejections, at times with
`candidateTargetNodeIds: []` overall. A direct 25-minute run never converged, so
the recovered Life install never completes. The earlier acknowledgement-only
readiness probe was rejected for exactly this reason. The real fixture performs
one CREATE and one INSERT, then only polls a SELECT for that exact row for 20
seconds; failure is an acceptance prerequisite, not an Images readiness/retry
policy. The consumer reproducer is
`fixtures/real-lagrange-m6-shared-server-process.js` pinned to that SHA.

A separate file-backed compatibility-runtime test proves the adapter mapping
across restart. The M6.3 shared-server proof is intentionally **not** a
multi-node durability/failure-recovery claim, so checklist items 7-10 remain
unchanged until those stronger proofs exist.

Snapshots currently write one snapshot record and do not append an event. Logical revision-frontier semantics remain later work.

## Compute moves inward later

Start with boring durable storage. After access patterns are measured, move locality-sensitive work into placed WASM where it helps: graph traversals, project/index queries, history reductions, compiler passes over many code objects, and distributed activations that genuinely belong near data.

That is where `ctx.call()` and Lagrange placement become useful; not every object send should become distributed execution.

## No private imports

Never import `lagrange-server/src/...`. If integration requires a private class, expose the missing public seam deliberately.

## Integration checklist

1. [x] Use the public embedded runtime and application database session.
2. [x] Map Values, shapes, objects, artifacts and refs to a durable schema.
3. [x] Make state write + history append atomic.
4. [x] Add a reusable backend conformance suite and run it against the mock.
5. [x] Run the same conformance suite against the Lagrange adapter.
6. [x] Add file-backed mapping restart coverage.
7. [ ] Add a real Lagrange process-restart durability test.
8. [ ] Add multi-node failure/recovery durability tests.
9. [ ] Define logical snapshot/revision frontiers.
10. [ ] Only then move selected runtime work into distributed WASM.
