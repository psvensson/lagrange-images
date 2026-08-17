# ADR 0042: authorized object mutation

Status: implemented — `object/write` as a fourth implementation lane, with an object-scoped opaque version token and conflicts translated rather than propagated.
Proven by: test/image-mutation.test.js

## Problem

Everything built in the last eight ADRs reads. Foreign code can be given a projected object, a
live handle over one, and host imports gated by live authority — and none of it can change
anything. That is the right order to have built them in, and it is now the missing half.

`object/write` is also a better next increment than the lifecycle machinery ADR 0041 constrained:
it is a genuine image semantic rather than a refinement, it builds on infrastructure that already
exists, and it forces decisions that matter more to the image model than instance pooling does.

The infrastructure is already in place, which shapes the decision:

```text
putObject(imageId, input, {expectedVersion})   optimistic concurrency already supported
putWithHistory(...)                            state and history in one transaction
VersionConflictError                           explicit conflict already modelled
assertObjectMatchesShape(...)                  shape invariant already enforced
```

So this ADR is mostly about authority, granularity and conflict semantics rather than about
storage.

## Decision

### 1. Mutation is a fourth implementation lane, symmetric with projection

```text
              callable-interface/v2
   write-item(string, version-token, item) -> version-token
                       |
          image-mutation-binding/v1
                       |
                 the image graph
```

The same shape as ADR 0039's projection lane, for the same reasons: a mutation is an ordinary
callable Block, nothing beyond `require` enters the executor context, and foreign code never
gets a privileged write API. A program mutates by sending to a Block.

Field-to-slot mapping is the binding's business, using **stable slot IDs**, exactly as for
projection.

### 2. `object/write` authorizes the whole object

Matching `object/read`, and for the same reason ADR 0039 gave: the underlying write replaces the
object record, so a field-level boundary would have nothing enforcing it.

```text
mutation field mapping != field-level capability
object/write authorizes the object, not this particular mutation's field set
```

Two operations with different granularity would also be a trap: a reader would reasonably assume
symmetry.

### 3. `object/write` alone authorizes a partial mutation

A v1 mutation writes its mapped slots and preserves the rest, so the host must read the current
object to construct the new one. That read does **not** require `object/read`.

```text
object/write   authorizes mutating the object, including the host-internal
               read-for-write needed to preserve unmapped slots and invariants

object/read    authorizes exposing object state to the caller

internal read-for-write  !=  object/read
```

An earlier draft derived the opposite rule from the mechanism: because a read happens, a read
grant must be required. That makes authority depend on storage mechanics rather than on what the
caller may observe or cause. A caller saying *change these slots, preserve the rest* never
observes the preserved values, so it has not read them in any sense that matters.

Getting this wrong would have cost something concrete. A write-only capability is genuinely
useful — an updater, a migration, or an audit-trail writer that may change state but must not
inspect it — and requiring `object/read` would have made that impossible in v1 for reasons that
are purely internal to how the lane happens to work.

### 4. Authorization happens before the object is fetched

```text
require({operation: 'object/write', resource: objectResource(imageId, objectId)})
read current object          (read-for-write, not an exposure)
compute the new object
write with the expected version token
```

The demand is checked before anything is fetched, so a caller without `object/write` learns
nothing — not the version, not the shape, not whether the object exists. This works cleanly
because the authority resource is computed from identifiers and needs no read.

Resources are named with `objectResource()`, never by concatenating identifiers. ADR 0039
demonstrated that collision; the same helper is the only permitted way to name a write target.

### 5. Concurrency uses an opaque version token, not an exposed backend version

```wit
write-item: func(
    object-id: string,
    expected-version: string,
    value: item
) -> string
```

The token is **opaque text**, with a private versioned encoding such as
`object-version/v0:<decimal>`. Today it maps trivially to the stored `_version`.

Exposing that version as `s64` would have been wrong in two ways. It advertises an exact domain
the implementation does not have: the mock computes `actualVersion + 1` in JavaScript Numbers and
the Lagrange adapter converts SQL versions with `Number(...)`, so the faithful range is
non-negative safe integers rather than signed 64-bit. And a numeric type invites clients to treat
a token as an ordered revision, which is precisely the interpretation this decision forbids.

```text
a caller may compare tokens and round-trip them
a caller must not interpret, order or arithmetic them

version token != object identity
version token != authority
version token format != the backend storage contract
```

Opacity is also freedom: a later concurrency token — a wider counter, a revision hash, something
branch-aware — becomes possible without changing every foreign callable interface that mentions
one.

**Conflict is explicit.**

```text
token matches   ->  write commits, the next token is returned
token stale     ->  explicit conflict, nothing written
```

Never last-writer-wins, and never a silent retry. A conflict is information the caller asked for
by supplying a token, and absorbing it would discard the only thing that makes concurrent
mutation safe. `VersionConflictError` already behaves this way; this ADR commits the lane to
surfacing it.

**On acquiring the first token.** A successful mutation returns the next token, so subsequent
mutations chain without a separate lookup. How a caller obtains its *initial* token is a separate
concern: an ADR 0039 projection returns the projected record and no version, so there is
presently no foreign-facing way to read one. A future version-aware projection —
`read-versioned-item(id) -> {version-token, value}` — could provide it without contaminating
ordinary projection semantics. This ADR does not add one.

### 6. State and history mutate atomically, and nothing else does

The existing `putWithHistory` contract commits the materialized record and its history event in
one backend transaction, and ADR 0032 already requires that. A mutation lane must use it rather
than performing two writes.

A failed write commits nothing: no partial slot update, no orphaned history event, no version
increment.

### 7. A mutation never follows a ref, and never writes through one

The read half obeys ADR 0039's rule unchanged: a mapped slot holding a `ref` is rejected rather
than followed, because authority for one object must not imply authority for what it points at.

The write half inherits the same rule in the other direction: a mutation may not write *through*
a ref to reach another object. Reaching a second object requires a second `require`, and there is
no traversal path on which one could happen.

A mutation cannot *store* a ref either, because `ref` is absent from the callable type language.
So in v1 a mutation cannot create or change a graph edge at all. That is a deliberate narrowing,
not an oversight: edge creation is how a caller with narrow authority could otherwise reach
broadly.

And when ref-valued mutation is eventually wanted, it should **not** be assumed to fall under
ordinary `object/write`. Changing an edge changes topology and reachability, and therefore
potentially collection and project semantics, which is a different kind of consequence from
changing a leaf value. It plausibly deserves its own authority and its own ADR.

### 8. Dropping a resource never commits

Reaffirming ADR 0040 decision 5 explicitly, because writes make the mistake newly attractive.

```text
drop(handle)  != commit
              != flush
              != delete
              != revoke
              != any durable effect whatsoever
```

A handle release is not a transaction boundary. If a future resource ever offers mutation, its
commit must be an explicit operation the guest calls and the host authorizes, never a side effect
of a handle going out of scope — which ADR 0040 also showed does not reliably happen at all,
since a trapping guest drops nothing.

### 9. v1 does not create objects or change shapes

`object/write` mutates an existing object's slots. It does not create objects, delete them,
change an object's shape, or alter its behavior ref.

Creation and deletion are different authorities with different consequences and belong in their
own decision. A shape change is a structural change that gets a new shape identity under an
existing invariant, so routing it through a slot-mutation lane would quietly break that.

## Proof

1. no authority → mutation denied, nothing read and nothing written
2. `object/write` alone, with a matching token → succeeds; a write-only capability is real
3. `object/read` alone → denied, and the object is not fetched
4. matching token → write commits, and the next token is returned
5. stale token → explicit conflict, and the object is genuinely unchanged: same slots, same
   stored version, and no history event appended
6. revoke between two mutations → the second fails and commits nothing
6a. a token is opaque: an arbitrary or malformed token is rejected rather than interpreted
7. unmapped slots are preserved, not cleared
8. a value violating the declared field type is rejected before any write
9. a mapped slot holding a `ref` is rejected rather than followed
10. state and history commit together; a rejected write leaves neither
11. the mutation Block writes only its own binding's image
12. the durable mutation binding contains no principal, grant, resource or authority context
13. dropping a resource handle commits nothing
14. projection, resource and ordinary Component paths remain unchanged

Case 5 is the one that matters most, and "unchanged" means all of it: the conflict is raised,
the stored slots are identical, the stored version has not advanced, and the history stream has
not grown. Asserting only that an exception occurred would pass while leaving a half-applied
write behind.

## Implementation status

All fourteen proof cases pass, plus three added while implementing.

Two things were tightened during implementation rather than after:

**The version token is object-scoped.** A token carrying only a backend version would have
succeeded against a different object sitting at the same version — authority would still have
prevented an escalation, but the compare-and-set would have failed to represent the caller's
assumption about *this* object, which is the only reason to supply one. `objectVersionToken`
therefore embeds the object resource, and `parseObjectVersionToken` requires the expected image
and object. The scope is object-wide rather than per binding, so a future version-aware
projection can issue a token any legitimate mutation binding over that object accepts. A test
creates two objects at the same version and confirms one's token cannot mutate the other.

**The backend conflict error is translated, never propagated.** `VersionConflictError` carries
`collection`, `key`, `expectedVersion` and `actualVersion`, and puts both numbers in its message,
so surfacing it — even as a `cause`, which would leave `actualVersion` reachable — would defeat
the opaque token outright. `ObjectMutationConflictError` carries only the object it was raised
for, and a test asserts no `cause`, none of those four fields, and no digits in the message.

Order of operations in the lane, all before any fetch: `require` the write, then validate the
token against the requested image and object. So a caller without `object/write` learns nothing,
and a wrong-object or malformed token fails without reading or writing anything.

## What is deferred

- object creation and deletion, as separate authorities
- shape-changing and behavior-changing writes
- whole-object writes that supply every slot, needing no read-for-write at all
- a version-aware projection for acquiring an initial token
- mutation through a resource handle, which needs an explicit authorized commit operation
- writing graph edges, which requires `ref` in the callable type language and a decision about
  how narrow authority may not become broad reach
- multi-object transactions, which need a decision about authority across a transaction boundary
- a richer grant algebra, unchanged since ADR 0039

## Guardrails

```text
mutation == a fourth implementation lane, not a new seam
object/write authorizes the object, not a field set
object/write alone authorizes a partial mutation
internal read-for-write != object/read
authorize before fetching anything
resource names come from objectResource(), never concatenation
the version token is caller-supplied and opaque
callers may compare and round-trip tokens, never interpret them
conflict is explicit; never last-writer-wins, never a silent retry
version token != identity, != authority, != the storage contract
acquiring an initial token is a separate future concern
state and history commit in one transaction, or neither commits
a mutation never follows a ref and never writes through one
v1 cannot create a graph edge at all
future edge mutation != automatically under object/write
drop != commit
v1 does not create, delete, or reshape
```
