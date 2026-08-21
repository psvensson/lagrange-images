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

### 2a. The lowering's binding seam is the existing one

There are no globals, so the send `^` lowers to needs a captured ref — and the pattern already exists:
ADR 0050's class-scoped binder injects reserved captures for the slot primitives, and installation
binds them to that image's Blocks. This uses the same seam, with the same reservation rules.

```text
primitive        non-local-return
Block id         smalltalk/primitive/non-local-return
capture name     $nonLocalReturn      reserved, like the slot-primitive captures
```

The method compiler injects that capture declaration when `^` occurs; installation binds it to the
image's primitive Block; nested Blocks inherit it through ordinary capture propagation, exactly as
they inherit the slot primitives today.

The point of doing it this way rather than baking an id into the compiler is that the semantic
artifact stays **image-independent**: it names a stable binding id and nothing about which image will
run it. Reserving the name and the id also matters — an unreserved `$nonLocalReturn` declared by a
caller would be spread after the binder's and silently replace it, which is precisely the collision
the uniform capture contract already refuses for the slot primitives.

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

### 3a. Ownership, not frame equality, decides where the transfer stops

Naming the frame is not enough, and this is the subtlety that would otherwise produce a return that
stops in the wrong place. The executor *deliberately* propagates one frame object into several
activations — that is what makes lexical `self` work:

```text
a dispatch that supplied a frame     OWNS it      — created fresh for this method activation
a kernel-primitive send              BORROWS it   — inherits, so slot primitives act for the caller
a closure activation                 BORROWS it   — restores, so it reads its creator's self
```

So at the moment a non-local return is raised, the *return primitive itself* is running with the
home frame, and so is every intervening Block. If a transfer stopped at "an activation whose frame is
this one", it would be caught immediately by the primitive that raised it, or by the nested Block it
was written in, and never reach the method.

The rule is therefore ownership:

```text
only the OWNER marks its frame live and dead
only the OWNER catches a transfer naming that frame
a borrower does neither, however identical its frame
```

The four routes are already distinguishable where it matters — the executor resolves them in
priority order, from a dispatch-supplied frame down to an arena restoration — so ownership is
readable at the point the catch belongs and needs no new state.

**And identity means object identity.** Two activations of the same method on the same receiver have
equal `{self, definingBehavior}` and are different homes: a recursive method must return from *its
own* activation, not from an outer one that happens to look the same. Matching structurally would
make a recursive early exit return from the wrong depth, so the frame is compared by identity and the
proof list requires a re-entrant case to pin it.

### 4. Liveness lives beside the frame, never in it

The frame's shape is validated as *exactly* `{self, definingBehavior}` at the dispatch seam, so
liveness cannot be a third field without changing a checked contract — and should not be, because
liveness is execution state and the frame is a description of identity.

```text
an executor-owned side table   marks a frame live while its method activation is running,
                               and dead when it returns, on both the normal and the
                               exceptional path
retained while reachable       a dead entry survives as long as the frame is still reachable
                               from this arena, which is what distinguishes the two failures
never durable                  no record, no Value, no activation field
```

Retention is load-bearing rather than housekeeping. Decision 5 distinguishes "the method already
returned" from "no home is available", and those are only distinguishable while the dead entry
survives: forget it too early and a returned-from method becomes indistinguishable from an escaped
closure, collapsing a precise diagnosis into a vague one. The entry may go when the frame itself does,
because at that point nothing can name it.

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

The one new rule: a transfer that reaches the activation that *owns* the frame it names stops there
and becomes that method's answer. Everything else about it is the mechanism ADR 0054 already proved.

**Cleanup precedence.** The classic case is decided rather than discovered:

```smalltalk
[ ^ 1 ] ensure: [ ^ 2 ]
```

answers **2**. A cleanup that itself performs a non-local transfer supersedes the one already
unwinding — it is a later, more specific act of control flow, and honouring the first would make the
second silently do nothing. This is consistent with ADR 0054's cleanup rule rather than an exception
to it: there, an *ordinary* cleanup value is discarded and the original transfer continues, and here
the cleanup is not answering a value but transferring. Discarding a value and overriding a transfer
are different because the second is not a value at all.

### 6a. A standalone Block has no home, and is refused at compile time

`compileSymmetricSmalltalkBlock` has no method context at all, so a `^` compiled there could never
have a home. That is a compile-time fact, not a runtime accident, and is reported as one:

```text
the parser                      accepts `^` universally — it is syntax, and one grammar
generic Block compilation       REFUSES it: "non-local return requires a method home"
class-scoped method compilation permits it, and supplies the intrinsic binding
```

Deliberately distinct from the escaped-Block case in decision 5. That Block compiled legitimately
inside a method and *had* a home; it fails later because the home died. A standalone Block never had
one, and refusing it at compile time is better than installing something that can only ever fail.

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
    a recursive method returns from its OWN activation: two live activations with the same
        receiver and the same defining Behavior are different homes, so matching is by frame
        object identity and not by structural {self, definingBehavior} equality
    the return primitive does not catch its own transfer, and neither does the Block the `^`
        was written in — only the owning method activation does
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
    `[ ^ 1 ] ensure: [ ^ 2 ]` answers 2, while `[ ^ 1 ] ensure: [ 2 ]` answers 1
    an unrelated `on:do:` does not intercept a non-local return
    a `^` inside a handler returns from the handler's home method, not to the `on:do:`
    a non-local return past a suspended WASM activation retires it, proven by pool statistics

lanes and durability
    neutral and WASM agree on every case above, including the home method being in the other lane
    the liveness table reaches no durable record, no Value and no activation field
    a dead entry is retained while its frame is reachable, so "already returned" and "no home"
        stay distinguishable rather than collapsing into one message
    a standalone Block containing `^` is refused at compile time, distinctly from an escaped
        method Block that fails at invocation
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
only the activation that OWNS a frame marks it live/dead and catches a transfer naming it — a
    kernel primitive and a closure BORROW the same object, so frame equality would let the return
    primitive catch its own transfer
frames are matched by object identity, never structurally: two activations of one method on one
    receiver are different homes
`^` lowers through the reserved `$nonLocalReturn` capture bound at installation, so the semantic
    artifact stays image-independent; the name and id are reserved against caller collision
a standalone Block containing `^` is refused at compile time; an escaped method Block fails at
    invocation, and the two are different diagnoses
a dead liveness entry is retained while its frame is reachable, or the two failures collapse
liveness lives in an executor-owned side table keyed by the frame, never as a frame field — the
    frame's shape is validated as exactly {self, definingBehavior}
returning to a dead activation fails explicitly and is NEVER converted into a local return
unwinding is ADR 0054's mechanism: protection blocks run, `on:do:` does not intercept, and a
    suspended WASM activation is retired
one mechanism for `^` in a Block and `^` in a method body; no second path
`[ ^ 1 ] ensure: [ ^ 2 ]` answers 2: a cleanup that transfers supersedes the transfer already
    unwinding, while an ordinary cleanup value is still discarded
when `includes:` can answer from its loop, delete the `found` temporary and its gap signal
```
