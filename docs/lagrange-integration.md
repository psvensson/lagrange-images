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

The PR-only integration lane installs the pinned public Lagrange package and starts
one embedded backend per isolated worker. Its transaction, kernel and Life scenarios run
sequentially against that warm session. The transaction scenario proves one atomic
state/history round trip; the kernel scenario installs
the metaclass and class phases (22 records each), verify all 52 kernel records and their history, and
prove that reinstalling writes nothing. It then creates and rediscovers a fresh named class
through two dictionary/Behavior pairs, checking ordered history and write-free replay in the
same public backend session. The transaction records are checked again after the kernel
and Life scenarios, and Life must leave the kernel image/history unchanged. Isolation
comes from distinct collection/stream and image identities, not the application
namespace (which is session identity only). Installed image contents are never
reused as fixture setup.

The fixture reports setup, transaction, kernel, Life and cleanup separately. Case
allowances remain 160, 340 and 340 seconds. Setup has a 160-second bound and cleanup
20 seconds, all within one 840-second child envelope (the sum of the former child
limits), with an 860-second parent. The shared ceiling can preempt an individual
allowance; a phase cannot publish success after either deadline. Resource exhaustion
is inconclusive and fails the lane. The parent requires a complete ordered report
and successful cleanup. Cold transaction, kernel and M6 Life CLI entries remain
available with the same assertion functions. This change makes no cold-start
performance, native admission repair or M6 acceptance claim.

M6.3 contains a candidate shared-server real-Lagrange proof using the same public
`createEmbeddedLagrange()` handle and two
`LagrangeBackend({runtime, ownsRuntime: false})` adapters. Each adapter opens its
own application session for an independent Images runtime without taking server
lifecycle authority.

The complete shared-server acceptance remains **unproven**. The candidate now pins
Lagrange `a43ce6a9fe3c2ffd17fcb084e596a0c709ba88c9`, matching the frozen diagnostic
source. The ordinary real state/history round trip and public write/readback passed
on that source; the complete Life run was interrupted by its host's idle policy.
The historical 40-operation prefix stopped before compiler work. The newer
600-second run on Images `b652f20…` and that same Lagrange source reached compiler-reuse
lookups, while backend transactions dominated its measured time; Life remained incomplete.
[ADR 0092](decisions/0092-object-residency-placement-and-remote-resolution-owners.md#5-ownership-map-and-proof-discipline)
and Bead `lagrange-images-0pxf.4` retain the exact measurements and source identities.

The kernel repair is now merged as PR #320 at main `b61c05d…`, with focused,
native and all six CI proofs. Its fresh kernel publication uses 10 transactions
instead of 52. The subsequent unchanged M6 witness on Images `8e14cbc…` and
Lagrange `a43ce6a9…` reached its original 340-second child deadline during Life
installation, after public write/readback and both runtime attachments passed.
PR #322 subsequently merged at main `ddff93c…`, preserving ordered history while
reducing each class's dictionary/Behavior segment from four transactions to two;
its native kernel/class proof and all six CI checks passed. Neither owner proof
establishes Life acceptance. Beads `lagrange-images-bi0i`, `lagrange-images-pqzm`
and `lagrange-images-0pxf.4` retain these separate results; `lagrange-images-f5kd`
tracks separate native admission failures. The warm M6 consumer proof proceeds independently
on unchanged Lagrange `a43ce6a9…`; it does not discharge core admission or the 0.3.2
upgrade work, and remains unproven until required CI passes.

The fixture performs one CREATE and one INSERT, then only polls a SELECT for that
exact row for 20 seconds. Failure is an acceptance prerequisite, not an Images
readiness/retry policy; passing it does not prove later installation succeeds.
The callable witness is `fixtures/real-lagrange-m6-scenario.js`; its original cold
entry remains `fixtures/real-lagrange-m6-shared-server-process.js` with the same
data-directory argument and public server configuration. The real lane calls that
same assertion body on the backend-owned warm server, then verifies that transaction
data and the kernel image/history are unchanged.

A separate file-backed compatibility-runtime test proves the adapter mapping
across restart. The M6.3 shared-server proof is intentionally **not** a
multi-node durability/failure-recovery claim, so checklist items 7-10 remain
unchanged until those stronger proofs exist.

Snapshots currently write one snapshot record and do not append an event. Logical revision-frontier semantics remain later work.

## Compute moves inward later

Start with boring durable storage. After access patterns are measured, move locality-sensitive work into placed WASM where it helps: graph traversals, project/index queries, history reductions, compiler passes over many code objects, and distributed activations that genuinely belong near data.

That is where `ctx.call()` and Lagrange placement become useful; not every object send should become distributed execution.

## Shared execution capabilities and application delivery (target)

Images is the owner of image graph semantics, local message resolution,
Blocks, language dispatch, activation and graph/Project materialization.
It is **not** a third Lagrange cluster execution provider or a second
service-deployment controller. Images must continue to use public Lagrange
facilities for physical partition routing, replication, Cell placement and
cross-node invocation. ADR 0092's Images-owned object locator and generic
placement intent are **semantic object-residency concerns**, not authority to
choose Lagrange Raft replicas or schedule Cells.

A future Images application can publish an immutable selected Project
release and have a Lagrange deployment consume that material. The existing
`installManagedProjectRelease()` persists imported graph and managed target
mapping **inside an Image**; it neither declares nor activates Lagrange
Bindings, and is not a competing cluster installer. Installed applications
that depend on Images semantics still need a compatible Images execution
engine; installing one must not imply embedding a complete independent VM
or daemon in every application's package. Engine provisioning/reuse,
deployment upgrade and rollback require separate Lagrange-owned contracts
and are **not implemented by this paragraph**.

The convergence target is one Lagrange host-capability contract:
WASM Components use the canonical host imports, and native OCI language
SDKs project those **same** supported capabilities 1:1 for the same admitted
Binding/world. Images can consume those facilities, while preserving its
own higher-level local message/Block semantics. Native OCI execution remains
a first-class customer-adoption path for existing languages and native
libraries, not a fallback after an obligatory WASM port. An Images method
send is not automatically a distributed invocation, and Images must not
introduce an alternate broker, fanout coordinator, authorization source or
retry classifier.

See Lagrange's
[Native OCI Call Cells](https://github.com/psvensson/lagrange/blob/main/architecture/native-oci-call-cells.md)
for the planned native SDK parity and the existing
[distributed public seam](https://github.com/psvensson/lagrange/blob/main/architecture/images-distributed-public-seam.md).
Neither document changes this repository's current backend guarantees or
ADR 0092's pending distribution proofs.

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
