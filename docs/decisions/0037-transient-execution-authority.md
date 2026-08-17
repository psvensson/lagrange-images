# ADR 0037: transient execution authority

Status: accepted — the decision for principal/capability semantics; deliberately no implementation yet.

## Problem

Every foreign boundary built so far has a zero-capability surface. `wasm-scalar-call/v0` has
no imports at all. The Cuis bridge exposes a closed whitelist of operations and no host
surface. The Component lane passes an empty import object to jco. ADR 0036 has just made
Component instances fresh per activation, so nothing can be inherited between activations.

That is a good position to add authority from, and a bad position to postpone it from. Two of
the three remaining items in the foreign-interface roadmap — capability-aware host imports and
async foreign callbacks — cannot be designed without deciding what authority *is*, and the
deferred outbound `ref` projection from ADR 0035 is blocked on the same question.

The obvious implementation is also the wrong one. Authority could be passed as an argument, or
captured in a lexical environment, or attached to a Block. Each would make authority *program
data*: something that can be stored in an object slot, survive in the durable graph, be
captured by a closure, travel through an InterfaceValue, or become part of Block identity.
`docs/security.md` already forbids the shape of that outcome — *"A ref identifies an object or
artifact. A callable interface describes how code may be invoked. Neither grants permission to
use it."* — and the canonical Value model exists precisely so that the durable substrate stays
small.

## Decision

### 1. Authority travels beside an activation, never inside it

A semantic activation keeps exactly the shape ADR 0005 defines:

```text
Block | code | environment | receiver | arguments | dispatch
```

with `arguments` remaining canonical Values. Nothing is added to it.

Authority arrives as execution context on the call instead:

```text
                    semantic activation
             receiver / arguments / environment
                            |
                            v
                    ActivationExecutor
                            ^
                            |
                    execution context
                   principal + authority
```

This seam already exists. `ActivationExecutor.execute(activation, {depth = 0})` takes a second
options object carrying execution-scoped state, and `depth` is already exactly that kind of
value: real, load-bearing, and absent from the durable model. Authority joins it.

The resulting invariant is the point of this ADR:

```text
Authority is execution context, not program data.
```

It therefore cannot become a captured lexical Value, cannot be written to an object slot,
cannot be packed into an `interface-composite/v0` envelope, cannot appear in a derivation key,
and cannot become part of Block identity. Not by policy — by not being representable there.

One existing detail reinforces this for free: `execute` ends with `canonicalizeValue(result)`,
so an execution's result is always a Value. Authority cannot leak back out as a return value
because there is no Value kind it could inhabit.

### 2. Executors receive an authorization question, not the authority

Executors are already handed a per-execution context containing `images`, `lookupBinding`,
`createClosure` and `sendMessage`. Authority is *not* added to that object.

Instead the context gains a narrow function:

```text
authorize(demand) -> grant     resolves, or throws
```

closed over the current authority. An executor can ask whether something is permitted; it
cannot read, store or forward the authority itself. That containment is deliberate: handing an
executor the authority object would make every executor a potential leak site, and the only
way to be sure none of them stash it is to never give it to them.

### 3. `principal != capability`

```text
principal   = who caused this execution
capability  = what this execution is allowed to do
```

Authorization asks the authority layer. Code that branches on `principal === 'alice'` is
wrong even when it produces the right answer, because it re-derives rights from identity.

A principal may be readable for audit and diagnostics. Reading it must never be the
mechanism by which anything is permitted.

This matches the direction `docs/security.md` already sets: authentication may eventually come
from OIDC/SSO, while the image runtime sees normalized principals and capabilities.

### 4. Authority contexts are opaque host-issued objects

An authority context must not be forgeable by an embedding caller, accidentally or otherwise.
So it is not plain data:

```text
rejected:   {capabilities: ['everything']}
```

A context is an opaque object minted by an authority service, carrying no more than an
unforgeable handle and, at most, a readable principal for audit. The grant table lives
privately in the service. A context that the service did not mint is rejected rather than
interpreted.

### 5. `AuthorityService` mints and resolves; it does not publish grants

```text
issue({principal, grants})        -> AuthorityContext
attenuate(context, {grants})      -> AuthorityContext, grants strictly narrowed
revoke(context)                   -> context and its descendants stop authorizing
require(context, demand)          -> grant, or throws
```

`attenuate` can only narrow. There is no operation that widens a context, so escalation is
impossible by construction rather than by check.

### 6. Absence of authority means no capabilities

An execution with no authority context has no host capabilities. It is not an error: every
lane built so far needs none, so pure Components, scalar WASM, the neutral executor and the
existing Cuis operations all keep working untouched.

Anything that requires a capability fails closed. The default is *no rights*, never *all
rights*, and never *rights inherited from ambient process state*.

### 7. Nested sends inherit, or are explicitly attenuated

Nested execution already recurses through one seam:

```js
return await this.execute(nested, {depth: depth + 1});
```

Authority propagates through that same call. A nested send inherits the current context by
default; an executor may instead request an attenuated child context. Because `attenuate` only
narrows, a nested send can lose rights and can never gain them.

### 8. Guest authority is the intersection of declared imports and caller grants

```text
what the implementation declares it may import
                     ∩
what the current execution is authorized to use
                     =
what the guest can actually do
```

Neither half grants anything alone.

```text
binding declares:            config/read

Alice's execution authority: config/read "public-banner"
                             config/read "internal-secret"

guest receives:              config/read
                             and every call is still checked against the
                             concrete resource requested
```

If a binding never declared network access, an administrator invoking it with broad authority
still does not give that Component networking. Conversely a binding that declares an import it
was never granted simply cannot use it.

Two mistakes are ruled out by name:

```text
declared import  != authority
caller authority != ambient guest authority
```

WASI stays out unless deliberately declared and granted.

### 9. `wasm-component-binding/v2` declares permitted host imports; v1 stays frozen

`wasm-component-binding/v1` has exactly two dependencies — interface and implementation — and
no host authority surface at all. Adding declared imports to it would let two runtimes read
one durable representation differently, which is the same argument that produced
`callable-interface/v2` and worked well there.

So a new representation declares the host-import interfaces its implementation legitimately
expects. Declaring is not granting.

### 10. Authority never becomes program data

Stated as the enforceable list, because this is what tests should pin:

- no authority context or principal is ever a canonical Value
- none is ever reachable from a slot, lexical environment, `derivedFrom` edge or metadata
- none is ever packed into an `interface-composite/v0` envelope
- none participates in Block identity or any derivation/cache key
- the graph walker never encounters one, because there is nothing for it to encounter

## The foreign-runtime lane needs a different answer, and this ADR does not have it

Worth stating now rather than discovering during implementation.

ADR 0036 solved cross-activation contamination for Components by instantiating fresh every
time. That answer does not transfer. A Cuis runtime is deliberately long-lived and shared
across activations — starting a VM per activation would defeat the entire foreign-runtime
substrate — so a single live image would span multiple authorities:

```text
activation A (Alice) ---.
                         >--- one long-lived Cuis image
activation B (Bob) -----'
```

Nothing is broken today: the bridge has a closed operation whitelist and no host surface, so
there is no authority for the image to retain. But capability-aware imports on that lane need
their own decision, and the plausible shapes differ — threading per-call authority through the
bridge protocol, or partitioning runtimes by authority, or declaring that this lane simply
never receives host capabilities.

This ADR deliberately does not choose. It records that the Component answer must not be
assumed to generalize.

## First proof: a narrowly scoped named host resource

Not image refs. That would combine authority with identity, ownership and lifetime, all
unresolved.

```wit
read-value: func(name: string) -> string
```

over two host resources, `public-message` and `private-message`. The proof must show:

1. no authority context → denied
2. authority for `public-message` → allowed
3. that same context reading `private-message` → denied
4. broad caller authority, but the binding never declared `read-value` → unavailable
5. binding declares it, caller lacks authority → denied
6. nested image-native calls retain the intended authority
7. an attenuated call loses rights and cannot regain them
8. no principal or capability becomes a Value or durable graph state

Small, and it exercises nearly the whole architecture.

## What this unlocks, and in what order

```text
1. transient authority/principal/capability substrate      (this ADR)
2. capability-aware Component host imports                 (binding v2)
3. authorized object projection                            (ADR 0035 point 8)
4. WIT resource handles for continuing image access
5. explicit Component instance reuse/reset contracts       (ADR 0036 defers)
6. async foreign callbacks/effects
```

Async callbacks come last on purpose. Once foreign code can call back later, something must
decide what happens to the originating authority — captured, attenuated, revoked, cancelled or
expired. Building callbacks before authority semantics exist would create exactly the kind of
debt ADR 0036 had to pay off.

Step 3 is the projection ADR 0035 deferred: a stored object travels outbound only through an
authorized read that produces a ref-free InterfaceValue, so the foreign side never receives
the ref. Step 4 is for foreign code that needs continuing access rather than a snapshot; a
resource handle maps privately to object identity plus permitted operations plus authority
provenance and lifetime. A `ref` still never crosses.

## What is deferred

- the foreign-runtime lane's capability model, per the section above
- WIT `resource`. It is not a cheap extra composite type: it is identity, ownership, lifetime
  and, here, authority. It belongs with this work, not with the `interface-composite/v0` codec
- revocation propagation, expiry and cancellation semantics
- attenuation algebra beyond "narrower or equal"
- OIDC/SSO/Keycloak integration; the runtime sees normalized principals only
- multiple activation results, unchanged from ADR 0035
- `option`, `result`, variants and tuples, to be added only when a real interface needs one

## Consequence

The substrate gains authority without the Value model gaining anything. Authority is
unrepresentable in the durable graph, so the question "could a capability be persisted by
accident?" has a structural answer rather than a review-discipline answer.

The risk this ADR accepts is that authority becomes invisible in a different way: a context
threaded through `execute` is easy to forget to pass, and forgetting fails closed, which is
safe but can look like a bug. That is the correct direction for the failure to point, and the
first proof's case 1 pins it deliberately.

## Guardrails

```text
authority is execution context, not program data
principal != capability
authority context != plain data
issued context != forgeable object
attenuate narrows only; nothing widens
absent authority == no capabilities, never all
declared import != authority
caller authority != ambient guest authority
guest authority == declared ∩ granted, checked per concrete resource
wasm-component-binding/v1 frozen; declared imports are v2
authority != Value, slot, capture, envelope, metadata or derivation key
Component per-activation isolation != a foreign-runtime capability model
WIT resource != another composite type
callbacks come after authority, not before
```
