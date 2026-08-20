# ADR 0052: Closure instance lifetime and identity

Status: accepted — a closure *instance* is execution-local by default and acquires a durable Block and LexicalEnvironment only when it crosses a durability boundary, so evaluating a Block literal costs no graph write unless the resulting closure actually escapes.

## Problem

ADR 0051 removed the activation-depth ceiling on iteration. What that exposed is that the ceiling had
been hiding a second one:

```text
loop body creating branch closures    +2 durable Blocks per iteration, forever
loop body creating a capturing closure +1 Block and +1 LexicalEnvironment per iteration, forever
loop body creating no closure          +0 per iteration
```

Strictly linear, never converging, and unbounded in iteration count. Recursion capped it at a couple
of hundred evaluations before `MAX_ACTIVATION_DEPTH` stopped the program; a loop does not. A
long-running image now grows without limit for doing nothing but iterating, which is an operational
problem in a way that missing protocol is not — hence this ahead of Integer ordering (ADR 0053).

The cause is narrow and worth stating precisely, because the fix depends on it. `createClosure` does
**not** mint a program:

```text
prototype        fetched, never created — already durable and already stable
per evaluation   putBlock(code: prototype.code, environment, metadata.prototypeBlockId)
                 putLexicalEnvironment(bindings)   only when there are captures
then             cells.associate(blockRef, cells) and arena.associateFrame(blockRef, frame)
                 — transient, execution-scoped, keyed by the newly minted Block ref
```

So the durable write per evaluation exists to give the instance an *identity* that the transient
arena can key on. The program was never the thing being duplicated.

## Decision

### 1. Three identities, named separately

Most of the confusion here comes from one word doing three jobs. This ADR separates them and uses
only the precise names afterwards:

```text
Block prototype    durable program identity — code plus capture declarations.
                   One per source Block literal. Already stable, already deterministic.

closure instance   one evaluation of that literal. What a Smalltalk programmer calls "a block".
                   Two evaluations of one prototype are two instances.

captured state     what an instance closed over, in two kinds that behave differently:
                     immutable snapshots  values, meaningful outside the creating execution
                     live cells + frame   ADR 0043 cells and ADR 0050 defining frame,
                                          meaningful only inside it
```

The defect is entirely in the second row. Prototypes are fine, and this ADR does not touch them.

### 2. What must not change

These are existing guarantees, and any candidate that weakens one is rejected regardless of what it
saves:

```text
1  evaluating one creation site twice may produce semantically distinct instances
2  an immutable-snapshot closure may outlive its creating execution and still work
3  live mutable cells exist only within the creating execution
4  defining Behavior / lexical self provenance is transient, never durable
5  an ivar-dependent closure that escaped its execution fails closed later (ADR 0050 decision 10a)
6  a mutable-cell closure that escaped fails with EscapingMutableClosureError (ADR 0043 decision 5)
7  the neutral and WASM lanes share exactly one lifetime model
```

Invariant 1 is the one this ADR is most at risk of breaking, and it is not hypothetical: two
simultaneously live instances of one site today differ by snapshot (`10` and `20` answering
independently) and by lexical self (two receivers bumped independently, `1` and `2`).

### 3. Per-site deterministic ids are rejected as the general model

The tempting fix — derive the instance id from the creation site, so repeated evaluation converges
under ensure-exact-or-create — is refused, because instances from one site are not interchangeable.

The aliasing is not abstract. The transient arena keys **on the instance ref**:

```text
cells.associate(blockRef, capturedCells)      live cells for this instance
arena.associateFrame(blockRef, frame)         ADR 0050 defining frame for this instance
```

Give two simultaneously live instances the same ref and the second `associate` silently displaces
the first, so one closure answers with the other's cells or acts on the other's `self`. That breaks
invariant 1, and it breaks it *quietly* — the wrong value, not an error.

Worth noting what does **not** save this: Block instance identity is currently unobservable from
Smalltalk, because a Block answers only `value`, `whileTrue:` and `whileFalse:` (ADR 0044 decision
11) and `=` is a does-not-understand. So the argument for per-site ids cannot be "nobody can tell" —
the arena can tell, and it is what makes closures work.

### 4. Durable garbage collection is rejected as the primary answer

Collecting unreachable closure Blocks would preserve every invariant, since it changes no semantics
at all. It is refused as the *primary* answer for two reasons:

```text
it still writes    every short-lived closure remains a durable write plus history, so the
                   operational cost is paid and then refunded, rather than not incurred
it is large        distributed reachability and reclamation over a persistent, shared,
                   versioned image is a subsystem, not a fix
```

A closure that never leaves its execution should not become durable in the first place. Collection
remains available later for closures that genuinely were promoted and then died, which is a much
smaller problem than collecting everything.

### 5. Closure instances are execution-local, and promoted on escape

The decision:

```text
by default    a closure instance is an execution-local value: prototype ref + captured state,
              held in the arena. No putBlock. No putLexicalEnvironment. No history event.

on escape     the instance is materialized into exactly today's durable form — a Block whose
              code is the prototype's and whose environment holds the bindings — at the moment
              it crosses a durability boundary, and not before.
```

This is chosen because it makes the common case free rather than cheap, and because the durable form
it promotes *to* is the one that already exists: promotion is not a new representation, it is the
current representation created later. An image containing promoted closures is indistinguishable from
an image written by today's code.

### 6. The durability boundary, which is the actual decision

Everything above is easy; this is the part that must be got right, because a boundary that is too
narrow loses closures and one that is too wide reintroduces the cost. A closure instance is promoted
when, and only when, a reference to it would otherwise outlive the arena:

```text
promote when the instance is
  returned from a root execution                    it reaches a caller with no arena
  written into an object slot, indexed part,
    or a Dictionary                                 a durable record would point at it
  captured by another closure that is itself
    promoted                                        transitive: promotion of a holder promotes
                                                    what it holds
  installed as a method, or referenced by any
    durable record                                  same rule, stated for the publication paths
  returned across a foreign-runtime or host
    boundary                                        the handle outlives this execution

do NOT promote when the instance is
  passed as an argument to a nested send            same arena
  answered to a caller within the same execution    same arena
  invoked and discarded                             the whole point
  stored in a temporary or cell of this execution   dies with the arena
```

The rule underneath the list, which is what a future case should be decided by: **promotion follows
reachability from anything that outlives the arena.** The list is that rule applied to the escape
routes the substrate currently has, not an independent enumeration.

Promotion is idempotent and identity-preserving: promoting an already-promoted instance answers the
same Block ref, so a closure written into two slots is one closure.

### 7. What a promoted closure carries, and what it deliberately loses

Promotion must not become a way to make transient things durable, which would quietly repeal ADRs
0043 and 0050:

```text
immutable snapshots   carried into the durable environment as values, exactly as today.
                      A promoted snapshot closure works in a later execution — invariant 2.

live mutable cells    the durable environment records {name, cell: true} and never cell
                      contents, exactly as today. A later execution therefore raises
                      EscapingMutableClosureError rather than restarting from a stale value.

defining frame        NOT carried. There is no durable field for it and this ADR adds none.
                      A promoted ivar-dependent closure invoked in a later execution finds no
                      frame and fails closed — invariant 5, unchanged and for the same reason:
                      a persisted defining Behavior would be forgeable data.
```

So promotion changes *when* the durable record appears, never *what* it may contain.

### 8. The capture-free case is an optimization, not the definition

A closure instance with no captures and no live frame dependency could reuse its prototype directly,
since there is nothing per-instance to distinguish. This ADR permits that, and explicitly refuses to
build the model on it:

```text
branch closures in a loop     2 per iteration, all capture-free   -> the special case removes all
capturing closure in a loop   1 Block + 1 environment per
                              iteration, none capture-free        -> the special case removes none
```

The measured ADR 0051 workload is entirely the first shape, which is exactly why it is a trap: it
would look like a complete fix while leaving the second shape growing without bound. The special case
is therefore a consequence of the lifetime model — a capture-free instance needs no distinct identity
because it has no per-instance state — and never the definition of closure identity.

### 9. Both lanes, one model

The neutral executor and Lagrange-WASM share the lifetime model, the boundary and the promotion
rules. A closure created in one lane and invoked in the other behaves identically, and a WASM
suspension across a non-tail send is not a durability boundary: the arena survives the suspension, so
a closure that never escapes is never promoted by the mere fact of resumption.

## Proof required for implementation

```text
the operational claim
    100,000 evaluations of a non-escaping closure creation site produce O(1) durable records
    the same at 1,000 and 10,000, so the constant is shown to be a constant
    a closure-free loop body still allocates nothing

instances stay distinct
    two simultaneously live instances of one site with different snapshots answer independently
    two simultaneously live instances over different receivers act on their own self
    one instance invoked repeatedly keeps its own live cell

escape still works
    an immutable-snapshot closure returned from a root execution works in a later execution
    a closure written into a slot, an indexed part and a Dictionary is promoted, and is one
        closure when written twice
    a closure captured by another closure that escapes is promoted transitively
    a promoted closure is byte-identical to the record today's code would have written

escape still fails where it must
    an escaped mutable-cell closure raises EscapingMutableClosureError
    an escaped ivar-dependent closure fails closed in a later execution
    neither failure is converted into a stale value

lanes
    neutral and WASM agree on all of the above
    a WASM suspension across a non-tail send promotes nothing by itself

what must not have changed
    prototypes are untouched, and remain deterministic and stable
    no new durable record kind, Value kind, activation field or executable representation
    a promoted closure's durable form is exactly today's Block + LexicalEnvironment
```

## What is deferred

- collecting closures that were genuinely promoted and later became unreachable, which is the
  smaller problem this ADR leaves behind rather than the one it solves
- `BlockClosure` as an ordinary class with a method dictionary (ADR 0044 decision 11), and with it
  any observable Block identity or `=` protocol
- non-local return, which interacts with instance lifetime and deserves its own decision
- promotion of the *prototype* tree, which is unaffected: nested prototypes are already deterministic
  under ADR 0051's `nestedIds`

## Guardrails

```text
prototype, closure instance and captured state are three identities; never conflate them
a closure instance that does not escape performs no graph write
promotion happens at the durability boundary, and the boundary rule is reachability from
    anything outliving the arena — the enumerated list is that rule applied, not a definition
promotion is idempotent and identity-preserving
a promoted closure carries snapshots, carries {cell: true} without contents, and carries no frame
per-site deterministic instance ids are rejected: the arena keys cells and frames on the instance
    ref, so two live instances of one site would alias quietly
durable GC is not the primary answer; not writing is better than writing and reclaiming
the capture-free reuse case is an optimization that falls out of the model, never its definition
neutral and WASM share one lifetime model; a WASM suspension is not an escape
ADRs 0043 and 0050 are unchanged: mutable cells and defining frames stay execution-scoped
```
