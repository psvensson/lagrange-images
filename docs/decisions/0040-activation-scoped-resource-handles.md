# ADR 0040: activation-scoped image resource handles

Status: accepted — the decision for WIT resources over image objects; deliberately no implementation yet.

## Problem

ADR 0039 gave foreign code a *snapshot* of an image object: authorized, ref-free, structural,
and complete at the moment of projection. Some foreign code instead needs continuing access —
several reads through one identity, without re-supplying an object id or re-projecting a whole
record each time.

WIT already has the right shape for that: a `resource` is an opaque handle to an entity outside
the component, unlike WIT's ordinary plain-data types. The danger is that `own<T>` reads like
ownership of the thing rather than of the handle, and that a handle is an extremely convenient
carrier for exactly the authority that ADR 0037 spent its effort making uncarryable.

ADR 0037 decision 13 already constrained this: an authority-bearing handle must carry explicit
scope and lifetime, and must never silently become runtime-global.

## What the mechanism actually permits

Spiked before deciding, because three earlier assumptions about this toolchain turned out wrong.

jco represents a host-imported WIT resource as a **JavaScript class in the import object**, and
the host mints the instances:

```text
imports['lagrange:proof/image-objects'] = { Item, openItem() { return new Item(...) } }
```

Three consequences, all favourable:

- the **host owns the handle arena**, so an activation-scoped lifetime is directly expressible
  rather than something to be simulated
- **every resource method is a host call**, so re-authorizing per method is the natural shape,
  not a bolt-on
- a guest dropping an owned handle **surfaces to the host** as `[Symbol.dispose]()` on the
  instance, so `drop` semantics are observable and therefore testable

Observed call sequence for one open-then-read: `construct 1 ; snapshot 1 ; dispose 1`.

The import specifier is unversioned (`lagrange:proof/image-objects`), consistent with ADR 0038.

## Decision

### 1. Three separate things, deliberately

```text
durable image object identity
        !=
transient WIT resource handle
        !=
execution authority
```

Conflating any pair of these is the failure mode. A handle resolves to host-private
`{imageId, objectId}` and **nothing else**: no `AuthorityContext`, no principal, no grants, no
cached authorization decision.

### 2. Every operation re-authorizes, before touching image data

```text
require({operation: 'object/read', resource: objectResource(imageId, objectId)})
read
```

Per method call, at use time. This is the same rule ADR 0038 and ADR 0039 established, for the
same reason: nothing precomputed, so revocation stays live. A handle is emphatically not a
cached `require`.

### 3. Handle lifetime is the activation, for v0

Not authority-context lifetime, and not an arbitrary lease.

```text
activation begins
    |
    +-- open handle H -> image object X
    |
    +-- guest may use H repeatedly
    |
    +-- every operation re-authorizes X
    |
    +-- H may be dropped early by the guest
    |
activation finishes
    |
    `-- every remaining H becomes invalid
```

The reasons line up unusually well: Component instances are already fresh per activation
(ADR 0036), the ordinary Block boundary has no resource-handle Value to carry one out,
authority is already associated with a call, and PR #50 already made the execution context
expire with its activation. The handle arena expires through **that same lifetime record**, so
this is one mechanism rather than two.

This is deliberately stricter than the maximum lifetime an owned Component Model resource could
have. That is correct while Lagrange has no safe inter-activation carrier for one.

### 4. Revocation and destruction are different concepts

```text
handle live + authority revoked   ->  method call denied, handle still a handle
handle dropped + authority valid  ->  handle unusable
```

Binding handle lifetime to the authority context would make revocation double as resource
destruction, which conflates a security event with a resource-management one. Keeping them
separate is worth more than the apparent simplification.

### 5. `own` owns the handle, never the image object

This is the strongest guardrail in this ADR, because the WIT spelling actively invites the
mistake.

```text
own<item>       ownership of the transient foreign handle
drop(handle)    release that transient handle

drop(handle)    != delete the image object
                != revoke object/read
                != mutate image history
                != change anything durable at all
```

A `borrow<item>` is call-bounded access to the handle, matching upstream's distinction between
owned and borrowed handles. Lagrange must not reinterpret WIT ownership as image ownership.

### 6. Resources are lane-local, and never join `callable-interface/v2`

`callable-interface/v2` describes what can cross the ordinary Block boundary, and its type
grammar is deliberately plain data: primitives, lists, records.

```text
resource handle != Value
resource handle != InterfaceValue
resource handle != interface-composite/v0
resource handle cannot be stored in an image slot
resource handle cannot be returned from an ordinary Block
```

A handle must acquire no packed representation. This is consistent with the Component Model
itself, where a resource is a handle to something outside the component rather than a data
type, and it is what keeps a handle from becoming durable by accident.

### 7. The first proof is prebound, not a generic object locator

The tempting first move is:

```wit
open-object: func(image-id: string, object-id: string) -> own<object>
```

That mixes this ADR's question — identity, handle lifetime and WIT ownership — with a second
architectural question about how a foreign guest discovers and selects image identity. Two
decisions at once is how one of them gets made badly.

So v0 is prebound: a runtime-local provider is configured around one existing
`image-projection-binding/v1` target and exposes

```wit
resource item {
  snapshot: func() -> item-record;
}
open-item: func() -> own<item>;
```

The handle privately points at that object. `snapshot()` reuses the structural projection
semantics ADR 0039 already proved — ref-free, structural by stable slot ID, never following
refs — and re-runs `object/read` every time.

How handles are *acquired* is a later decision: object ids, prebound factories, project-scoped
lookup, query results, or something else. This ADR deliberately does not constrain it.

## Proof

1. no authority → opening or using a handle is denied
2. granted object → repeated reads through one handle succeed
3. revoke between two calls → the second fails, the first having succeeded
4. two handles to the same object are distinct handle identities observing the same object
5. dropping one handle affects neither the other nor the durable object
6. a handle cannot be canonicalized, stored in a slot, packed, or returned through a Block result
7. after the activation completes, a retained handle **and** a retained `require`/`sendMessage`
   path are both dead
8. cleanup happens even when the Component traps
9. a handle never carries a principal, grants or an authority context
10. existing projection and ordinary Component paths remain unchanged

Case 7 is the load-bearing one, and it should prove mechanically that:

```text
activation lifetime ends
        =>
authority-facing closures expire
    and
resource-handle arena expires
```

Case 5 matters more than it looks: it is what distinguishes handle ownership from object
ownership in observable behaviour rather than only in prose.

## What is deferred

- **persistent handles that outlive an activation.** These need a genuinely new abstraction — an
  explicit lease or session with ownership, expiry, revocation, recovery and cleanup semantics.
  They should not arrive merely because WIT has `own<T>`, and they belong near the future
  Component instance-reuse and async-callback work, because all three ask the same question:
  what execution state is allowed to survive one activation?
- generic foreign object lookup, per decision 7
- writes through a handle; `object/write` remains its own decision
- handles over anything other than an image object
- a richer grant algebra, unchanged from ADR 0039

## Guardrails

```text
object identity != handle != authority
handle resolves to identity only; never to a context, principal, grant or decision
handle != cached require; every method re-authorizes
handle lifetime == activation lifetime, sharing the existing lifetime record
revocation != destruction
own owns the handle; drop mutates nothing durable
borrow is call-bounded
handle != Value, InterfaceValue or interface-composite/v0
handle is lane-local; callable-interface/v2 stays plain data
prebound acquisition; the locator question stays open
persistent handles need a lease abstraction, not own<T>
```
