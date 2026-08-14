# ADR 0024: OpenSmalltalkVM + Cuis runtime proof

Status: accepted for the first real foreign-runtime provider proof.

## Problem

ADR 0023 introduced a language-neutral long-lived runtime lifecycle:

```text
start -> many calls -> stop
```

That abstraction is only useful if it survives contact with a real image-based runtime without leaking that runtime's heap/process semantics into the generic image model.

OpenSmalltalkVM + Cuis is the first pressure test.

## Upstream proof pins

The first reproducible integration proof pins two independent upstream artifacts:

```text
OpenSmalltalkVM release
  tag: 202606270913
  asset: squeak.cog.spur_linux64x64.tar.gz
  sha256: dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba

Cuis-Smalltalk/Cuis-Smalltalk-Dev
  commit: 6bcee3f38ce037c9714b997ccd3b5b3ff62965c8
  image: CuisImage/Cuis7.9-8090.image
  git blob: 523dc5e74b5b550922b56ff2406415c19700ee8e
```

Provider identity is derived from explicit VM/image identities supplied by the caller. Local filesystem paths do not participate in stable provider identity.

The CI integration job downloads and verifies these exact artifacts before running the proof.

## Decision

Add a real provider:

```text
smalltalk/opensmalltalk-cuis
```

implemented by `createOpenSmalltalkCuisProvider()`.

It remains an ordinary consumer of `ForeignRuntimeService`:

```text
Lagrange Images
  -> ForeignRuntimeService
  -> OpenSmalltalk Cuis provider
  -> headless OpenSmalltalkVM process
  -> Cuis image
  -> explicitly exported Smalltalk service
```

The first placement mechanism is a local process. OCI/runtime placement remains a later provider/deployment concern; the generic lifecycle contract does not change.

## Headless launch

The provider writes a temporary bridge script and launches the configured VM without a shell. It follows the current Cuis Linux CI convention for null sound/display, then uses Cuis' script option:

```text
squeak
  -vm-sound-null
  -vm-display-null
  <Cuis.image>
  -s <bridge.st>
```

The VM path and image path are runtime installation details. Their stable upstream identities are separate constructor inputs.

The provider's opaque handle owns the child-process/line transport, temporary bridge workspace, request sequencing/serialization and termination state. None of this becomes durable image state or an ObjectRef.

## The bridge is deliberately not remote Smalltalk eval

The first bridge protocol is `lagrange-cuis-stdio/v0`, line-framed over VM stdin/stdout.

The bridge source creates and compiles a real Cuis class at runtime:

```text
LagrangeProofService
  add:to:
  factorial:
```

The exported provider interface is deliberately whitelisted:

```text
service = proof
operation = add | factorial
```

There is no generic `perform:`, source evaluation, arbitrary selector send or oop/object lookup in v0. The proof demonstrates the real compiler/object model/runtime without creating an ambient code-execution endpoint.

## Wire Values

The first bridge transports only a subset of canonical Values:

```text
integer  -> i:<decimal>
boolean  -> b:0 | b:1
```

The provider converts wire results back into canonical Lagrange Values. Refs, strings, bytes, floats, arrays/records and foreign-object handles are intentionally absent.

## Persistent runtime

One provider `start()` launches one VM and waits for `READY <bridge protocol>`. Several `call()` operations then use the same running Cuis image and service object. Calls are serialized by this provider's stdio transport even though the generic service does not prescribe serialization.

`stop()` asks the bridge to quit cleanly using `Smalltalk quitPrimitive: 0` and waits for VM exit. If graceful shutdown fails, it attempts forced termination before deleting the temporary bridge workspace.

The running Cuis heap persists across calls but remains foreign runtime state:

```text
persistent foreign heap != durable Lagrange image graph
```

## Real CI proof

Normal unit tests inject a fake line runner and test process arguments/bridge materialization, stable provider identity, interface whitelisting, Value encoding, calls/shutdown and the Node line transport itself.

A separate PR-only GitHub Actions job runs the real integration:

```text
verified OpenSmalltalkVM archive
  + verified Cuis image
  -> real headless VM
  -> Cuis compiles LagrangeProofService
  -> add 12 30 == 42
  -> factorial 8 == 40320
  -> clean shutdown
```

A green repository PR therefore proves more than mock protocol compatibility.

## Why Cog/Spur here

The first native compatibility proof uses the current Linux x64 Cog/Spur runtime because the goal is compatibility with a real current Cuis image. ADR 0022 still prefers an interpreter-style VM for a future OpenSmalltalk-to-WASM port; these are separate milestones.

## What remains out of scope

This proof does not yet add durable Smalltalk runtime/image artifacts inside an image, OCI runtime placement, restart/reconciliation, arbitrary foreign-object handles, generic Smalltalk message sending, callbacks into Lagrange, capabilities, snapshot import/export, an existing Cuis package proof beyond the bridge class, the OpenSmalltalk toolchain role, structured class/method export or a WASM-hosted OpenSmalltalk runtime.

## Guardrails

```text
OpenSmalltalk process != image object
Cuis heap != Lagrange image graph
Spur oop != ObjectRef
stdio request ID != durable identity
provider handle != capability
exported interface != arbitrary perform:
local process placement != runtime semantics
current Cog proof != future WASM VM strategy
```

## Consequence

The foreign-runtime abstraction now has a real intended consumer. If this proof remains green, the next useful Smalltalk work should move upward into a real existing Cuis package and/or the OpenSmalltalkVM/Cuis toolchain role, rather than adding more generic runtime machinery first.
