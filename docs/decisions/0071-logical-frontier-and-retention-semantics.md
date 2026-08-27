# ADR 0071: logical frontier and retention semantics — a design investigation

Status: accepted — investigation outcome; **decision-only, nothing implemented here**

**Decides what a logical frontier *is* and what retaining one *guarantees*, so that the deferred §7
features (revision-aware reads, GC respecting history/pinned refs, snapshots-as-compaction) and the
§8 Project features (working frontier, branch base, diff, merge) all agree on one notion of a
historical image position.** This ADR builds **no** historical reads, GC, snapshot engine, branch
objects, merge, or authority. Where the current substrate does not provide enough evidence to decide
safely, it records the open unknown and stops (ADR 0037 §6: decide against actual requirements).

This ADR is the §7 dependency ADR 0069 named as the blocker for a first-class revision-pinned read:
0069 fixed that `pin:<id>@R` denotes a per-record `_version` and that historical reads are separately
authorized, but deferred the read because retention/frontier semantics were undefined. This ADR
defines the frontier and the *form* of the retention rule, and records the three unknowns that gate
any GC algorithm or as-of read.

## Problem

Several already-recorded future features need a shared, stable answer to "what is a historical point
in an Image, and what keeps it reconstructable?":

- ADR 0069: a revision-pinned read cannot be designed correctly until retention/frontier semantics
  exist (it would bake in a "history is unbounded" assumption the §7 work would have to retrofit).
- Roadmap §7 lists "logical snapshot/revision frontiers", "revision-aware reads", and
  "garbage-collection rules respecting history and pinned refs" as open items.
- Roadmap §8 (Projects) anticipates branch/working-frontier, diff, and merge — all of which need a
  stable historical position without inventing a second notion of one.
- `pin:<id>@R` (ADR 0069) already has a defined meaning (per-record `_version`) but **no** defined
  retention guarantee — nothing says version `R` stays reconstructable.

Without a decision, each of these would pick its own notion of "the past" and diverge.

## Recon: the substrate as it actually is

Ground truth from the code (each verified):

1. **Two distinct version axes** (ADR 0069, confirmed). (a) the **per-record `_version`** —
   optimistic-concurrency, CAS-incremented on each write to *that record*
   (`lagrange-backend.js:61-90`); (b) the **per-image event-stream `revision`** — a monotonic,
   gapless, per-stream high-water mark, CAS-assigned at append (`lagrange-backend.js:114-141`;
   `streamRoute` maps `image:<id>:history` to one stream). These are not the same number.
2. **History is an append-only, put-only event log.** The five record-put events embed the **full
   record** at its `_version`: `object.put` (`graph-image-service.js:194`), `shape.put`,
   `code-artifact.put`, `lexical-environment.put`, `block.put`. The two image events are different:
   `image.created` (`:98`) carries the full image record; `image.root-set` (`:383`) carries only
   `{rootObjectId, imageVersion, at}` — the only mutable image-record fields. (Only `createImage` and
   `setRoot` write the image record, so the image record at F folds from `image.created` plus each
   later `image.root-set`.) The event's `revision` is its **position in the ordered stream**, assigned
   at append and stripped from the stored payload (`:121`,`:135`) — it is *not* a field inside events.
   **There are no deletion or tombstone events anywhere**; KV records are never removed (put overwrites
   in place). The log is monotonically growing.
3. **`readStream({afterRevision})`** reads the ordered events after a revision (`:145-152`); the
   stream-head revision row is the HWM.
4. **There is no frontier primitive.** `snapshot(imageId)` (`graph-image-service.js:393-397`) is the
   only "captured state" today, and it is **not** a frontier: it stores a **full materialized copy**
   (`records: await this.listRecords(imageId)`) with **no revision anchor**, captured **non-atomically**
   (`getImage` then a separate `listRecords`, no transaction) and written via a bare `backend.put`
   (`:396`) that appends **no** history event. A concurrent write between the read and the scan can
   make the copy correspond to **no single stream position** — it is not even a consistent cut.

So a logical frontier does not exist yet; this ADR defines it. It is deliberately **not** defined in
terms of today's `snapshot()` representation.

## Decision

### Q1 — frontier identity (decided)

An **image frontier F** is the logical state of *one image* as of a committed **history-stream
revision F** (the per-image high-water mark). A frontier is identified by that per-image revision —
which already exists, is monotonic, and is the natural position axis.

A frontier is a **whole-image position**, categorically distinct from `pin:<object>@R`, which is **one
record's per-record `_version`** (ADR 0069). These two axes must **not** be collapsed into one number:
pinning object `X` to a global stream position would be a category error (it would pin every object),
and a frontier cannot name one record's staleness. Revision granularity is **per-event**, not
per-transaction (`putObjects` appends N events in one transaction, `:228-244`).

### Q2 — what state a frontier denotes (decided)

Frontier F denotes the **fold of the image's ordered event stream up to and including revision F**:
the image record (from the latest `image.created` / `image.root-set` at or before F — a frontier
without the image record has no root), **plus**, for every record id, the latest record-version whose
event position is `<= F`, across all record kinds (`object`, `shape`, `code-artifact`,
`lexical-environment`, `block`).

This is a **logical, derivable view** — reconstructable by replaying events in revision order up to
F — **not** a full materialized copy. Because the record-put events carry full records and the image
record folds from `image.created` + `image.root-set` (above), folding is well-defined for the current
event-type set. Frontier semantics are **not** defined by today's
`snapshot()`: that API is unanchored, non-atomic, and invisible to the history stream, so it is **not
valid evidence** of "a captured state at F" and must not be retrofitted as a compaction base without
adding a revision anchor and atomic capture (see Open unknowns).

### Q3 — what retention guarantees (form decided; one bound gated on an unknown)

The **logical** retention rule, stated for the current **put-only** log:

- **(a)** every durable `pin:<object>@R` protects the target record's version `R` from collection
  (version `R` is reconstructable only from the `object.put` event that wrote it, so protecting `R`
  means retaining that event);
- **(b)** an explicitly retained frontier `F` protects the history required to reconstruct `F` — given
  a base snapshot at revision `B < F`, that is the **full event segment `B+1 .. F`** (no per-event
  cherry-picking is guaranteed safe without a liveness analysis this ADR does not define).
  Absent any base, it is the full prefix `origin .. F`;
- **(c)** a snapshot **may** establish a compaction point — a base state at a revision from which
  later events re-derive later frontiers — *but only once it is anchored and atomic* (today's
  `snapshot()` is neither);
- **(d)** history events older than the oldest protected point may be collected — **where "oldest
  protected point" is well-defined only for a put-only log.** Today any prefix is self-contained (any
  prefix reconstructs its own frontier), so (d) is sound *only because deletion does not exist*.

**(d) is gated on the deletion/tombstone open unknown below** — the moment deletion is introduced,
"required to reconstruct F" must account for tombstone ordering, and the bound changes kind. This ADR
establishes the logical rule (a)–(c) and the *form* of (d); it **defers the GC algorithm entirely**.

### Q4 — readability and retention are separate (decided)

Extends ADR 0069's Q2:

- **retained ≠ authorized** — a historical state may physically exist without the principal being
  entitled to read it (historical reads are separately authorized, not inherited from
  `object/read(current)`);
- **authorized ≠ retained** — a caller may hold history-read authority yet request a revision that has
  legitimately been collected.

This yields four failure semantics that must not be conflated. Their implementability on this
substrate differs and is recorded honestly:

| failure | distinguishable? |
|---|---|
| (i) **unauthorized** (no history-read grant) | implementable — pure authority check, orthogonal to storage |
| (iv) **backend failure** | implementable — distinct thrown error type |
| (ii) **historical revision not retained** vs (iii) **never existed**, for a **frontier F** | implementable **iff** the stream-head HWM row is never collected: `F > HWM` ⇒ never existed; `F <= HWM` but events missing ⇒ collected |
| (ii) vs (iii), for a **pin `pin:obj@R`** | **aspirational** — a never-written and a superseded-then-collected record-version both yield "no event found"; there is no per-record version HWM the substrate retains |

**Retention invariant (required for the frontier (ii)/(iii) distinction): the per-image stream-head
revision row is never collected.** Pin-level (ii)/(iii) separation requires retaining per-record
version metadata the substrate does not currently keep — recorded as an unknown, not asserted.

### Q5 — relationship to Project history (single-image decided; cross-image is an unknown)

The frontier concept must later support Project working-frontier, branch base, `diff A..B`, and merge
bases **without a second notion of historical image position**.

- **Within one image** (decided): the monotonic per-image revision is a **total order**, sufficient
  for `diff A..B` (fold events in `(A, B]`, or compare the two record-version maps) and for a merge
  base (one image's committed history is today a *linear* sequence, so the greatest common frontier
  of two tips is well-defined). A Project working-frontier/branch-base that lives in one image is, at
  the substrate level, a named/retained frontier.
- **Across images** (open unknown): a Project is **not** single-image (roadmap §8 mixes image-native
  and OpenSmalltalkVM-backed code; refs are cross-image `{imageId, objectId}`). Each image has an
  **independent** revision axis, so two per-image revisions from different images have **no ordering**.
  A **Project-level frontier is a map `{imageId → revision}`**, not one number; cross-image merge base
  is only a partial (product) order and requires a **Project-level sequencing decision** (e.g. a
  Project commit that records the per-image frontier map atomically). That is a §8 decision this ADR
  deliberately does **not** make.

## Open unknowns (recorded, not decided — these gate the next step)

1. **Deletion / tombstone semantics.** The log is put-only; nothing is ever deleted. Q3(d)'s
   collection bound holds only by that accident. Introducing deletion re-opens Q3(d) and changes Q2's
   replay (a record present at F but deleted before a later frontier G needs its put *and* the
   tombstone ordering retained). Decide the deletion model **before** any GC algorithm.
2. **Snapshot anchoring + atomic capture.** Today's `snapshot()` is unanchored and non-atomic, so it
   cannot serve as a compaction base. A usable compaction snapshot needs a revision anchor and an
   atomic (transactional) capture. Deferred to the §7 snapshot work.
3. **Cross-image / Project-level frontier composition.** A Project frontier is a `{imageId →
   revision}` map with only a partial order; merge base across images needs a §8 Project-sequencing
   decision. Not a §7 question.

If these cannot be decided soundly when the §7 implementation is pulled down, record the further
unknowns and stop again — the environment should pull the next substrate implementation down against
real requirements.

## What this ADR does NOT build

Explicitly out of scope (each falls out separately, under real downward pressure, citing this ADR):
revision-aware / as-of reads; historical-read grants (the authority shape is decided with retention —
ADR 0069); garbage collection; history compaction; a new snapshot engine; branch objects; merge; any
new authority. This ADR only makes those future operations agree on what a historical point means and
what keeps it reconstructable.

## Consequences

- ADR 0069's blocker is now resolved at the **semantic** level: a first-class revision-pinned read can
  be designed against (a) `pin` = per-record `_version` (0069), (b) frontier = per-image history
  revision (this ADR Q1/Q2), and (c) retention rules (Q3) + the stream-head invariant (Q4). The read
  itself is still **not built** — it is gated on the deletion/snapshot unknowns and on real demand.
- The §7 GC work has its logical retention rule (a)–(c) and knows (d) is bounded by the deletion
  unknown; it must not ship a GC algorithm before deciding deletion semantics.
- The §8 Project work knows a Project frontier is a per-image frontier **map**, and that cross-image
  merge base is a §8 sequencing decision, not something §7 provides for free.
- The existing `snapshot()` is flagged as **not** a frontier and not a compaction base — a future
  agent must not build on it as though it were.

## Guardrails

```text
image frontier F   = the image's logical state as of committed per-image history-stream revision F.
                     A whole-image position (monotonic, total-ordered within one image).
pin:<object>@R     = one record's per-record _version = R (ADR 0069). A DIFFERENT axis. Do not
                     collapse frontier and pin into one number.
frontier state     = fold of the ordered event stream up to F (image record + latest version <= F
                     per record id). Derivable by replay; NOT a full materialized copy; NOT defined
                     by today's snapshot() (which is unanchored, non-atomic, stream-invisible).
retention          = durable pin:obj@R protects record-version R; a retained frontier F protects the
                     full event segment from its base to F; a snapshot may compact ONLY once anchored
                     + atomic. Collection below the oldest protected point is sound ONLY for a
                     put-only log — deletion/tombstones re-open that bound (open unknown).
readability        = retained != authorized; authorized != retained. Four distinct failures:
                     unauthorized / not-retained / never-existed / backend-failure. Frontier
                     not-retained vs never-existed requires the stream-head HWM never be collected;
                     pin-level separation is aspirational (no per-record version HWM is retained).
Project frontier   = within one image, a total order (sufficient for diff A..B and merge base);
                     across images, a {imageId -> revision} map with only a partial order — cross-
                     image merge base is a separate §8 Project-sequencing decision.
```
