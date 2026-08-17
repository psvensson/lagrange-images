# ADR 0035: interface composite values

Status: accepted — the decision for WIT composites; deliberately no implementation yet.

## Problem

ADR 0034 established an implementation-independent callable contract and proved it through a
real Rust Component and a live Cuis image. Its type language is deliberately tiny:

```text
bool | s32 | s64 | f32 | f64 | string | list<u8>
```

`list<T>` for other element types, records, tuples, `option`, `result` and multiple results
were all deferred to this ADR, because they raise a question the scalar types never did:
what is the relationship between a structured *interface* value and the deliberately small
canonical Value model?

The canonical Value set is:

```text
boolean | integer | float64 | text | bytes | ref | pinned-ref
```

`docs/value-model.md` states the commitment plainly: *"There is no generic nested JSON
collection Value."* Composites must therefore arrive without that changing.

Two facts about the current substrate constrain every available answer:

- `InvocationService` canonicalizes every argument, so the Block boundary is Values-only.
  There is no seam through which a non-Value can enter an activation.
- The graph walker resolves slot references through `referencesOfValue`, which is **flat**.
  A nested Value carrying refs would create graph edges the walker cannot see, violating
  *"Metadata must not hide refs."*

Together these rule out the comfortable answer. A structured value cannot simply be "a new
kind of Value that the executor understands", and it cannot be a nested tree containing
refs.

## Decision

### Three layers, named separately

```text
language/personality value
        |
        | personality projection
        v
ephemeral InterfaceValue
        |
        | shared schema-directed packing
        v
canonical Value at the Block edge
        |
        | lane adapter
        v
Component / Cuis / future JVM / ...
```

The middle layer is new and is the substance of this ADR.

### 1. `VALUE_KIND` remains unchanged

No `list`, `record`, `tuple`, `option` or `result` Value kind is introduced, now or as a
consequence of anything below. The canonical Value set stays exactly as ADR 0002 and
`docs/value-model.md` define it.

### 2. WIT composites are InterfaceValues, not image Values

An `InterfaceValue` is a host-local typed value that exists only inside a callable
invocation. It may look like `["a", "b", "c"]` or `{name: "Peter", count: 3}`.

It is **not** a Value. It cannot enter the graph, cannot be stored in a slot, cannot appear
in an activation request, and cannot be persisted. Nothing in the durable model knows the
type exists.

### 3. InterfaceValues are transient, acyclic and ref-free

The codec refuses a reference-bearing value rather than encoding it. This is not a
convenience check: it is what keeps the flat graph walker correct. A ref inside a composite
would be an invisible graph edge, so composites may not contain one.

Acyclicity is likewise a hard rule, not an encoder optimization.

### 4. The Block edge carries a composite as one schema-directed `bytes` Value

For scalar interface types nothing changes:

```text
string     -> canonical text
s32 / s64  -> canonical integer
f32 / f64  -> canonical float64
list<u8>   -> canonical bytes
```

A composite has no canonical Value representation, so it is packed:

```text
InterfaceValue
    |
    | encode against the exact declared WIT type
    v
{kind: 'bytes', ...}   an interface-composite/v0 envelope
```

This is the one point where the small Value model and the Values-only calling convention
genuinely conflict, and a private carrier is the price of keeping both. It is not a new
calling convention and not a new Value kind.

### 5. The encoding is schema-directed, never self-describing

This is the guardrail that makes point 4 safe rather than a loophole.

The envelope does **not** carry a generic object model. Given

```wit
record person {
    name: string,
    age: u32,
}
```

the payload is not `{"name":"Peter","age":42}` and carries no `"record"`, `"string"` or
`"integer"` tags. The declared interface type already says all of that. The payload is
effectively:

```text
length("Peter") "Peter" u32(42)
```

and `list<string>` is:

```text
count (length item)(length item)...
```

plus a small version header and a fingerprint of the normalized expected type.

**Decoding is impossible without the declared interface type.** That is the property that
prevents `interface-composite/v0` from degenerating into the generic nested collection
Value the substrate rejects. There is deliberately no way to ask "what is in these bytes?"

The envelope carries a non-reference type fingerprint only — never a ref to the interface
artifact. Embedding that ref would hide a graph relationship inside bytes, which is the
same mistake in a different costume.

Further properties this buys, each of which is a requirement rather than a nicety:

- deterministic encoding, so equal InterfaceValues always pack to identical bytes
- cheap validation against a known type
- straightforward depth, element-count and total-size limits
- a persisted envelope is merely opaque bytes, never an image collection

### 6. Personalities own projection

Translating between a language's own values and InterfaceValues is personality work, as
`docs/language-platform.md` §1 requires. The substrate provides the codec and the type
language; it does not decide that a WIT record is a Smalltalk object, a Lisp plist or a
Java record.

### 7. Personalities may materialize composites into ordinary object graphs

When identity, history or durability is actually wanted, a personality may project an
InterfaceValue into ordinary shape/object/ref records. This needs no new machinery: `ref` is
already a Value, records map well onto shapes with stable slot IDs, and provenance stays
walkable.

This is a semantic projection chosen per use, not the transport. The distinction matters
because the two cases want opposite things:

```text
transient
    InterfaceValue -> packed composite Value -> next call -> gone

persistent
    InterfaceValue -> personality projection -> shape/object -> ref -> identity/history
```

A program that calls `foreignA()` and passes the result straight to `foreignB()` has no
reason to mint image identities. A program that stores the result does.

Materializing a 2000-element list as 2000 permanent identities with revisions and history
events would be the wrong default; so would denying identity to a record the program keeps.
Neither is the platform's decision to make.

### 8. Automatic ref-to-InterfaceValue projection is deferred

A stored object *can* eventually travel outbound, but only through an authorized read:

```text
ref -> authorized personality projection -> read object/slots
    -> ref-free InterfaceValue -> Component / Cuis
```

The foreign implementation never receives the ref. This requires capability/principal
semantics, because `ref != authority`, so it is explicitly not implemented here. It is
documented so that point 7 is not mistaken for a dead-end representation.

### 9. Raw refs never cross a foreign interface

`ref` and `pinned-ref` remain absent from the interface type language. When foreign code
eventually needs image identity, the mechanism should be an explicit WIT `resource` backed
by a capability handle — never a declaration that "image ref" is a foreign interface scalar.

### 10. A composite is still exactly one activation result

ADR 0005's *"Execution returns exactly one tagged Value"* is untouched. `tuple<string, s64>`
and `record result {...}` are each one interface value, hence one packed Value.

This should **not** be described as making multiple results fall out. Lisp multiple values
are semantically different from a tuple; a Lisp personality may later implement them using a
composite representation, but the substrate continues to say one Value. That boundary has
proved extremely useful and this ADR does not spend it.

## The Cuis lane reuses proven bytes transport

The foreign-runtime lane does **not** learn a nested collection grammar:

```text
InterfaceValue
   -> interface-composite/v0 bytes
   -> existing lagrange-cuis-stdio/v1 bytes transport
   -> Cuis composite decoder
   -> Smalltalk Array
```

ADR 0034's `transport != interface` guardrail is the reason. The stdio framing stays
ignorant of lists and records, and nested framing is solved once as an interface concern
rather than twice.

This is also the pragmatic choice. PR #39 proved that transport carries arbitrary bytes
correctly — every byte value, empty payloads and 2000-byte payloads — and found and fixed a
latent base64 line-wrapping defect while doing so. Building a second nested wire format
beside it would put the fragile part of the bridge back in play for no gain.

## Open question for review

The interface descriptor's type grammar has to grow, and the descriptor is a versioned
contract. Currently every type is a plain string from a closed set, which already
accommodates `list<string>`, but a record needs a name and fields.

The WIT-shaped option is a declared-types section, keeping parameter and result positions as
type *references*:

```json
{
  "abi": "callable-interface/v2",
  "function": "process",
  "types": {
    "item": {"kind": "record", "fields": [["name", "string"], ["quantity", "s64"], ["enabled", "bool"]]}
  },
  "parameters": ["list<item>"],
  "result": "item"
}
```

This implies bumping `callable-interface/v1` to `/v2`. That is ordinary contract evolution
rather than the parallel lane-specific representations ADR 0034 consolidated away, but it is
a durable representation change and should be agreed before implementation.

## Proof sequence

Composites should be proven in this order, because each step establishes something the next
one depends on.

1. `normalize-all: func(values: list<string>) -> list<string>`

   `list<string>` rather than `list<s32>` on purpose. It exercises arbitrary list length,
   variable-length elements, Unicode, empty strings, empty lists, large lists,
   delimiter-looking content and repeated values, so it validates the actual codec instead
   of mostly testing array iteration.

2. ```wit
   record item {
       name: string,
       quantity: s64,
       enabled: bool,
   }
   ```

   Establishes named fields and mixed element types.

3. `list<item>`

   Where recursive schema-directed encoding is really established.

Each step must agree bit for bit between a real Component and a live Cuis image, as ADR
0034's proofs do.

## What is still deferred

- `option<T>`, `result<T, E>` and WIT variants
- nested `list<list<T>>` beyond what step 3 establishes
- capability-aware `ref` projection outbound (point 8)
- WIT `resource` handles for foreign access to image identity (point 9)
- multiple activation results (point 10 keeps one)
- capability-aware imported host functions and async foreign callbacks, unchanged from ADR 0034

## Consequence

Composite interface data becomes possible without a generic collection Value, without
hidden graph refs, without a second calling convention, and without turning a line-framed
stdio protocol into a recursive serialization format.

The cost is honest and bounded: one private encoding contract, plus the discipline that its
bytes are meaningless without a declared type. If that discipline ever slips — if something
starts inspecting an envelope without its interface type — the substrate has grown a nested
collection Value by accident, which is exactly the outcome this ADR exists to prevent.

## Guardrails

```text
canonical VALUE_KIND unchanged
InterfaceValue != Value
InterfaceValue is transient, acyclic, ref-free
interface-composite/v0 != generic collection encoding
schema-directed != self-describing
decoding requires the declared interface type
type fingerprint != interface artifact ref
transport != interface
packed carrier != semantic representation
personality projection != platform policy
materialized object graph != transport representation
ref != authority, and ref never crosses a foreign interface
activation -> exactly one Value
tuple != Lisp multiple values
```
