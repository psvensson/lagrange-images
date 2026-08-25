# ADR 0066: created-object capability — a design investigation

Status: accepted — investigation outcome; **no new mechanism is adopted**. The conclusion is to keep
the staged-authority status quo and to *not* introduce a created-object capability at this time, for
reasons that are falsifiable against ADR 0037. This ADR exists so the question has a durable,
verified answer instead of recurring.

## Problem

The authorized creation lanes (ADR 0062, ADR 0064) mint object identity **server-side** and commit
insert-only. The authority service matches grants **exactly** (`{operation, resource}` pairs in a
`TupleSet`; no wildcards — ADR 0037 §6). So a caller that creates N objects and then references them
— a Perspective whose indexed part names its just-created children — cannot hold the per-target
`object/edge-write` grants for those ids up front: **the ids do not exist until creation commits.**

The first consumer, `lagrange-object-environment`, hits exactly this when saving a Perspective
(children first, then the indexed Perspective as the commit point). Its working composition (its
`savePerspective`, env PR #15) is a **staged authorized workflow**: an injected `authorityProvider`
control-plane seam issues a **fresh authority context per stage**, after that stage's exact resources
are known — stage 1 a context to create the children, stage 2 a context authorizing the subject edge
and the indexed edges to the now-known child ids. The adapter never issues, inspects, or holds an
authority root itself.

Bead `lagrange-images-3zm` asks: is there a **created-object capability** — successful creation
returns a capability authorizing a bounded set of follow-on operations over the newly created object
(e.g. being referenced as an edge target) — that would let a caller compose create-then-reference in
**one continuous authority context**, without the control-plane re-issuance step?

## The invariant under tension

ADR 0037 fixes the authority root model precisely, and this investigation is bounded by it:

- **`issue` is the only authority root**, held by the trusted host / control plane. *"Image code,
  executors, foreign guests receive neither the issuer nor a context."* (ADR 0037 §4)
- **`attenuate` can only narrow.** There is *no* widening operation, "so escalation is impossible by
  construction rather than by check." (authority-service.js)
- **`require` is the only authority operation that crosses into an executor**, and it is check-only —
  it returns nothing, so no grant object can be stashed, forwarded, or outlive the check. (ADR 0037,
  authority-service.js `require`)
- Grants are exact-match; **no wildcards**, because wildcards are "a place where 'narrower' becomes
  arguable." (ADR 0037 §6)

A created-object capability is, by construction, **a grant the caller did not hold before the
operation that produced it** — authority that *widens* as a result of an executor's action. That is
the precise thing the root model forbids. Any honest evaluation must either (a) fit within the
invariant, or (b) propose to change it — and (b) is a far larger decision than an ergonomic
improvement, to be made only against real, demonstrated pressure.

## Design space and evaluation

### Option 0 — keep staged authority (the status quo)

The caller's control plane remains the authority root and issues a context per stage once resources
are known. This is what the environment ships.

- **Cost**: the composition is not a single authority context; it needs a control-plane
  `authorityProvider` that can re-issue, and the workflow is multi-step. This is an ergonomic cost,
  not a correctness one — each stage is independently authorized and atomic. (The *separate* cost of
  the 1+N composition being non-atomic — orphan children on the change feed, mitigated by
  Perspective-as-commit-point — is a different matter, recorded in ADR 0064 §6 and addressed by
  multi-record transactions, not by a capability; see revisit condition 2.)
- **Benefit**: ADR 0037's model is untouched. The authority root stays exactly where the substrate
  can reason about it; no executor ever widens; grants stay exact-match and auditable; revocation
  keeps its simple upward-walk semantics.

### Option 1 — overload the returned version token as a capability

Let the version token returned by creation double as proof authorizing follow-on ops on the object.

- **Rejected outright.** ADR 0062 §6 and 3zm both name it: a version token is *concurrency*, not
  authority. It is caller-comparable and round-trippable by design (ADR 0042 §5), so treating it as
  a grant would make a publicly-inspectable concurrency value into an authority bearer token — the
  exact confusion ADR 0037 §3 (`principal != capability`) and §7 (absence of authority means no
  capabilities) forbid. This also grants nothing for *referencing the object as an edge target*,
  which is the actual need; `object/edge-write` on the new id is a different operation from
  `object/write` on it. (For precision: the lane's signature returns the version-token *string*
  alone; the caller already knows the id it minted under, and `parseObjectVersionToken` re-scopes
  to that caller-supplied id — so "returns id + token" is shorthand, not a separate id field.)

### Option 2 — the lane adds a derived grant to the caller's existing context

Creation, on success, mutates the caller's context to add `object/edge-write` on the new id.

- **Impossible without breaking the root model.** `attenuate` only narrows; there is no widen. And
  the executor receives no context at all — it receives `require`, a check-only function. Giving the
  creation executor a widen-capable handle on the caller's context is precisely "an executor can
  escalate," which ADR 0037 §4 exists to prevent. Rejected.

### Option 3 — a capability Value the lane returns, honored by the authority service

Creation returns an opaque capability Value; a later `require` for `object/edge-write` on that id
accepts the capability in lieu of an exact-match grant.

- This is the only variant that is a *real* capability, and it is foreclosed on **two independent
  grounds**, both worth recording so a future revisitor does not re-litigate from a weaker premise.
  First, a capability carried as a **canonical Value** is exactly what ADR 0037 §1 ("authority is
  execution context, not program data") and §11 ("no authority context or principal is ever a
  canonical Value … nor packed into an `interface-composite/v0` envelope") forbid — and ADR 0035
  forbids new nested Value kinds entirely. Second, even reshaped to avoid the Value form, it is a
  **change to the grant algebra**, not a lane tweak: it introduces a bearer-token grant form beside
  exact-match pairs, which is one of the "places where 'narrower' becomes arguable" ADR 0037 §6
  deferred. It raises questions that have no cheap answers within the current model: Is the
  capability forgeable or copyable (a Value is data — it can be duplicated and passed to other
  contexts, so it is no longer per-principal)? Does it survive revocation of the creating context
  (ADR 0037's upward-walk assumes grants live only in contexts)? Does `attenuate` understand it? Can
  it be attenuated, or does it escape the narrowing algebra entirely? Each answer is a new
  authority-semantics decision. That is a larger surface than the ergonomic problem warrants
  **today**, with one consumer and a working composition.

### Option 4 — a new control-plane operation `issueDerived` for "creator's follow-on grant"

The trusted host calls a new authority-root operation that, given a completed creation, issues a
narrow context authorizing bounded follow-on ops on the new id.

- This is **staged authority with a convenience wrapper**, not a new capability. The control plane
  still re-issues; the only change is that the re-issuance is named and constrained to a bounded
  grant set. It is a reasonable *ergonomic* improvement to Option 0 (a well-typed
  `authorityProvider` helper), but it is environment-side / control-plane-side sugar and requires
  **no substrate change** — so it does not need this ADR to permit it, and it does not remove the
  re-issuance step, only standardizes it.

**The design space is closed.** The obvious further candidates collapse into already-rejected options
or an existing invariant: pre-minted/deterministic caller-supplied ids would let the caller hold
exact-match grants up front, but server-side minting is load-bearing for ADR 0046 §6 lost-ack/retry
identity preservation (and the environment's adapter uses no deterministic ids); a wildcard grant
("edge-write on anything I created") is precisely what ADR 0037 §6 forbids; issuing a broader
up-front context covering the eventual ids reduces to Option 0; and a multi-record transaction is a
*different* deferred item, not a capability. Every in-model path to "compose create-then-reference in
one continuous context" reduces to staged authority.

## Decision

**Adopt Option 0: keep staged authority; do not introduce a created-object capability now.**

- The only genuine capability (Option 3) is a grant-algebra change whose hard questions (bearer
  semantics, revocation, attenuation) have no cheap answers within ADR 0037, and the pressure for it
  is one consumer with a working composition. ADR 0037 §6's own rule applies: a richer algebra is "a
  later decision that can be made against actual requirements rather than anticipated ones."
- Options 1 and 2 are rejected as violating the root model outright (token-as-authority;
  executor-widens).
- Option 4 is legitimate but is environment/control-plane sugar over Option 0, not substrate work;
  the environment may adopt it freely (it is a better-typed `authorityProvider`), and nothing here
  forbids it.

**Revisit conditions** (the falsifiable part — what would change this answer):

1. A **second, independent consumer** needs create-then-reference composition, so the ergonomic cost
   is demonstrably recurring rather than one-off; or
2. The environment finds staged authority **cannot** express a real workflow. Here the *kind* of
   inexpressibility matters and routes the answer: inexpressible **for want of authority** (a
   follow-on grant the control plane cannot legitimately issue) could point back at a capability;
   inexpressible **for want of atomicity** (an atomic create-and-reference that staging fundamentally
   cannot sequence) points at *multi-record transactions* (ADR 0062 §8), not a capability — a
   capability authorizes follow-on operations but does not make the 1+N writes atomic. The honest
   cost of the current 1+N composition (non-atomic, orphan-on-change-feed, mitigated by
   Perspective-as-commit-point) is recorded in ADR 0064 §6, and it is the atomicity case; or
3. A **multi-record transaction** lane lands (ADR 0062 §8), at which point "create children + the
   referencing parent in one transaction" subsumes the composition and a separate edge-capability is
   moot.

If any holds, the question is reopened *with that requirement in hand*, and Option 3 (or a
multi-record lane) is decided against it — not before.

## Consequences

- The environment's staged-authority `savePerspective` (env PR #15) is the sanctioned composition
  pattern; no substrate change is required of it. It may adopt an Option-4-style typed
  `authorityProvider` helper as sugar, control-plane-side, without any substrate ADR.
- ADR 0037's root model (issue-is-root, attenuate-only-narrows, require-is-check-only, exact-match
  grants, no wildcards) is reaffirmed unchanged. No executor ever widens authority.
- The deferred items this touches stay deferred, each for its own reason: a richer grant algebra /
  object capabilities (ADR 0037 §6), multi-record transactions (ADR 0062 §8), edge removal (ADR 0062
  §8). This ADR links them rather than resolving them.
- Version tokens remain strictly concurrency proof, never authority (ADR 0062 §6), reaffirmed.

## Guardrails

```text
created-object capability: NOT ADOPTED (keep staged authority)
issue stays the only authority root, held by the trusted host/control plane
no executor ever widens authority (attenuate only narrows; require is check-only)
a version token is concurrency, never authority (ADR 0062 §6) — never a capability
grants stay exact-match; no wildcards (ADR 0037 §6)
a real created-object capability = a grant-algebra change (Option 3), deferred for lack of pressure
staged authority is the sanctioned create-then-reference composition
a typed authorityProvider (Option 4) is environment/control-plane sugar, not substrate work
revisit on: a second consumer, an inexpressible workflow (-> multi-record tx), or a multi-record lane
```
