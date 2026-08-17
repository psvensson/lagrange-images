# 0033 — Durable Lagrange backend

Status: implemented.
Proven by: test/lagrange-backend-real.test.js

## Context

ADR 0032 established the image-side atomic transaction contract. Lagrange 0.1.0
now exposes `createEmbeddedLagrange()` and application database sessions through
its side-effect-free public package. The image service no longer needs a private
import, a parallel SQL planner or a Lagrange-owned image abstraction.

The adapter must preserve the collection/stream contract used by the neutral
graph while routing ordinary reads and scans through Lagrange's `id` primary-key
convention. It must also allocate history revisions inside the same transaction
as current-state writes.

## Decision

`LagrangeBackend` owns one embedded runtime and opens one application database
labelled by its namespace. Startup creates five application-owned tables:

```text
lagrange_images_images
lagrange_images_records
lagrange_images_snapshots
lagrange_images_stream_heads
lagrange_images_events
```

Every table has an `id` primary key. Images, records, snapshots, streams and
events use tagged composite IDs. Each variable part is UTF-8 encoded as
lowercase hex, so separators cannot collide with user IDs and a collection/key
prefix becomes a bounded primary-key range. Event IDs end in a fixed-width
decimal revision.

Current Values, refs, shapes, objects, artifacts, environments and Blocks remain
normalized graph records encoded as JSON payload text. This is a portable first
mapping, not a claim that all future indexes should inspect JSON. Backend
versions and history revisions stay in typed columns and remain distinct from
object identity.

`put()` executes its read/check/write inside `database.transaction()`. Conditional
updates include the observed version. `append()` reads and conditionally advances
one stream-head row, then inserts the event under the allocated revision. A graph
mutation therefore commits its record, stream head and history event through the
single Lagrange callback transaction supplied by ADR 0032.

The adapter imports only the public `lagrange-server` package. `createBackend()`
selects it when `createEmbeddedLagrange` is available; the explicit injected
backend factory remains for tests and integrations. The mock remains the default
when Lagrange is absent in `auto` mode.

## Verification

The reusable backend conformance suite runs unchanged against the SQL adapter.
Additional tests cover:

- the exact five-table schema;
- delimiter-safe and Unicode collection/key identities;
- primary-key prefix scans;
- neutral image graph and history round trips;
- expired scoped transaction handles;
- file-backed SQL compatibility-runtime restart behavior; and
- a PR-only schema and atomic state/history round trip using the pinned public
  Lagrange package.

## Consequences

- The image graph now has a durable/distributed backend without putting image
  semantics into Lagrange core.
- State and history use Lagrange's canonical router, Raft and transaction path;
  SQLite is never exposed to the image service.
- Application namespace is session identity only, not schema or security
  isolation.
- JSON payloads are sufficient for semantic fidelity now. Typed secondary
  projections and graph indexes remain later measured optimizations.
- Real Lagrange process restart, logical snapshot frontiers, multi-node
  failure/recovery proof and schema migration/versioning remain explicit next
  work.
