# ADR 0036: foreign Component instance lifetime

Status: implemented — compilation machinery is cached, Component instances are fresh per activation, and reuse requires an explicit contract that does not yet exist.
Proven by: test/component-instance-lifetime.test.js

## Problem

ADR 0034's Component lane shipped with a runtime that cached the *instantiated* Component by
artifact identity and then called that same instance for every activation. The roadmap
simultaneously listed reusable foreign instance/reset contracts as unresolved, so the
implementation had quietly become the contract.

This was not a grey area. AGENTS.md already stated the rule for the sibling lanes:

> Reuse `WebAssembly.Instance` objects only behind an explicit module reset/reuse contract.
> Absence of a contract means one-shot execution.

> Foreign scalar modules are compiled once per runtime but instantiated fresh per activation.
> Do not pool arbitrary foreign instances without a separate reset/reuse contract.

The Component lane violated both.

The defect was demonstrable rather than theoretical. A Component export backed by a mutable
counter, invoked through four unrelated activations, returned `1, 2, 3, 4`.

While Components are pure calculations this is merely wrong. It becomes a security defect the
moment host imports exist:

```text
activation A            authority = Alice
        |
        v
   cached instance      mutable state, handles, imports
        |
        v
activation B            authority = Bob
```

Guest-resident state, and eventually authority obtained under one principal, would be
reachable from an activation running under another. Fixing this before capability work
begins is much cheaper than retrofitting isolation afterwards, and it removes the risk that
the capability ADR is written against an unsound execution model.

## Decision

### Cache immutable machinery; never infer that execution state is reusable

```text
Component artifact bytes
    -> transpilation and core-module compilation   MAY be cached
    -> keyed by immutable artifact identity, runtime-local, never persisted

Component instance
    -> fresh for every activation

instance reuse
    -> requires an explicit reset/reuse contract
    -> no such contract exists yet
```

This mirrors the rule already established for the internal WASM lane by ADR 0014 and ADR
0015, and for the foreign scalar lane by ADR 0021. The Component lane is now consistent with
both rather than an exception.

What is cached is precisely the part that cannot carry activation state: the jco-generated
factory module and the compiled `WebAssembly.Module` objects. Both are derived
deterministically from immutable artifact bytes. What is not cached is the only thing that
can hold state.

### A failed preparation is not cached

A preparation that throws evicts its own cache entry, so a later activation retries rather
than inheriting a stale rejection forever. This matches the existing requirement that failed
module compilation must evict its cache entry.

### The absence of a reuse contract is deliberate, not an oversight

If measurement later justifies pooling, it needs an explicit contract in the manner of
`stateless-v0`: a declaration by the implementation that it holds no activation-persistent
guest memory, mutable globals, tables or handles, plus a rebindable activation context so
every checkout starts clean. Such a contract must also advance the runtime's identity so
durable derivation reuse cannot silently return artifacts made under different lifetime
promises.

Until that exists, the current implementation must not be read as constituting it. That is
the whole reason this ADR exists as a written decision rather than as code that happens to
behave a certain way.

### Cost

Marginal cost measured at roughly 0.85 ms per activation with compilation cached, against
roughly 20 ms when it is not. The caching that matters for performance is exactly the
caching that is safe, which is why the conservative rule costs little.

## Consequence

The Component lane is now isolated per activation, and the empty import object passed to jco
is a contained seam for capability-aware host imports rather than an existing ambient host
surface that would have to be clawed back.

This ADR deliberately decides nothing about authority. It only ensures that when authority
arrives it cannot be inherited by an activation that was never granted it.

## Guardrails

```text
compiled module != instance
transpilation cache != instance reuse
implementation behaviour != lifetime contract
absent contract == one-shot execution
cached failure != permanent failure
runtime-local cache != durable state
performance argument != authority argument
```
