# ADR 0020: deterministic toolchain result reuse

Status: accepted — the first external-toolchain result cache.

## Problem

`ToolchainService` now has enough explicit information to avoid rerunning deterministic external toolchains for identical immutable inputs.

For Cargo/rustc this matters immediately: a repeated build may otherwise rematerialize the same source/vendor tree and start the same digest-pinned OCI compiler even though every input artifact is unchanged.

The cache must not weaken the artifact/provenance rules established by ADRs 0017-0019.

## Decision

Toolchain result reuse is opt-in per provider.

A cacheable provider implements:

```js
provider.cacheKey(request, context)
```

in addition to its stable:

```text
provider.identity
```

If `cacheKey` is absent, `ToolchainService` remains one-shot for that provider.

The first toolchain derivation-key version is:

```text
lagrange-toolchain-derivation-key/v0
```

## Generic derivation material

The service hashes deterministic material containing:

```text
provider identity
provider selection ID
provider protocol
root artifact snapshots
complete resolved artifact snapshots
target
options
provider-specific cache-key material
```

Artifact snapshots contain the same build-relevant durable view already given to providers:

```text
kind
id
imageId
languageId
representation
content
dependencies
metadata
```

They deliberately exclude backend versions, timestamps and `derivedFrom` history.

This means source text, manifest/lock/config data, vendored text/bytes, dependency refs and build-relevant metadata all participate in the key.

## Exact graph identity in v0

The first cache includes artifact/image identities as well as content.

Therefore reuse is for the same explicit immutable input graph, not merely another independently imported graph with equivalent bytes.

This is deliberate: a reused toolchain output keeps its original explicit `derivedFrom` edges. Reusing it for different input identities would make current-invocation provenance disappear unless the platform introduced a separate installation/wrapper artifact.

Cross-install/content-addressed reuse may be added later with that provenance layer.

## Provider-specific material

The generic request already includes target/options and all resolved artifacts. `provider.cacheKey()` is additional deterministic material for provider configuration that affects observable results but is not in the generic request.

The public Cargo/rustc OCI provider opts in with the full digest-pinned OCI image reference.

The provider identity already contains the image digest, but the full image reference is also part of the cache material because fresh output metadata records `ociImage` and should remain observably identical on reuse.

## Multi-output result sets

One toolchain invocation may produce several outputs.

A cacheable persisted output receives non-reference metadata:

```text
toolchainDerivationKey
toolchainResultId
toolchainOutputName
toolchainOutputIndex
toolchainOutputCount
```

`toolchainResultId` distinguishes multiple complete installations created with the same derivation key, for example through `reuse: false` or different requested output IDs.

Cache lookup groups artifacts by result ID and reuses only a complete set where:

- every output has the expected common count/result ID
- output names are unique
- output indices are unique and cover the complete range
- every output still has exactly the current resolved input provenance

An incomplete/partial persisted result is ignored rather than treated as a hit.

## Output ID semantics

`ToolchainService.run()` now accepts:

```js
reuse: true // default
```

Requested `outputIds` are respected.

A cached result is reused only when every explicitly requested output ID matches that cached result. Asking for different IDs requests another installation and causes the provider to run again.

`reuse: false` always runs the provider, but a cacheable provider still gets a derivation key and the resulting complete set may be reused by a later compatible call.

## Return contract

Toolchain results now include:

```text
reused: boolean
derivationKey: string | null
```

Non-cacheable providers return `derivationKey: null` and never report reuse.

On a cache hit:

- the provider is not invoked
- the existing immutable output artifacts are returned
- transient diagnostics are `[]`

Diagnostics are intentionally not cached because they describe one execution, not durable derived program state.

## Failure/partial-write behavior

The existing multi-output persistence path is still not transactionally atomic.

If a backend failure leaves only part of a cacheable result set persisted, later lookup ignores that incomplete set. It does not fabricate missing outputs or treat the partial set as reusable.

A later transactional output-installation contract may strengthen this further.

## Cargo consequence

The public `createCargoRustcOciProvider()` now returns a cacheable provider.

For the same manifest/source/lock/config/vendor graph, target and options, a second compatible toolchain run can return the existing `wasm-binary/v1` without:

```text
rematerializing the Cargo workspace
starting Docker/Podman
rerunning Cargo/rustc
```

Changing any explicit vendored byte, source content, path metadata, lock/config data, target/options, provider selection, provider identity or pinned image reference changes the derivation key.

## Guardrails

```text
provider cache opt-in != inferred determinism
cache key != artifact filename
cache hit != replayed diagnostics
result-set reuse != merged output identities
exact input provenance != cross-install content equivalence
```

Do not infer external-toolchain cacheability merely because a provider returned the same representation before. Determinism is an explicit provider contract.
