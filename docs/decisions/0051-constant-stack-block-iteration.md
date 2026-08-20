# ADR 0051: Constant-stack Block iteration

Status: implemented — `whileTrue:` and `whileFalse:` are two more operations on the existing classless Block personality, dispatched to language-owned loop primitives that drive the condition and body through ordinary `value` sends, so iteration costs no activation depth.
Proven by: test/block-loop.test.js, test/smalltalk-library.test.js

## Problem

ADR 0047 promised `OrderedCollection` as "an ordinary object holding an `Array` plus a size and a
growth policy, written in Smalltalk". ADR 0050 made that possible and it now exists. Writing it
exposed the thing that makes it a toy:

```smalltalk
OrderedCollection >> do: aBlock          [ self do: aBlock index: 1 ]
OrderedCollection >> do:index:           [ :aBlock :index |
    (index = (tally + 1))
      ifFalse: [ aBlock value: (contents at: index). self do: aBlock index: (index + 1) ] ]
```

That is not a stylistic choice. A Block answers `value` and nothing else (ADR 0044 decision 11), so
`whileTrue:` is not expressible, and every iteration in the image is therefore recursion. Recursion
consumes activation depth, and `MAX_ACTIVATION_DEPTH` is 256:

```text
do: over 50 elements     works
do: over 100 elements    activation depth limit exceeded
```

So this is not a missing convenience. It is a correctness and scalability defect in protocol that
already ships: `do:`, `includes:`, growth and copying are all written, all correct, and all unusable
at ordinary collection sizes. That is what makes iteration more urgent than the other gaps the
library exposed — Integer ordering is protocol that is simply absent, and absent protocol misleads
nobody.

## Decision

### 1. This is not a loop instruction

The framing matters more than the mechanism, because the mechanism follows from it.

`whileTrue:` and `whileFalse:` are **two more operations on the temporary classless Block
personality** ADR 0044 decision 11 created, implemented by repeated ordinary sends. They are not a
control-flow construct the compiler knows, not an operation in the semantic IR, and not a new
execution primitive in the loop sense.

That keeps the direction ADR 0045 set. Conditionals became message sends rather than compiler magic;
iteration does the same. A language whose `ifTrue:` is a message and whose `whileTrue:` is a keyword
would be inconsistent in a way that shows up the first time somebody wants to write their own control
structure.

```text
the compiler                learns no selector
lagrange-code/v0 and /v1    unchanged; both remain frozen
executable representations  unchanged; no new one
Block                       still classless, still not a BlockClosure
```

### 2. Ordinary source sends, resolved by the existing Block rule

```smalltalk
[ index <= limit ] whileTrue: [ ... ]
[ done ] whileFalse: [ ... ]
```

parse as keyword sends like any other, and reach the dispatcher's existing Block special case — the
one that answers `value`/`value:` today. That case gains exactly two selectors and no third
mechanism.

The receiver is the **condition** Block and the single argument is the **body** Block, which is
Smalltalk's own arrangement.

### 3. Dispatch resolves them to language-owned loop primitives, discovered rather than named

This is the first Block send that resolves to a Block *other than the receiver*: `value` answers the
receiver itself, while `whileTrue:` must reach a loop primitive with the condition Block as its
receiver.

The dispatcher must therefore obtain that primitive without knowing its object id, because ADR 0044
decision 9 is explicit that the dispatcher learns *rules*, never specific object ids. So the loop
primitives are reachable through a small discoverable protocol object, discovered exactly as
`findSmalltalkKernel` discovers the kernel — same convention, same failure taxonomy, no second style
of bootstrap lookup:

```text
object id     smalltalk-block-protocol/v1        one per image, at a fixed known id
shape         smalltalk/block-protocol-shape/v1  fixed, local, exactly these two slots
metadata      protocol: smalltalk-block-protocol/v1
slots
    while-true    unpinned local ref to the whileTrue: loop primitive Block
    while-false   unpinned local ref to the whileFalse: loop primitive Block
```

The shape is pinned rather than left to the installer because an under-specified protocol object is
how a partially-written or deliberately-shaped impostor gets handed to the dispatcher. Installation
is ensure-exact-or-create at those deterministic ids, like every derived id in this repository:
absent creates, identical reuses and writes nothing, different fails and overwrites nothing.

**Absent and corrupt are different answers**, which is the distinction `findSmalltalkKernel` already
draws and this must not blur:

```text
no object at the id                       absent  -> the image has no loop protocol, so a
                                                     whileTrue: send is an ordinary
                                                     "Block does not understand"
present, wrong shape, wrong metadata,     corrupt -> an explicit failure naming the problem;
non-local slot, pinned slot, missing                 never silently treated as absent, and
slot, or a slot that is not a ref                    never handed to the dispatcher
```

An image without the protocol is coherent — merely an image whose Blocks do not loop — which is the
same position an image without the allocation protocol is in. Degrading a *corrupt* one into that
state would turn a damaged image into a quietly less capable one, which is the failure mode worth
refusing here.

**Validating the object is not validating what it points at.** A structurally perfect protocol object
whose slots have been repointed is the interesting attack, and it passes every check above: the slots
are still local, still unpinned, still refs. Discovery must therefore follow each ref and prove the
*target* is the primitive that slot claims, not merely that something is there:

```text
load the referenced Block                      must exist
load that Block's CodeArtifact                 must exist
representation                                 must be smalltalk-kernel-primitive/v1
parse the primitive declaration                the existing parser, same JSON contract
identity                                       while-true  slot -> the while-true primitive
                                               while-false slot -> the while-false primitive
```

Two new primitive names join the existing enumeration for that last step, so the check is an equality
against a known name rather than a heuristic. Both slots are validated, and a mismatch is a corrupt
protocol by decision 3's taxonomy — an explicit failure, never "absent".

The reason to pay for the extra reads is that this object is a **routing authority**: the dispatcher
hands it control of what a `whileTrue:` send runs. Accepting a local ref as sufficient would let any
object in the image be nominated as the loop implementation, and it would be invoked with the
caller's frame inherited (decision 9) — so the weaker check would not merely run the wrong code, it
would run attacker-chosen code with borrowed identity. Slot-repointing is exactly the shape ADR 0049
guarded against with its structural discriminator, and the answer is the same one: verify the target,
not the pointer.

**The protocol is discovered in the condition Block's image, and the loop answers that image's nil.**
This is not a new rule; it is the existing one applied. A nested send sets the dispatch image from an
object receiver's own image (`activation-executor.js`: `isObjectRef(receiver) ? receiver.imageId :
activeDispatchImage`), and a Block is an object ref, so `conditionBlock whileTrue: body` already
dispatches in the condition Block's image. The protocol lookup follows the dispatch image, so the
image that owns the send owns the loop.

The consequence for a cross-image body is likewise inherited rather than special-cased: when the
primitive sends `value` to a body Block living elsewhere, that ordinary send sets the dispatch image
to the *body's* image by the same line, so the body executes against its own image's protocol. Two
images that disagree about their kernels therefore each behave as themselves, and neither is
silently evaluated against the other's.

### 4. The invocation shape is dispatched, not `value:`-applied — and is guarded accordingly

Every kernel primitive so far is reached as `aPrimitive value: x`, so its activation receiver *is* the
primitive Block, which `assertBlockApplicationReceiver` checks. A loop primitive is different by
construction: its activation receiver is the condition Block.

```text
activation.block       the loop primitive
activation.receiver    the condition Block
activation.arguments   [ the body Block ]
```

That guard therefore cannot apply, and something must replace it or the primitive becomes reachable
by an unintended route — `aLoopPrimitive value: aBlock` would otherwise arrive with the primitive
itself as the condition.

The replacement rule is structural and cheap:

```text
the receiver must be a Block, and must not be a kernel-primitive Block
the argument must be a Block, and must not be a kernel-primitive Block
```

"Kernel-primitive Block" means the existing **structural** test and nothing else: the Block's
CodeArtifact has representation `smalltalk-kernel-primitive/v1`. Not metadata, not a list of known
ids, not a naming convention. That is already exactly how the dispatcher decides frame inheritance
for a Block send today, so this guard reuses a definition the system depends on rather than adding a
second, weaker notion of "is a primitive" that the two could drift apart on.

which refuses the self-application above, refuses a primitive smuggled in as a body, and leaves
ordinary Blocks working. A loop primitive is not otherwise callable.

### 5. The loop drives both Blocks through ordinary `value` sends

The implementation never executes a Block's CodeArtifact directly. It sends `value` — through the
execution context's ordinary nested-send path — once per condition evaluation and once per body
evaluation.

That is the whole reason the semantics stay right rather than needing to be re-established:

```text
lexical frame restoration   ADR 0050 decision 5a: a closure restores the frame it was created in
authority                   flows through the nested send, attenuated exactly as it already is
dispatch image              carries through unchanged
lexical cells               resolved through the arena the sends already share
cross-execution behaviour   an escaped ivar-dependent closure still finds no frame, and fails closed
```

Executing the code directly would bypass every one of those and would require re-implementing them
inside a loop, which is how this kind of primitive usually acquires subtly different semantics from
the rest of the language.

### 6. Constant activation depth with respect to iteration count

Each condition and body activation **returns before the next begins**. The loop is a sequence of
sibling sends from one activation, not a chain of nested ones, so depth is constant no matter how
many iterations run:

```text
recursive do: over n elements    depth grows with n; fails at ~100
whileTrue: over n iterations     depth is that of the loop primitive plus one, for every n
```

Implementing `whileTrue:` recursively would satisfy the surface protocol and preserve the exact
defect this ADR exists to remove, so it is ruled out explicitly rather than left to taste.

**Scope, stated so it is not overclaimed:** only *iterations* are constant-stack. A loop nested inside
another loop consumes nesting depth normally, a loop body that recurses still recurses, and this ADR
makes no arbitrary recursive program constant-stack. It removes iteration as a consumer of depth,
nothing more.

### 7. The condition answers a canonical boolean, and nothing else

```text
canonical boolean Value    continue or stop
anything else              an explicit failure
```

No truthiness, no coercion, no "nil is false", no object with a `isTrue`-ish protocol. ADR 0045
established that Symmetric Smalltalk's conditionals are polymorphism over `True` and `False` rather
than a test on an arbitrary value, and a loop that accepted more would quietly introduce a second,
looser notion of truth into the same language.

Note that the condition Block answers the canonical boolean, not the `true`/`false` singleton: ADR
0045's bridge nominates a singleton as the *receiver of a send*, and nothing here sends to the
condition's result.

### 8. Semantics

```text
whileTrue:    evaluate the condition; while it answers true, evaluate the body, then the condition again
whileFalse:   the same, while the condition answers false
body result   ignored
answer        that image's nil
zero iterations  a condition that stops immediately runs the body zero times, and answers nil
```

`whileFalse:` is included rather than deferred for the reason ADR 0045 included `ifFalse:ifTrue:`:
it is the mirror of an operation being added, and omitting it would be an arbitrary hole rather than
a decision.

### 9. Frames follow ADR 0050 exactly, with one deliberate difference

```text
the loop primitive     INHERITS the caller's frame, as a language-owned host operation
the condition Block    inherits nothing; its own creation frame is restored, or it has none
the body Block         the same
```

The primitive inherits for the same reason the slot primitives do — it is the language's own
operation, invoked on the language's behalf. The condition and body are *arbitrary* Blocks and must
never borrow it, which is ADR 0050 decision 5a rule 4 and needs no new machinery: they are reached by
ordinary `value` sends, which inherit nothing.

The consequences are therefore inherited rather than restated:

```text
an ivar-using closure created in this execution   works inside a loop
an escaped ivar-dependent closure from earlier    still fails closed
```

### 10. No new durable record *kind*, Value, activation field or representation

Stated precisely, because the loose version of this claim is false: the protocol object and the two
primitive Blocks **are** durable, newly written records. What must not grow is the set of *kinds* of
thing the substrate has:

```text
added            three ordinary durable records — one object, two Blocks — plus their
                 CodeArtifacts and one Shape, all of existing kinds
not added        no new durable record kind
                 no new Value kind
                 no new field on the activation request or the activation itself
                 no new executable representation
                 no new metadata key outside the protocol object's own `protocol` tag
```

The loop primitives are ordinary Blocks carrying the existing `smalltalk-kernel-primitive/v1`
representation, installed by an explicit installer like every protocol since ADR 0045, and the
protocol object is an ordinary graph object with a fixed Shape. An image that has never installed the
protocol contains none of these records and is, as decision 3 says, coherent without them.

### 11. `BlockClosure` stays deferred

ADR 0044 decision 11 deliberately left Blocks with a special classless protocol and deferred making
them ordinary instances with a method dictionary. That is still deferred, and this ADR is careful not
to force it: two selectors are added to the existing personality, not a class.

When `BlockClosure` eventually arrives, `whileTrue:` becomes an ordinary method on it and the
dispatcher's special case shrinks. Nothing here makes that harder — which is the test a temporary
mechanism should pass.

### 12. The answered nil comes from the kernel, and the two failure modes stay distinct

Decision 8 says the loop answers the condition image's nil. That is a **dependency**, not a
convenience: the loop cannot complete without one, so it must be obtained the ordinary way and the
absence of one must be reported as itself.

```text
installation   requires a valid kernel in the target image, and refuses to install without one
execution      obtains nil through normal kernel discovery in the dispatch image —
               the kernel's `nil` slot, already validated as an unpinned local ref
```

There is no host `null`, no synthesized nil, and no nil captured at install time and frozen into the
primitive — a captured nil would keep answering after the image's kernel changed underneath it, which
is precisely the class of stale-binding bug the dispatch-image rule exists to prevent.

The failure taxonomy is stated explicitly because the two cases are easy to collapse and mean
opposite things about the image:

```text
valid kernel, no Block protocol        ordinary "Block does not understand: whileTrue:"
                                       — a coherent image whose Blocks simply do not loop

Block protocol present, kernel         a kernel failure, named as one
missing or corrupt                     — NOT a does-not-understand, and NOT a host null
```

Reporting the second as a does-not-understand would describe a broken image as a limited one and send
whoever is debugging it after the wrong protocol entirely. Answering a host `null` would be worse: it
would let a broken image's loop appear to succeed and hand a non-Value into Smalltalk code.

## Proof required for implementation

```text
constant stack
    10,000+ iterations complete, and activation depth does not grow with iteration count
    a recursive equivalent at the same count still fails, so the difference is demonstrated
    nested loops consume nesting depth normally

semantics
    whileTrue: and whileFalse: both run, with the expected sense
    a condition that is false at once runs the body zero times
    the loop answers that image's nil, and the body result is ignored
    for N body executions the condition runs N+1 times, counting the final stopping test;
        the property being proven is that no condition test and no body effect is duplicated,
        not that the two counts are equal

state
    a mutable temporary written by the body is visible to the next condition evaluation
    a snapshot capture behaves as ADR 0043 says
    a condition or body created inside a method reaches that method's instance variables
    such a closure invoked from another method still uses its creator's self
    an escaped ivar-dependent closure fails closed in a later execution

refusals
    a non-boolean condition result is refused explicitly, and names the problem
    a loop primitive applied to itself with `value:` is refused
    a kernel-primitive Block passed as the condition or the body is refused
    an image without the Block protocol object answers neither selector, as a
        "does not understand" rather than a crash
    a corrupt protocol object fails explicitly and is never degraded to "absent":
        wrong shape, wrong metadata, missing slot, non-ref slot, pinned slot, foreign-image slot
    a structurally perfect protocol whose slots are repointed is refused, for each of:
        a slot pointing at a non-Block object; at a Block with an ordinary (non-primitive)
        CodeArtifact; at a Block whose CodeArtifact is missing; at a different kernel
        primitive; and at the *other* loop primitive, so while-true/while-false cannot be swapped
    re-installation is exact-or-create: identical reuses and writes nothing, different refuses

kernel dependency
    installation into an image with no valid kernel is refused
    a valid kernel with no Block protocol gives an ordinary Block does-not-understand
    a present Block protocol with a missing or corrupt kernel gives a kernel failure —
        proven to be neither a does-not-understand nor a host null
    the answered nil is the dispatch image's current kernel nil, not one captured at install time

both lanes
    the protocol is discovered in the condition Block's image, and the loop answers that
        image's nil
    a body Block from another image executes against its own image, by the ordinary send rule
    neutral and WASM callers both loop
    a non-tail WASM case: the loop's result feeds a further send after it returns

what must not have changed
    no compiler selector recognition; the semantic artifact contains ordinary sends
    no lagrange-code op and no new executable representation
    no BlockClosure class, and Blocks still answer value without one
    installation is idempotent and the publication sequence is swept pre/post-commit
```

## What is deferred

- `BlockClosure` as an ordinary class with a method dictionary, per decision 11
- `to:do:`, `timesRepeat:`, `detect:`, `inject:into:` and the rest of the iteration protocol, which
  become ordinary Smalltalk once `whileTrue:` and Integer ordering both exist
- non-local return from inside a Block, which is a separate control-flow decision
- Integer ordering comparison, which is ADR 0053 and is what lets `OrderedCollection` drop its
  count-up-and-compare-with-`=` idiom and regain `at:`, `first`, `last` and `removeLast`. It was to
  have been 0052; implementing this ADR displaced it, because removing the depth ceiling exposed
  unbounded durable growth from repeated closure creation — a substrate problem, where ordering is
  missing functionality — so closure lifetime and identity took that number instead
- making recursion constant-stack, which this ADR explicitly does not do
- any loop that is not driven by ordinary sends

## Guardrails

```text
whileTrue:/whileFalse: are sends; the compiler recognizes no loop selector
this is two operations on the classless Block personality, not a loop instruction
lagrange-code stays frozen; no new op and no new executable representation
the loop drives condition and body through ordinary `value` sends, never their CodeArtifact directly
each iteration returns before the next begins; depth is constant in iteration count
looping is never implemented recursively
only iterations are constant-stack; nesting and recursion still consume depth
the condition answers a canonical boolean; there is no truthiness
the loop primitive inherits the caller frame; an arbitrary condition or body never does
a loop primitive is reachable only by dispatching these selectors, and refuses self-application
the dispatcher discovers the loop primitives through a protocol object; it never knows their ids
no new durable record *kind*, Value, activation field or representation; the protocol object
    and the two primitive Blocks are themselves ordinary durable records
the protocol object has a fixed Shape, is installed exact-or-create, and absent never means corrupt
discovery validates what the slots point at — each target must be the primitive that slot claims —
    because the protocol object is a routing authority, not merely a record
the answered nil comes from kernel discovery in the dispatch image, never a host null or a
    nil captured at install time; a missing kernel is a kernel failure, not a does-not-understand
the condition Block's image owns the send: it supplies the protocol and the answered nil
a kernel-primitive Block is one whose CodeArtifact representation is smalltalk-kernel-primitive/v1
BlockClosure stays deferred, and nothing here makes it harder to arrive
```
