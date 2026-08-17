# ADR 0014: runtime-local compiled WASM module cache

Status: accepted — the bootstrap WASM executor.

## Problem

ADR 0013 groups several executable entries into one immutable `wasm-module/v1`, but the executor still instantiated directly from module bytes on every activation. That asks the host WebAssembly engine to validate/compile the same immutable bytes repeatedly even when many Blocks execute different entries from one shared module.

The execution cache must improve runtime cost without becoming durable program state, changing image identity, or sharing activation-local imports/handles across calls.

## Decision

Add a runtime-local `WasmModuleCache` that caches compiled host `WebAssembly.Module` objects by immutable CodeArtifact identity:

```text
(imageId, wasm-module/v1 artifact id)
    -> WebAssembly.Module
```

`wasm-module/v1` CodeArtifacts are immutable, so their identity is sufficient inside one runtime. The cache is execution state only and is never persisted in the image.

The default code-executor registry creates a fresh WASM executor and cache for each runtime/registry instance.

## Compile once, instantiate per activation

The initial ADR 0014 execution path was:

```text
wasm-module/v1 bytes
       |
       | first activation
       v
WebAssembly.compile(...)
       |
       v
runtime-local WebAssembly.Module cache
       |
       +---- activation A -> fresh instance + imports
       +---- activation B -> fresh instance + imports
       `---- activation C -> fresh instance + imports
```

The compiled module is shared. At this decision point `WebAssembly.Instance` was still fresh per activation because imports close over activation-local state:

- `ValueHandleArena`
- active function/send/closure-site policy
- pending tail host effect
- captured runtime request context

ADR 0015 subsequently adds instance reuse only behind an explicit `stateless-v0` compiler/module contract and a rebindable host environment. That follow-up does not change the compiled-module cache contract here.

## Concurrent misses

The cache stores the in-flight compilation promise immediately. If two activations request the same module before compilation completes:

```text
activation A -> miss -> compile promise
activation B -> hit  -> same promise
```

Only one host compilation occurs.

## Failure behavior

A failed compilation:

- increments the failure count
- removes the failed promise from the cache
- propagates the original error

A later activation may therefore retry instead of being permanently poisoned by one failed entry.

## Observability

The cache exposes a small runtime-only stats snapshot:

```text
entries
hits
misses
compilations
failures
```

These counters are diagnostic execution state, not durable image metadata.

`clear()` drops compiled modules while leaving counters intact. `resetStats()` resets counters without changing cached modules.

## Identity and security consequence

A cached `WebAssembly.Module` is not a language object, image object, capability, or durable executable identity. It is a host-engine representation of one immutable `wasm-module/v1` artifact.

Sharing the compiled host module does not share:

- Block identity
- `wasm-function/v1` identity
- lexical environments
- Value handles
- pending effects
- capability context

Entry-level host-effect isolation from ADR 0013 remains enforced per activation.

## Multilingual consequence

This cache sits below source-language semantics. A future Java, Rust, Lisp or Smalltalk compiler that produces `wasm-module/v1` benefits from the same compiled-module cache automatically.

The cache key does not contain selectors, class names, crate names or language concepts.

Instance reuse is a separate question: languages/backends with mutable guest state need their own reset/reuse contract rather than inheriting ADR 0015's stateless promise accidentally.

## Backward/API consequence

`createWasmFunctionV1Executor()` is the public construction path. Default registries create runtime-local execution caches rather than relying on a shared singleton.

Existing single-function and shared multi-function `wasm-module/v1` artifacts use the same compiled-module cache.

## Deferred

- cache size limits and eviction/LRU policy
- host compiled-module serialization, if a portable host API becomes appropriate
- sharing compiled host modules across runtime instances
- worker/thread ownership semantics
- distributed node-local compiled-module warming
- metrics integration beyond the bootstrap stats snapshot

Instance pooling/reuse is addressed separately by ADR 0015.
