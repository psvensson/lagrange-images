# ADR 0039: authorized object projection

Status: implemented — the image is a third callable implementation lane; projection is authorized per object at use time, produces ref-free composites, and never follows a ref.
Proven by: test/image-projection.test.js

## Problem

ADR 0035 decision 8 deferred one path until capability semantics existed:

```text
ref -> authorized personality projection -> read object/slots
    -> ref-free InterfaceValue -> Component / Cuis
```

Everything it needed now exists. ADR 0037 put a check-only `require` at the execution seam,
ADR 0038 proved authorization at use time through a real host import, and the
`interface-composite/v0` codec already refuses reference-bearing values outright.

So the remaining question is not whether this is possible but where it belongs, and how the
authority for it is named. Both have answers that look reasonable and are wrong: a host import
that reaches back into the image, and a resource key built by concatenating identifiers.

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

### 2. Projection produces ref-free InterfaceValues, and never follows a ref

The interface takes an object **id** as `string` and returns a composite. `ref` and
`pinned-ref` remain absent from the callable type language, so a ref crossing is
inexpressible, and the composite codec refuses reference-bearing values even if one were
somehow constructed.

A mapped slot that holds a `ref` is therefore **rejected, not followed**. This is a security
rule rather than a simplification:

```text
object A -> ref -> object B

authority for A must not imply authority for B
```

Following a ref would silently project state the caller was never authorized to read, and it
would do so through a path where no second `require` was possible. Recursive projection, if it
is ever wanted, needs an explicit check at every traversed object — which is a later decision,
not an emergent behaviour of this one.

The foreign side receives ordinary data and cannot tell it came from an object.

### 3. Authorization happens per concrete object, before any slot is read

```text
require({operation: 'object/read', resource: objectResource(imageId, objectId)})
read the object
project declared fields
pack
```

Use-time, per object — the same rule ADR 0038 established, for the same reason: nothing is
precomputed, so revocation stays live.

The argument names only the object id; the image comes from the binding, so a projection Block
cannot be pointed at another image by its caller.

### 4. `object/read` is whole-object authority; projection fields are not security scopes

Holding `object/read` for an object authorizes reading **that object**. The fact that one
projection exposes two slots and another exposes five does not create two authority levels.

```text
projection field mapping != field-level capability
object/read authorizes the object, not this particular view of it
a projection binding limits what this callable returns;
    it does not attenuate object/read
```

This matters because the mistake is attractive: a narrow projection *looks* like a narrow
capability. It is not one, and treating it as one would put a security boundary in a place with
no enforcement behind it — the underlying read retrieves the whole object record either way.

If field-level confidentiality becomes necessary, it needs an explicit operation or scope, not
an inference from projection definitions.

### 5. Resource identity uses a canonical collision-free encoding

Concatenating `imageId` and `objectId` with a separator is **not safe**. Neither identifier
forbids the separator, so this is a demonstrated collision rather than a theoretical one:

```text
imageId "a/b", objectId "c"    ->  "a/b/c"
imageId "a",   objectId "b/c"  ->  "a/b/c"
```

Two distinct objects in two distinct images would share one authority resource key, so a grant
for one would authorize the other. Both are accepted by the current identifier rules today.

So `object-resource/v0` is an injective encoding, conceptually:

```text
objectResource(imageId, objectId) = base64url(imageId) "." base64url(objectId)
```

The separator is safe because base64url's alphabet excludes it. The exact spelling matters less
than the invariants:

```text
objectResource is injective
objectResource(a, b) == objectResource(c, d)  iff  a == c and b == d
callers never hand-build a resource string
```

One helper produces every object resource, and nothing else is permitted to construct one. A
hand-built string is how the collision would return.

### 6. `image-projection-binding/v1` is structural, by stable slot ID

An object satisfies a projection when the mapped slots exist and their Values satisfy the
declared interface types. **Shape identity is not part of v1 compatibility.**

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
Stable slot IDs rather than slot names, so a rename does not change what a projection reads —
the existing invariant.

Being structural is a decision, not an omission. If a projection should later apply only to a
particular immutable Shape, that is `image-projection-binding/v2` with an explicit
graph-visible shape edge, rather than a silent change to what v1 means.

A missing slot, or a slot whose Value kind does not match the declared field type, is an error.
A projection that silently produced a default would be describing a different object than the
one asked for.

### 7. v1 stays narrow on purpose

```text
one string object-id parameter  ->  one named record result
```

Field types are restricted to those that correspond directly to canonical leaf Values:
`bool`, `s32`, `s64`, `f32`, `f64`, `string`, `list<u8>`. No nested records, no lists of
records, no recursion — consistent with decision 2.

### 8. An object-id argument is an address, not a ref and not a capability

```text
objectId != ref
objectId != capability
knowing an objectId grants nothing
```

The string is lane addressing. It conveys no rights: the binding fixes the image, and authority
is checked independently against the concrete object.

This is what keeps the third-lane abstraction honest. `read-item("42")` could equally be
implemented by a Component, a Cuis dictionary or an external service. The interface describes a
logical operation; only the image binding interprets that identifier as an image object id, and
the foreign result never contains it unless the application interface itself chooses to.

### 9. The v0 grant algebra stands, and this ADR records the pressure rather than resolving it

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

