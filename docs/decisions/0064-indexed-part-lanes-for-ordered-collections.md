# ADR 0064: indexed-part lanes for ordered collections

Status: accepted — decision-only; implementation is its own task with its own proof list.

## Problem

ADR 0047 gave objects an ordered **indexed part** whose elements are canonical Values — including
`ref`/`pinned-ref` — and made an indexed ref a first-class graph edge everywhere an edge is read
(`referencesOfRecord` walks `record.indexed`). That is the substrate's native ordered-ref
collection. But ADR 0047 deferred one thing as an interface question: **"projecting or mutating an
indexed part across a callable interface."** Every authorized lane today stops short of it:

- the **creation** lane only ever creates a *zero-length* indexed part
  (`image-creation-binding.js`: `indexed = shape.indexed === VALUES ? [] : null`);
- the **mutation** lane preserves the indexed part verbatim but cannot write it;
- the **projection** lane *refuses* indexed objects outright ("v1 maps named slots only").

The first consumer has arrived. `lagrange-object-environment` needs to persist a Perspective whose
ordered `presentations` list is, semantically, an ordered collection of refs (issue #119). It
cannot reach the indexed part through any authorized lane. The proposal is careful about what it
does **not** ask for — and it is right on each point, so they are stated as accepted constraints
here, not re-litigated:

- **No nested Value kinds** — ADR 0035: "No `list`, `record`, `tuple`, `option` or `result` Value
  kind is introduced." The `presentations` array cannot be a single field.
- **No refs buried in composites** — the flat walker resolves edges only through slot/indexed
  Values; a ref in a composite is an invisible edge (`composite-codec.js` `assertRefFree`).
- **No metadata-write lane** — the environment relocates `title`/`layout`/`formatVersion` to leaf
  text slots instead.

The environment amends its own ADR 0008 in parallel (each presentation becomes a child image object;
the Perspective holds the ordered presentation refs in its indexed part). This ADR is the substrate
half: un-defer the indexed part at the interface, narrowly.

## Decision

### 1. Creation with initial indexed elements

The creation lane's value record may supply **initial indexed elements** when the class's instance
Shape declares `indexed: values`. The interface expresses them as a record field of structural type
`{kind: 'list', element: ...}` — the type grammar already supports `list` (type-grammar.js §76),
and the field is **excluded from the slot layout**: it populates the indexed part, not a slot. A
class whose Shape is not indexed refuses an indexed field; an indexed class with no indexed field
creates the zero-length form exactly as today (`basicNew` parity, ADR 0046).

Elements are constrained to what the indexed part can lawfully hold *and* the boundary can
authorize. Two element kinds, matching the slot rule:

- **Leaf scalars** (`bool`/`s32`/`s64`/`f32`/`f64`/`string`) — canonicalized host-side, like a
  non-edge slot field.
- **Ref elements, as strings** — each element is a target id (or `pin:<id>@<rev>`), canonicalized
  to a `ref`/`pinned-ref` host-side, exactly as §4 of ADR 0062 does for a ref *slot*. The string
  seam is where a transient-looking id is refused (require-time) and where the write-seam guard is
  the backstop — unchanged.

A nested record/list *inside* an indexed element is refused for the same reason nested slot values
are refused (ADR 0035's Value model). This ADR does not touch that.

### 2. Indexed ref elements reuse per-target `object/edge-write` — no new operation

An indexed ref element **is** a graph edge (ADR 0047 §4; `referencesOfRecord` walks it). It is
therefore authorized by the **same** mechanism ADR 0062 §4 established for a ref slot: writing an
element naming target `T` triggers a separate `require({operation: 'object/edge-write', resource:
objectResource(imageId, T)})` per element. Create-on-class plus edge-write-per-target composes two
narrow grants rather than widening one (ADR 0042 §7: authority for A must not imply authority for
what A points at).

**Why not a new grant shape.** The operation's meaning — "create a permanent, walk-visible edge to
T" — is identical whether the edge lives in a named slot or an indexed element. The walker treats
them identically; the authority should too. A distinct `object/indexed-edge-write` would assert a
distinction the graph model explicitly does not make, and would double the surface a grantor must
reason about for zero additional selectivity (the resource is already the *target*, which is where
the narrowness lives). The falsification the proposal offers — "the owner rules indexed edges need a
new operation" — is rejected on exactly this ground: position in the record is not an authority
distinction.

A transient-looking element id is refused at require-time (clean error) with the write-seam guard as
backstop — the same two-layer pinning ADR 0062 §4 and `test/residency-creation-durability.test.js`
establish for slot edges.

### 3. Indexed elements travel ref-free; canonicalization is where edges appear

The `list<string>` of target ids is **ref-free** under `assertRefFree` (strings are not refs), so it
crosses the boundary legally and stays **invisible to the flat walker** while it is a string. An
edge becomes visible only when the lane canonicalizes the string to a `ref`/`pinned-ref` — which is
precisely where the per-target `require` fires. So the safety invariant holds by construction: no
edge is created without its grant, and no string is walkable as an edge before it is authorized.
This is the ADR 0062 §4 string-seam argument applied element-wise; nothing new is asserted.

### 4. Indexed-aware read: `object/read`-level is sufficient for v1

The projection lane's indexed refusal **stays** for v1. ADR 0047 named the reason: returning only
named slots for an indexed object would make a partial object look complete to foreign code, and
silently dropping the indexed part would be a defect. Lifting that refusal is a *projection
interface-shape* decision (how is an ordered, possibly-large, ref-bearing collection represented in
the projection record?) that this ADR does not need to make, because the first consumer does not
need projection:

- The environment reads back through **`object/read`-level access** — the existing, already-
  authorized `getObject`/`listRecords` host path, which returns the whole record including
  `indexed`. That is sufficient to reconstruct a Perspective and is what the proposal assumes.
- A future indexed-aware *projection* is a separate, separable decision (its own interface shape and
  its own ADR if pressure arrives). This ADR un-defers the **write/create** half of ADR 0047's
  deferred item and **leaves the projection half deferred**.

### 5. Indexed-aware mutation is separable, not required for v1

ADR 0047 deferred "projecting **or** mutating" as one item, but the first consumer's flow is
create-then-read, not mutate-in-place. Growing the indexed part of an *existing* Perspective
(append/remove a presentation) is indexed-aware **mutation** — a whole-record rewrite that replaces
the indexed part under the mutation lane's version-token CAS. That is a coherent, separable next
slice with the same per-target edge-grant rule for any newly-added ref element. This ADR accepts
**creation with initial elements** now and names indexed mutation the adjacent follow-up rather than
absorbing it, keeping this slice minimal (one semantic change per PR). Removal of an indexed element
is edge **removal**, which ADR 0062 §8 already defers.

### 6. Honest v1 cost (accepted, stated plainly)

Saving a Perspective creates 1 + N objects (presentations, then the Perspective) with **no
multi-record transaction** — that remains deferred (ADR 0062 §8). The environment mitigates by
ordering: create presentations first, the Perspective last, so the Perspective object is the commit
point and no half-built Perspective references a not-yet-existing child. Each individual creation is
atomic (insert-only, `putWithHistory`). Orphan presentation objects are possible on the change feed;
a half-built Perspective is not. This degradation from "one durable unit" is real and accepted;
multi-record transactions are the deferred work that would remove it.

### 7. Binding seams

Extends `src/callable/image-creation-binding.js` (no new lane, no new operation): the binding's
field mapping gains an optional indexed-field marker, and the executor grows an indexed-construction
step beside the slot loop — same require-first, per-target-edge-grant, mint-explicit-id, atomic
pattern. The `callable-interface/v2` artifact declares the indexed field as `{kind:'list',
element:...}`. Proof list in the implementation task covers: indexed-field-on-non-indexed-class
refusal; per-target edge grant for each ref element (plain + pinned); transient element refusal
before any write; zero-length parity when no indexed field is supplied; the created indexed part is
walk-visible (`referencesOfRecord`); no projection change; and a restart/recovery proof alongside
`test/residency-creation-durability.test.js`. `docs/seams.md` and `docs/ownership.md` are updated if
the interaction row's wording changes (it already names the creation lane).

## Consequences

- The environment can persist a Perspective's ordered collection through an authorized lane, with no
  unguarded `putObject` and no shadow semantics.
- The grant algebra stays v0 exact-match: one grant per instantiable class, plus one grant per edge
  target — whether the edge is a slot or an indexed element. No wildcards, no new operations.
- ADR 0035 (Value model), the flat-walker invariant, and metadata semantics are untouched. The only
  change is un-deferring one interface boundary on a model the substrate already decided.
- Indexed-aware mutation and projection remain explicitly deferred, each a coherent separable slice.

## Guardrails

```text
indexed ref element is a graph edge              (referencesOfRecord walks record.indexed)
indexed ref element reuses object/edge-write      (per-target, no new operation — narrow != broad)
elements travel ref-free (strings)                (an edge appears only at canonicalize+require time)
a transient element cannot commit                 (require-time refusal + write-seam backstop)
indexed field only on an indexed Shape            (non-indexed class refuses; absent field = zero-length)
no nested composite inside an element             (ADR 0035 Value model, unchanged)
no refs inside composites                         (assertRefFree, unchanged)
no metadata-write lane introduced                 (environment uses leaf text slots)
projection indexed-refusal stays in v1            (object/read-level read suffices for the consumer)
indexed-aware mutation is a separable follow-up   (create-then-read is the consumer's flow)
element removal is edge removal                   (already deferred, ADR 0062 §8)
multi-record transactions stay deferred           (creation ordered so the Perspective is the commit point)
```
