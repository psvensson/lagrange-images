# ADR 0043: mutable lexical state and assignment

Status: accepted — the decision for temporaries, sequences and assignment; deliberately no implementation yet.

## Problem

Symmetric Smalltalk cannot express an ordinary program. This is an absence rather than a missing
convenience, and it is checkable: the parser has no assignment, no temporaries and no sequences,
and the neutral executor's entire operation set is `literal`, `argument`, `receiver`, `binding`,
`integer-add`, `equals`, `if`, `send`, `make-block`. Nothing sequences, and nothing assigns.

```smalltalk
| total n |
total := 0.
n := 3.
total := total + n.
total
```

None of that parses today.

Assignment is not merely syntax, which is why it gets an ADR. `x := value` must mean something
definite when `x` is a temporary of the current activation, when `x` is captured by a nested
Block, and eventually when `x` is an object slot. Those are three different decisions wearing one
piece of syntax.

### The trap this ADR exists to avoid

Closures today capture **by value into the durable graph**. `createClosure` builds
`bindings[id] = {name, value: canonicalizeValue(capture.value)}` and persists it with
`putLexicalEnvironment`.

So the obvious implementation of a mutable captured variable — rewrite the environment record on
each assignment — would make this:

```smalltalk
increment := [ n := n + 1 ].
increment value.
increment value.
```

perform two durable graph writes and append two history events, for what Smalltalk considers two
increments of a local variable. That is wrong twice over: it makes activation-local mutation into
graph and history mutation, and it makes closures vastly heavier than the semantics require.

## Decision

### 1. Assignment mutates an activation-visible binding cell

Never a canonical Value, never a Block, and never the durable lexical-environment graph.

```text
immutable lexical layout          durable: binding identity and name
       |
       v
activation-local mutable cells    execution state: contents
       ^
       |
outer Block  <----  nested Block  shares the cell, not a snapshot
```

### 2. Durable lexical environments are never rewritten by assignment

A `LexicalEnvironment` record holds layout — stable binding IDs and their names — plus the values
a closure was created with. Assignment does not touch it. The existing layout-compatibility rule
continues to mean what it already means.

```text
binding identity  !=  binding contents
```

### 3. Cells are activation-scoped execution state, threaded like authority

The seam already exists twice over: `execute(activation, {depth, authority})` carries
execution-scoped state, and PR #50 made that state expire with the activation. Cells join it.

An arena is created at the outermost activation of an execution and is reachable by nested
activations, keyed by stable binding ID, so only bindings a Block actually captures are visible
to it. Nothing new is added to the activation record itself, and nothing beyond what an executor
already receives is exposed.

### 4. A nested Block captures the cell, not the value that happened to be in it

This is the whole point. `[ n := n + 1 ]` invoked twice must observe `2`, because both
invocations resolve the same cell — not because anything wrote to the graph in between.

### 5. Mutable execution state does not persist, and that is deliberate

Cells are activation state, so ADR 0041 already decides their lifetime: they die at the
activation boundary unless an explicit survival contract says otherwise, and no such contract
exists. A closure Block invoked in a *later*, separate execution therefore materializes fresh
cells from its durable environment rather than resuming the ones it mutated.

Recorded rather than discovered, because it is genuinely surprising: mutation is shared within an
execution and invisible across executions. Making it persist would be a survival mechanism under
ADR 0041 — needing an owner, an identity, an expiry, a release and forced cleanup — and must not
emerge accidentally from a closure being stored.

### 6. Assignment is an expression whose value is the assigned value

So `a := b := 0` works, and an assignment may be the last statement of a Block. This matches
Smalltalk and costs nothing.

### 7. A sequence evaluates in order and yields its last expression

`a. b. c` is three expressions evaluated left to right; the sequence's value is `c`'s. An empty
sequence is not expressible, which avoids deciding what it would return.

### 8. Reading an unassigned temporary is an error, because there is no `nil` yet

Smalltalk temporaries begin as `nil`. There is no `nil` to begin as: the canonical Value set is
`boolean | integer | float64 | text | bytes | ref | pinned-ref`, deliberately, and `nil` is a
personality concept that does not exist in this personality yet — verified, not assumed.

Rather than invent one here, a temporary is declared but unbound until assigned, and reading it
before assignment fails explicitly.

That is narrow, and honest about being narrow. `nil` belongs with `true`, `false` and `Object` in
the object-system bootstrap, where its identity can be decided once alongside them instead of
being introduced as a side effect of needing a default. An explicit failure is also strictly
better than a surprising default while the language is this young.

### 9. Both execution paths must agree

The neutral executor and the Lagrange-WASM lane must produce the same result for the same
semantic artifact, as they already must for everything else. A mutable cell that worked only in
the interpreter would be a differential bug waiting for its first real program.

## Proof

Temporaries, sequences and assignment land together, because they exercise each other and none is
independently demonstrable.

```smalltalk
| total n |
total := 0.
n := 3.
total := total + n.
total                     "6 -> 3; must be 3 in both execution paths"
```

Then the load-bearing case:

```smalltalk
| n increment |
n := 0.
increment := [ n := n + 1 ].
increment value.
increment value.
n                         "must be 2 in both execution paths"
```

If that returns `2` through the neutral executor and through Lagrange-WASM, the language has real
mutable lexical closure semantics rather than syntax painted over immutable captures. If it
returns `0`, captures are still snapshots. If it returns `1`, the cell is being re-materialized
per invocation.

Also required:

- assignment's own value, so `a := b := 0` binds both
- a sequence's value is its last expression
- reading an unassigned temporary fails explicitly rather than defaulting
- two closures over the same temporary observe each other's writes
- a closure over a temporary of an *outer* Block, not just of a method
- no assignment produces a `LexicalEnvironment` write or a history event — asserted by comparing
  history length across a program that assigns repeatedly
- a Block whose cells have expired materializes from its durable environment rather than failing
  or resuming

## What is deferred

- slot assignment. `x := v` where `x` names an instance variable needs the object system, and it
  is also an `object/write`-shaped question rather than a lexical one
- `nil`, `true` and `false` as objects, with the object-system bootstrap
- cascades, which are surface syntax and need no decision
- non-local return and `thisContext`
- persistence of mutable execution state, per decision 5 and ADR 0041

## Guardrails

```text
assignment mutates a cell, not a Value, a Block, or the durable graph
binding identity != binding contents
durable lexical environment is layout, never rewritten by assignment
a closure captures the cell, not a snapshot
cells are activation state; they expire with the activation
persistence of cells would be an ADR 0041 survival mechanism, not a side effect
assignment is an expression
a sequence yields its last expression
unassigned temporary != nil; there is no nil yet
both execution paths agree, or it is not implemented
```
