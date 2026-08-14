# ADR 0030: resumable non-tail host effects in Lagrange WASM

Status: accepted for the first compiler-generated resumable effect path.

## Problem

The original Lagrange WASM ABI deliberately allowed host effects only in tail position. A WASM function could compute a message-send or nested-Block request, yield it to the host, and let the host return that effect's result as the activation result.

That model is small and efficient, but PR 32 exposed the semantic gap:

```smalltalk
[ :x | cuis value: (rust value: x value: x) value: x ]
```

The inner `rust` Block invocation returns a Value which is then used as an argument to the outer `cuis` Block invocation. The neutral executor can evaluate that expression naturally, while the Lagrange WASM backend previously rejected it because the inner send is not in tail position.

Backend choice should not change which ordinary language programs are expressible.

## Decision

Keep the existing tail-only ABI unchanged:

```text
lagrange-value-handle/v0
```

and add a second ABI for semantic functions that actually require suspension and resumption:

```text
lagrange-value-handle-resumable/v1
```

The default compiler is hybrid:

1. compile with the established v0 backend first;
2. if and only if compilation fails because a send or nested-Block creation is non-tail, compile the same semantic artifact with the resumable backend;
3. other compiler errors remain errors and do not trigger fallback.

This keeps existing simple/tail programs on the smaller proven ABI while making non-tail effects explicit rather than silently switching to the neutral executor.

## Compiler-generated continuations

The resumable compiler lowers a semantic expression to a small internal plan of:

```text
pure Value operations
conditional branches
host effects
returns
```

A non-tail host effect splits that plan into WASM segments:

```text
entry
  -> compute request
  -> effect import
  -> return reserved handle 0

resume_N(saved handles..., effect-result handle)
  -> continue computation
```

Resume functions are ordinary exported WASM functions only so the host can re-enter the compiled module. They are compiler-private execution entries, not durable Blocks and not language-level callables.

For a tail effect there is no resume entry. The existing v0 behavior remains the optimized shape: the host performs the effect and returns its result directly.

## Continuation state

PR 33 does not introduce a durable continuation object or serialize a WASM stack.

At each non-tail effect the compiler passes explicit live Value handles to the effect import after the handles needed for the effect request. The host records those raw handles as transient continuation state while the same activation-local `ValueHandleArena` remains alive.

After the host completes the effect:

```text
canonical Value
    -> arena handle
    -> resume entry(saved handles..., result handle)
```

The compiler currently keeps continuation liveness intentionally conservative: it may carry all values available at the suspension point rather than performing an aggressive live-variable analysis. That is an optimization issue, not a semantic contract.

## Runtime lifecycle

A resumable activation holds one WASM instance lease across non-tail host effects. The instance is unbound from its host activation environment while awaiting the host operation, then rebound before the continuation entry is invoked.

This matters for two reasons:

- no hidden WASM memory/stack snapshot is treated as durable state;
- a nested host call may acquire another pooled instance without re-entering the suspended instance.

The current `stateless-v0` instance-reuse declaration remains valid because continuation state lives in explicit handles and compiler-generated parameters, not retained mutable guest state.

A hard resumption limit prevents an accidentally unbounded host-effect trampoline in one activation. This is an execution safety bound, not language-level control flow semantics.

## Effects covered

The first resumable ABI covers the same host effects already owned by the Lagrange WASM lane:

```text
message send
nested Block creation
```

Both may now occur in non-tail position. Pure operations and conditionals may appear before, between, or after suspensions, and multiple sequential suspensions are allowed.

No new ambient host authority is introduced. A continuation only resumes computation after an effect that the normal `ActivationExecutor` already knows how to perform.

## Shared modules

The nested-Block tree installer uses the same hybrid preflight rule as the compiler registry. If one member of a shared module requires resumable effects, the shared module is emitted with the resumable ABI and all semantic entry descriptors continue to identify their own send/closure sites.

This allows a nested Block to be created in non-tail position and then immediately invoked while preserving the existing shared-module/prototype installation model.

## Mixed-program proof

The PR 32 program is compiled from the same persistent Symmetric Smalltalk semantic artifact into both execution forms:

```text
lagrange-code/v0
      |                |
      v                v
neutral-expression/v0  wasm-function/v1
                        |
                        v
              resumable value-handle ABI
```

The WASM version executes:

```text
x = 14
  -> foreign WASM Block: 14 + 14 = 28
  -> resume Lagrange WASM
  -> live Cuis Block: 28 + 14 = 42
  -> result 42
```

The ordinary Node test requires neutral and resumable WASM executions to produce the same Values. The PR-only integration job runs the WASM orchestration against the real pinned OpenSmalltalkVM/Cuis toolchain-produced image.

A separate unit proof performs two non-tail suspensions before a final tail effect, and the shared-module proof resumes after non-tail closure creation.

## What remains out of scope

This is not yet:

- first-class continuations or `call/cc`;
- durable suspended activations;
- process-restart recovery of suspended frames;
- migration of a suspended activation between nodes;
- exception/condition unwinding across suspension points;
- debugger mutation of continuation state;
- cancellation, retry or idempotency semantics;
- arbitrary async callbacks from a foreign runtime;
- a capability grant.

Those concerns need separate contracts rather than being inferred from compiler-generated resume entries.

## Guardrails

```text
semantic continuation != durable Block
resume entry != public callable interface
suspended activation != object identity
saved Value handle != durable Value identity
effect request != capability
resumption != retry
resumption != deployment reconciliation
compiler-private export != language-visible method
```

## Consequence

For the semantic subset currently supported by both backends, ordinary nested host-effect composition no longer requires a neutral-executor fallback merely because one call's result feeds another call.

This materially strengthens the execution boundary:

```text
language meaning != chosen execution backend
```

The next pressure should therefore move outward again: richer foreign/component values, structured ecosystem artifacts, capabilities, or distribution can build on a core execution lane that now supports real non-tail composition.
