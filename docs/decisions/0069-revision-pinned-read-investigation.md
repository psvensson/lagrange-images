# ADR 0069: revision-pinned read — a design investigation

Status: accepted — investigation outcome. **Do not implement as-of historical reads yet.** The
investigation pins down what `pin:<id>@<revision>` denotes and answers the authority question, and
concludes that a correct revision-pinned read depends on history-retention / revision-frontier
semantics that are still unbuilt roadmap items (§7). A narrow, honest interim is available and noted;
the full feature is deferred with falsifiable triggers.

## Problem

Bead `gyr` (surfaced by the environment's inspector slice, env Bead 61r): `ObjectNavigator` accepts a
`pinned-ref` subject (`pin:<id>@<rev>`) but **ignores the revision** — the read seam
(`ImageService.getObject`) reads current state and has no revision parameter, so `pin:<id>@<rev>`
does **not** pin the read to that revision. The environment can carry a revision in a pinned-ref
Value (ADR 0008) but cannot read *as-of* it. It currently presents a semantic promise it cannot
uphold.

## Recon: what "revision" actually is today

Three facts from the code establish the ground truth:

1. **A pinned-ref's `revision` is uninterpreted.** `pinnedRef(imageId, objectId, revision)` stores
   free-form text/integer (`src/value/scalars.js:71-76`); the creation/mutation lanes parse
   `pin:<id>@<rev>` and canonicalize it (`image-creation-binding.js:259`,
   `image-mutation-binding.js:237`) but **never read or interpret the revision**. The Value is
   self-describing but the substrate attaches no meaning to the field.
2. **The substrate has two distinct version notions.** (a) the backend's **per-record `_version`** —
   optimistic concurrency, incremented on each write to *that record* (`lagrange-backend.js:61-90`,
   `expectedVersion` CAS); (b) the **event-stream `revision`** — a global per-stream (per-image
   history) sequence (`lagrange-backend.js:117-137`). These are not the same number and must not be
   conflated.
3. **There is no as-of read.** `getObject` reads current state only (`graph-image-service.js:248-251`,
   funnelling through `getRecord` at `:142-145`, via `backend.get`). History is an **append-only event log** (`readStream`,
   `graph-image-service.js:388-390`); each `object.put` event embeds a full `structuredClone` of the
   record at that `_version` (`:194`). So the historical state of an object at record-version `R` is
   *reconstructable from the history events*, not addressable as a first-class read.

**History retention / revision frontiers / GC are unbuilt.** Roadmap §7 lists "logical
snapshot/revision frontiers" and "garbage-collection rules respecting history and pinned refs" as open
items. How far back a revision remains readable, and what a pinned ref protects from collection, is
**undefined** today.

## The two questions `gyr` must answer

### Q1 — what does `pin:<id>@<revision>` promise? (the semantic question)

The revision denotes the **target record's `_version`** — the per-record optimistic-concurrency
version — *not* the global event-stream revision. Rationale:

- A pinned-ref pins **one object** (`imageId`, `objectId`), so the revision must be a property of
  *that object*. The event-stream revision is a property of the whole image's history, not of one
  record; pinning object `X` to a global stream position would be a category error (it would also pin
  every other object).
- The version token (ADR 0042/0062) already scopes concurrency to one object via `_version`; a
  pinned-ref's revision is the same per-record axis, used for *identity/staleness* rather than CAS.
- The `object.put` history event embeds the record at each `_version`, so "the state of object `X` at
  record-version `R`" is well-defined and reconstructable.

So: **`pin:<id>@R` promises "the object `id`, specifically at its record-version `R`"** — a
stable, immutable reference to one historical state of one object. What it does *not* yet promise is
that this state is **retained and readable** — that depends on the unbuilt frontier/GC semantics.

### Q2 — does `object/read(current)` automatically authorize `object/read(revision R)`? (the authority question)

**No — and the default must not assume yes.** The grant `object/read(imageId, objectId)` authorizes
reading the object **as it is now**. A historical revision `R` is a *different state* of the same
identity, and it may carry information the caller is **no longer** entitled to see:

- A slot that was overwritten may have held a secret, a different ref, or PII at `R`.
- Once ownership/collaboration enters the environment, authority over "the object now" and authority
  over "every state the object has ever had" are genuinely different grants.

This is the same discipline ADR 0068 applied to refs: identity is not authority, and *currency* is
not *history*. The safe default is that **historical reads are separately authorized**, not inherited
from current-read. The exact grant shape (e.g. `object/read-history`, or `object/read` extended with
a revision qualifier, or a per-image history-read grant) is a real design decision that should be made
**against the retention semantics**, not guessed now — because the answer to "who may read history" is
entangled with "how much history exists and what GC preserves."

## Why not implement now

A correct revision-pinned read needs three things that are **not yet decided or built**:

1. **Retention semantics** — how far back `R` is guaranteed readable (frontiers, snapshots, GC
   respecting pinned refs). Without this, "read `R`" can silently fail or read a partially-collected
   past. (Roadmap §7, unbuilt.)
2. **The authority shape** for historical reads (Q2) — which depends on (1), because "who may read
   how much history" is one question, not two.
3. **A read path** that reconstructs state-at-`R` from the history events (or from a future
   snapshot/frontier store) under that authority.

Implementing the read path now, before (1) and (2), would bake in an authority assumption (likely the
wrong "current-read implies history-read") and a retention assumption (likely "history is unbounded")
that the deferred §7 work would then have to retro-fit. That is exactly the retrofit-trap this
repository's "decide against actual requirements" rule (ADR 0037 §6) exists to avoid.

## The honest interim (what the environment can do today)

Because each `object.put` history event embeds the full record at its `_version`, a caller with
**history-stream access** can *already* reconstruct "object `X` at version `R`" by scanning
`history(imageId)` for the `object.put` event with `objectId = X` and `objectVersion = R`. Two honest
frictions: the stream is **unindexed and whole-log** (no per-object or per-version index, so the scan
is O(history length) and reads events for every object), and it serves **object records only** — a
pinned-ref to a version that was never written, or to a non-object record (a `shape.put`/`block.put`
at a colliding id), produces no matching event. This is:

- **not a new substrate capability** — it uses the existing append-only history read;
- **subject to the history stream's own authority** (a separate question from `object/read`), which
  is the correct place for the "who may see history" decision to live;
- **bounded by retention** — only as far back as the history stream is kept.

So the environment's *immediate* need (show a pinned Perspective as-of a revision it carries) is
serviceable **without a new substrate lane**, by reading the history stream — provided the caller is
authorized for that stream. The substrate work that `gyr` would add (a first-class as-of read) is a
*convenience and a contract*, not a missing capability, and it should be designed together with the
retention/frontier semantics it depends on.

## Decision

**Defer the first-class revision-pinned read.** Establish the two answers above as the contract for
when it is built:

- `pin:<id>@R` means "object `id` at its per-record `_version = R`" — an immutable reference to one
  historical state of one object (not a global stream position).
- Historical reads are **separately authorized**, not inherited from `object/read(current)`. The
  grant shape is decided with the retention/frontier semantics.

**Do not** implement a `readObject`-as-of lane yet. The environment uses the **history-stream** read
for its current pinned-read need, under history-stream authority.

**Build it when** (falsifiable triggers): the §7 retention/frontier/GC semantics are decided (so "how
far back is `R` readable" is defined), **and** a real consumer needs a first-class as-of read rather
than the history-stream scan (e.g. it must read a specific revision without streaming the whole log,
or history-read authority must be finer-grained than whole-stream). At that point the lane, its
authority shape, and its retention bounds are designed **together** — and the two answers above are
the constraints it must satisfy.

## Consequences

- The semantic promise of `pin` is now **pinned down** (per-record `_version`), even though the read
  is not built — so the environment stops "presenting a promise it cannot uphold" ambiguously: it
  knows `pin` means record-version, and it serves it via the history stream.
- The authority default (**current-read does not imply history-read**) is recorded now, before any
  implementation can accidentally bake in the wrong inheritance.
- `gyr` is **resolved as an investigation**; implementation is a **separate, future** Bead gated on
  the §7 retention/frontier decision. This ADR links `gyr` to that dependency rather than resolving it.
- The roadmap §7 items (snapshot/revision frontiers, GC respecting pinned refs) are the **blocker**
  for the first-class read, and should cite this ADR's two answers as their read-side constraint.

## Guardrails

```text
pin:<id>@R  means: object `id` at its per-record _version = R  (immutable reference to one
  historical state of one object). It is NOT the global event-stream revision, and NOT a promise
  that R is retained/readable (retention/frontier semantics are unbuilt, roadmap §7).
a pinned-ref revision is currently UNINTERPRETED by the substrate; this ADR fixes its meaning
  without yet implementing an as-of read.
object/read(current) does NOT authorize object/read(history R): historical reads are separately
  authorized (currency is not history; identity is not authority). Grant shape decided WITH the
  retention/frontier semantics, not guessed now.
no first-class as-of read lane yet: the environment serves pinned reads via the existing history
  stream (each object.put event embeds the record at its _version), under history-stream authority.
build the first-class read only when §7 retention/frontier/GC is decided AND a consumer needs more
  than the history-stream scan; design the lane + authority + retention bounds together.
gyr: resolved as an investigation; implementation is a separate future Bead gated on §7.
```
