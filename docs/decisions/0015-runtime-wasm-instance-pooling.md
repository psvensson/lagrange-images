# ADR 0015: runtime-local WASM instance pooling

Status: accepted for the bootstrap WASM executor.

## Problem

ADR 0014 caches host `WebAssembly.Module` compilation, but each activation still creates a fresh `WebAssembly.Instance`.

For the current generated modules that is unnecessary work: they contain executable functions and imports but no guest memory, mutable globals, tables or other activation-persistent guest state. Related entries already share one physical module under ADR 0013, so sequential activations should be able to reuse an instantiated host object too.

Instance reuse is more dangerous than module reuse, however. Imports close over activation-local Value handles, closure prototypes and pending host effects. Future Java, Rust, Lisp or other WASM backends may also introduce heaps, memories, mutable globals, thread state or initialization protocols. The executor must therefore never assume that every `wasm-module/v1` instance is reset-safe.

## Decision

Add a runtime-local `WasmInstancePool` and an explicit module contract:

```text
metadata.instanceReuse = "stateless-v0"
```

Only modules carrying a supported instance-reuse contract may enter the pool.

The built-in single-member and grouped Lagrange-code WASM compilers now stamp `stateless-v0` on their module artifacts. Their compiler identities advance from `compiler-v1` to `compiler-v2` because this changes observable derived artifact metadata and should not silently reuse older cached modules that predate the contract.

Modules with no `instanceReuse` metadata remain valid and execute one-shot. An unknown declared reuse contract is rejected rather than guessed.

## Meaning of `stateless-v0`

For the bootstrap executor, `stateless-v0` means an instance may be used for another activation after a successful entry returns because the generated guest module has no durable mutable guest state that survives an activation.

In particular, the compiler/runtime contract assumes:

- no guest linear memory whose contents carry activation state
- no mutable guest globals carrying activation state
- no mutable tables carrying activation state
- no activation-dependent start-function behavior
- no guest-owned handles that survive the synchronous entry call
- observable image state remains outside the instance and crosses through explicit host effects/Values

This is a compiler promise, not a property inferred from source language or module name.

A future compiler with a heap, memory, TLS, GC/runtime state or another mutable instance model must omit this contract or define a later reset/reuse contract.

## Rebindable host environment

A pooled instance is instantiated once with imports backed by a small mutable host binding holder.

At checkout the executor binds a fresh activation state:

```text
ValueHandleArena
active function descriptor
active send-site set
active closure-site set
closure prototype refs
pending tail-effect slot
```

The WASM import functions dereference that current activation state rather than closing permanently over the first activation.

After the synchronous WASM entry has returned and its result contract has been checked, the binding is removed before the instance is returned to the pool.

No invocation-local Value handle or pending-effect object is kept in the idle instance.

## Tail effects and release timing

A tail send or closure materialization is only a request recorded during synchronous WASM execution.

The executor therefore performs:

```text
checkout instance
  -> bind activation host state
  -> execute WASM entry
  -> copy pending effect request out
  -> unbind host state
  -> return instance to pool
  -> await asynchronous language send / closure materialization
```

The instance is not held while asynchronous image/runtime work happens. That work cannot call back into the already-finished WASM stack under the current tail-effect ABI.

## Failure retirement

An instance is returned to the pool only after the synchronous guest boundary completed successfully.

If the entry traps or a host import/result contract fails while WASM is executing, the lease is retired rather than reused. Examples include:

- inactive host-effect site invocation
- invalid Value handle
- wrong tagged type passed to a host primitive
- missing/invalid exported entry
- a nonzero result returned alongside a pending tail effect

Errors that happen later while performing an already-recorded asynchronous send/closure effect do not retire the instance: the guest execution already completed and the instance was cleanly unbound.

## Pool policy

The bootstrap pool is per runtime and keyed by immutable module artifact identity:

```text
(imageId, wasm-module/v1 artifact id)
```

It does not serialize concurrent activations. If all idle instances are checked out, another activation creates another instance.

The default retention policy keeps at most one idle instance per module. This is deliberately conservative: it captures the common sequential reuse win without retaining the full peak-concurrency population forever. `maxIdlePerModule` is configurable on `WasmInstancePool`.

Extra instances released when the idle budget is full are discarded.

## Runtime ownership

The default executor registry creates a fresh:

- `WasmModuleCache`
- `WasmInstancePool`
- WASM executor

for each runtime/registry.

Neither compiled modules nor pooled instances are durable image objects.

`createRuntime()` may accept injected `wasmModuleCache` / `wasmInstancePool` objects for host tuning and tests, but cross-runtime sharing is not the default contract.

## Observability

`WasmInstancePool.stats()` reports runtime-only counters:

```text
modules
idle
inUse
hits
misses
created
retired
discarded
```

`clear()` drops idle instances while leaving checked-out leases alone. `resetStats()` resets counters without changing current pool contents.

These are diagnostics, not image metadata.

## Security and identity consequence

Instance reuse does not reuse:

- Block identity
- `wasm-function/v1` identity
- lexical environments
- Value handles
- active entry/effect permissions
- capability context
- pending host effects

A pooled instance is host execution machinery for one immutable module artifact. Entry-level host-effect isolation from ADR 0013 is rebound and rechecked for every activation.

## Multilingual consequence

Pooling is not Smalltalk-specific. Any future compiler producing `wasm-module/v1` may benefit if it can honestly declare a compatible reset/reuse contract.

A Java or Rust backend that owns mutable linear memory or runtime heap state should not inherit `stateless-v0` merely because another language uses it. It may instead remain one-shot or introduce a later explicit reset protocol.

## Deferred

- stronger reset contracts for modules with reusable mutable memories/globals
- pool sizing based on measured load or module cost
- idle timeout/LRU eviction
- worker/thread ownership semantics
- sharing instance pools across runtime instances
- WASM GC/runtime-specific pooling contracts
- node-local warming and distributed placement policy
- metrics integration beyond bootstrap stats
