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
resumption consumes a resumption   MAX_WASM_RESUMPTIONS already bounds these, and a
                                   resumed signal counts like any other
resumption does not re-enter       the handler runs in the *host*, above the guest; it does
the guest                          not run inside the suspended WASM frame
```

### 4. Unwinding is one-way, and retires what it passes

`return:` unwinds to the establishing `on:do:`. The mechanics already exist: a throw during a host
effect unbinds the instance host and releases its lease with `{retire: true}` rather than returning it
to the pool, because a mid-computation instance is not reusable.

```text
unwinding past a WASM activation   retires the instance; the activation is gone for good
unwinding past a neutral frame     ordinary stack unwinding
resuming after unwinding           impossible, and refused explicitly rather than silently
                                   producing a wrong answer
```

An implementation must not "optimize" by pooling a retired instance. That is the one place where a
correct-looking change would produce a guest resuming into another computation's locals.

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

### 6. A handler runs with its establisher's identity, not the signaller's

The handler is the `on:do:` caller's Block, so ADR 0050 decision 5a rule 3 already answers this: it
restores the frame it was created in, so its `self` and its instance variables are the establisher's.
Authority likewise attenuates from the establisher's context, not the signaller's — a handler must not
become a way for signalling code to borrow rights it does not hold.

That falls out of running the handler as an ordinary Block invocation. It is stated here because the
opposite is easy to implement by accident: invoking the handler on the signalling stack makes the
signaller's context the *ambient* one, and inheriting it would be a privilege escalation.

### 7. Unwind protection

```text
ensure: aBlock        runs on both the normal and the unwinding path
ifCurtailed: aBlock   runs only when unwound through
```

Both must run while the arena is still alive, since ADR 0052 makes a closure execution-local: an
`ensure:` block that ran after the arena died could not reach its own captures.

An `ensure:` block that itself signals during unwinding is the case that turns a simple mechanism
into a hard one. It is decided rather than left open: the original condition continues unwinding, and
the secondary one is reported as having occurred during unwinding rather than replacing it — losing
the first failure is how a debuggable error becomes an inexplicable one.

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

resumption
    `resume:` makes the signalling send answer the handler's value and continue
    proven in the WASM lane across a real suspension: the guest resumes at the effect site
    and its locals are intact
    a resumed signal counts against MAX_WASM_RESUMPTIONS like any other resumption

unwinding
    `return:` unwinds to the establishing `on:do:`, which answers the handler's value
    unwinding past a WASM activation retires the instance and does not return it to the pool,
        proven by instance-pool statistics rather than by inspection
    resuming after unwinding is refused explicitly
    a signal crossing several activations unwinds all of them exactly once

context
    a handler runs with its establisher's `self`, not the signaller's
    a handler's authority is the establisher's; a signaller cannot borrow rights through it
    an escaped Block signalling in a later execution sees that execution's handlers only
    the handler stack reaches no durable record, no Value and no activation field

unwind protection
    `ensure:` runs on the normal path and on the unwinding path
    `ifCurtailed:` runs only when unwound through
    both run while the arena is alive, and can reach their own captures
    a signal raised inside an unwinding `ensure:` does not replace the original condition

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

## Guardrails

```text
a condition is an object and signalling is a send; the compiler and lagrange-code learn nothing
handlers run at the signal point BEFORE unwinding — unwinding first makes `resume:` impossible,
    and in the WASM lane the frames are genuinely gone once retired
resumption rides the existing resumable ABI: a handled signal answers the host effect, and the
    guest resumes at its effect site with no new export or ABI change
unwinding retires WASM instances; never return a mid-computation instance to the pool
the handler stack is execution context — never durable, never a Value, never an activation field
a handler runs with its establisher's self and authority, never the signaller's
`ensure:` runs on both paths while the arena is still alive; a signal during unwinding does not
    replace the condition already unwinding
this ADR makes failures catchable, not interceptable: `doesNotUnderstand:` stays deferred
```
