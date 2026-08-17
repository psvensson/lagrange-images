# ADR 0039: authorized object projection

Status: accepted — the decision for projecting image objects outward; deliberately no implementation yet.

## Problem

ADR 0035 decision 8 deferred one path until capability semantics existed:

```text
ref -> authorized personality projection -> read object/slots
    -> ref-free InterfaceValue -> Component / Cuis
```

Everything it needed now exists. ADR 0037 put a check-only `require` at the execution seam,
ADR 0038 proved authorization at use time through a real host import, and the
`interface-composite/v0` codec already refuses reference-bearing values outright.

So the remaining question is not whether this is possible but where it belongs, and that
splits into two decisions that are easy to get wrong in opposite directions.

## Decision

### 1. The image is a third implementation lane, not a new host import

A callable interface already has two implementation bindings. This adds a third whose
implementation is the image itself:

```text
                  callable-interface/v2
                  read-item(string) -> item
                 /          |           \
wasm-component-   foreign-runtime-   image-projection-
  binding/v2        binding/v1         binding/v1
      |                  |                  |
 Component           Cuis image        the image graph
```

Projection is therefore an **ordinary callable Block**. A program obtains a projected record
by sending to a Block, exactly as it would call a Component, and then passes that record to a
foreign Block as an ordinary composite argument.

Two alternatives were rejected.

**Not a host import.** A guest asking `read-object(id)` would need a statically declared WIT
return type for an object whose shape is image data, so either the shape gets frozen into the
interface anyway or the result degrades to a stringly-typed field list. It would also invert
ADR 0035's wording: the *personality* projects, the foreign side does not ask. And it would
require the guest to know image identity, which is exactly what this path exists to avoid.

**Not a new executor-context capability.** Adding anything beyond `require` to the executor
context would weaken ADR 0037's containment, and the containment is worth more than the
convenience. Reusing the binding mechanism costs one representation and no new seam.

### 2. The ref never crosses, and this is enforced rather than policed

The interface takes an object **id** as `string` and returns a composite. `ref` and
`pinned-ref` remain absent from the callable type language, so there is no way to express a
ref crossing, and the composite codec refuses reference-bearing values even if one were
somehow constructed.

The foreign side receives ordinary data and cannot tell it came from an object.

### 3. Authorization happens before any slot is read

```text
require({operation: 'object/read', resource: '<imageId>/<objectId>'})
read the object
project declared fields
pack
```

The demand names the concrete object, so the check is per object rather than per interface, and
it happens at use time — the same rule ADR 0038 established, for the same reason: nothing may
be precomputed, so revocation stays live.

The resource is `imageId/objectId` because that pair is the object's stable identity. The
argument is only the object id; the image comes from the binding, so a projection Block cannot
be pointed at another image by its caller.

### 4. Field-to-slot mapping is the binding's business

Like `target: {service, operation}` for the foreign-runtime lane, the mapping is the part that
is meaningless to any other lane:

```json
{
  "abi": "image-projection-binding/v1",
  "fields": [
    {"name": "name", "slot": "slot-name"},
    {"name": "quantity", "slot": "slot-quantity"}
  ]
}
```

Record field names come from the interface's declared record; slot IDs come from the image.
Keeping stable slot IDs here rather than slot *names* preserves the existing invariant that a
rename does not change identity.

A slot whose Value does not match the declared field type is an error, not a coercion. A
missing slot is an error too: a projection that silently produced a default would be a
different object than the one asked for.

### 5. The v0 grant algebra stands, and this ADR records the pressure rather than resolving it

Exact-match grants mean one grant per object:

```text
{operation: 'object/read', resource: 'demo/counter'}
{operation: 'object/read', resource: 'demo/other'}
```

Reading two objects needs two grants. That is genuinely coarse, and the first requirement for
"read this project's objects" will make it uncomfortable.

It stands anyway, for this step. The proof works with exact grants, and the coarseness is now
demonstrable rather than hypothetical — a test asserts that a grant for one object does not
read another. When a real multi-object requirement arrives it should shape the algebra, and it
will arrive with an actual scope in hand rather than an anticipated one.

What would trigger the change, recorded so the next decision has a starting point: a caller
that legitimately needs a set of objects it cannot enumerate in advance. The likely shapes are
a prefix or project-scoped grant, and whichever is chosen must keep `attenuate` decidable —
"narrower" has to stay computable, which is the property exact matching gives for free and a
naive wildcard scheme does not.

## Proof

1. no authority → projection denied, no slot read
2. grant for `demo/counter` → projection succeeds and matches the object's slots
3. same context projecting `demo/other` → denied, demonstrating per-object granularity
4. revoke between two projections → the second fails
5. the projected result is a composite envelope containing no ref
6. the durable projection binding contains no principal, grant, resource or authority context
7. a projected record passes straight into a Component lane as an ordinary argument, and the
   Component cannot distinguish it from a literal
8. a declared field whose slot is missing, or whose Value kind does not match, fails rather
   than coercing
9. the projection Block reads only its own binding's image
10. existing lanes and pure Components remain unchanged

Case 7 is the point of the whole ADR: image identity, authority and structured projection meet,
and the foreign side still receives only ordinary data.

## What is deferred

- writes. This is read-only projection; `object/write` needs its own decision about
  transactions and conflicting authority
- `pinned-ref` and historical reads
- shape validation as a dependency edge, rather than trusting the declared field mapping
- WIT `resource` handles for continuing access, which add lifetime and ownership and should
  come only after this
- a richer grant algebra, per decision 5

## Guardrails

```text
image projection == a third implementation lane, not a new seam
projection != host import
nothing beyond require enters the executor context
ref never crosses; enforced by the type language and the codec
authorize before reading, per concrete object, at use time
resource == imageId/objectId; the image comes from the binding, not the caller
field mapping is lane-specific addressing, like target
stable slot IDs, not slot names
missing or mistyped slot != coerced default
v0 exact-match grants stand; the coarseness is demonstrated, not hidden
read-only; writes are a separate decision
```
