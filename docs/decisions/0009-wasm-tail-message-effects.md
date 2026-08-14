# ADR 0009: WASM tail message effects

Status: accepted for the bootstrap WASM backend.

## Problem

Language message dispatch may read image state and execute another Block, so the host path is asynchronous. Ordinary WebAssembly imports are synchronous. The first WASM backend must not hide that mismatch by blocking, replaying execution or silently switching to the interpreter.

## Decision

`lagrange-value-handle/v0` supports message sends as **tail host effects**.

A semantic send may be lowered to WASM only when the send is in tail position. Tail position propagates through the selected branches of `if`, so a module may perform pure WASM computation/control flow before yielding one final message send.

A non-tail send is rejected explicitly by the WASM compiler.

## Send sites

Each compiled semantic send creates a derived module send-site descriptor:

```text
sendSites[N]
  languageId
  message : Value
  arity
```

The message Value may not be a graph reference because derived metadata must not hide graph edges. Receiver and argument Values are not stored in module metadata; they cross the activation boundary as ordinary invocation-local Value handles.

For each site the generated module imports a typed function:

```text
lagrange.send_site_N(
  receiverHandle,
  argumentHandle0, ...
) -> i32
```

The import arity is fixed for that site. The returned `i32` is the reserved handle `0`.

## Execution

The synchronous import does not perform image lookup. It validates the supplied handles, resolves them to canonical Values in the current `ValueHandleArena`, records exactly one pending language-send request, and returns `0` immediately.

The generated WASM entry then returns. If a pending request exists, the WASM executor requires the entry result to be `0` and resumes outside WASM:

```text
WASM entry
  -> send_site_N records request
  -> WASM returns 0
  -> WASM executor awaits context.sendMessage(request)
  -> normal InvocationService dispatch
  -> normal ActivationExecutor execution
  -> canonical Value result
```

The resolved callee may itself use any registered executable representation, including another `wasm-function/v1`. WASM-to-WASM language calls therefore still pass through ordinary language dispatch rather than acquiring a separate method-lookup path.

Only one pending send may be recorded by one WASM activation. Attempting multiple pending effects is an execution error.

## Why tail-only

Tail effects preserve the existing asynchronous runtime contract without introducing a continuation representation prematurely. There is no suspended WASM stack to serialize or resume: all pure WASM work is complete before the host send begins.

General non-tail asynchronous sends will require an explicit later design such as continuation/trampoline lowering or another asynchronous WASM integration. That extension must not weaken the v0 rule silently.

## Security and capability consequence

A send-site import grants no ambient image access. The module can request only the language send described by that derived site, using Values already admitted to the current activation as receiver/arguments.

Value handles remain invocation-local and are still not capabilities. Authorization/capability context for host sends remains a later runtime boundary and must be applied before distributed or privileged operations are exposed.

## Consequences

Compiled Symmetric Smalltalk such as:

```smalltalk
[ :target | target echo: 42 ]
```

can now execute as WASM when the send is the final semantic operation. Pure computation may select which final send occurs through `if`.

The interpreter remains the reference implementation. Differential tests require interpreted and WASM callers to produce the same canonical Value, including when a WASM caller resolves to a WASM-backed callee.

## Deferred

- non-tail asynchronous message sends
- dynamic message Values carried as handles rather than derived send-site metadata
- nested Block creation in WASM
- capability-aware send authorization
- exceptions/conditions crossing a WASM host effect
- distributed/local send policy
- continuation/trampoline representation
