# ADR 0055: Non-local return

Status: accepted — `^` is syntax the compiler learns, compiled to an ordinary send to a language-owned primitive that unwinds to the home method activation, which is identified by the ADR 0050 frame the Block was created in rather than by any new notion of activation identity.

## Problem

`OrderedCollection >> includes:` still cannot answer from inside its own loop:

```smalltalk
includes: item
  | index found |
  index := 1. found := 1 = 2.
  [ found ifTrue: [ 1 = 2 ] ifFalse: [ index <= tally ] ] whileTrue: [
    (item = (contents at: index)) ifTrue: [ found := 1 = 1 ] ifFalse: [ 1 = 2 ].
    index := index + 1 ].
  found
```

The `found` temporary exists solely because a Block cannot return from its enclosing method. Every
search, every `detect:`, every early exit in the eventual collection protocol carries the same
scaffolding, and each one is a place to get the flag logic wrong.

ADR 0054 built most of the machinery this needs — a transfer that unwinds the host stack, protection
blocks that run on the way past, and one execution-wide runtime to hang scopes on. What it did not
build is the part that makes non-local return *different*: a target that is a lexically enclosing
method activation rather than a dynamically established scope, and which may have returned already.

## Decision

### 1. `^` is syntax, and the compiler learns it

Unlike every language decision since ADR 0045, this one does change the compiler — and the
distinction is worth being precise about, because "the compiler learns nothing" has been a guardrail
throughout:

```text
what the compiler learns    `^` as syntax: a caret token and a return statement
what it does NOT learn      any selector. `^` is not a message and never was
```

A return is syntax in every Smalltalk, not a message send, so this is not the erosion the guardrail
was protecting against. The guardrail exists to stop the compiler recognizing *selectors* —
`ifTrue:`, `whileTrue:`, `<` — and that rule is untouched.

### 2. The semantic output is an ordinary send; `lagrange-code` stays frozen

```text
^ expr   compiles to   primitiveNonLocalReturn value: expr
```

No new IR operation, no new executable representation, and `lagrange-code/v0` and `/v1` remain frozen.
The alternative — a `return` op — would require a new semantic representation version for a feature
that a primitive expresses exactly, and would put a control-flow construct into a language-neutral IR
that has no notion of a Smalltalk method.

So the compiler's *syntax* grows and its *output vocabulary* does not. A reader of the semantic
artifact sees a send, like every other language operation since ADR 0045.

### 3. The target is the ADR 0050 frame, not a new identity

This is the decision the rest depends on, and the pleasing part is that the identity already exists.

A method activation already has a transient frame — `{self, definingBehavior}` — created per dispatch
and carried in the invocation envelope. A Block created inside that method already has that frame
associated with it in the arena, because that is how ADR 0050 gives a closure its lexical `self`.

```text
home activation   the method activation whose frame the Block was created in
found by          arena.frameFor(blockRef), which already exists and is already correct
```

So `^` inside a Block targets the frame the Block would read `self` from. That is exactly Smalltalk's
home context, reached through machinery that is already load-bearing rather than a parallel scheme
that could disagree with it.

The primitive obtains that frame the way every kernel primitive does: a kernel-primitive send
INHERITS the caller's frame (ADR 0050 decision 5a rule 2), and a closure's activation RESTORES its
creation frame (rule 3). Chained, those two rules already deliver the home frame to the primitive
with no new propagation.

### 4. Liveness lives beside the frame, never in it

The frame's shape is validated as *exactly* `{self, definingBehavior}` at the dispatch seam, so
liveness cannot be a third field without changing a checked contract — and should not be, because
liveness is execution state and the frame is a description of identity.

```text
an executor-owned side table   marks a frame live while its method activation is running,
                               and dead when it returns, on both the normal and the
                               exceptional path
never durable                  no record, no Value, no activation field
```

A frame is only ever a key here. Nothing about it changes shape, and nothing outside the executor can
read or forge the liveness of an activation.

### 5. Returning to an activation that has already returned is an explicit failure

Two ways a Block can outlive its home, and they must be distinguished from each other and from
success:

```text
same execution, method returned    the frame is known and marked dead
                                   -> an explicit "cannot return" failure naming the method

later execution                    the arena is gone, so the frame is not available at all
                                   -> fails closed exactly as an ivar-dependent escaped closure
                                      does today (ADR 0050 decision 10a), for the same reason
```

Neither may answer a value, and neither may be silently converted into a local return. A `^` that
quietly became "answer from this Block" would be the worst possible outcome: a program that computes
the wrong thing rather than one that stops.

Making the first case *work* — resuming a returned activation — would require durable activation
identity and a way to re-enter a frame that no longer exists, which in the WASM lane means an
instance that has been retired. That is refused, not deferred: it is the same impossibility ADR 0054
decision 4 records for unwinding.

### 6. Unwinding is ADR 0054's, unchanged

A non-local return is a transfer, and it travels the way a `return:` does:

```text
ensure: and ifCurtailed:   run on the way past, because a non-local return is a non-normal exit
on:do:                     does not claim it — the transfer names an activation, not a handler
                           scope, so an unrelated handler cannot intercept a return
WASM                       a suspended activation it passes is retired, exactly as decision 4 says
```

The one new rule: a transfer that reaches an activation whose frame it names *stops there* and
becomes that method's answer. Everything else about it is the mechanism ADR 0054 already proved.

### 7. `^` outside a Block is the same mechanism

`^ expr` written directly in a method body is not a special case: it targets its own activation,
which is trivially live, and stops the method. That matters because methods currently answer their
last expression, so a mid-method `^` with statements after it must actually stop rather than
evaluate them.

Using one mechanism for both means there is no second path to get wrong, at the cost of a send where
a compiler could have emitted a jump. That is the right trade at this stage — and the cost is a send
in the lane that already makes every operation a send.

### 8. What this retires

```text
includes:   answers from inside the loop; the `found` temporary is deleted
AGENTS.md   loses the non-local-return gap signal, because the gap is gone
```

As with ADR 0051 and ADR 0053, the awkward spelling goes with the gap it marked rather than surviving
as decoration.

## Proof required for implementation

```text
syntax and shape
    `^ expr` parses, and the semantic artifact contains an ordinary send — no new IR op
    `lagrange-code/v0` and `/v1` are unchanged, and no new executable representation appears
    the compiler recognizes no new *selector*

returning
    `^` from inside a Block returns from the enclosing method, not from the Block
    `^` from inside a nested Block, two levels deep, does the same
    `^` from inside a loop body exits the loop and the method together
    `^` in a method body stops it: statements after it do not run
    the value answered is the method's answer at its call site

the dead-target cases
    a Block whose method already returned fails explicitly, naming the method, in the same
        execution — and does NOT answer locally
    the same Block invoked in a later execution fails closed, as an escaped ivar closure does
    neither case is convertible into a local return by any spelling

interaction
    `ensure:` and `ifCurtailed:` run when a non-local return unwinds past them
    an unrelated `on:do:` does not intercept a non-local return
    a `^` inside a handler returns from the handler's home method, not to the `on:do:`
    a non-local return past a suspended WASM activation retires it, proven by pool statistics

lanes and durability
    neutral and WASM agree on every case above, including the home method being in the other lane
    the liveness table reaches no durable record, no Value and no activation field
    installation is idempotent, and every write is swept pre-commit and commit-then-lost-ack with
        both images and compilation bound to the faulting service, in both lanes

the library
    `includes:` answers from inside its loop and the `found` temporary is gone
    a search over a thousand elements still works, and stops early
```

## What is deferred

- `^` from a Block whose home has returned, made to *work* rather than fail — refused per decision 5
- reifying an activation as an object, or a debugger that can resume one
- `thisContext` and the reflective protocol generally
- `doesNotUnderstand:`, still ADR 0054's deferral and still a metaobject-protocol decision
- optimising the common in-method `^` into something cheaper than a send

## Guardrails

```text
`^` is syntax, not a selector; the compiler still recognizes no selector, and lagrange-code stays
    frozen — the semantic output of `^` is an ordinary send
the target is the ADR 0050 frame the Block was created in, reached by the existing inherit/restore
    rules; never a second notion of activation identity
liveness lives in an executor-owned side table keyed by the frame, never as a frame field — the
    frame's shape is validated as exactly {self, definingBehavior}
returning to a dead activation fails explicitly and is NEVER converted into a local return
unwinding is ADR 0054's mechanism: protection blocks run, `on:do:` does not intercept, and a
    suspended WASM activation is retired
one mechanism for `^` in a Block and `^` in a method body; no second path
when `includes:` can answer from its loop, delete the `found` temporary and its gap signal
```
