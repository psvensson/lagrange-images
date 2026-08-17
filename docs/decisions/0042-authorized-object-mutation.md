# ADR 0042: authorized object mutation

Status: accepted — the decision for `object/write`; deliberately no implementation yet.

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
        write-item(string, s64, item) -> s64
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

### 3. A partial write requires both read and write authority

This follows from the mechanism rather than from taste, and it is worth stating because it is
easy to get wrong in the permissive direction.

A v1 mutation writes its mapped slots and preserves the rest, so it is a read-modify-write: the
current object must be read to construct the new one. Therefore:

```text
partial write   requires object/read AND object/write
```

The alternative — letting `object/write` alone imply the read it needs — would quietly grant
read access to anyone who can write, which is not what a caller granting write intends.

A caller holding write but not read is not stuck in principle: a future whole-object write that
supplies every slot needs no read. v1 does not offer one, and that limitation is honest rather
than hidden.

### 4. Authorization happens before the current state is read

```text
require({operation: 'object/read',  resource: objectResource(imageId, objectId)})
require({operation: 'object/write', resource: objectResource(imageId, objectId)})
read current object
compute the new object
write with expectedVersion
```

Both demands are checked before anything is read, so an unauthorized caller learns nothing about
the object — not its version, not its shape, not whether it exists.

Resources are named with `objectResource()`, never by concatenating identifiers. ADR 0039
demonstrated that collision; the same helper is the only permitted way to name a write target.

### 5. A write carries an expected version, and a conflict is explicit

```wit
write-item: func(object-id: string, expected-version: s64, value: item) -> s64
```

The expected version is a parameter rather than something the lane discovers, so the caller's
assumption about what it is overwriting is part of the call. The result is the new version, which
makes a read-modify-write chain expressible without a second read.

```text
expected version matches   ->  write commits, new version returned
expected version stale     ->  explicit conflict, nothing written
```

Never last-writer-wins, and never a silent retry. A conflict is information the caller asked for
by supplying a version, and swallowing it would discard the only thing that makes concurrent
mutation safe.

`VersionConflictError` already exists and already behaves this way; this ADR commits the write
lane to surfacing it rather than absorbing it.

**A version is a conflict token, not identity.** `identity != revision` is an existing invariant,
and exposing a version through an interface must not turn it into a way to name an object.

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

A mutation may still *store* a ref in a slot when the interface's field type allows it — except
that it cannot, because `ref` is absent from the callable type language. So in v1 a mutation
cannot create or change a graph edge at all. That is a deliberate narrowing, not an oversight:
edge creation is how a caller with narrow authority could otherwise reach broadly.

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
2. `object/write` alone → denied, because a partial write also needs `object/read`
3. `object/read` alone → denied
4. both grants, matching expected version → write commits, new version returned
5. stale expected version → explicit conflict, and the object is unchanged
6. revoke between two mutations → the second fails and commits nothing
7. unmapped slots are preserved, not cleared
8. a value violating the declared field type is rejected before any write
9. a mapped slot holding a `ref` is rejected rather than followed
10. state and history commit together; a rejected write leaves neither
11. the mutation Block writes only its own binding's image
12. the durable mutation binding contains no principal, grant, resource or authority context
13. dropping a resource handle commits nothing
14. projection, resource and ordinary Component paths remain unchanged

Case 5 is the one that matters most: it must show the stored object genuinely unchanged, not
merely that an error was raised.

## What is deferred

- object creation and deletion, as separate authorities
- shape-changing and behavior-changing writes
- whole-object writes that need no read, and therefore no read authority
- mutation through a resource handle, which needs an explicit authorized commit operation
- writing graph edges, which requires `ref` in the callable type language and a decision about
  how narrow authority may not become broad reach
- multi-object transactions, which need a decision about authority across a transaction boundary
- a richer grant algebra, unchanged since ADR 0039

## Guardrails

```text
mutation == a fourth implementation lane, not a new seam
object/write authorizes the object, not a field set
partial write requires object/read AND object/write
authorize both before reading anything
resource names come from objectResource(), never concatenation
expected version is a caller-supplied parameter
conflict is explicit; never last-writer-wins, never a silent retry
version is a conflict token, never identity
state and history commit in one transaction, or neither commits
a mutation never follows a ref and never writes through one
v1 cannot create a graph edge at all
drop != commit
v1 does not create, delete, or reshape
```
