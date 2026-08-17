# ADR 0041: inter-activation state survival

Status: accepted — a constraint on every future mechanism that lets state outlive an activation; deliberately not a framework.

## Problem

Three ADRs arrived at the same boundary independently, from different directions.

ADR 0036 decided a Component instance is created fresh per activation, because reuse would let
guest state cross between unrelated activations, and that reuse must not happen merely because
it is convenient or cheap. ADR 0037 decided authority belongs to the individual active call, and
PR #50 made the execution context actually expire with its activation. ADR 0040 then found
experimentally that a trapping guest does not drop its handles at all, so host-owned lifetime
closure is not a design preference but a necessity.

The convergence is worth naming before three more mechanisms are built against it separately:

```text
activation          the default lifetime boundary
anything surviving  exceptional, explicit, host-owned,
                    and must not smuggle authority with it
```

Three known future mechanisms all want to cross that boundary: reusable Component instances,
persistent resource handles, and async foreign callbacks. Each is a plausible place to
accidentally reintroduce everything the last four ADRs removed.

## Decision

### 1. State may survive an activation. Authority never survives implicitly with it

This is the whole ADR in one line. Everything below is its consequences.

### 2. Activation-scoped is the default, and stays the default

State dies when its activation ends unless something explicitly says otherwise. There is no
opt-out by omission, no inference from convenience, and no survival acquired by a mechanism
merely being capable of it.

### 3. Survival requires an explicit contract that names all of this

A mechanism that lets state outlive an activation must state:

```text
what survives
who owns it
how it is identified
when it expires
how it is explicitly released
how forced cleanup works
whether it is runtime-local or durable
how a later activation reacquires and uses it
```

A mechanism that cannot answer all eight does not get to survive. Notably *forced cleanup* is
non-negotiable: ADR 0040 established that cooperative cleanup is not merely unreliable but
absent on the path that matters, since a trapping guest drops nothing.

### 4. Surviving state must retain none of this

```text
AuthorityContext
require closure
sendMessage closure
activation-local resource handle
principal
cached authorization result
```

Retaining any of them would make the surviving thing a carrier for authority, which is exactly
what ADR 0037 spent its effort making impossible and what PR #50 had to repair once already.

### 5. Later use re-enters through a new activation and re-authorizes there

```text
surviving state
      |
      | later use
      v
new activation
      |
      v
new execution authority
      |
      v
authorization at use time
```

No step may be skipped, and in particular no authorization may be inherited from the activation
that created the surviving state. This keeps revocation live across survival, which is the
property that makes survival tolerable at all.

### 6. A survival identifier is not a capability

If a mechanism's identifier ever crosses an ordinary data boundary, possession of it must not
grant access. Otherwise it has quietly become a bearer token, and bearer tokens need a far more
serious security design than "we needed to name something".

Stated as the rule worth remembering:

```text
surviving state may remember what.
It must never remember who-may-do-what.
```

### 7. This is a constraint, not a framework

There is deliberately no `SurvivalManager`, no generic lease type, and no shared implementation
that the three future mechanisms are pushed through.

They share invariants but are not the same kind of thing:

```text
reused Component instance   guest execution state survives
persistent resource         host-side identity and state survive
async callback              pending computation and control flow survive
```

Their ownership, cleanup and recovery semantics differ enough that a single abstraction would
become a union of special cases wearing one name — which is worse than three honest mechanisms
that each satisfy the same written constraint. This ADR therefore behaves like the Value-model
decisions: later work must satisfy it, and may implement it differently.

## How the three known specializations look under this rule

Sketches, not decisions. Each still needs its own ADR.

### Persistent resource handles

Not "a handle plus Alice's authority survives". Instead:

```text
lease L  ->  host-private object identity
         ->  explicit expiry and release

later activation
    reacquire L
    require(object/read, object) under the *current* activation's authority
    access
```

The lease identifies surviving state; it does not authorize its use. That separation is what
makes a persistent handle safe, and decision 6 is what stops the lease identifier from becoming
a token.

### Reusable Component instances

```text
prepared Component     already reusable, and already cached (ADR 0036)
Component instance     one-shot by default

a reusable instance would require:
    an explicit reuse contract
    no activation-scoped handles remaining
    no host-import closures from a previous activation remaining
    imports and execution context rebound freshly per activation
    a defined reset or quiescence operation
    reset failure destroys the instance rather than returning it
```

Worth restating the measurement, because it removes the usual motivation: ADR 0036 measured
fresh instantiation at roughly 0.85 ms with preparation cached, against roughly 20 ms without.
The caching that matters for performance is already permitted. There is very little
architectural pressure to weaken the one-shot rule.

### Async foreign callbacks

The hardest case, and where this ADR will earn its keep.

A pending callback must not close over `require`, an authority context, or an
`ActivationExecutor` context. It survives as inert host-owned state:

```text
pending work
callback target
result and error routing
cancellation and lifetime information
```

When it fires it re-enters through an explicit execution boundary, per decision 5.

That isolates the genuinely hard question rather than answering it: **what authority, if any,
does the new activation receive?** It may need an explicit delegated-authority concept, with its
own expiry and revocation semantics. This ADR deliberately does not decide it. It only insists
that the originating activation's authority does not survive by accident, which is the failure
that would otherwise be discovered late and expensively.

## A note on ADR 0040's synchronous read

ADR 0040 loads an object record when a prebound resource interface is wired, because a WIT
`snapshot: func() -> item-record` is synchronous while image reads are not.

That is a **tooling limitation, not the intended contract**, and it must not be confused with
persistence or used to justify redesigning resource lifetime. The intended semantics remain:

```text
snapshot()
    authorize now
    read the current object now
    return the current projection
```

Only the second "now" is currently unavailable, and only because the pinned jco async-resource
path did not wire correctly. Nothing in this ADR changes that, and no survival mechanism should
be shaped around it.

## Consequence, and what happens next

The seven-ADR interface and security arc now has a written boundary rather than three
independent instincts about one. A future mechanism that wants to cross it has a checklist to
satisfy and a list of things it may not carry.

Deliberately, none of the three specializations is implemented next. All three are advanced
lifecycle machinery with little demonstrated pressure: fresh Component instances are already
cheap, activation-scoped resources work, and nothing yet requires delayed callbacks. Building
them now would be following the machinery because it has become visible.

The next increment is authorized object mutation — `object/write` — which is a genuine missing
image semantic rather than a lifecycle refinement, builds directly on the existing atomic
state-and-history transaction contract, and will be immediately useful to language
personalities, inspectors and tools. It also generates real pressure on questions that matter
more to the image model than instance pooling does: whether write authorizes the whole object,
whether a slot write requires an expected version, what a conflicting write does, and whether
dropping a resource may ever commit. It may not.

## Guardrails

```text
activation == default lifetime boundary
survival is exceptional, explicit and host-owned
no survival by omission, convenience or capability-to-do-so
a survival contract names all eight properties or does not exist
forced cleanup is mandatory; cooperative cleanup is absent on traps
surviving state != AuthorityContext, require, sendMessage, handle, principal, cached decision
later use == new activation + new authority + authorization at use time
survival identifier != capability
surviving state remembers what, never who-may-do-what
constraint != framework; no generic lease type
0040's synchronous read is a tooling limit, not a contract
```
