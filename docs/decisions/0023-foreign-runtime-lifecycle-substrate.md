# ADR 0023: language-neutral foreign runtime lifecycle substrate

Status: accepted and implemented as the first foreign-runtime execution seam.

## Problem

The artifact/toolchain side can already run short-lived external compilers, but a compatibility runtime such as OpenSmalltalkVM or a JVM has a different lifecycle:

```text
start
  -> many calls
  -> stop
```

Treating that as a toolchain invocation would conflate build machinery with a live execution environment. Treating its process/heap handles as image objects would conflate foreign runtime state with the durable Lagrange image graph.

OpenSmalltalkVM is the first intended consumer, but the substrate must remain language-neutral.

## Decision

Add two transient runtime abstractions:

```text
ForeignRuntimeProviderRegistry
ForeignRuntimeService
```

The provider protocol is:

```text
lagrange-foreign-runtime-provider/v0
```

A provider declares a stable implementation identity and implements:

```js
provider.start(request, context)
provider.call(handle, request, context)
provider.stop(handle, request, context)
```

The registry selection ID and provider identity remain separate:

```text
providerId          smalltalk/opensmalltalk
provider.identity   opensmalltalk-runtime/...version...
```

This mirrors the existing toolchain distinction between configuration selection and implementation identity.

## Runtime instance identity is transient

`ForeignRuntimeService.start()` creates a runtime-local UUID and returns a descriptor:

```text
kind = foreign-runtime-instance
runtimeId
providerId
providerIdentity
status
metadata
```

The runtime ID is host execution identity. It is not:

```text
ObjectRef
image object ID
Spur oop
capability
portable durable identity
```

The provider's actual opaque handle is stored only inside `ForeignRuntimeService`. It is never returned to ordinary callers.

A later durable runtime-definition/installation artifact may describe what should be started, but a running process/VM instance remains transient execution state.

## Explicit start data

The v0 start request contains frozen plain data:

```text
protocol
providerId
providerIdentity
runtimeId
spec
```

The service does not interpret the provider-specific `spec`.

The generic provider context contains only the protocol. It deliberately exposes no ambient `ImageService`, toolchain service or capability minting API.

OpenSmalltalkVM integration may later define how runtime/image/package artifacts are resolved into a concrete start spec. That should pressure this contract rather than being guessed into v0 now.

## Explicit call data

A call request contains:

```text
protocol
providerId
providerIdentity
runtimeId
interface
arguments
```

`interface` is frozen provider-specific plain data in v0. The generic service does not interpret Smalltalk selectors, Java method descriptors or another language's interface semantics.

Arguments are canonical Lagrange Values. The provider must return one canonical Value.

This is the first common transport shape, not the final rich foreign-call ABI. Later interface artifacts may be resolved into this transient call description by a higher layer.

## Interface is not authority

The runtime service intentionally has no implicit authorization semantics yet.

```text
runtimeId != capability
provider handle != capability
interface description != capability
```

When capability-aware foreign calls are added, principal/capability context must be passed explicitly through a new/extended contract rather than hidden in a runtime handle or ambient service.

## Call/stop ordering

A running instance has lifecycle status:

```text
active
stopping
```

`call()` is accepted only while active.

When `stop()` begins:

1. status becomes `stopping` immediately;
2. new calls fail explicitly;
3. the service waits for already in-flight calls to settle;
4. the provider's `stop()` hook is invoked;
5. successful stop removes the instance.

If provider shutdown fails, the service restores `active` so the caller can inspect/retry rather than pretending the runtime disappeared.

This does not prescribe whether a provider executes calls concurrently or serially internally. It only prevents service-level shutdown from racing accepted calls.

## Runtime shutdown ownership

`createRuntime()` now owns:

```text
foreignRuntimeProviders
foreignRuntimes
```

and `runtime.close()` attempts to stop all active foreign runtimes before stopping the backend.

A provider-specific process/container must therefore not be silently orphaned merely because the Lagrange Images host is shutting down normally.

Crash recovery and distributed runtime ownership are later concerns.

## What v0 deliberately does not define

Not implemented here:

- OpenSmalltalkVM or JVM process launching;
- OCI lifecycle details;
- durable runtime-definition artifacts;
- runtime restart/reconciliation policy;
- distributed runtime ownership/placement;
- arbitrary foreign-object handles;
- callback/re-entrant calls into image services;
- capabilities/principal context;
- transactional calls;
- retry/idempotency semantics;
- streaming or multiple return values;
- image artifact resolution inside the provider context.

Those should be added from pressure created by real runtimes.

## OpenSmalltalkVM consequence

The next proof can now be concrete:

```text
Lagrange Images
    -> ForeignRuntimeService
    -> OpenSmalltalkVM provider
    -> headless Cuis-compatible image
    -> explicitly exported Smalltalk service
    -> canonical Value result
```

The OpenSmalltalk provider may keep a process/socket/transport object as its opaque handle. That handle remains transient and private to the provider/service.

The foreign Spur heap remains owned by OpenSmalltalkVM:

```text
Spur object memory != Lagrange image graph
Spur oop != runtimeId
Spur oop != ObjectRef
```

## Guardrails

```text
foreign runtime != toolchain lifecycle
runtime definition != running instance
running instance != image object
provider handle != ObjectRef
runtime ID != capability
interface != capability
foreign heap != image graph
```

The purpose of this seam is to let real language runtimes participate without making their process or heap model part of generic image semantics.
