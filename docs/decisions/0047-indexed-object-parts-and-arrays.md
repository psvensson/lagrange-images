# ADR 0047: Indexed object parts and fixed-size Arrays

Status: implemented — Shapes declare an optional indexed canonical-Value part, objects carry one only when their Shape permits it, indexed refs are first-class graph edges everywhere, and `Array` is a fixed-size class over that part with `at:`/`at:put:` as ordinary messages.
Proven by: test/indexed-objects-and-arrays.test.js, test/steering-docs.test.js

## Problem

Symmetric Smalltalk can now hold state, define classes, branch, and allocate objects. It cannot hold
a sequence of anything.

That gap is not merely a missing library. It is a hole in the object model, and it is visible in two
places at once.

The first is `MethodDictionary`. ADR 0044 decision 2 represented a selector-to-Block mapping as a
Shape whose slot *names* are selectors, and said plainly why:

> The canonical Value set has no collection and this ADR does not add one. A name-to-Block mapping is
> exactly what a Shape already expresses.

That compromise works, and it costs a new Shape and a rewritten dictionary object on every method
added. ADR 0044 said it "disappears when collections arrive".

The second is that an object today is a Shape plus named slots, and nothing else:

```text
assertObjectMatchesShape    every shape slot id present, no extras — exactly
referencesOfRecord          Object.values(record.slots), and nothing else
```

There is no indexed part, no variable-sized object, and no representation for "N of something" that
is not N named slots. ADR 0046 deferred `basicNew:` and variable-sized indexed objects precisely
because they belong to this decision rather than to allocation.

### The two shapes this could take, and why one of them is wrong

An `Array` could be built without touching the generic object model at all, as a chain of small
fixed-shape cells: a head object pointing at a cell holding one element and a ref to the next. The
object model stays exactly as it is, and no record kind changes.

It is the wrong answer, and the reason is worth stating rather than assuming. Indexing becomes
traversal, so `at:` is O(n) and every collection algorithm written on top inherits that cost as a
property of the *language* rather than of one implementation. A thousand-element Array becomes a
thousand durable records with a thousand history events. And every later collection — sorted,
hashed, streamed — is built over an accidental representation nobody chose on its merits.

Lagrange Images exists to carry real language runtimes rather than to demonstrate that one could
exist. This is the point where the language-neutral object model should grow the one concept it
genuinely lacks, instead of making every language above it pay for the omission forever.

So the object model grows an indexed part. What follows is how to do that without making Shape
meaningless, without hiding graph edges, and without changing what a single stored record means.

## Decision

### 1. A Shape declares whether its objects have an indexed part

The indexed part is **declared layout**, not an ambient capability every object quietly acquires.

```text
Shape
    slots     [{id, name}, ...]
    indexed   none | values

Object
    shape
    behavior
    slots     {stable-slot-id -> Value}
    indexed   [Value, ...]        iff shape.indexed == values
```

Adding `indexed: Value[]` to every object without a declaration would be the easier change and would
quietly undo the reason Shape exists: a Shape is the statement of what an object's layout *is*, and
a layout that a record can extend at will describes nothing. The same argument already made named
slots exact in both directions — missing and extra ids are both errors — and the indexed part is
held to it too.

Shapes are immutable, so giving an existing class an indexed part is a new Shape identity and an
explicit layout change, exactly as adding a named slot already is.

### 2. Absence means `none`, and no stored record changes meaning

A Shape written before this ADR carries no `indexed` declaration, and that reads as `none`. An
object written before this ADR carries no indexed part, and continues not to.

```text
stored Shape with no indexed field    -> none
stored Object with no indexed part    -> no indexed part
an object whose Shape says none       -> may not carry one
an object whose Shape says values     -> carries one, possibly empty
```

This is an extension, not a migration by interpretation — the distinction ADR 0044 decision 10 and
ADR 0044 decision 8 both turn on. Nothing already in an image is reread as something else, and no
record has to be rewritten for the extension to land.

### 3. Indexed elements are canonical Values, and v1 is deliberately narrow

An indexed element is a canonical Value: the same seven kinds as a named slot, **including `ref` and
`pinned-ref`**. Holding refs is the entire point — a collection of objects is the thing a language
needs — and it is also what makes decision 4 load-bearing.

What v1 does not have, and each is a separate decision if it is ever wanted:

```text
no typed/homogeneous storage      an indexed part is Values, not "Values of type T"
no bytes-backed specialization    a byte array is not secretly a different representation
no sparse representation          length N means N elements
no nested InterfaceValues         those are boundary data, per decision 5
no growth in place                see decision 6
```

Keeping the storage untyped is what keeps this a change to the *object model* rather than the
beginning of a type system in the graph.

### 4. An indexed ref is a graph edge, everywhere a graph edge is read

This is the headline invariant of this ADR, and the one whose violation would be genuinely
dangerous rather than merely wrong.

```text
Graph edges are refs in slots, shape, behavior, artifact dependencies/provenance
                    ... and now indexed elements.
```

A ref reachable only through an indexed element and invisible to the walker is an object the graph
believes is unreferenced. That is the same class of defect as hiding a ref in metadata, which this
substrate has forbidden from ADR 0002 onward — except that here it would arrive silently, in code
that already looks complete.

Every reader of an object record becomes responsible for both parts. The list is enumerable, so it
is enumerated rather than gestured at:

```text
object/model.js       createObjectRecord, assertObjectMatchesShape, createShapeRecord
graph/references.js   referencesOfRecord — the walker, and the dangerous one
image service         putObject's allowed-field set; history clones the whole record already
projection binding    ADR 0039, which projects an object to foreign code
mutation binding      ADR 0042 — see below
```

The mutation binding deserves naming explicitly. It rebuilds an object from `{...object.slots}` and
re-puts the whole record, so an indexed part it does not carry forward is not merely unreadable by
foreign code — it is **destroyed** by any authorized mutation of the object. "Preserve unmapped
state" is already that code's stated intent for named slots; the indexed part joins it.

Field mapping for projection and mutation stays named-slot-only in v1. Exposing an indexed part
across a callable interface is an interface-shape question, and ADR 0035 already decided that
boundary's vocabulary. Refusing to project it is a limitation; silently dropping it would be a
defect.

### 5. ADR 0035 composites are not image collection storage

`list<T>` already exists in this substrate, as an `interface-composite/v0` payload, and reusing it
here would be a mistake specific enough to name:

```text
interface-composite/v0        !=      an image collection
transient boundary data                durable graph state
schema-directed, undecodable           self-describing through its Shape
   without the declared type
deliberately ref-free                  exists in order to hold refs
```

ADR 0035 forbids a ref inside a composite precisely so the flat graph walker stays correct. An
image-native `Array` exists to contain refs. Packing one into a composite envelope would violate the
exact property that ADR introduced to protect, and the fact that the two look alike from a distance
is why the non-reuse is a decision rather than an omission.

### 6. `Array` is fixed-size, and `basicNew:` establishes its length

The first collection is the one with no policy in it.

```text
Class  >> basicNew: size        allocate with an indexed part of `size` nils
Array class >> new: size        ^self basicNew: size
Array  >> size
Array  >> at:
Array  >> at:put:
```

Growth is not a property of storage. An `OrderedCollection` is an ordinary object holding an `Array`
plus a size and a growth policy, written in Smalltalk, and it stays out of the primitive layer
entirely. Building resizing into the indexed part would put a policy decision — grow by what, copy
when — inside the object model, where every language would inherit one language's answer.

`basicNew` and `basicNew:` keep the traditional relationship:

```text
basicNew  on an indexed class      indexed length 0
basicNew: on an indexed class      indexed length N
basicNew: on a non-indexed class   an explicit failure, distinct from "not instantiable"
```

A zero-length Array is then unsurprising rather than impossible, and `basicNew` needs no special
case per class.

Every indexed element begins as that image's `nil`, for the same reason ADR 0046 decision 5 gives
for named slots: `UNBOUND` is lexical-cell machinery and never appears in object storage.

### 7. Index semantics belong to the language, not to the object model

The generic indexed part is a sequence with positions `0..N-1`. Smalltalk's `at:` is 1-based, and
the translation lives in `Array >> at:`, not in the record.

```text
object model      0-based positions, a language-neutral sequence
Array >> at:      1-based, because Smalltalk is, and the method says so
```

Teaching the graph one language's indexing convention would be the same mistake as teaching
`lagrange-code` what `nil` means. Bounds are checked by the primitive — an out-of-range index is an
explicit failure, never a silent `nil` — and the language method decides what "in range" means in
its own terms.

### 8. `at:` and `at:put:` are ordinary messages over language-owned primitives

No new machinery. ADR 0046 decision 2 already established the route: a method reaches a
language-owned primitive Block through an explicit captured ref and sends it `value:`, so the host
effect rides the existing send/resumption path and neither lane gains an ABI.

```text
smalltalk-kernel-primitive/v1
    class-of        (ADR 0046)
    basic-new       (ADR 0046)
    basic-new-sized (this ADR)
    indexed-size
    indexed-at
    indexed-at-put
```

They inherit ADR 0046 decision 11's locality rule unchanged: a primitive's image is
`activation.block.imageId`, and a ref argument from another image is refused.

The compiler and dispatcher learn no selector, exactly as with `+`, `ifTrue:`, `new` and `class`.

### 9. Indexed mutation is intrinsic image-native semantics, not an authority check

`at:put:` mutates a durable object, and it is not an ADR 0037 capability check — for the same reason
`basicNew` is not, given once here rather than re-litigated per selector.

```text
image-native language semantics       no grant: closure materialization, basicNew, at:put:
external/foreign object mutation      ADR 0042's authorized lane, unchanged
```

A program that can materialize a closure and allocate an object without a grant, but cannot store
into an Array it just created, would have an incoherent boundary rather than a stricter one. ADR
0042 continues to govern mutation reaching the image from outside, with its object-scoped version
token; nothing about that lane changes here.

If image-native durable effects ever need sandboxing, the policy covers them coherently — allocation,
closure materialization, indexed mutation — rather than treating whichever primitive landed last as
special.

### 10. `Array` equality stays object identity in v1

Two Arrays with equal elements are not `=`. An Array is an object, and object equality is identity
until some class says otherwise by implementing `=`.

The temptation to do more is real and specific: `lagrange-code`'s `equals` op compares Values
structurally, and for refs that is identity — so exposing a container's elements must not let that op
quietly become deep structural equality for objects. Element-wise `Array >> =` is an ordinary method
somebody can write later, and writing it properly means deciding recursive `=` dispatch, cycles, and
almost certainly `hash` at the same time. That is a decision, not a convenience, and it is not this
one.

### 11. `MethodDictionary` migration is enabled here, not required here

ADR 0044 said the shape-backed dictionary disappears when collections arrive. This ADR makes that
removal *possible* and deliberately does not perform it.

The reason is that method lookup is the hot path of every send. Replacing a Shape — whose name
lookup is a host-side map — with a linear scan over an association sequence would be semantically
cleaner and algorithmically worse. Shipping that as progress would be backwards.

So dispatch will eventually read two representations, and the record says which it is:

```text
shape-backed MethodDictionary        ADR 0044 representation, unchanged
collection-backed MethodDictionary   a later representation, once its lookup is good enough
```

That is the same rule as ADR 0044 decision 10 for legacy behaviors: installing a new representation
reinterprets nothing, and moving a dictionary from one to the other is an explicit rewrite of records
rather than a change of meaning. `assertUniqueSelectorShape` remains necessary for as long as the
old representation is read, and can disappear only when nothing reads it.

A real `Dictionary` needs hashing, and hashing needs an equality and hash contract across Value
kinds. Deciding that here would expand this ADR into a second one wearing its clothes. A later ADR
settles `Dictionary` against working `Array` machinery, and only then is migrating the dispatch
dictionary an improvement rather than a trade.

## Proof required for implementation

```text
object model
    a Shape declaring indexed: values accepts an object with an indexed part
    a Shape declaring none rejects an object carrying one
    a Shape declaring values rejects an object carrying no indexed part at all
    an existing Shape with no indexed field still means none, and its objects still store no indexed part
    indexed elements are canonical Values, refs and pinned refs included

graph edges
    referencesOfRecord returns refs held only in indexed elements
    an object reachable only through an indexed element is reachable to the walker
    an authorized ADR 0042 mutation of a named slot preserves the indexed part rather than erasing it
    an ADR 0039 projection of an indexed object refuses the indexed part rather than dropping it silently
    history round-trips an indexed object unchanged

Array
    Array class >> new: 3 answers an Array whose size is 3 and whose elements are nil
    at:put: then at: answers the stored Value, including a ref element
    basicNew on an indexed class answers a zero-length Array
    basicNew: on a non-indexed class fails, distinctly from "not instantiable"
    an out-of-range at: and at:put: fail explicitly, in Smalltalk's 1-based terms
    a subclass may not drop its superclass's indexed declaration (ADR 0046 decision 4, extended)

boundaries
    at:put: succeeds with no authority context at all
    a foreign primitive Block refuses a local Array, per ADR 0046 decision 11
    two Arrays with equal elements are not `=`
    the compiler recognizes none of new:, size, at: or at:put:

both lanes
    the same semantic methods derived into neutral and WASM Blocks, both executed
    an at:put: whose result feeds a further send exercises the non-tail path
    the publication sequence is enumerated by the recovery sweep, not sampled
```

## What is deferred

- `Dictionary`, hashing, and the equality/hash contract across Value kinds
- migrating `MethodDictionary` to a collection representation, per decision 11
- `OrderedCollection`, `Set`, `Bag`, `Interval` and the rest of the hierarchy, all of which are
  ordinary Smalltalk above `Array`
- growing, copying and streaming as primitives rather than as methods
- typed or byte-specialized indexed storage, and any sparse representation
- element-wise `Array >> =` and `hash`
- projecting or mutating an indexed part across a callable interface
- `String` as an indexed collection of Characters; `text` remains a canonical Value and this ADR does
  not relate the two
- becoming/migration when a class gains or loses its indexed declaration under existing instances
- indexed parts on Behaviors, and therefore class-side indexed state

## Guardrails

```text
a Shape declares indexed: none | values; an object may carry one only if its Shape says so
absence means none; no stored Shape or Object changes meaning
indexed elements are canonical Values, refs included, and never typed or specialized in v1
an indexed ref is a graph edge: the walker, projection, mutation and export all read both parts
a mutation that rewrites an object record carries the indexed part forward, never drops it
interface-composite/v0 is transient ref-free boundary data and is never image collection storage
Array is fixed-size; growth is a method above it, never a property of storage
basicNew on an indexed class means length 0; basicNew: supplies N; basicNew: on a plain class fails
every indexed element begins as that image's nil; UNBOUND never appears in object storage
the object model is 0-based and language-neutral; Array >> at: is 1-based because Smalltalk is
bounds are checked; an out-of-range index fails explicitly and never answers nil
at:/at:put:/size are ordinary messages over language-owned primitives, image-local per ADR 0046
indexed mutation is intrinsic image-native semantics, not an ADR 0037 capability check
Array equality is identity; a container must not turn the structural equals op into deep equality
MethodDictionary migration is enabled, not performed; dispatch reads a record as what it says it is
a subclass may not drop an inherited indexed declaration, as it may not drop an inherited slot id
```
