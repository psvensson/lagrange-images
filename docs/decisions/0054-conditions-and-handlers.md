# ADR 0054: Conditions and handlers

Status: accepted — a condition is an ordinary Smalltalk object, signalling is an ordinary send, and a handler runs *at the signal point before any unwinding*, so it may either resume the signalling computation with a value or unwind to its `on:do:` — which is what makes resumption expressible across WASM suspension at all.

## Problem

ADR 0053 gave `OrderedCollection` real bounds checks and, in doing so, made the absence of this
substrate concrete. There is no way to signal a refusal, so the collection reports one by sending a
selector nothing implements:

```smalltalk
at: index
  (index < 1)
    ifTrue: [ self errorIndexOutOfBounds: index ]
    ifFalse: [ ... ]
```

The failure arrives as a message-not-understood. That names the collection's own concept rather than
surfacing an Array error about a different object, which is why it was tolerable as a placeholder —
but it is a gap signal, not a design. Nothing can catch it, nothing can distinguish it from a genuine
typo, and a caller that wants `at:ifAbsent:` has nowhere to put the alternative.

Every failure in the system is currently a host error: `SmalltalkIndexedBoundsError`,
`EscapingMutableClosureError`, `SmalltalkDivideByZeroError`. They are precise and they are invisible
to Smalltalk.

## Decision

### 1. A condition is an object; signalling is a send

```text
Exception            an ordinary class, with ordinary subclasses
signalling           `anException signal`, an ordinary message send
the compiler         learns nothing
lagrange-code        gains no op
```

No new Value kind, no new executable representation, and no signalling instruction. The consistency
argument is ADR 0045's and ADR 0051's, for the third time: a language whose conditionals and loops
are messages should not acquire a keyword for failure.

### 1a. One object model: a condition is an ordinary object

Stated explicitly, because the ADR is otherwise silent on it and silence here invites exactly the
wrong optimization:

```text
condition object     an ordinary image object, with ordinary identity, ordinary allocation
                     and ordinary persistence rules. Nothing about being a condition changes
                     how it lives.

signal occurrence    transient execution state: which handler is currently selected, whether
                     that handler is active, the resume and return targets, and any primary
                     failure retained during cleanup.
```

That split is already forced by decision 6a — `resume:` cannot be state on the condition object,
because one object may be signalled twice at once and each occurrence must act independently. It is
repeated here as a *lifetime* statement rather than only a protocol one.

**This ADR introduces no second category of object.** The temptation is real: a handled
`IndexOutOfRange` allocates a durable object per occurrence, and a tight loop over a failing accessor
therefore creates durable garbage. That is a known allocation cost, not a semantic ambiguity, and the
fix does not belong here.

Making conditions execution-local would generalise ADR 0052 from closures to arbitrary objects, and
the two cases are not alike. A closure has a deliberately narrow durable projection — a Block plus an
immutable snapshot environment, with live cells and the defining frame explicitly not persisting. A
general mutable object's durable projection is the whole reachable mutable graph, which raises
questions closures never had to answer: whether an ephemeral object may hold another, what happens to
mutable slots at promotion, whether identity survives, how cycles and shared mutable subgraphs
publish, whether `basicNew` now makes transient objects, and whether persisting one object
recursively persists everything it reaches.

Those belong to a general object residency decision, not to a decision about signalling. Until such a
decision exists, no invariant of the form "N signals produce zero durable records" is claimed here.

### 2. Handlers run at the signal point, before unwinding

This is the load-bearing decision, and it is forced by the substrate rather than merely preferred.

```text
signal
  -> find the innermost applicable handler
  -> run the handler block ON TOP of the signalling stack, which is still intact
  -> the handler chooses:
       resume: value   the signalling send answers `value` and computation continues
       return: value   unwind to that handler's `on:do:`, which answers `value`
```

The alternative — unwind first, then run the handler where the `on:do:` is — is what most exception
systems do, and it makes `resume:` impossible by construction: the frames it would resume into are
already gone.

Here that is not an abstract loss. In the WASM lane a suspended activation's locals and stack live
*inside the WASM instance*, and `resumable-executor-v2.js` retires that instance on any throw. Once
unwound past a WASM frame, that frame cannot be re-entered by any mechanism this system has. So
"handlers run before unwinding" is the only design under which `resume:` can exist in both lanes.

### 3. Resumption is already expressible; the ABI does the work

The resumable ABI turns every non-tail send into a suspend/resume pair:

```text
guest suspends at a send site
host runs `performHostEffect` -> a Value
guest resumes at `effect.resume.entry` with that Value
```

A resumed condition is *exactly* that shape. If a signal raised inside the host effect is handled by
`resume: v`, the host effect answers `v` and the guest resumes as though the send had returned
normally. No new ABI, no new export, no change to the compiler.

Two consequences worth stating rather than discovering later:

```text
no extra resumption is charged     the executor increments its counter *before* running the
                                   host effect, so a resumed signal rides the resumption that
                                   send already booked. Counting the signal separately would
                                   double-charge it against MAX_WASM_RESUMPTIONS and make a
                                   handled loop fail sooner than the same loop unhandled.

the handler does not re-enter      the search and the transfer are orchestrated by the host,
the suspended guest                above the guest, and never inside the suspended frame
```

"In the host" describes *orchestration*, not what the handler is made of. A handler is an ordinary
Block: it may itself be a WASM method, in which case it runs in its own nested activation with its own
lease, exactly like any other Block invoked during a host effect. Reading "the handler runs in the
host" as "handlers are host code" would be a real misimplementation — it would put a Smalltalk Block
somewhere it cannot be written.

### 4. Unwinding is one-way, and retires what it passes

`return:` unwinds to the establishing `on:do:`. The mechanics already exist: a throw during a host
effect unbinds the instance host and releases its lease with `{retire: true}` rather than returning it
to the pool, because a mid-computation instance is not reusable.

```text
unwinding past a SUSPENDED WASM    retires the instance; that activation is gone for good
activation (a non-tail effect)

unwinding out of a TAIL effect     retires nothing. The guest already returned, the loop broke
                                   with `effect.resume === null`, and the lease was released
                                   normally *before* the effect ran — the effect itself runs
                                   outside the executor's try/catch, so there is no live
                                   instance to retire and none is wrongly pooled either.

unwinding past a neutral frame     ordinary stack unwinding

resuming after unwinding           impossible, and refused explicitly rather than silently
                                   producing a wrong answer
```

The tail case matters in both directions, and an implementation that treats every WASM effect alike
gets one of them wrong. It must not try to retire an already-released lease, and it must not assume a
signal during a WASM effect always destroys a continuation — a tail effect has none to destroy.

Resumption still works there, and means something slightly different: the handler's value becomes the
effect's result, which is the activation's result. It does not re-enter a guest, because the guest has
already finished. A tail effect also books no resumption at all — the counter is incremented only on
the non-tail path.

An implementation must not "optimize" by pooling a *retired* instance. That is the one place where a
correct-looking change would produce a guest resuming into another computation's locals.

### 4a. Blocks receive the new selectors through a separate protocol object

`on:do:`, `ensure:` and `ifCurtailed:` are Block selectors, and ADR 0044 decision 11 still leaves
Blocks classless. ADR 0051 solved the same problem with a discoverable Block protocol object, so the
mechanism exists — but that object is an *exact* two-slot protocol whose shape and both targets are
validated, and the dispatcher recognizes exactly `whileTrue:`/`whileFalse:` against it.

A second protocol object, not a wider first one:

```text
smalltalk-block-protocol/v1          unchanged — two slots, loop primitives, exact validation
smalltalk-block-unwind-protocol/v1   new — the unwind selectors, same discovery convention
```

Widening v1 would change the shape of a durable record that existing images already hold, and would
make its exactness check a migration rather than a guard. A separate object is discovered the same
way, validated the same way, and an image with one protocol and not the other is coherent — which is
the property that made ADR 0051's design worth copying rather than extending.

### 5. The handler stack is execution context

A handler is transient in exactly the way `dispatchImage`, the authority context and ADR 0050's frame
are:

```text
never durable         no record names a handler; an image holds no handler stack
never a Value         it reaches no slot, no Value, no activation field
per execution         it dies with the execution, like the arena
dynamically scoped    the innermost applicable handler wins, searched at signal time
```

An escaped Block that signals in a later execution finds whatever handlers *that* execution
established, and none of the ones from the execution it was created in — which is the same rule ADR
0050 applies to frames, and for the same reason: the alternative is a durable, forgeable claim about
a dead execution.

### 6. A handler runs with its establisher's identity — and authority does *not* come free

Two halves, and they behave differently. Getting that wrong is a privilege escalation, so they are
separated here rather than asserted together.

```text
self, instance variables   free. The handler is the establisher's Block, and ADR 0050 decision
                           5a rule 3 restores the frame it was created in.

authority                  NOT free, and must be captured explicitly.
```

Authority is propagated *dynamically* by the executor — a nested send inherits the current execution's
authority context — so invoking the handler as an ordinary Block at the signal point would hand it the
**signaller's** authority. Signalling code could then reach rights the establisher never held, simply
by raising a condition inside a more privileged caller.

So the handler entry retains the establisher's authority context at `on:do:` time, and the handler
runs under that. The same applies to `ensure:` and `ifCurtailed:` blocks, which run during unwinding
and would otherwise inherit whatever context the unwinding passes through.

**Where that captured context lives is itself a decision.** ADR 0037 keeps authority out of Values,
Blocks and executor-visible data, so it is *not* attached to the closure and does not become part of
any durable record. It is retained privately on the transient handler or protection entry — the same
lifetime as the entry itself, invisible to Smalltalk, and gone with the execution.

### 6a. The transfer protocol

Left unpinned, this is where an implementation invents something subtly different from every
Smalltalk. The protocol is small and it is stated:

```text
anException signal          raise it; answers whatever the handler decides
anException resume: value   the signalling send answers `value`; computation continues
anException return: value   unwind to this handler's `on:do:`, which answers `value`
```

`resume:` and `return:` act on the receiver's **currently active signal occurrence** — the one being
handled right now — which is transient execution state, not durable condition-object state.

Being precise about *which* occurrence is the point, not pedantry. Sending `resume:` to a condition
with no active occurrence, or to one whose occurrence has already been transferred out of, is an
explicit failure rather than a silent no-op: both mean the sender believes it is inside a handler it
is not inside. And a condition object signalled twice concurrently has two occurrences, so
"the current one" must be resolved per active handling and never by reading the object. One condition object signalled twice — or signalled from two
executions — has two occurrences, and neither may see the other's. Storing "am I being handled" on the
object would make a durable record carry live control-flow state, which is the same mistake ADR 0050
refused for defining frames.

Two rules that fall out, and that a naive implementation gets wrong:

```text
a handler's ordinary value   means `return:` implicitly, so the natural idiom works:
                             `[ ... ] on: Error do: [ :e | 0 ]` answers 0. Requiring an
                             explicit `return:` would make the common case the verbose one.

re-signalling disables       while a handler runs, its own entry is disabled, so a signal
the running handler          raised inside it finds only *outer* handlers. Without that, a
                             handler that signals the condition it is handling is an
                             immediate infinite regress rather than a delegation upward.
```

### 7. Unwind protection

```text
ensure: aBlock        runs on every exit, normal or not
ifCurtailed: aBlock   runs only on a non-normal exit

both answer           the protected Block's value on a normal exit. The cleanup Block's own
                      ordinary value is discarded — cleanup runs for its effect, and letting
                      it replace the answer would make adding a `Transcript` line to an
                      `ensure:` silently change what the expression evaluates to.
```

A cleanup Block that *signals* is a different matter and is decided below; discarding a value is not
the same as ignoring a failure.

**"Non-normal" means every non-normal exit, not only a Smalltalk condition.** A host trap crossing the
protected scope — a depth-limit failure, an expired closure instance, a WASM error — must run the
protection too, even though those are not themselves Smalltalk-catchable. Protection that only fired
for catchable failures would be protection that stops working precisely when something unexpected
happened, which is when it matters most.

Both must run while the arena is still alive, since ADR 0052 makes a closure execution-local: an
`ensure:` block that ran after the arena died could not reach its own captures.

An `ensure:` block that itself signals while unwinding is the case that turns a simple mechanism into
a hard one, and it is decided here rather than deferred. A cleanup failure is a real failure and stays
catchable:

```text
P is unwinding
  the ensure: block signals S
    S gets an ordinary handler search, like any other signal

    S handled locally (resumed, or returned to a handler inside the cleanup)
      -> the ensure: block finishes normally
      -> P carries on unwinding, unchanged

    S escapes the ensure: block
      -> S becomes the failure travelling outward
      -> P is retained on it as the condition that was unwinding
      -> neither failure is lost
```

An earlier draft had the primary always win, with the secondary merely reported. That protects the
debugging goal — never lose the first failure — but pays for it by making a cleanup failure
uncatchable, which is too high a price: a handler that exists specifically to deal with a failing
cleanup would never run. Retaining the primary as the escaping condition's cause reaches the same
debugging goal without suppressing anything.

### 8. What becomes signalable now, and what does not yet

```text
now      the collection refusals ADR 0053 could only spell as message-not-understood:
         index out of range, empty collection
         division by zero, indexed bounds, dictionary key absent
         — existing host errors gain a Smalltalk-visible condition class

not yet  message-not-understood as a *signalable* condition, i.e. `doesNotUnderstand:`.
         That is a metaobject-protocol decision, not a condition-system one: it lets any
         object intercept any selector, and it deserves its own ADR
```

The distinction is worth holding: this ADR makes failures *catchable*, not *interceptable*.

### 9. Non-local return shares this machinery, and is still deferred

`return:` is a non-local return: it unwinds to a specific establishing frame and answers a value.
The general form — `^` inside a Block returning from its enclosing method — is the same mechanism
pointed at a different target.

This ADR builds the unwinding mechanism and deliberately does not expose the general form, because
the target differs: an `on:do:` establishes an explicit, dynamically-scoped handler frame, while `^`
targets a lexically-enclosing method activation that may already have returned. That second case is
its own decision, and it is what `includes:` still needs.

## Proof required for implementation

```text
signalling and handling
    a signal with no handler fails, naming the condition rather than a host error type
    the innermost applicable handler wins, with nested `on:do:` proven in both orders
    a handler for a superclass catches a subclass; an unrelated class does not catch
    a re-signal from inside a handler finds only *outer* handlers, never itself
    a handler's ordinary returned value acts as `return:`, so `on: Error do: [ :e | 0 ]` answers 0
    two signals of one condition object have independent occurrences, and the object holds
        no handling state
    `resume:` or `return:` with no active occurrence for that receiver fails explicitly
    a handler that is itself a WASM method runs in its own activation and lease, and can
        resume or return from there
    the unwind selectors are reached through their own protocol object, and an image holding
        the loop protocol but not the unwind protocol is coherent

resumption
    `resume:` makes the signalling send answer the handler's value and continue
    proven in the WASM lane across a real suspension: the guest resumes at the effect site
    and its locals are intact
    a resumed signal charges no *extra* resumption: a loop that handles and resumes runs to
        the same iteration count as the same loop with no handler at all

unwinding
    `return:` unwinds to the establishing `on:do:`, which answers the handler's value
    unwinding past a *suspended* WASM activation retires the instance and does not return it
        to the pool, proven by instance-pool statistics rather than by inspection
    unwinding out of a *tail* effect retires nothing, because the lease was already released
        normally before the effect ran — and no attempt is made to release it twice
    a signal resumed during a tail effect answers the activation, and books no resumption
    resuming after unwinding is refused explicitly
    a signal crossing several activations unwinds all of them exactly once

context
    a handler runs with its establisher's `self`, not the signaller's
    a handler's authority is the establisher's, proven adversarially: a signal raised inside a
        more privileged caller must not let the handler reach rights the establisher lacks
    the same holds for `ensure:` and `ifCurtailed:` blocks running during unwinding
    the retained authority context appears in no Value, no Block and no durable record
    an escaped Block signalling in a later execution sees that execution's handlers only
    the handler stack reaches no durable record, no Value and no activation field

unwind protection
    `ensure:` answers the protected Block's value, and a cleanup Block that answers something
        else does not change it
    `ensure:` runs on the normal path and on the unwinding path
    `ifCurtailed:` runs only when unwound through
    both run for a non-catchable host failure crossing their scope, not only for conditions
    both run while the arena is alive, and can reach their own captures
    a signal raised inside an unwinding `ensure:` gets an ordinary handler search
    handled locally, the cleanup completes and the original condition keeps unwinding
    escaping, it becomes the outward failure and retains the original as its cause, so
        neither failure is lost and the cleanup failure is itself catchable

the library
    `at:` signals an index-out-of-range condition instead of sending a selector nobody implements
    `removeLast` on an empty collection signals rather than failing as message-not-understood
    `at:ifAbsent:` becomes expressible, and is proven by handling the collection's own signal
    the `errorIndexOutOfBounds:` placeholder is gone

durability and lanes
    the Exception class installation is idempotent, and every write is swept pre-commit and
        commit-then-lost-ack with both images and compilation bound to the faulting service
    neutral and WASM agree on every case above, each enumerating its own publication sequence
```

## What is deferred

- `doesNotUnderstand:` and message interception generally; a metaobject-protocol decision
- the general non-local return `^`, per decision 9
- resumable *restarts* in the Common Lisp sense — named recovery strategies offered by the
  signaller and chosen by the handler — which is a richer protocol than `resume:`/`return:`
- an interactive debugger, or reifying a suspended computation as an object
- conditions crossing image boundaries as anything other than ordinary objects
- retrofitting every existing host error; decision 8 lists the ones this ADR covers
- the allocation cost of automatically generated conditions, which belongs to a general
  object-residency decision: should a newly allocated image object begin execution-local and become
  durable only on crossing a durability boundary, as ADR 0052 made closures? That would keep one
  object kind and one ObjectRef, with residency as a lifetime state — potentially a large
  simplification of the image model — but it has to answer mutable graphs, aliasing, cycles,
  promotion atomicity and identity first, and may prove too expensive

## Guardrails

```text
a condition is an object and signalling is a send; the compiler and lagrange-code learn nothing
a condition object obeys ordinary object lifetime; ONLY the signal occurrence is transient. This
    ADR adds no second category of object — making conditions execution-local would generalise
    ADR 0052 from closures to arbitrary mutable graphs, which is a separate decision
no "N signals, zero durable records" invariant is claimed until that decision exists
handlers run at the signal point BEFORE unwinding — unwinding first makes `resume:` impossible,
    and in the WASM lane the frames are genuinely gone once retired
resumption rides the existing resumable ABI: a handled signal answers the host effect, and the
    guest resumes at its effect site with no new export or ABI change
unwinding retires a *suspended* WASM instance and never returns a mid-computation one to the
    pool — but a tail effect's lease is already released normally before the effect runs, so
    nothing is retired there and nothing is released twice
"the handler runs in the host" is about orchestration; a handler is an ordinary Block and may
    itself be a WASM method with its own activation and lease
the handler stack is execution context — never durable, never a Value, never an activation field
a handler runs with its establisher's self (free, via ADR 0050) and its authority (NOT free —
    authority propagates dynamically, so it must be captured at `on:do:` time and retained
    privately on the transient entry, never on the closure and never in a Value: ADR 0037)
`ensure:` and `ifCurtailed:` capture the establisher's authority the same way
the unwind selectors get their own protocol object; never widen the exact two-slot loop protocol
`resume:`/`return:` act on the receiver's currently active transient occurrence, never on durable
    condition state, and fail explicitly when there is no active occurrence;
    a handler's ordinary value means `return:`, and a running handler is disabled for re-signals
a resumed signal charges no extra WASM resumption — the counter increments before the host effect
unwind protection runs for every non-normal exit, including host failures that are not catchable
a cleanup failure stays catchable: if it escapes it becomes the outward failure and retains the
    original as its cause
`ensure:` runs on both paths while the arena is still alive and answers the protected Block's
    value, discarding the cleanup Block's own
this ADR makes failures catchable, not interceptable: `doesNotUnderstand:` stays deferred
```
