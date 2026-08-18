# ADR 0049: The hashed MethodDictionary

Status: accepted — selector lookup moves to a fixed-Shape hashed MethodDictionary that is kernel representation rather than a Smalltalk class, uses only the pure built-in Text hash and equality, and arrives by explicit per-Behavior migration while the ADR 0044 reader keeps working.

## Problem

ADR 0044 represented a selector-to-Block mapping as a Shape whose slot *names* are selectors, said
why, and said it would go away:

> The canonical Value set has no collection and this ADR does not add one. […] Adding a method
> therefore writes a new shape and a new dictionary. That is genuinely expensive and genuinely
> honest: the cost is visible, it is confined to one object kind, and it disappears when collections
> arrive.

Collections have arrived. ADR 0047 built the indexed object part, ADR 0048 built the hashed table and
deliberately designed it so a later dispatcher could read it without executing Smalltalk. What
remains is to use it — and two things about that turn out to be sharper than expected.

### The path being replaced is already linear

ADR 0047 decision 11 deferred this migration on the grounds that a collection lookup would make
every send worse than the "host-readable Shape lookup" it replaced. That is not what the implemented
dispatcher does. `methodAt` performs, **at every level of the superclass walk, on every send**:

```text
get the method-dictionary object                    one record read
get its Shape                                       a second record read
assertUniqueSelectorShape(shape)                    O(n) — a Set over every slot
shape.slots.find(name === selector)                 O(n) — again
```

So the current hot path costs two record reads and roughly `2n` slot inspections per Behavior level.
The uniqueness validation is not incidental: ADR 0044 decision 2 requires it on *read*, because a
generic graph write can produce a dictionary shape with duplicate selector names and a `find` over
that resolves by position.

The hashed form costs one record read, one pure hash, and an expected-O(1) probe. This ADR is
therefore a simplification and a speedup of the dispatch path, not a representation change that has
to justify its overhead.

### A MethodDictionary cannot be an ordinary Dictionary

ADR 0048 decision 12 anticipated storing selector Text keys "in this exact hashed-table
representation" and probing with the built-in helpers, so the dispatcher never sends `hash` or `=`
while trying to find the method that would implement those sends.

That is sound only if the table was *built* the same way. An ordinary `Dictionary` deliberately uses
dynamic protocol — ADR 0048 decision 4 says a class may override `=` and `hash`, and general lookup
must honour the override. Put those together on one object and:

```text
someone defines Text >> hash          ordinary Smalltalk, explicitly permitted
a method is installed                 placed by the override's hash
the dispatcher probes                 by the built-in hash
                                      -> the method is invisible to every send
```

The escape of forbidding `Text >> hash` is worse than the problem. Reserving apparently ordinary
behavior because the dispatcher secretly depends on it is exactly the kind of hidden coupling this
substrate refuses everywhere else, and a program would discover the restriction only by tripping
over it.

So the two must be different things.

## Decision

### 1. The central invariant: two mappings with deliberately different key semantics

```text
Dictionary
    semantic key equality/hash is dynamic Smalltalk protocol
    sends #hash and #=
    for application objects

MethodDictionary
    selector identity is kernel-defined
    key must be Text
    always uses builtInHash / builtInEquals
    never sends #hash or #=
    for implementing dispatch itself
```

They share a *representation* and its pure machinery. They share no lookup or mutation operation.
Everything else in this ADR follows from that line.

### 2. A MethodDictionary is a kernel representation, not a Smalltalk class

It is identified structurally, by a fixed Shape, and manipulated through kernel machinery. It is
**not** a user-instantiable class, has no metaclass, and gets no `at:`/`at:put:` protocol in this
ADR.

Giving it ordinary dynamic protocol would be unnecessary and would risk recreating the very problem
decision 1 exists to prevent: the moment a MethodDictionary answers ordinary messages, somebody can
override them, and the dispatcher's guarantees become conditional on user code again. A later ADR may
expose read-only reflection over it; that is a different decision with its own proof obligations.

Recognition is by the *local* fixed Shape, never by object id alone:

```text
methods.shape == this image's smalltalk/method-dictionary-shape/v1     hashed lookup
anything else                                                          ADR 0044 legacy lookup
```

Another image may hold its own Shape at that id, so identity is the `(imageId, objectId)` pair — the
same rule `isBehaviorObject` already applies to `smalltalk/behavior-shape/v1`.

### 3. One record, with tightly constrained cells

```text
MethodDictionary
    Shape = smalltalk/method-dictionary-shape/v1     named: tally;  indexed: values

    tally   Integer Value
    indexed [ hash, selector, method,
              hash, selector, method, ... ]
```

One object, not two: the selector set lives in the record's own indexed part, so lookup needs no
second read for a Shape. That is where one of the two record reads goes.

The cells are constrained far more tightly than general Dictionary keys, and the constraint is what
licenses the fast path:

```text
hash      Integer Value, the built-in hash of the selector
selector  Text Value
method    an unpinned Block ref, local to the dictionary's image
```

Because a selector is Text and nothing else, the dispatcher may hash and compare it with the pure
helpers without inspecting or executing any Smalltalk behavior it might have. A cell violating any of
these is structural corruption, not a lookup miss — see decision 5.

Bucket occupancy is the hash cell, exactly as in ADR 0048, so the representation carries over
unchanged. `nil` is not a legal selector, but the rule costs nothing and keeping one bucket
convention avoids two nearly-identical probing implementations.

### 4. Reuse the representation, never the dynamic operations

`smalltalk-dictionary-table.js` already holds the parts that are genuinely representation-neutral,
and they are reused as-is:

```text
reused          capacity validation, power-of-two/minimum-8 rules, floor-modulo probe start,
                linear probing, 3/4 load factor, growth by reinsertion using stored hashes,
                tally/bucket agreement checking

not reused      Dictionary's at:/at:put:/includesKey: operations, its hash/= sends,
                its copy-on-write-then-CAS-after-user-code publication rule
```

Reinsertion after growth continues to place entries by their **stored** hashes. For a
MethodDictionary that is not merely a policy about user code — there is none — but it keeps one
implementation honest across both users of the machinery.

### 5. Lookup is pure, and its failures stay separate

```text
selector (Text)
   |
   v
builtInHash(selector)          pure; no send, no dispatch, no recursion
   |
   v
probe stored hashes            expected O(1)
   |
   v
builtInEquals(stored, query)   pure; exact Text comparison
```

Nothing in that path can re-enter the dispatcher, which is the property ADR 0048 decision 12 promised
and the reason MethodDictionary is not a Dictionary.

ADR 0044's three-way separation of failures is preserved exactly. A dictionary whose cells violate
decision 3 — a non-Integer hash, a non-Text selector, a method that is not a local unpinned Block
ref, an indexed length that is not `capacity * 3`, a tally disagreeing with its buckets — is a
**malformed dictionary**, reported as structural corruption. It is never reported as
message-not-understood, because "this class does not implement that selector" and "this dictionary
cannot be read" are different facts and a caller that cannot tell them apart cannot respond to
either.

### 6. Mutation is read-build-CAS, and a conflict may safely be recomputed

Installing a method runs no arbitrary Smalltalk. That single fact makes this materially simpler than
ADR 0048 decision 7, and the difference is worth stating rather than leaving to be inferred:

```text
ADR 0048 at:put:            user hash/= runs between read and write
                            -> a conflict must be surfaced, never retried,
                               because a retry re-executes user code

ADR 0049 method install     no user code runs at all
                            -> a conflict may be resolved by reloading and recomputing
```

So the sequence is:

```text
read the current MethodDictionary and its version
build the complete next indexed contents
putObject(..., expectedVersion = the version read)
```

and on a version conflict the installer may reload and recompute, because recomputation is pure. It
is permission, not obligation — but the proof obligation that follows is absolute: two concurrent
method additions either both survive, or one fails with a clear conflict. A lost method is not an
acceptable outcome of either path.

The **add-only** rule of ADR 0044 stands unchanged. Method replacement still needs versioned method
identity and remains its own decision.

Note that a MethodDictionary rewrite does not touch the Behavior record, which is exactly what ADR
0044 decision 1 gave Behaviors a fixed shape for. Migration is the one exception, and it rewrites a
ref rather than a layout — see decision 7.

### 7. Migration is explicit, per Behavior, and atomic at the `methods` edge

Two paths, deliberately different.

**A class defined after this ADR** gets the hashed representation immediately, at creation. There is
nothing to migrate.

**An existing shape-backed dictionary** is rewritten by an explicit operation:

```text
read the legacy dictionary
validate it completely                      including ADR 0044 selector-name uniqueness
build the hashed MethodDictionary           under a fresh identity
CAS Behavior.methods:  old ref -> new ref   expectedVersion = the Behavior version read
```

Building under fresh identity and swapping one ref is what makes the transition atomic in the way
that matters: a reader sees the complete legacy dictionary or the complete hashed one, never a
half-converted mapping. It is the same shape as ADR 0048's table swap, for the same reason, minus
the user-code hazard.

Installing this ADR's machinery **migrates nothing on its own**. An image bootstrapped before it
keeps every kernel dictionary in the legacy form and keeps dispatching, because decision 2's
discrimination reads each record as what it says it is. That is ADR 0044 decision 10's rule applied
to a new format rather than a new interpretation: no stored record changes meaning.

### 8. The legacy reader stays, and so does `assertUniqueSelectorShape`

Both remain necessary for exactly as long as any reachable Behavior still points at a shape-backed
dictionary. Removing them because a better format now exists would be the migration-by-interpretation
mistake in a different costume — every unmigrated class would break at once.

Their removal is a later cleanup, valid only after every reachable legacy MethodDictionary has been
explicitly rewritten. This ADR does not schedule it and does not pretend to know when that is true.

### 9. This changes lookup, not execution

Dispatch resolves a Block ref; how that Block runs is untouched. Neutral and Lagrange-WASM execution,
the send/resumption machinery, `effectiveReceiver`, the primitive representation and every installed
method are all unaffected. No `lagrange-code` op, executable representation, or WASM ABI changes.

Both lanes are still proven, precisely because the expected result is *no difference*: a change to
the hot path of every send that claimed to be invisible and was not checked would be a poor claim.

### 10. ADR 0047 decision 11 is corrected, not quietly rewritten

ADR 0047 gets an implementation note rather than an edit that pretends its reasoning was always
right:

> **Implementation note, corrected by ADR 0049:** this decision described the existing Shape-backed
> lookup as effectively map-like and deferred migration to avoid replacing it with a linear
> collection lookup. The implemented dispatcher in fact validates the full Shape and then linearly
> searches its slots on each lookup, making the existing path O(n) twice per Behavior level. ADR 0049
> replaces that implementation with hashed lookup.

The reasoning that produced a decision is part of the record. Showing why a later decision differs is
more useful to the next reader than a document that appears never to have been wrong.

## Proof required for implementation

The headline, because it is the whole architectural claim in one test:

```text
Text >> hash    ^0
Text >> = other ^false

installed as ordinary Smalltalk, after which
    1 + 2                    still answers 3
    Array new: 3             still allocates
    a user-defined selector  still dispatches
    a missing selector       still fails as message-not-understood
```

If pathological overrides of the exact protocol the dispatcher would otherwise depend on change
nothing about dispatch, the separation is real rather than asserted.

Then the representation and the path:

```text
representation
    a new MethodDictionary carries the fixed local Shape, tally, and capacity*3 indexed Values
    selectors are Text, methods are local unpinned Block refs, hashes are the built-in Integer
    a foreign image's method-dictionary Shape does not qualify a record as this image's
    colliding selectors probe correctly
    growth preserves every selector -> Block mapping, reinserting by stored hashes

lookup
    one record read per Behavior level, and no Shape fetch
    a malformed hashed dictionary fails as structural corruption, never message-not-understood
    legacy and hashed dictionaries coexist in one superclass chain and resolve identically

mutation
    adding a method rewrites the dictionary, never the Behavior record
    add-only: redefining a selector is still refused
    two concurrent additions both survive, or one fails with a clear conflict; never a lost method

migration
    an explicit rewrite preserves every selector -> Block mapping
    a failure before the Behavior CAS leaves the legacy dictionary active and the class working
    a lost acknowledgement is idempotent: an exact retry converges and publishes nothing new
    installing the machinery migrates nothing by itself

both lanes and recovery
    neutral and WASM results are unchanged, because this changes lookup rather than execution
    the installer/migration publication sequence is enumerated by the pre/post-commit sweep,
    not sampled
```

## What is deferred

- removing the ADR 0044 legacy reader and `assertUniqueSelectorShape`, per decision 8
- method *replacement*, which still needs versioned method identity
- `doesNotUnderstand:`, unchanged from ADR 0044
- read-only Smalltalk reflection over a MethodDictionary, and any dynamic protocol on it
- enumerating a class's selectors, and `respondsTo:`
- migrating a whole image in one operation, or migrating lazily on first send
- caching lookup results anywhere; this ADR makes the uncached path cheap instead
- sharing one MethodDictionary between Behaviors
- cross-image method dictionaries, which remain excluded with cross-image inheritance

## Guardrails

```text
Dictionary sends hash/=; MethodDictionary never does, and they share no operation
a MethodDictionary is kernel representation identified by a fixed local Shape, not a Smalltalk class
selector keys are Text and nothing else; that constraint is what licenses the pure fast path
never reserve ordinary language behavior to protect the dispatcher; separate the representations instead
one record per dictionary: the selector set is its indexed part, so lookup fetches no Shape
lookup is pure and cannot re-enter dispatch
a malformed dictionary is structural corruption, never message-not-understood
method installation runs no user code, so a version conflict may be recomputed rather than surfaced
a lost method is never an acceptable outcome of a concurrent addition
adding a method rewrites the dictionary; only migration rewrites a Behavior, and only its methods ref
migration is explicit, per Behavior, fresh identity plus one CAS on the methods edge
installing this machinery migrates nothing; an unmigrated image keeps dispatching
the legacy reader and selector-uniqueness check stay until nothing reachable needs them
this changes lookup, not execution: no IR op, no representation, no ABI
```
