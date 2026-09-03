# ADR 0078: a derivation cache contract names the computation, so it moves when the computation does

Status: implemented
Proven by: test/toolchain-result-cache.test.js

ADR 0077 changed what the Cargo/rustc OCI runner executes for identical inputs: the requested
program became authoritative and the image's declared `ENTRYPOINT` stopped participating in command
interpretation. The Cargo provider's cache material, decided by ADR 0020, still said
`cargo-rustc-oci-cache/v0`.

That left one contract identifier naming results produced under two execution semantics:

```text
before 0077: OCI image metadata + requested argv -> container program
after  0077: requested program authoritative; ENTRYPOINT neutralized
```

Derivation records are persisted in the image with their derivation key. A record written before
the change therefore satisfied a lookup after it, returning outputs and provenance that describe an
invocation the current runner no longer performs. That the presently pinned image makes such a
record unlikely in practice is a fact about one image, not about the contract.

## Decision

`createCargoRustcOciProvider()` now emits `cargo-rustc-oci-cache/v1`. `CARGO_RUSTC_OCI_CACHE_CONTRACT_V0`
remains exported as historical identity only, following the pattern ADR 0019 set for the provider
identity.

More durably: **a provider's cache contract identifies the computation a cached derivation stands
for, not merely the inputs it consumed.** Whenever what the provider executes for identical inputs
changes — runner semantics, container program selection, output extraction — the contract version
must move with it. The generic derivation key (ADR 0020) covers inputs, target, options and provider
identity; it cannot know that the machinery behind an unchanged identity started doing something
else. Only the provider does, and it says so by bumping its contract.

## Ownership

The runner change belonged to the Cargo/rustc OCI provider's runner (ADR 0077). Reacting to it
belongs to that provider's cache material, under ADR 0020's authority. Neither reaches across the
boundary: the runner does not know about caching, and the cache material does not parse OCI image
metadata or inspect argv. It states a version.

The tempting alternative — mixing the executed argv into the derivation key so the cache moves by
itself — was rejected: argv carries host uid/gid and a temporary workspace path, none of which
belongs in a durable derivation identity, and stripping them back out is the redesign this decision
avoids.

## Proof

`test/toolchain-result-cache.test.js` runs the A/B on one image store with one provider id and one
request, output id included:

1. a provider identical to the shipped one except for the reverted contract string persists a
   record under v0
2. that same provider reuses it — the control, and the falsifier: this is exactly the provider the
   runtime would ship if the bump were undone
3. the shipped v1 provider does not find it: the runner executes again, and because the caller
   asked for the id the v0 record holds, `ToolchainService` refuses to overwrite it
4. the two derivation keys differ over identical request material while the toolchain identity is
   the same

## Consequence

A Cargo derivation cached before ADR 0077 is not admissible after it. Nothing is migrated or
deleted; the old records simply stop matching.

What happens next depends on the requested output ids. With fresh or omitted ids the next build
under the new semantics runs and writes a new record. A request that pins an id an old record still
occupies runs the toolchain and is then **refused** — `ToolchainService` will not overwrite an
existing artifact — so the old result is neither reused nor silently replaced, and the remedy is to
request a different output id. That refusal is deliberate; that it is discovered only after paying
the build is a pre-existing property of the service's ordering, recorded as follow-up work
(Bead lagrange-images-iu6) rather than changed here.
