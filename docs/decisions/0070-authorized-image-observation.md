# ADR 0070: authorized image observation / history disclosure — a design investigation

Status: implemented
Proven by: test/image-observation-binding.test.js

**Adopted and implemented**: a metadata-only invalidation feed (contract 3), realized through
object-scoped filtering inside the substrate (contract 2's mechanism), with an opaque object-local
cursor. The lane is `image-observation-binding/v1`. Do NOT add a broad `image/history-read` grant
for normal observation. The first-class full-history read (for admin/history-browser use) stays a
separate, narrower decision gated on §7 retention semantics.

## Problem

`lagrange-object-environment` is now a security-sensitive client. Ordinary object reads are
authorized (ADR 0068 `image-object-read-binding/v1`). But its **live observation seam** still consumes
the **privileged full-image history stream**:

- `ImageService.history(imageId, {afterRevision})` is a bare pass-through to `backend.readStream`
  with **no `require`** (`graph-image-service.js:388-390`).
- Every `object.put` event embeds the **complete record** (`structuredClone(saved)`,
  `graph-image-service.js:194`) — not merely "object `X` changed." The environment's
  `image-observation.js` normalizes each event into a `Change` carrying `record: event.object`.
- The environment's `observe()` calls `images.history(...)` directly
  (`image-client-adapter.js:714`), with no authority.

So a principal authorized to `object/read(A)` but **not** `B` can receive `B`'s complete state through
the change feed. ADR 0009's "receiving a Change confers no authority" is true but answers the wrong
question: authority is required to **disclose** the data in the first place. The change feed is, after
ADR 0068 closed the read seam, **the remaining privileged data-read seam**.

**Question:** what may an environment user *observe* — without turning `object/read(A)` into read
access to every object that changes in the image?

## The invariant under tension

ADR 0037 / 0068: authority is exact-match, check-only `require`, and identity/currency is not
authority. A live view must learn "something I care about changed" without the feed itself becoming a
**second object-read mechanism** that bypasses `object/read`. Two failure modes to avoid:

1. **Over-disclosure**: the feed hands full records of objects the caller cannot `object/read`.
2. **Over-broad grant**: a single `image/history-read` grant that gives an ordinary inspector enormous
   authority merely to stay live.

## The three contracts

### Contract 1 — whole-image history authority

A grant `object/history-read(imageId)` (or similar) authorizes reading the raw stream. **Appropriate
for administration / a history browser**, where the principal is *meant* to see everything. **Far too
broad** for normal object presentations: any live inspector would need it, and it discloses every
object. Rejected as the *normal* observation contract (kept as a possible future, narrow, admin-only
grant — see Decision).

### Contract 2 — object-scoped observation (filter inside the substrate)

The caller observes with its authority; the substrate **filters the stream inside `lagrange-images`**,
emitting an event only for records the caller may `object/read`. History stays private below the
boundary; filtering happens **before** disclosure, not after. This is correct *in principle* — it is
the only way per-object authority is honored — but if the filtered events still carry **full records**,
the feed is still a second read mechanism (an authorized one, but a parallel read path with its own
snapshot semantics). On its own it duplicates `object/read` rather than composing with it.

### Contract 3 — metadata-only invalidation feed

The feed reveals **only** that "an object you may read changed" — the **identity** of the changed
object (and perhaps its kind), **never its state**. The environment then performs its **normal
authorized `readObject(A)`** (ADR 0068) to obtain the new state. This has the decisive property:
**state-disclosure authority already exists and stays in one place** (`object/read`); the feed is an
*invalidation signal*, not a read path. A live view generally needs "A changed; reread it," not a
historical copy of every changed object. It avoids making the change feed a second object-read
mechanism.

## The side channel: does the feed leak through *what it omits*?

Even a metadata-only feed can leak. Two distinct leaks must be decided explicitly:

- **Existence/activity leak via the global revision sequence.** The raw stream is one global per-image
  sequence (`revision` increments on every write to *any* object). If the substrate filters the stream
  but hands the consumer the **global revision cursor**, the consumer sees **gaps**: it asked for
  events after revision `N`, got an event at `N+4`, and can infer "three writes happened to objects I
  can't see." That reveals *activity elsewhere* — a real, if low-bandwidth, side channel.
- **Mitigation: an opaque, object-local cursor.** The feed must not expose the global revision to the
  consumer. Instead the substrate returns an **opaque cursor** (an uninterpreted token the consumer
  passes back, which internally encodes the global high-water mark) and emits only the *visible*
  events. The consumer cannot infer how many invisible writes occurred between two visible ones. The
  cursor is opaque (not a number the consumer can compare/gap-analyze) and object-local in spirit: it
  denotes "your position in the stream of *your visible* changes," not the image's global clock.

**Decision on the side channel:** leaking *activity elsewhere* via revision gaps is **not acceptable**
for the default observation contract. The feed uses an **opaque cursor**, not the raw global revision.
Three precisions, all required for the mitigation to actually hold:

- **Strip the per-event global `revision`.** The opaque cursor is the **only** ordering token. Emitted
  events must **not** carry the raw global `revision` (or must be re-sequenced with a per-consumer
  visible ordinal). This is load-bearing: the environment's existing `normalizeChange`
  (`image-observation.js:49,58,61,68`) currently copies `event.revision` onto every `Change`, which
  would silently re-open the gap channel the opaque cursor exists to close.
- **Scope the claim.** The opaque cursor closes the *gap-analysis / counting* channel only. It does
  **not** close the **timing** channel (in a pull model, a visible event's arrival time still
  correlates with activity bursts — low-bandwidth and unclosable) or the "at least one of my readable
  objects changed" channel. Those are accepted, not claimed closed.
- **Cursor integrity.** The opaque cursor must be **unforgeable** and **rollback-safe**: it is
  integrity-protected (server-side session state or an authenticated token), and reusing a stale
  cursor is an idempotent resume, never an oracle or a trap.

(Whether even "the *set* of objects I can read changed" is too much is a further reduction — a
per-object subscribe — noted as a possible refinement, not required for v1.)

## Decision

**Adopt contract 3, realized through contract 2's mechanism, with an opaque cursor.** Specifically:

- The observation seam is a **substrate-side filtered, metadata-only invalidation feed**. The caller
  supplies its authority; the substrate filters the history stream **inside `lagrange-images`** to
  records the caller may `object/read`, and emits only **identity + kind + opaque cursor** — never the
  record payload.
- **State disclosure stays in one place**: the environment obtains new state only via the existing
  authorized `readObject(A)` (ADR 0068). The feed never carries state.
- **The cursor is opaque** (not the raw global revision), so invisible writes leave no observable gap.
- **No new broad grant**: observation requires the caller to *already* hold `object/read` on the
  objects it observes; the feed discloses nothing beyond what those grants already authorize. (An
  object the caller cannot read simply never appears — and its absence is indistinguishable from "it
  didn't change," so no existence oracle is added.)
- **Contract 1 (whole-image history)** is **not** the normal observation path. If an admin /
  history-browser needs the full stream, that is a **separate, narrower** decision made with the §7
  retention/frontier semantics (the same gate as ADR 0069's first-class historical read), **not**
  something added "because it is easy."
- **Per-kind authority mapping.** The history stream carries **non-object records too** (shapes,
  blocks, code-artifacts, lexical-environments, `image.created`, `image.root-set`). The filter maps
  each event kind to its required grant: `object.put` → `object/read(thatObject)`; the non-object
  kinds either map to their own read grant (where one exists) or are **dropped** from the authorized
  feed until such a grant exists. The v1 feed emits object invalidations; broader kinds are opt-in.
- **Cursor and revision handling** per the side-channel decision above: opaque, integrity-protected,
  rollback-safe cursor; the per-event global `revision` is stripped (the cursor is the only ordering
  token).

This is intentionally **not** a large implementation. It is one authorized observation seam (filter +
metadata-only + opaque cursor) plus the rule that state moves only through `readObject`. Feasibility:
`require` is a synchronous, in-memory exact-match check (`authority-service.js`), so per-event
filtering inside `lagrange-images` is cheap, and the substrate owns `readStream`, so holding the raw
global cursor internally while handing back an opaque token is straightforward.

This is intentionally **not** a large implementation. It is one authorized observation seam (filter +
metadata-only + opaque cursor) plus the rule that state moves only through `readObject`.

## Relationship to ADR 0069 (historical reads)

This investigation **precedes** first-class historical reads, as ADR 0069 (amended) requires: the
change feed is the remaining privileged data-read seam, and it is fenced/closed here before any as-of
read is built. The metadata-only feed answers "did A change?" for *live* following; ADR 0069's pinned
historical read ("what was A at version R?") remains deferred on §7, and when built it will reuse the
*authorized-observation* authority model decided here (separate history authority, not inherited
current-read).

## Consequences

- The environment's `observe()` stops consuming the raw `history()` stream for restricted sessions;
  it consumes the authorized invalidation feed and rereads via `readObject`. The full-record
  disclosure hole closes.
- **Downstream contract change (named, not silent):** this supersedes env ADR 0009's normalized
  `Change` shape for the authorized feed — the `Change.record` payload (the full stored record,
  `image-observation.js`) becomes null/omitted for restricted consumers; the feed yields
  identity+kind+cursor only, and consumers reread. The environment's ADR 0009 and `image-observation`
  normalize/contract must be amended accordingly when this is implemented.
- The change feed is no longer a second object-read mechanism: it is an invalidation signal, and
  `object/read` remains the single state-disclosure authority.
- The global-revision activity side channel is closed by the opaque cursor.
- Implementation (a follow-on Bead): a substrate observation lane — authority-aware filter,
  metadata-only events, opaque cursor — plus the environment consuming it. Sized like a lane, not an
  architecture.

## Guardrails

```text
the raw history stream is a PRIVILEGED/INTERNAL seam (full records, no require). It is NOT an
  environment-facing observation contract for restricted principals.
authorized observation = a substrate-side FILTERED, METADATA-ONLY invalidation feed:
  caller supplies authority; lagrange-images filters the stream to records the caller may
  object/read; events carry identity + kind + opaque cursor, NEVER the record payload.
state disclosure stays in ONE place: new state is obtained only via authorized readObject (ADR 0068);
  the feed is an invalidation signal, NOT a second read mechanism.
the cursor is OPAQUE and the per-event global revision is STRIPPED (the cursor is the ONLY ordering
  token): invisible writes leave NO observable gap. The cursor is integrity-protected and
  rollback-safe (idempotent resume). This closes the gap-analysis/counting channel ONLY — the timing
  channel and the "some readable object changed" channel are accepted, not claimed closed. Not an
  object-existence oracle: an unreadable object's changes are indistinguishable from "no change."
  (Load-bearing: the env's normalizeChange currently copies event.revision onto every Change — that
  re-opens the gap and must be stripped for the authorized feed.)
per-kind authority mapping: object.put -> object/read(thatObject); non-object record kinds (shape/
  block/artifact/environment/root-set) map to their own read grant or are DROPPED from the authorized
  feed until one exists. v1 emits object invalidations.
NO broad image/history-read grant for normal observation. A whole-image history read (admin /
  history browser) is a SEPARATE, narrower decision gated on §7 retention semantics — same gate as
  ADR 0069's first-class historical read.
downstream contract change (named): supersedes env ADR 0009's Change.record (full payload) for the
  authorized feed — identity+kind+cursor only, consumers reread.
this precedes first-class historical reads (ADR 0069): the change feed is fenced/closed here first.
possible v1 refinement (not required): per-object subscribe to reduce even the "which of my readable
  objects changed" signal.
```
