# ADR 0060: Object residency and promotion

Status: implemented
Proven by: test/object-residency.test.js

An object allocated inside an execution begins as a transient value in that
execution's arena, in the same reserved REF namespace ADR 0052 established for closures, and is
materialized as a durable object record only when a reference to it crosses a durability boundary —
one object kind, one ObjectRef, with residency as a lifetime state rather than a type distinction.

## Problem

ADR 0052 made closure instances execution-local and thereby made iteration free. What it left
standing is the same defect one kind over. Today *every* allocated object is durable at birth:
`allocate` (`smalltalk-primitives.js`) ends in `images.putObject(...)`, so

```text
[ c new add: n ] value            one durable Object + history event, kept forever
(IndexOutOfRange new) signal      one durable Object + history event per occurrence, even when the
                                  handler that catches it discards it in the same activation
OrderedCollection new in a loop   durable garbage at the rate the program allocates
```

That is the cost ADR 0054 decision 1a measured, named, and deliberately declined to pay a design
for: a handled condition allocates a durable object per occurrence, and a tight loop over a failing
accessor grows the image for doing nothing but handling its own signals. ADR 0054 recorded exactly
this question as deferred, and the roadmap carries it as the remaining residency decision.

The temptation is to generalize ADR 0052 by symmetry: closures became transient-by-default, so
objects should too. ADR 0054 also recorded why symmetry is not an argument — a closure's durable
projection is deliberately narrow (a Block plus an immutable snapshot environment, with live cells
and the defining frame explicitly *not* persisting), while a mutable object's durable projection is
its whole reachable mutable graph. The questions that raises are the ones this ADR exists to answer
before anything is built:

```text
identity       does an object keep one identity across promotion, and how
aliasing       if two slots hold one transient object, is it one durable object after promotion
cycles         how does a cyclic structure publish atomically
projection     what happens to mutable slot contents at the moment of promotion
reachability   does persisting one object persist everything it reaches, and when
allocation     does basicNew now make transient objects, and what does `new` answer
```

## Decision

### 1. One object kind, one ObjectRef; residency is a lifetime state

There is one kind of object and one kind of reference to it. An object's *residency* — transient
versus durable — is a fact about its lifetime, never about its type, its Shape, or its behavior:

```text
no new Value kind      a transient object is an ordinary REF Value whose objectId lies in the
                       reserved transient namespace ADR 0052 decision 5b established
                       (~runtime/transient/...), exactly as a transient closure already is

no second store        the arena maps that ref to the object's state; the durable store holds
                       it only after promotion. One identity space with a residency boundary,
                       not two stores with a copy between them

promotion preserves    the object's identity at promotion — within the identity semantics
identity               decided in decision 4
```

This is the same shape ADR 0052 decision 5 chose for closures, for the same reason: the common case
— an object that never leaves its execution — should cost no graph write, and the durable form an
object promotes *to* is the one that already exists. Promotion is not a new representation; it is
the current representation created later.

### 2. The boundary rule is unchanged: reachability from anything that outlives the arena

ADR 0052 decision 6 fixed the rule, and this ADR adopts it verbatim rather than re-deriving it for
objects: **promotion follows reachability from anything that outlives the arena.** Applied to
objects, an object is promoted when, and only when, a reference to it would otherwise outlive the
execution:

```text
promote when the object is
  returned from a root execution
  written into a durable object slot, an indexed part, or a durable Dictionary
  captured as a snapshot binding by a closure being promoted
  installed into any durable record — a class, a method environment, a GlobalBinding
  passed across a foreign-runtime or host boundary

do NOT promote when the object is
  passed as an argument within the same execution
  answered to a caller within the same execution
  stored in a temporary or cell of this execution
  referenced only by other transient objects that themselves never escape
```

The last rule is the one that makes the common case free, and it is decided explicitly because it
is where a naive implementation reintroduces the cost one level up: **a transient object held only
by another transient object is not escaped.** An `OrderedCollection` built, filled and read within
one evaluation — its backing Array, its elements' container, all of it — performs no durable write
unless the collection itself leaves. If a transient holder later escapes, promotion recurses from
it (decision 5).

A signal occurrence is the case ADR 0054 was waiting on: a condition object created, signalled,
handled and discarded inside one execution is reachable only from transient state throughout, so it
promotes never. An unhandled condition returned as the execution's failure crosses the root
boundary and is promoted then, which is exactly when its information must outlive the arena.

### 3. `basicNew` answers a transient object; `new` stays composition

ADR 0046's layering is untouched. `primitiveBasicNew` allocates in the arena instead of in the
durable store, and everything above it is unchanged:

```text
Class >> basicNew     primitiveBasicNew value: self   -> a transient REF in the arena,
                      slots nil-initialized, indexed part nil-initialized, identity fresh
Class >> new          ^self basicNew initialize        -> still composition; `initialize`
                      runs against the arena object exactly as it runs against a durable one
```

`initialize`, slot reads and slot writes (ADR 0050's primitives) operate on the arena state by the
same arena-first resolution the dispatcher already uses for transient closures — never by
promoting. What changes is where the bits live before escape, not which operations are available.

The one behavioral difference an allocation gains is the one this ADR exists for: no
`putObject`, no history event, and no durable identity attempt until the object escapes.

### 4. Identity across promotion: stable, derived, and one per object

The aliasing question answers itself only if identity is decided first, so it is decided here.

A transient object's id is fresh at allocation, inside the reserved namespace — never derived from
its class or its creation site, for exactly the reason ADR 0052 decision 3 rejected per-site
closure ids: two simultaneously live instances of one site are two objects, and the arena keys on
the instance ref. Its durable id is derived from that transient id by the same rule ADR 0052's
`durableIdFor` applies to closures (strip the reserved prefix, re-root under a durable object
namespace), and promotion is memoized on the transient ref.

```text
two slots holding one transient object     one durable object after promotion, shared — the memo
                                           answers the same durable ref for both writes
one object promoted, then promoted again   the same durable ref; promotion is idempotent
a promotion retried after a                ensure-exact-or-create converges on the derived id,
commit-then-lost-ack                       like every other derived id in this substrate
```

So `basicNew` answering twice never aliases, and promotion never duplicates. What this ADR
deliberately does *not* claim: that a transient ref and its promoted durable ref are *equal* —
residency is a lifetime state, and ADR 0048's default equality is identity, which is per-ref. An
object read back from a durable slot after promotion is the promoted ref. Whether Smalltalk needs
an observable equality that treats them as one object is a language question this ADR does not
create; the substrate guarantee is that there is exactly one durable object, not that two refs
compare equal.

### 5. Promotion publishes the reachable graph, in one operation, at one seam

This is the decision ADR 0052 never had to make, because a closure's projection is narrow and its
captured closures share its own representation. An object's projection is its reachable mutable
graph, so the rules closures never needed are stated here:

```text
what is traversed    the object's slots and indexed part, recursively through transient refs
                     only — ADR 0052 decision 7's rule, restated for objects: what is
                     traversed is what is written. Durable refs reachable from the object are
                     edges to existing durable records and are written as edges, not re-published

mutable slots        carried as their values at the moment of promotion. Promotion snapshots
                     the graph as it stands when the holder escapes; later mutation of a
                     promoted object is an ordinary durable write (ADR 0042), not a re-promotion

cycles and sharing   terminate through the same memoization ADR 0052 decision 7a fixed:
                     preassigned derived ids reserved before recursion, so a cycle promotes to
                     a cyclic durable graph and a shared subgraph stays shared. LexicalEnvironment's
                     precedent — records may be staged before every edge resolves — is the
                     mechanism; no strongly-connected-component analysis is added

one operation        every boundary — root return, durable slot/indexed/Dictionary write,
                     closure snapshot, record publication, foreign boundary — calls the same
                     promote(value), extended from the closure-only operation ADR 0052 decision
                     7a centralized. Slot writes, indexed writes and the foreign boundary do not
                     each implement promotion

the guard            ADR 0052 decision 5b's write-seam guard — no durable record may take a
                     reserved id, and none may embed an unpromoted transient ref — is unchanged
                     and now covers objects. Promotion runs before it; the guard exists to make
                     a forgotten boundary loud, and never fires in correct operation
```

Promotion atomicity therefore reduces to a fact the substrate already guarantees: one promote
operation stages the whole reachable subgraph, and the publication rides the backend's atomic
state-and-history transaction contract (ADR 0032). There is no new transactional machinery.

### 6. What does not change

```text
ADR 0043   live mutable cells stay execution-scoped; a transient object referenced only from a
           cell's contents is exactly as transient as any other arena value
ADR 0048   Dictionary internals are durable records and promote through the ordinary write seam;
           nothing about hashing or equality changes
ADR 0050   slot access is still proven against the activation's self; arena-first resolution is
           execution context, never a durable field
ADR 0052   closures keep their own projection rules; this ADR extends the arena and the promote
           operation to objects, it does not re-decide closure lifetime
the write  the reserved-namespace guard and its enforcement point are unchanged; an existing
seam       durable record at a reserved id remains the migration condition ADR 0052 decision 5c
           defined
lanes      neutral and WASM share the one arena and the one promotion operation; a WASM
           suspension is not a durability boundary, so it promotes nothing by itself
```

### 7. Alternatives considered and rejected

**Keep objects durable-at-birth and collect garbage later.** Rejected for the reason ADR 0052
decision 4 rejected it for closures: it pays the write and the history event and then refunds them,
rather than not incurring them, and durable distributed reachability over a versioned image is a
subsystem, not a fix. Collection remains available later for objects that genuinely promoted and
then died — a much smaller problem.

**Make only condition objects transient.** Rejected. ADR 0054 decision 1a named this: a special
lifetime for one class of object is a second category of object, which is precisely what this ADR
removes by making residency a state rather than a type. The pressure that motivated it — handled
conditions as durable garbage — is a consequence of the general rule, not a condition concern.

**Promote eagerly at every durable write site without a central operation.** Rejected as four
implementations of one subtle rule, which ADR 0052 decision 7a already settled: they would
disagree, and the disagreement would appear as the same object sometimes shared and sometimes
duplicated.

### 8. Cost honesty

This makes allocation free only when nothing escapes; it does not make escape cheap. A program that
returns a large transient graph pays one promotion traversal and one atomic publication at the
boundary — work the durable-at-birth model amortized across every write. That trade is the same one
ADR 0052 accepted for closures and for the same reason: not writing is better than writing and
reclaiming, and the common case in a loop or a handled signal escapes nothing.

## Proof required for implementation

```text
the operational claim
    a handled condition allocated, signalled and discarded inside one execution writes no
        durable record — asserted by record count, and at 1, 100 and 10,000 occurrences so the
        constant is shown to be a constant
    an OrderedCollection built, filled and read within one evaluation, never returned,
        promotes nothing

identity and aliasing
    two slots written with one transient object hold one durable object after promotion
    basicNew answered twice at one site gives two objects that never alias
    a promotion retried after a commit-then-lost-ack converges on one durable identity
    a promoted object's durable id derives from its transient id by the 0052 rule

projection
    a cyclic structure promotes to a cyclic durable graph and terminates
    a shared subgraph stays shared under promotion
    a slot mutated after promotion is an ordinary durable write, not a re-promotion
    durable refs reachable from a promoted object are written as edges, not re-published

the boundary
    an object returned from a root execution is promoted and usable in a later execution
    an object that never escapes leaves no durable trace
    the write-seam guard fires only when a boundary forgets to promote, proven by driving
        every boundary through promotion and seeing no refusal

lanes
    neutral and WASM agree on all of the above
    a WASM suspension across a non-tail send promotes nothing by itself
```

## What is deferred

- collecting objects that were genuinely promoted and later became unreachable — the smaller
  problem this ADR leaves behind, not the one it solves
- observable equality between a transient ref and its promoted durable ref, if a language ever
  needs one; the substrate guarantee is one durable object, not ref equality
- whether a transient object may be *adopted* durable by a long-lived structure without promotion
  (an optimization), rather than published by it (this decision)
- garbage-collection rules for the durable graph generally, already on the roadmap independently

## Guardrails

```text
one object kind, one ObjectRef; residency is a lifetime state, never a type or Shape distinction
promotion follows reachability from anything outliving the arena — the enumerated boundary list
    is that rule applied, not a definition
a transient object held only by transient objects is not escaped
basicNew allocates in the arena; new stays composition; slot access resolves arena-first, never
    by promoting
identity is fresh at allocation and stable across promotion; promotion is memoized, idempotent
    and ensure-exact-or-create — never per-site, never duplicated
promotion traverses slots and indexed parts through transient refs only, snapshots mutable state
    at escape, terminates on cycles by preassigned ids, and is one central operation every
    boundary calls — never re-implemented per write site
the reserved-namespace write-seam guard is unchanged and now covers objects; it exists to make a
    forgotten boundary loud and never fires in correct operation
ADRs 0043, 0048, 0050 and 0052 are extended, not re-decided; a WASM suspension is not an escape
allocation free does not mean escape free; not writing is better than writing and reclaiming
```
