# ADR 0065: indexed-aware mutation (append and reorder; removal deferred)

Status: accepted — decision-only; implementation is its own task with its own proof list.

## Problem

ADR 0064 let the creation lane create an object *with* an initial indexed part. It deliberately left
changing that part **after** creation as the adjacent follow-up (ADR 0064 §5). The first consumer's
need is now concrete: `lagrange-object-environment`'s ADR 0012 names *"revisit condition: delivery
of lagrange-images#119"* (delivered) and migrates a Perspective's ordered membership into its
indexed part (`formatVersion` 3). Once membership lives there, a live session must **add** a
presentation, **reorder** presentations, and eventually **remove** one — on the *existing*
Perspective object, not by recreating it (recreating breaks the "Perspective is the durable
identity" model and the change-feed semantics).

Two decided invariants stand in the way, and both are honored here rather than weakened:

- ADR 0042 §7: *"v1 cannot create a graph edge at all"* in the mutation lane, and *"future edge
  mutation ≠ automatically under `object/write`... changing an edge changes topology and
  reachability... it plausibly deserves its own authority and its own ADR."* This is that ADR.
- ADR 0062 §8 deferred **edge removal** explicitly: a created edge is permanent across v1 lanes.

So the question is narrow: how may an authorized caller append and reorder the indexed part of an
existing object, with edge *addition* authorized per-target exactly as ADR 0062/0064 established,
while edge *removal* stays deferred?

## Decision

### 1. The mutation lane gains an indexed field; it rewrites the indexed part under the same CAS

A mutation binding may declare **one indexed field** (`indexed: true`, mutually exclusive with
naming a slot; at most one per binding — the same rule ADR 0064 added to creation). Its value is a
ref-free `list`. The mutation is still a **whole-record rewrite** under the version-token CAS
(`putObject(…, {expectedVersion})`): the slots are mutated as today, the indexed part is replaced by
the field's list, and `object.metadata` is preserved. Conflict stays explicit (never
last-writer-wins, never a silent retry — ADR 0042 guardrail).

The CAS is what makes indexed mutation safe under concurrency: two sessions appending to one
Perspective conflict on the version token, and the loser retries against fresh state rather than
silently dropping the winner's element. This is the same guarantee the mutation lane already gives
for slots, extended to the indexed part of the same record.

### 2. Three element-level operations, three authority rules

The lane distinguishes what the new list *does* to the old indexed part, because the authority that
must be satisfied differs per case. Let `old` be the existing indexed part and `new` the field's
list:

- **Append leaf elements** (`new` ⊇ `old` as a prefix, added elements are scalars): no edge is
  created or removed. This is the indexed analogue of a leaf slot write and is authorized by the
  existing **`object/write`** grant on the object alone.
- **Append ref elements** (added elements are ref-target strings): each *added* ref creates a new
  graph edge to a target. Honoring ADR 0042 §7 ("future edge mutation ≠ automatically under
  `object/write`"), each added ref element requires a **separate per-target
  `require({operation: 'object/edge-write', resource: objectResource(imageId, T)})`** — the same
  grant ADR 0062 §4 and ADR 0064 §2 use, no new operation. `object/write` authorizes the object;
  `object/edge-write` authorizes each new edge. Narrow authority cannot become broad reach: a caller
  holding `object/write` but not `object/edge-write` on a target cannot add an edge to it.
- **Reorder** (`new` is a permutation of `old` — same elements, same multiset, different order, per
  the identity rule in §3): topology is unchanged (no edge created, none removed), only sequence.
  This is authorized by **`object/write`** alone. Reorder is what "move a presentation up/down"
  needs. Note this holds *only* under the multiset-with-identity rule: a "reorder" that re-pins an
  element (`ref T` → `pin:T@rev`) is not a permutation — it drops one edge occurrence and adds a
  different one — and is governed by the append-ref and shrink rules, not this one.

Added ref elements travel as ref-free strings (plain id or `pin:<id>@<rev>`), canonicalized
host-side with the per-target grant firing at that point — the ADR 0062 §4 / ADR 0064 §3 string
seam, applied to mutation. Transient targets are refused require-time with the write-seam guard as
backstop.

### 3. Element removal stays deferred — this lane cannot shrink the indexed part

`new` must contain every element of `old` (as a multiset): the lane may append and reorder but
**never drop an element**. Removing an indexed ref is **edge removal**, which ADR 0062 §8 deferred
and which is a genuinely different authority question — it interacts with garbage collection (an
edge's removal can make a subgraph unreachable), with pinned refs (dropping a pinned edge discards
its revision frontier, a history-semantics question per ADR 0002), and with the change feed (a
removal must be observable). Those considerations deserve their own ADR rather than being smuggled
into a mutation lane as "just another list value." A binding whose `new` list is missing an element
of `old` is refused.

**Element identity, stated precisely so the rule is falsifiable.** Whether a `new` element "is" an
`old` element is decided by **canonical-Value identity**: two `ref`s are the same element iff they
share `(imageId, objectId)`; two `pinned-ref`s iff they share `(imageId, objectId, revision)`; a
`ref` and a `pinned-ref` are never the same element (a `ref T` → `pin:T@rev` change drops the plain
edge and adds a pinned one — refused as a shrink of the plain edge, not treated as a no-op
re-pinning); two leaf Values are the same element iff canonically equal. This is the only reading
under which the multiset rule and the reorder rule are sound, and it is what the proof list pins.

This is the scope the environment's current model supports: it is command-based and additive
("add presentations" is a named operation; no "remove presentation" lifecycle operation exists in
its ADRs), and its formatVersion-3 migration *moves* membership rather than deleting presentations.
**The question was put to the environment on #119 (whether shrink is ever required); this ADR's
narrow scope holds unless that answer says otherwise, and widening to removal is a clean follow-up
ADR, not a rework of this one.**

### 4. Why not recreate, and why not a new lane

Recreating the Perspective per edit would mint a new durable identity each time, orphaning the old
object on the change feed and breaking the "Perspective is the durable identity" invariant — the
cost ADR 0064 §6 already accepted *once* at creation, not per edit. A separate `indexed-mutation`
lane would duplicate the mutation lane's require-first / CAS / preserve-slots machinery for no
authority distinction: the operation *is* an object write, with the edge-addition part carved out
per-target exactly as ADR 0042 §7 demanded. Extending the existing lane keeps one owner for the
"authorized image mutation" boundary (docs/ownership.md).

### 5. Binding seams

Extends `src/callable/image-mutation-binding.js` (no new representation, no new operation):
`normalizeMutationFields` / `assertMutationInterface` gain the indexed-field carve ADR 0064 added
to creation (a ref-free `list` field, leaf element, `edge`-list element = `string`); the executor
builds the new indexed part via the append/reorder/shrink-refuse rule of §2–3, reusing
`parseEdgeTarget` and the per-target require. Proof list in the implementation task covers: append
leaf under `object/write` alone; append ref denied without the per-target grant (falsifiable) and
permitted with it (plain + pinned); reorder under `object/write` alone with no edge grant; shrink
refused; transient added element refused before write; indexed field on a non-indexed object
refused; CAS conflict on concurrent appends; slots and metadata preserved; the write-seam transient
guard as backstop. `docs/seams.md` updated (the mutation lane's field map is no longer
named-slot-only). The projection lane's indexed refusal is unchanged (ADR 0064 §4).

## Consequences

- The environment can add and reorder presentations on a live Perspective through an authorized
  lane, per-edit, without recreating the object — unblocking its formatVersion-3 migration.
- Edge *addition* authority is unified across creation (ADR 0062 §4), indexed creation (ADR 0064 §2),
  and indexed mutation (here): always per-target `object/edge-write`, never implied by
  `object/create` or `object/write`. One rule, three lanes.
- Edge *removal* remains a deferred, separate authority decision with its GC/pinned-ref/change-feed
  considerations intact. The concurrency guarantee for indexed mutation is the existing version-token
  CAS.
- The grant algebra stays v0 exact-match: `object/write` for the object, one `object/edge-write`
  grant per **distinct added ref target**. No wildcards, no new operations. Note for grantors:
  because grants are exact-match and not consumed, `object/edge-write` on `T` authorizes *any number
  of* parallel edges to `T` on that object (appending `[T, pin:T@1]` to `[T]` rides on the single
  `T` grant) — the same semantics ADR 0062 §4 already gives creation. The narrowness lives in the
  target, not in an edge count.

## Guardrails

```text
indexed mutation rewrites the indexed part under the same version-token CAS (conflict stays explicit)
one indexed field per binding, mutually exclusive with naming a slot (as ADR 0064)
append leaf elements       -> object/write alone         (no edge created)
append ref elements        -> + object/edge-write per distinct added target (ADR 0042 §7 honored)
element identity is canonical-Value identity            (pinned-ref identity includes its revision)
reorder existing elements  -> object/write alone         (topology unchanged, no edge added/removed)
added refs travel as ref-free strings, canonicalized with the per-target grant (ADR 0062 §4 seam)
a transient added element cannot commit                (require-time refusal + write-seam backstop)
element removal stays deferred                          (edge removal, ADR 0062 §8: GC/pinned/change-feed)
a shrunk indexed part is refused                        (new must contain every element of old)
slots and metadata preserved on the whole-record rewrite
indexed field on a non-indexed object refused
the projection lane's indexed refusal is unchanged      (indexed projection still deferred, ADR 0064 §4)
edge mutation is NOT plain object/write                 (edge addition carries its own per-target grant)
```
