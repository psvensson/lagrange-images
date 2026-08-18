# ADR 0049: The hashed MethodDictionary

Status: implemented — selector lookup moves to a fixed-Shape hashed MethodDictionary that is kernel representation rather than a Smalltalk class, uses only the pure built-in Text hash and equality behind per-version structural validation, and arrives by a seal-build-swap migration that cannot lose a concurrent method addition, while the ADR 0044 reader keeps working.
Proven by: test/hashed-method-dictionary.test.js, test/smalltalk-dispatch.test.js

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
behavior  null — structurally, not merely by convention
hash      Integer Value, the built-in hash of the selector
selector  Text Value
method    an unpinned Block ref, local to the dictionary's image
```

The `behavior` rule carries the weight of decision 2. A MethodDictionary has no dynamic protocol, so
it must not be *dispatchable*: a generic graph write that gave one a behavior edge while leaving the
Shape intact would make it answer messages, and the class it answered through could then override
anything. Requiring `behavior == null` structurally means such a record is malformed rather than
quietly promoted into a Smalltalk object.

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
decision 3 — a non-null behavior, a non-Integer hash, a non-Text selector, a method that is not a
local unpinned Block ref, an indexed length that is not `capacity * 3`, a tally disagreeing with its
buckets — is a **malformed dictionary**, reported as structural corruption. It is never reported as
message-not-understood, because "this class does not implement that selector" and "this dictionary
cannot be read" are different facts and a caller that cannot tell them apart cannot respond to
either.

Two of those checks are not cell-local, and they are the ones that actually protect the distinction:

```text
selector uniqueness    two buckets holding the same selector make one method unreachable
probe reachability     every occupied bucket must be reachable from its own hash's probe start
                       without crossing an empty bucket
```

Without them, corrupted hashed state can physically hide a method and present as an ordinary selector
miss — the exact failure ADR 0044 decision 2 introduced `assertUniqueSelectorShape` to prevent, in
the new format.

### 5a. Global validation is per *version*, not per send

Decision 5 creates a real tension with the performance claim, and pretending otherwise would be the
kind of overstatement this project's ADRs are supposed to avoid. Detecting duplicate selectors,
probe-chain holes and tally violations requires reading the whole table. Doing that on every send is
`O(n)` — precisely the cost this ADR exists to remove.

The resolution is to validate once per *version* of the record, behind a transient cache:

```text
key      (imageId, objectId, _version)
value    "this exact record version was fully validated"
```

Validate the whole table on first sight of a version; afterwards, a send does the cheap probe alone.
A dictionary that changes gets a new `_version` and is validated again.

This is deliberately **not** a selector-result cache. It caches a structural fact about one immutable
record version, not a lookup answer, so it cannot mask a method addition, a migration, or any other
graph change — the thing that would change the answer also changes the key.

That distinction matters because this substrate has an explicit rule against memoizing durable-graph
reads (ADR 0044 decision 8: "a cache without an invalidation contract hides later graph changes"). The
`_version` component *is* the invalidation contract, and it is the reason this cache is permissible
where a selector-result cache would not be.

The cache is transient runtime state: never durable, never a Value, never in the graph, and correct
to drop at any moment. A cold cache costs one `O(n)` validation and then behaves as before.

Full validation is expected `O(n)` — the probe-reachability check costs the sum of bucket
displacements, which linear probing keeps small at the 3/4 load factor — with an adversarial worst
case bounded by cluster length. Amortized across the sends that reuse a version, it is not the hot
path.

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

**An existing shape-backed dictionary** is rewritten by an explicit operation — and that operation
needs a coordination protocol, because the obvious version of it silently loses methods.

#### The race, and why the obvious guard does not catch it

Method addition and migration write *different records*, each guarded by its own version:

```text
defineMethods       writes the dictionary       expectedVersion = the dictionary's version
migration           writes the Behavior         expectedVersion = the Behavior's version
```

So an addition that lands between migration's read and its swap changes neither record the swap is
conditioned on. The CAS succeeds, and the added method disappears with the legacy dictionary:

```text
migration  reads legacy L at version v, builds hashed H from that snapshot
addition   adds a selector to L            -> L is now v+1, and it succeeded
migration  CAS Behavior.methods L -> H     -> succeeds; the Behavior never changed
                                              the added method is gone
```

The irony is exact. ADR 0044 decision 1 gave Behaviors a fixed shape precisely so that adding a
method would *not* touch the Behavior record — and that virtue is what makes the Behavior's version
useless as a migration guard. Nothing here is fixed by re-reading `L` just before the swap either:
that narrows the window without closing it, and this ADR's obligation is that a method is never lost,
not that losing one is unlikely.

The two writers need a shared serialization point, and the only record both must pass through is `L`
itself.

#### The protocol: seal, build, swap

```text
1. read legacy L at version v, and validate it completely
2. seal L      CAS on L, expectedVersion = v          <- the serialization point
3. build the hashed MethodDictionary
4. CAS Behavior.methods:  L -> H
```

A seal is a durable marker on the legacy dictionary saying "this record is being migrated; it no
longer accepts additions". After it, `defineMethods` refuses a sealed dictionary with an explicit
conflict rather than writing to a record that is about to be abandoned.

That gives every interleaving a defined outcome:

```text
addition commits before step 2   the seal's CAS fails; migration reloads and includes it
addition attempts after step 2   refused with a clear conflict, and the caller retries
                                 against the hashed dictionary once step 4 lands
```

Either way the method survives, which is the property that matters. A migration failing its seal is
not an error: it reloads and recomputes, which is pure and safe for exactly the reason decision 6
gives — migration executes no user code either.

Crashing between steps 2 and 4 leaves the class sealed but still dispatching through `L`, since the
seal governs writes and not reads. A retry resumes from step 3 and converges. Additions are refused
in the meantime, which is a visible and correct stall rather than silent loss.

The seal is metadata on the legacy record. It hides no ref, it is read only by the method installer,
and dispatch ignores it entirely.

#### The migration target has a deterministic identity

The hashed dictionary is written at a **deterministic per-Behavior id**, ensure-exact-or-create — not
a fresh random identity per attempt.

This is the opposite of ADR 0048 decision 6, and deliberately so. A Dictionary table is one of an
unbounded series of snapshots, so each needs a fresh identity and old ones must stay readable.
A Behavior has exactly one hashed dictionary, ever: after migration, decision 6 rewrites that same
record in place. Migration is one-shot, so its output is a named durable thing, and this substrate's
rule for those is a deterministic id plus ensure-exact-or-create.

Retry-stability is the concrete reason. With a fresh id per attempt, a table write that commits but
whose acknowledgement is lost leaves an orphan, and every retry leaves another; "exhaustive lost-ack
recovery" would then mean recovering into a growing pile of garbage. With a deterministic id the
retry finds its own previous output, reuses it if identical, and refuses it if not.

Building under one identity and swapping one ref is what makes the transition atomic in the way that
matters: a reader sees the complete legacy dictionary or the complete hashed one, never a
half-converted mapping.

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
    duplicate selectors are detected rather than resolving by probe order
    an occupied bucket unreachable from its own probe start is detected, not read as a miss
    a non-null behavior edge makes a dictionary malformed
    legacy and hashed dictionaries coexist in one superclass chain and resolve identically

validation cache
    a table is fully validated once per record version, and a send afterwards probes only
    a changed dictionary is validated again, because its version changed
    corruption introduced by a generic write is caught on the next version, never masked
    dropping the cache changes no answer, only cost
    it caches structure, never a selector result: a method addition is visible immediately

mutation
    adding a method rewrites the dictionary, never the Behavior record
    add-only: redefining a selector is still refused
    two concurrent additions both survive, or one fails with a clear conflict; never a lost method

migration
    an explicit rewrite preserves every selector -> Block mapping
    an addition committing before the seal is included in the migrated dictionary
    an addition attempting after the seal is refused explicitly, never written to an abandoned record
    a method added concurrently with a migration is never lost under any interleaving
    a failure before the Behavior CAS leaves the legacy dictionary active and the class dispatching
    a crash between seal and swap leaves a sealed-but-working class, and a retry converges
    the migration target has a deterministic per-Behavior identity, so a retry produces no orphan
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
- a multi-record image transaction, which would make the seal unnecessary; ADR 0048 already deferred
  one, and the seal is the cheaper answer to a narrower problem
- unsealing, or any operation that returns a migrated Behavior to the legacy representation
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
selector uniqueness and probe reachability are validated, or corruption hides a method as a miss
a MethodDictionary has no behavior edge; a record that has one is malformed, not dispatchable
whole-table validation is cached per (imageId, objectId, _version) — structure, never a lookup result
the version is the invalidation contract; without one, caching a durable-graph read stays forbidden
method installation runs no user code, so a version conflict may be recomputed rather than surfaced
a lost method is never an acceptable outcome of a concurrent addition
adding a method rewrites the dictionary; only migration rewrites a Behavior, and only its methods ref
migration seals the legacy dictionary first: it is the one record both writers pass through
a Behavior's version cannot guard migration, because adding a method deliberately does not touch it
the migration target id is deterministic per Behavior, so a lost acknowledgement leaves no orphan
installing this machinery migrates nothing; an unmigrated image keeps dispatching
the legacy reader and selector-uniqueness check stay until nothing reachable needs them
this changes lookup, not execution: no IR op, no representation, no ABI
```
