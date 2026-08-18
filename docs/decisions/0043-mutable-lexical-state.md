# ADR 0043: mutable lexical state and assignment

Status: implemented
Proven by: test/mutable-lexical-state.test.js, test/mutable-lexical-differential.test.js, test/wasm-lexical-cells.test.js, test/wasm-resumable-cells.test.js

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

A `LexicalEnvironment` record holds layout — stable binding IDs and their names — plus the binding
*state* a closure was created with, which may be unbound (decision 6). Assignment does not touch
it. The existing layout-compatibility rule
continues to mean what it already means.

```text
binding identity  !=  binding contents
```

### 3. A cell is scoped by lexical activation *and* static binding ID

An earlier draft said the arena is keyed by stable binding ID. That is wrong, and checkably so.

Binding IDs are **static lexical slot identity**. The compiler builds them from a path that
defaults to `'root'` for every separate compilation — `root:parameter:0`, `root:self`,
`root/block:0:parameter:0` — so two activations of the same code deliberately share their binding
IDs, and two unrelated semantic artifacts both start at `root`.

Keying by binding ID alone would therefore make recursion share one variable, make two
invocations of the same Block share temporaries, and make unrelated artifacts collide.

```text
static lexical layout
        |
        +-- binding id x
        |
activation/frame #1  ---->  cell x1
activation/frame #2  ---->  cell x2

nested closure created in frame #1
        `--------------------->  captures cell x1
```

So:

```text
binding ID  =  static lexical slot identity
cell        =  that slot in one particular lexical activation
```

An execution-wide arena may still own frames for lifetime purposes — that is what makes cells
expire with the execution — but lookup is by frame plus binding ID, never by binding ID alone. A
nested closure captures the cell of the frame that *declared* the binding, not whichever frame is
currently running.

Cells thread through the options object that already carries `depth` and `authority` and already
expires with the activation. Nothing is added to the activation record, and nothing beyond what an
executor already receives is exposed.

### 4. A nested Block captures the cell, not the value that happened to be in it

This is the whole point. `[ n := n + 1 ]` invoked twice must observe `2`, because both
invocations resolve the same cell — not because anything wrote to the graph in between.

### 5. Persistence of mutable captured cells is deferred, not replaced by reset semantics

Cells are activation state, so ADR 0041 already decides that they cannot survive an activation
absent an explicit survival contract, and no such contract exists.

An earlier draft went further and said a stored closure invoked in a later execution
materializes fresh cells from its durable snapshot. That is a worse divergence from Smalltalk
than the missing `nil`, and it should not be written down as the language's semantics. Ordinary
Smalltalk is unambiguous:

```smalltalk
| n counter |
n := 0.
counter := [ n := n + 1 ].
```

If `counter` survives, its `n` survives with it. Invoking it tomorrow does not restart `n` from
whatever was captured when the Block was created.

So the honest position is that this case is **unsupported**, not redefined:

```text
non-escaping mutable closure
    activation-local cells, cheap, no graph writes

escaping mutable closure
    a future explicit ADR 0041 survival or promotion contract,
    with proper persistent Smalltalk semantics
```

Cross-execution invocation of a closure that depends on mutable captured state is not promised
Smalltalk persistence semantics, and should fail explicitly rather than silently resetting a
counter to an old value. Immutable captured values continue to behave exactly as they do today.

Baking "persistent counters quietly reset between executions" into the language would be far
harder to remove later than an explicit unsupported-case error is now.

### 6. Unbound is a binding *state*, never a Value

A closure may be created before the variable it captures is assigned:

```smalltalk
| x reader |
reader := [ x ].
x := 42.
reader value              "must be 42: the closure captured the cell, not a snapshot"
```

At closure creation there is no canonical Value for `x`, and today there is no way to say so.
`normalizeBindings` requires each binding to contain *exactly* `name` and `value`, and applies
`canonicalizeValue` unconditionally — so an unbound capture is currently unrepresentable, and
`createClosure` cannot persist one.

Binding state therefore gains an unbound case, without inventing a Value:

```text
bound:    {name, state: 'bound', value: Value}
unbound:  {name, state: 'unbound'}
```

The exact spelling is implementation detail; the invariant is not:

```text
unbound binding state  !=  nil
unbound binding state  !=  a Value
```

Existing stored environments carrying `{name, value}` continue to mean bound, so this widens the
record rather than breaking it.

At runtime the same distinction is a private cell state:

```text
UNBOUND    a host sentinel; never a canonical Value, never observable as one
Value      once assigned
```

Which is what lets the object-system bootstrap later change a temporary's initial contents from
`UNBOUND` to the `nil` object ref without touching assignment or cell machinery at all.

### 7. Assignment is an expression whose value is the assigned value

So `a := b := 0` works, and an assignment may be the last statement of a Block. This matches
Smalltalk and costs nothing.

### 8. A sequence evaluates in order and yields its last expression

`a. b. c` is three expressions evaluated left to right; the sequence's value is `c`'s. An empty
sequence is not expressible, which avoids deciding what it would return.

### 9. Reading an unassigned temporary is an error, because there is no `nil` yet

> **Superseded for bootstrapped Symmetric Smalltalk execution by ADR 0044 decision 8.** There is a
> `nil` now, so in an image carrying a Smalltalk kernel a declared temporary starts holding that
> image's `nil` ref. The decision below still governs every other case: an image without a kernel
> initializes to `UNBOUND` and raises exactly as described here, and a durable `{unbound}` capture
> written before a bootstrap keeps its meaning forever rather than being reinterpreted.
>
> The sentence that dated this decision is its own: *"Rather than invent one here."* The reason was
> the absence of `nil`, and only that absence.

Smalltalk temporaries begin as `nil`. There is no `nil` to begin as: the canonical Value set is
`boolean | integer | float64 | text | bytes | ref | pinned-ref`, deliberately, and `nil` is a
personality concept that does not exist in this personality yet — verified, not assumed.

Rather than invent one here, a temporary is declared but unbound until assigned, and reading it
before assignment fails explicitly.

That is narrow, and honest about being narrow. `nil` belongs with `true`, `false` and `Object` in
the object-system bootstrap, where its identity can be decided once alongside them instead of
being introduced as a side effect of needing a default. An explicit failure is also strictly
better than a surprising default while the language is this young.

### 10. Both execution paths must agree

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

Frame isolation is just as load-bearing as the increment case, because the simple proof above
would pass while recursion was fundamentally broken:

- two invocations of the same Block within one outer execution do not share temporaries
- recursion does not share temporaries between activations
- two unrelated semantic artifacts whose static binding IDs both begin `root:` do not collide
- two closures created in the *same* lexical activation share a captured cell
- two closures created by *different* activations of the same code do not

Capture before assignment, which the current durable binding shape cannot express at all:

```smalltalk
| x reader |
reader := [ x ].
x := 42.
reader value              "must be 42"
```

Also required:

- assignment's own value, so `a := b := 0` binds both
- a sequence's value is its last expression
- reading an unassigned temporary fails explicitly rather than defaulting
- two closures over the same temporary observe each other's writes
- a closure over a temporary of an *outer* Block, not just of a method
- no assignment produces a `LexicalEnvironment` write or a history event — asserted by comparing
  history length across a program that assigns repeatedly
- invoking a closure that depends on mutable captured state across executions fails explicitly
  rather than resetting it

## Implementation status

Landed across both execution lanes.

```text
src/execution/lexical-cells.js      frames, cells, arena — the common layer, not a lane's private one
lagrange-code/v1                    temporaries, sequences, binding-write, capture modes
neutral-expression/v1               the executable counterpart; no frame machinery in the IR
{name, cell: true}                  the third durable capture disposition
lagrange-value-handle/v1            synchronous cell_get/cell_set; mixed-mode closure sites
lagrange-value-handle-resumable/v2  the same, correct across suspension and resumption
wasm-nested-block-tree/v1           its own group policy, so the v0 tree is untouched
```

Nothing older changed meaning. The v0 compilers emit byte-identical modules, `lagrange-code/v0` and
`neutral-expression/v0` are untouched closed grammars, and source needing none of these semantics
still produces exactly its v0 artifact.

Two findings shaped the WASM lane:

**A shared cell cannot be a WASM local.** The closure that writes it is a separate activation with
its own frame, so a local would give each activation its own copy — the snapshot semantics this ADR
exists to remove. Cells stay host-side behind synchronous imports.

**Cell identity is never continuation state.** A Value already read from a cell may be saved across
a suspension, because evaluation consumed that read before suspending; a future read or write always
goes through `cell_get`/`cell_set`. So an assignment whose right-hand side suspends lowers its write
into the resume segment and writes only after resumption.

A cell capture occupies no Value-handle position anywhere in either ABI, so there is no channel
through which a snapshot of a mutable cell could enter a closure.

The proofs are differential: one source compiles to one `lagrange-code/v1` artifact and runs through
the neutral executor and through the WASM Block tree — simple backend where every effect is in tail
position, resumable where it is not — and the lanes are compared to each other rather than to
hardcoded constants.

Arithmetic in the proofs arrives as a message send to a Block, because `integer-add` is a
neutral-expression op no front end emits. Making `+` a primitive would prejudge Integer objects, so
it belongs with the object bootstrap.

## What is deferred

- slot assignment. `x := v` where `x` names an instance variable needs the object system, and it
  is also an `object/write`-shaped question rather than a lexical one
- `nil`, `true` and `false` as objects, with the object-system bootstrap
- cascades, which are surface syntax and need no decision
- non-local return and `thisContext`
- persistence of mutable captured cells, and therefore escaping mutable closures, per decision 5.
  This needs an explicit ADR 0041 survival or promotion contract

## Guardrails

```text
assignment mutates a cell, not a Value, a Block, or the durable graph
binding identity != binding contents
durable lexical environment is layout, never rewritten by assignment
a closure captures the cell, not a snapshot
cell key == lexical activation + static binding ID, never binding ID alone
binding ID == static slot identity, not a runtime variable
cells are activation state; they expire with the activation
unbound binding state != nil, != Value
UNBOUND is a runtime sentinel, never observable as a Value
escaping mutable closures are unsupported, not silently reset
persistence of cells would be an ADR 0041 survival mechanism, not a side effect
assignment is an expression
a sequence yields its last expression
unassigned temporary != nil where there is no nil (see decision 9's supersession note)
both execution paths agree, or it is not implemented
```
