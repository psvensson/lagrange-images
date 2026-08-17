# ADR 0037: transient execution authority

Status: implemented — the authority substrate: transient contexts beside the activation, a check-only require seam, and attenuation on the nested-send path. Capability-bearing host imports remain unimplemented.
Proven by: test/execution-authority.test.js

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

### 2. Executors receive a check, not the authority and not a grant

Executors are already handed a per-execution context containing `images`, `lookupBinding`,
`createClosure` and `sendMessage`. Authority is *not* added to that object.

Instead the context gains one narrow function, closed over the current authority:

```text
require(demand) -> void        returns normally, or throws
```

It is deliberately check-only. An earlier draft had it return a grant, which would have
created a second representation of authority that could be stored, passed on or outlived the
check that produced it — the precise thing this ADR exists to prevent. There is nothing to
stash: the only observable outcome is whether the call threw.

A host import therefore closes over `require`, and each invocation looks like:

```text
require({operation, resource})     throws if not permitted
perform the host operation
```

The executor receives neither the authority nor a reusable authorization token, so no
executor is a leak site and no intermediate object needs its own lifetime rules.

### 3. `principal != capability`

```text
principal   = who caused this execution
capability  = what this execution is allowed to do
```

Authorization asks the authority layer. Code that branches on `principal === 'alice'` is
wrong even when it produces the right answer, because it re-derives rights from identity.

A principal is available to host-side audit and diagnostic infrastructure. It is **not**
placed in the executor context, and not reachable by a foreign guest.

That is a deliberate second line of defence rather than an inconvenience. If executors could
read the principal, `principal != capability` would degrade into "every executor can still
inspect the principal and branch on it", which is the same mistake with extra steps. If some
guest later genuinely needs caller identity as *information*, that should be an explicitly
declared host interface subject to the same intersection rule as any other import.

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
require(context, demand)          -> void, or throws
```

`attenuate` can only narrow. There is no operation that widens a context, so escalation is
impossible by construction rather than by check.

The service is split by trust rather than merely by convention, because whoever may call
`issue` is by definition an authority root:

```text
issue / revoke / root grant configuration   trusted host and control-plane API
require                                     execution-time API
image code, executors, foreign guests       receive neither the issuer nor a context
```

The `AuthorityService` itself is never placed in an executor context. Only the closure around
`require`, and the attenuation machinery that `ActivationExecutor` uses internally, cross that
seam.

### 6. The v0 grant algebra is deliberately boring

"Attenuate can only narrow" is not implementable without saying what narrower means, so v0
fixes it at the dullest possible answer: exact-match grants.

```json
{"operation": "host-value/read", "resource": "public-message"}
```

`require` matches a demand against granted pairs exactly. `attenuate` selects a subset of
grants already present in the parent context.

No wildcards, no `*`, no inheritance, no resource trees, no deny rules and no precedence
order. Every one of those is a place where "narrower" becomes arguable, and none is needed
until object and project capabilities create real pressure. A richer algebra is a later
decision that can be made against actual requirements rather than anticipated ones.

### 7. Absence of authority means no capabilities

An execution with no authority context has no host capabilities. It is not an error: every
lane built so far needs none, so pure Components, scalar WASM, the neutral executor and the
existing Cuis operations all keep working untouched.

Anything that requires a capability fails closed. The default is *no rights*, never *all
rights*, and never *rights inherited from ambient process state*.

### 8. Nested sends inherit, or are explicitly attenuated

Nested execution already recurses through one seam:

```js
return await this.execute(nested, {depth: depth + 1});
```

Authority propagates through that same call. A nested send inherits the current context by
default.

An executor that wants a narrower child does not receive one. It states the request, and
`ActivationExecutor` performs the attenuation itself:

```text
sendMessage(request, {attenuate: requestedGrants})
```

`ActivationExecutor` calls `AuthorityService.attenuate(currentContext, ...)` and recursively
executes under the resulting child. The executor sees only its own request; the child context
never crosses back out to it. This keeps decision 2 intact — no executor ever holds a context —
while still making attenuation expressible, and it needs no new seam because the recursive
send path already exists.

Because `attenuate` only narrows, a nested send can lose rights and can never gain them.

### 9. Guest authority is the intersection of declared imports and caller grants

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

### 10. `wasm-component-binding/v2` declares permitted host imports; v1 stays frozen

`wasm-component-binding/v1` has exactly two dependencies — interface and implementation — and
no host authority surface at all. Adding declared imports to it would let two runtimes read
one durable representation differently, which is the same argument that produced
`callable-interface/v2` and worked well there.

So a new representation declares the host-import interfaces its implementation legitimately
expects. Declaring is not granting.

### 11. Authority never becomes program data

Stated as the enforceable list, because this is what tests should pin:

- no authority context or principal is ever a canonical Value
- none is ever reachable from a slot, lexical environment, `derivedFrom` edge or metadata
- none is ever packed into an `interface-composite/v0` envelope
- none participates in Block identity or any derivation/cache key
- the graph walker never encounters one, because there is nothing for it to encounter

### 12. Authority belongs to the call, never to the runtime instance

ADR 0036 removed cross-activation contamination for Components by instantiating fresh every
time. That answer cannot transfer to a long-lived foreign runtime: a Cuis image is
deliberately shared across activations, and starting a VM per activation would defeat the
whole foreign-runtime substrate.

The resolution is one level above the transport, and it is decided here rather than left as
three plausible futures:

```text
long-lived foreign runtime instance
    MAY serve calls from many authorities

authority
    belongs to the individual active call
    NEVER to the runtime instance

foreign host operation
    must resolve against that call's execution context

no active call, or no context
    => no host authority
```

This is the ordinary shape of a server process handling requests from Alice and Bob. The
process is not Alice-authorized or Bob-authorized; each request is. Runtime partitioning by
authority remains available as an isolation or deployment policy, but it must not become the
semantic capability model — and declaring that foreign runtimes simply never receive
capabilities would be needlessly restrictive.

Stated as the two invariants that generalize:

```text
authority lifetime    == invocation lifetime
authority ownership   != runtime instance ownership
```

Those hold for Components, for Cuis, and for a future JVM or remote runtime. *How* a runtime
makes host calls is lane-specific. *Whose* authority it uses is not.

The Cuis transport remains deferred. A likely shape is request-scoped host-call frames:

```text
CALL 42 ...
    Cuis -> HOST_CALL 42 read-value public-message
    host -> require against call 42's context
    host -> HOST_OK 42 ...
```

When `CALL 42` completes, authority 42 ceases to exist. A delayed or background host request
therefore has no active context and fails closed, which is the same reason async callbacks are
ordered after this ADR rather than before it.

### 13. Authority-bearing handles need explicit scope, unlike ordinary foreign data

A corollary of decision 12, recorded now because it constrains WIT `resource` later:

```text
foreign-runtime instance      long-lived
ordinary foreign data         may survive per that runtime's own semantics
authority-bearing handle      must carry explicit scope and lifetime
                              must never silently become runtime-global
```

A handle that outlives the invocation whose authority created it would reintroduce exactly the
contamination decision 12 forbids, through a different door.

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

- the foreign-runtime lane's host-call *transport*. Its capability semantics are decided in
  decision 12; only the wire mechanism is open
- WIT `resource`. It is not a cheap extra composite type: it is identity, ownership, lifetime
  and, here, authority. It belongs with this work, not with the `interface-composite/v0` codec
- revocation propagation, expiry and cancellation semantics
- attenuation algebra beyond "narrower or equal"
- OIDC/SSO/Keycloak integration; the runtime sees normalized principals only
- multiple activation results, unchanged from ADR 0035
- `option`, `result`, variants and tuples, to be added only when a real interface needs one

## Implementation status

Built and proven, all eight first-proof cases plus the algebra and forgery checks:

- `AuthorityService` with `issue`, `attenuate`, `revoke`, `require` and `principalOf`, exact-match
  v0 grants, and contexts that are empty frozen objects whose records live in a private
  `WeakMap` — so a context from anywhere else is absent rather than misinterpreted
- revocation resolved by walking ancestors, so revoking a parent invalidates every context
  attenuated from it without holding references to children
- `ActivationExecutor.execute(activation, {depth, authority})`, with `require` in the executor
  context and nothing else authority-shaped, asserted by enumerating that context's keys
- `sendMessage(request, {attenuate})`, where the executor states a request and
  `ActivationExecutor` performs the attenuation, so no executor ever holds a context

Not implemented, deliberately:

- `wasm-component-binding/v2` and capability-bearing Component host imports
- the foreign-runtime host-call transport, whose semantics decision 12 already fixes
- authorized object projection and WIT `resource` handles

The proof uses a purpose-built probe executor and a two-line dispatcher rather than a real
host interface, so authority propagation is established in the substrate before any foreign
lane is involved. That turned out not to need the language personality at all.

## Consequence

The substrate gains authority without the Value model gaining anything. Authority is
unrepresentable in the durable graph, so the question "could a capability be persisted by
accident?" has a structural answer rather than a review-discipline answer.

The foreign-runtime lane is decided at the level that generalizes — authority belongs to the
call, not the instance — while its wire mechanism stays open. That is the right split: the
semantic rule is what other lanes will have to obey, and it would have been expensive to
discover it was wrong after building one transport around it.

The risk this ADR accepts is that authority becomes invisible in a different way: a context
threaded through `execute` is easy to forget to pass, and forgetting fails closed, which is
safe but can look like a bug. That is the correct direction for the failure to point, and the
first proof's case 1 pins it deliberately.

The v0 grant algebra will look inadequate the first time a real object capability appears. That
is intended. Exact-match pairs are the only algebra where "narrower" needs no argument, and
replacing them later against real requirements is cheaper than defending an anticipated
hierarchy that turns out to model the wrong thing.

## Guardrails

```text
authority is execution context, not program data
principal != capability
principal is not in the executor context
require is check-only; there is no grant object to stash
authority context != plain data
issued context != forgeable object
issue is a control-plane API; require is an execution-time API
AuthorityService is never in an executor context
attenuate narrows only; nothing widens
attenuation request != child context handed to an executor
v0 grants are exact-match pairs; no wildcards, trees or deny rules
absent authority == no capabilities, never all
declared import != authority
caller authority != ambient guest authority
guest authority == declared ∩ granted, checked per concrete resource
wasm-component-binding/v1 frozen; declared imports are v2
authority != Value, slot, capture, envelope, metadata or derivation key
authority lifetime == invocation lifetime
authority ownership != runtime instance ownership
runtime partitioning == deployment policy, not the capability model
authority-bearing handle != ordinary foreign data
WIT resource != another composite type
callbacks come after authority, not before
```
