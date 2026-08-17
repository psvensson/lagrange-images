# ADR 0035: interface composite values

Status: accepted — the decision for WIT composites; the v2 grammar, codec, list<T> and named records are built, but see Implementation status: list<item> is not yet proven.

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

It is **not** a Value. It cannot enter the graph, cannot be stored in a slot and cannot
appear in an activation request.

The precise rule about durability has three parts, because a looser statement would be
wrong in both directions:

- An InterfaceValue **instance** is never a durable image value or object.
- Its interface **type** may be durable, in `callable-interface/v2`.
- Its **packed bytes** may be persisted as ordinary opaque bytes, but persistence grants
  those bytes no structured image semantics.

Decoding stored bytes later against a matching interface type is a new projection
operation. It does not retroactively make them a nested canonical Value.

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
    age: s32,
}
```

the payload is not `{"name":"Peter","age":42}` and carries no `"record"`, `"string"` or
`"integer"` tags. The declared interface type already says all of that. The payload is
effectively:

```text
length("Peter") "Peter" s32(42)
```

and `list<string>` is:

```text
count (length item)(length item)...
```

plus a small version header and a fingerprint of the normalized expected type.

**Decoding is impossible without the declared interface type.** That is the property that
prevents `interface-composite/v0` from degenerating into the generic nested collection Value
the substrate rejects.

Stated as an invariant that can actually be checked, rather than as a claim about
inspectability — a canonical `bytes` Value can always be read as bytes:

```text
No generic substrate operation may decode, traverse, query or assign
structural meaning to interface-composite/v0 without the exact expected
interface type.
```

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

ADR 0005's *"Execution returns exactly one tagged Value"* is untouched. A `record result
{...}` is one interface value, hence one packed Value, however many fields it has.

This should **not** be described as making multiple results fall out. Lisp multiple values
are semantically different from a composite; a Lisp personality may later implement them
over a composite representation, but the substrate continues to say one Value. That boundary
has proved extremely useful and this ADR does not spend it.

### 11. `callable-interface/v2` is introduced for composites; v1 stays frozen

Composites arrive as a new interface representation rather than as a loosened v1.

```text
callable-interface/v1   types map directly to one canonical Value
                        bool / s32 / s64 / f32 / f64 / string / list<u8>
                        frozen; remains valid forever

callable-interface/v2   introduces the composite type grammar
                        composites may use interface-composite/v0
```

The reason is stronger than "records will need it eventually". v1 is a genuinely closed
contract today: its validator accepts exactly seven types and rejects everything else, so
`list<string>` is not merely unanticipated by v1, it is **explicitly invalid** under it.
Admitting it while keeping the `/v1` identity would let two runtimes read the same durable
representation differently, which is exactly what a version number exists to prevent.

There is a second, more architectural reason. `interface-composite/v0` fingerprints the
normalized expected type, so type normalization and fingerprinting rules must be settled
*before* a codec depends on them. Inventing them for `list<string>` and changing them when
records arrive would invalidate every envelope produced in between.

This is an unusually clean version boundary because it tracks a semantic distinction — "maps
to one canonical Value" versus "needs a carrier" — rather than a mere JSON-schema change.

### 12. The v2 type grammar is structural, not string expressions

Type positions hold either a string (an atomic primitive, or a named type declared in
`types`) or a structural object for a type constructor:

```json
{
  "abi": "callable-interface/v2",
  "function": "process",
  "types": {
    "item": {
      "kind": "record",
      "fields": [
        {"name": "name", "type": "string"},
        {"name": "quantity", "type": "s64"},
        {"name": "enabled", "type": "bool"}
      ]
    }
  },
  "parameters": [
    {"kind": "list", "element": "item"}
  ],
  "result": "item"
}
```

String type *expressions* such as `"list<item>"` are rejected. They would quietly require a
type-expression parser inside the descriptor, and every future constructor would have to
extend that grammar. Structurally, `list<string>` is `{"kind":"list","element":"string"}`,
`list<item>` uses identical machinery, and nesting is naturally recursive.

Note the consequence for v1's spelling: `list<u8>` remains a v1 atomic string because it maps
directly to canonical `bytes`. Under v2 the same meaning is written
`{"kind":"list","element":"u8"}` only if `u8` is ever added as a primitive, which this ADR
does not do. Bytes stay `list<u8>` as an atom.

**The first implemented v2 subset is primitives, `list<T>` and named records.** `option`,
`result`, variants, tuples, resources and ownership are deliberately left undefined. A future
v3 is cheap compared with prematurely fixing semantics for any of them.

### 13. Type normalization and fingerprinting

The envelope fingerprint is a SHA-256 over the canonical normalized type schema — never over
the interface artifact identity, per point 5.

```text
type-definition names   sorted lexically for hashing
record fields           retain declared order
object key order        never semantically significant
type expressions        normalized recursively
```

Record field order is preserved because it is part of the type's meaning and of the encoding
layout. Type-definition names are sorted because the `types` map is a set of declarations,
not a sequence. Object key order carries no meaning anywhere, so normalization must erase it
before hashing.

## The Cuis lane reuses proven bytes transport

The foreign-runtime lane does **not** learn a nested collection grammar:

```text
InterfaceValue
   -> interface-composite/v0 payload (header stripped by the host)
   -> existing lagrange-cuis-stdio/v1 bytes transport
   -> Cuis composite decoder
   -> Smalltalk Array
```

### The header is the host's concern on a host-controlled transport

The envelope header exists to protect a composite that floats around as an opaque Value. A
lane whose transport the host controls at both ends does not need it on the wire, so the host
strips the header before the call and stamps it afterwards.

This is not a weakening. On the way in, the host verifies the incoming fingerprint against
the declared type before stripping. On the way out, it decodes the returned payload against
that same declared type, and successfully decoding is what earns the right to stamp the
type's fingerprint. The host is the side that knows the type, so it is the side entitled to
assert it.

The practical consequence is large: the Cuis image never computes SHA-256 and therefore has
no type-dependent limit on which composite operations it can serve. An earlier draft of this
ADR expected to pass an expected-result fingerprint into the bridge instead; moving the
header to the host is simpler and removes the problem rather than routing around it.

ADR 0034's `transport != interface` guardrail is the reason. The stdio framing stays
ignorant of lists and records, and nested framing is solved once as an interface concern
rather than twice.

This is also the pragmatic choice. PR #39 proved that transport carries arbitrary bytes
correctly — every byte value, empty payloads and 2000-byte payloads — and found and fixed a
latent base64 line-wrapping defect while doing so. Building a second nested wire format
beside it would put the fragile part of the bridge back in play for no gain.

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

### Implementation ordering

The first change implements the **final** v2 descriptor machinery, not a list-only extension:

```text
1. callable-interface/v2 type grammar
   + canonical type normalization and fingerprint
   + interface-composite/v0 codec
   + list<string> through both lanes

2. named record item through both lanes

3. list<item> — the first genuinely recursive composite proof
```

Settling the grammar, normalization and fingerprint before any codec exists is what makes
steps 2 and 3 boring, which is the desired outcome for substrate work. Shipping a temporary
list-only v1 extension first would produce envelopes whose fingerprints stop matching the
moment records arrive.

## Implementation status

The status line stays `accepted` rather than `implemented`, because the Cuis lane has no
record decoder yet. Claiming otherwise would be exactly the overstatement the repository's
ADR convention exists to prevent.

Built and tested:

- `callable-interface/v2` with the structural type grammar, normalization, cycle rejection
  and type fingerprinting
- the `interface-composite/v0` codec for primitives, `list<T>` (including nesting) and named
  records, with fingerprint mismatch, ref, bounds and malformed-envelope rejection
- both bindings accept v1 or v2 interfaces
- `list<string>` and named records proven in both directions through a real Rust Component
  and a live Cuis image, producing byte-identical envelopes from two independent
  implementations

Not yet proven end to end:

- `list<item>`, where a list and a record compose. The Cuis image has a list-of-string
  decoder and a record decoder but nothing that nests one inside the other yet.

## What is still deferred

- `option<T>`, `result<T, E>`, WIT variants, tuples, resources and ownership: undefined in
  v2 on purpose, and a future v3 rather than a v2 extension
- unsigned primitives (`u8`, `u32`, ...): the primitive set stays signed
- nested `list<list<T>>` beyond what proof step 3 establishes
- capability-aware `ref` projection outbound (point 8)
- WIT `resource` handles for foreign access to image identity (point 9)
- multiple activation results (point 10 keeps one)
- capability-aware imported host functions and async foreign callbacks, unchanged from ADR 0034

## Consequence

Composite interface data becomes possible without a generic collection Value, without
hidden graph refs, without a second calling convention, and without turning a line-framed
stdio protocol into a recursive serialization format.

The cost is honest and bounded: one new interface representation, one private encoding
contract, plus the discipline that the encoding's bytes are meaningless without a declared
type. `callable-interface/v1` is unaffected and stays valid forever. If that discipline ever slips — if something
starts inspecting an envelope without its interface type — the substrate has grown a nested
collection Value by accident, which is exactly the outcome this ADR exists to prevent.

## Guardrails

```text
canonical VALUE_KIND unchanged
callable-interface/v1 frozen; composites are v2 only
v1 type != v2 type grammar
structural type constructor != string type expression
InterfaceValue != Value
InterfaceValue is transient, acyclic, ref-free
interface-composite/v0 != generic collection encoding
schema-directed != self-describing
decoding requires the declared interface type
type fingerprint != interface artifact ref
fingerprint over normalized type schema != over artifact identity
transport != interface
packed carrier != semantic representation
personality projection != platform policy
materialized object graph != transport representation
ref != authority, and ref never crosses a foreign interface
activation -> exactly one Value
composite result != Lisp multiple values
```
