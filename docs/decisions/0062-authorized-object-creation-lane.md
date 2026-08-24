# ADR 0062: authorized object-creation lane

Status: accepted — decision-only; implementation is its own task with its own proof list.

## Problem

ADR 0042 opened an authorized write lane for the scalar slots of an *existing* object
(`image-mutation-binding/v1`, operation `object/write`), and deliberately deferred creation, edge
creation, deletion, and multi-record writes. The first consumer has now arrived: the
`lagrange-object-environment` needs to save a Perspective — an ordinary durable image object with a
**mandatory ref slot** — and has no authorized way to create it (issue #113).

The two paths that exist are the wrong shape for it:

- `ImageService.putObject` performs **no authorization** — it is the host-side unguarded path, and
  the environment correctly refuses to shadow the lane with it.
- `image-mutation-binding/v1` **cannot create objects, delete objects, reshape, or write graph
  edges** (ADR 0042 §9), and refuses to write through any ref-holding slot.

ADR 0046 §10 anticipated exactly this boundary and named it: *"if object creation is later exposed
to foreign code, Components, external service interfaces or a cross-image mutation API, that is a
different boundary and should use an explicit authorized `object/create` contract."* This ADR is
that contract. It is also the "ref-valued edges get their own authority and their own ADR" that ADR
0042 §7 deferred — so this ADR consciously **amends the scope of ADR 0042's guardrail "v1 cannot
create a graph edge at all"**: that guardrail was about the *mutation* lane, and this is the
separate, separately-authorized edge authority ADR 0042 pointed at.

## Decision

### 1. A new `object/create` operation on a new `image-creation-binding/v1` lane

A distinct operation, not an overload of `object/write`. Creation has no existing object to
read-for-write, no unmapped slots to preserve, and no prior version to conflict against —
overloading would blur the granularity rule ADR 0042 §2–3 established. The lane is a new callable
binding representation `image-creation-binding/v1`, registered beside the projection/mutation
bindings, and following their shared pattern: the executor context destructures `{images, require}`
and nothing else authority-shaped; `imageId = code.imageId` (the image comes from the binding,
never the caller); `require` runs first, before any fetch.

### 2. Scope: per-(image, class), via `objectResource(imageId, classId)`

The grant resource names a **class**, not a Shape. ADR 0046 §10's stated inclination is
class-scoped — "permission to instantiate a particular class" — and a per-Shape grant is strictly
broader than that: two classes can share one instance Shape (a class takes an arbitrary
`instanceShapeRef`; nothing enforces Shape-per-class), so a per-Shape create grant would authorize
minting instances of *any* class pointing at that layout. Per-class is the narrowest grant that
means "instantiate this".

The caller names a class; the lane derives `shape = class.instanceShape` and `behavior = class`
from the class record, exactly as `basicNew` does (ADR 0046 guardrail). A class with
`instanceShape == nil` is not instantiable and create refuses it, matching ADR 0046.

The resource is built by **reusing `objectResource(imageId, classId)`** — the single canonical
injective helper ADR 0039 §5 mandates. A class *is* an object in this graph, so the existing helper
names it collision-proof; the operation `object/create` is what distinguishes this grant from
`object/read`/`object/write` on the same class object (grants are exact-match `{operation,
resource}` pairs, so the three are disjoint even on one resource). A separate `createResource`
helper adds no injectivity and would open a second hand-built-string path, which ADR 0039 forbids.

One consequence to state plainly: the grant names the class *object*, so it covers that class's
current *and future* instance Shape — editing the class's layout does not escape the grant.

### 3. Authorize before any read or mint

`require({operation: 'object/create', resource: objectResource(imageId, classId)})` runs before the
class record is read or any id is minted. A caller without the grant gets `AuthorityError` and
learns nothing — not even whether the class exists.

The class-existence check that follows is **integrity, not exposure**: an *authorized* creator who
names a wrong class id learns "that class does not exist" — an existence oracle over ids the caller
already supplied (they had to name the class to make the grant). This is the same shape as ADR 0039
§8 ("knowing an objectId grants nothing") and the mutation lane's not-found error after `require`.

### 4. Initial ref slots under per-target edge authority

Initial slot values may include `ref`/`pinned-ref` to **durable** objects. Writing a ref naming
target `T` triggers a **separate** `require({operation: 'object/edge-write', resource:
objectResource(imageId, T)})` for each such ref. Create-on-class plus edge-write-on-target composes
two narrow grants rather than widening one — preserving ADR 0042 §7's invariant ("authority for A
must not imply authority for what it points at") at creation time.

- **Ref slots arrive as strings** naming target ids, because the callable type language has no
  `ref` type (ADR 0042 §7); the lane canonicalizes them to refs host-side. That string seam is also
  where a hostile caller could hand a `~runtime/transient/…`-namespaced id — see below.
- **Transient targets cannot commit.** A caller *can* present a transient-namespaced string as a
  slot value, but the write-seam guard `assertNoTransientIdentity` (via `putObject` →
  `putWithHistory`) structurally refuses any durable record embedding an unpromoted transient ref.
  Creation is a host lane with no arena, so there is nothing to promote; the guard is the backstop,
  and the lane also refuses transient-looking target ids at require-time for a clean error.
- **A created edge is immutable and unreadable through all v1 lanes.** Once the object exists with
  a ref in a slot, the mutation lane refuses to overwrite a ref-holding slot and the projection
  lane refuses to read one. So `object/edge-write` effectively grants *permanent* edge creation:
  **edge removal is deferred** alongside edge mutation (ADR 0042's deferred list), and this ADR
  adds it there explicitly.
- **Leak check:** a caller holding create-on-class + edge-write-on-T cannot read T through this
  lane — creation returns only the id and a version token, and projection rejects ref slots rather
  than following them. The caller already supplied T's id, so creation confirms at most "T exists
  in this image" — the same bounded oracle as §3.

`pinned-ref` initial slots are permitted and go through the same per-target `object/edge-write`
require; pinning carries residency semantics a plain ref does not (ADR 0060), so the proof list
covers the pinned case explicitly rather than lumping it with plain refs.

### 5. Initial slots are nil-filled to the complete layout

The created object must satisfy `assertObjectMatchesShape` against the class's instance Shape —
the **complete** slot set, by exact slot-id match. Slot values the caller does not supply are
filled with the image's `nil`, exactly as `basicNew` initializes every slot to nil (ADR 0046
guardrail: "every slot = that image's nil"). A caller may not supply a slot id the Shape does not
declare (an extra slot is a shape-match failure, not silently dropped). This keeps a created object
layout-complete and indistinguishable in kind from a `basicNew` one.

### 6. The lane mints the id; insert-only; atomic

- **The lane mints the candidate id itself** (v1 default `randomUUID()`, injectable for tests as
  `options.smalltalkObjectIds` already allows) and passes it explicitly to `putObject(…,
  {expectedVersion: 0})`. It does **not** use `putObject`'s internal default — ADR 0046's guardrail
  "the allocation primitive mints its own candidate id; putObject never mints it" applies to this
  host lane for the same lost-acknowledgement reason: an id the lane never saw cannot be preserved
  across a retry. Collision/retry semantics follow ADR 0046 §6: a known collision chooses another
  candidate; any other failure surfaces.
- **No version token on the request** — with no prior state there is nothing to conflict against;
  insert-only is the entire guard.
- **Atomic commit**: state + history in one backend transaction via `putWithHistory`, or neither
  (ADR 0032 / 0042 §6).
- **Returns** the new object's id and its initial object-scoped version token
  (`objectVersionToken(imageId, newId, stored._version)`), so a subsequent `object/write` chains.
  The token is concurrency, not authority — a later write still needs its own `object/write` grant
  (ADR 0042 §5).

### 7. Binding seams

New module `src/callable/image-creation-binding.js` exporting the representation constant,
`OBJECT_CREATE_OPERATION = 'object/create'`, `OBJECT_EDGE_WRITE_OPERATION = 'object/edge-write'`,
parse/assert helpers, an `installImageCreationBinding` (writes the binding artifact + a Block,
mirroring `installImageMutationBinding`), and the executor. The create signature is declared in a
`callable-interface/v2` artifact (slot values travel as a composite record; ref slots as strings,
per §4). Registered in `createDefaultCodeExecutorRegistry` like the other callable bindings (no
composition-root route — that is for language-owned executors). Also: export from
`src/callable/index.js`, add the representation to `docs/seams.md` (the steering test checks the
table against the registry both ways), and name creation in the existing "Authorized image
projection/mutation → GraphImageService" interaction row in `docs/ownership.md`.

### 8. Deferred (unchanged, per ADR 0042 — with edge removal added)

- object deletion
- ref **mutation** on existing objects (writing an edge into an already-created object)
- **edge removal** (added here; a created edge is permanent across v1 lanes, §4)
- multi-object transactions (needs authority-across-a-transaction)
- whole-object writes supplying every slot
- shape/behavior-changing writes

## Consequences

- The environment can save a Perspective through an authorized lane, with no unguarded `putObject`.
- The grant algebra stays v0 exact-match: one grant = one instantiable class, plus one grant per
  edge target. No wildcards, no quotas — decidable and boring, as ADR 0037 §6 demands.
- Creation is coherent with `basicNew` (same shape/behavior derivation, same nil-filled complete
  layout) but is a *separate authorized external boundary*; image-native `basicNew` stays ungated
  (ADR 0046 §10 unchanged).
- Nothing here weakens the mutation or projection lanes; it adds one lane that reuses the shared
  require-first, injective-resource, atomic-write pattern.

## Guardrails

```text
object/create != object/write                      (distinct operation, distinct binding)
create resource names a CLASS, per (image, class)   (never per-shape: classes share layouts)
resource built only by objectResource()             (injective helper, never concatenation)
authorize before any read or mint                   (an unauthorized caller learns nothing)
shape = class.instanceShape, behavior = class        (derived, like basicNew; nil shape refuses)
initial slots nil-filled to the complete layout      (assertObjectMatchesShape; extra slot fails)
the lane mints the id, passes it explicitly          (never putObject's default; retry-preserving)
insert-only, state + history in one transaction      (or neither commits)
a ref slot requires a separate per-target edge grant (narrow != broad reach)
a transient target cannot commit                     (the write-seam guard is the backstop)
a created edge is permanent across v1 lanes          (edge removal deferred with edge mutation)
create returns id + initial version token            (token is concurrency, not authority)
image-native basicNew stays ungated                  (this is the external boundary, not basicNew)
delete / ref-mutation / edge-removal / multi-record stay deferred
```
