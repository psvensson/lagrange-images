# ADR 0028: foreign-runtime callables as ordinary Blocks

Status: accepted for the first ordinary invocation path over durable foreign-runtime definitions.

## Problem

ADR 0027 made the definition of a foreign runtime durable without making a running runtime durable:

```text
runtime-definition artifact
        -> transient provider selection
        -> transient runtimeId
```

That closes the artifact/toolchain/runtime identity gap, but callers still need to start a runtime explicitly, keep its `runtimeId`, and call `ForeignRuntimeService` directly. That leaks lifecycle and implementation choice into code that should only know that it is invoking a callable service.

Foreign WASM already has the better shape:

```text
Block -> callable interface artifact -> implementation artifact
```

The same ordinary Block/ActivationExecutor path should work for services implemented by long-lived foreign runtimes.

## Decision

Add a language-neutral callable artifact:

```text
foreign-runtime-callable-interface/v1
```

with one explicit dependency role:

```text
Block
  -> foreign-runtime-callable-interface/v1
       dependency(runtime-definition)
          -> runtime-definition artifact
```

The first ABI is:

```text
foreign-runtime-value-call/v0
```

Its durable descriptor contains:

```json
{
  "abi": "foreign-runtime-value-call/v0",
  "argumentCount": 2,
  "interface": {
    "service": "example",
    "operation": "add"
  }
}
```

`interface` is frozen JSON-compatible plain data in v0. The arguments and result are still full canonical Lagrange Values carried by the existing `ForeignRuntimeService`; JSON is only the durable interface descriptor format.

The v0 callable accepts no receiver and no lexical environment. Those semantics must be introduced deliberately by a later interface contract rather than inferred from a provider.

## Provider selection remains transient

The callable artifact does **not** contain a provider ID.

A new runtime-local `ForeignRuntimeDefinitionBindingRegistry` maps a runtime-definition representation to the provider selection ID installed in this host runtime:

```text
smalltalk/cuis-runtime-definition-v1
        |
        | runtime-local binding
        v
smalltalk/opensmalltalk-cuis
```

This preserves the identity split from ADR 0027:

```text
callable interface       durable
runtime definition       durable
provider selection       transient deployment/runtime policy
provider handle          transient
runtimeId                transient
```

A future local-process, OCI or distributed provider can therefore execute the same durable runtime definition without rewriting the Block or callable artifact. More sophisticated placement can replace the simple representation binding with a richer resolver later.

## Lazy runtime instance reuse

`ForeignRuntimeDefinitionInstanceCache` is runtime-local. It is keyed by:

```text
provider selection ID + runtime-definition artifact identity
```

The first activation of a callable lazily starts the definition through `ForeignRuntimeDefinitionService`. Concurrent first activations coalesce on one in-flight start. Later activations reuse the same live runtime instance.

The cache does not own shutdown. `ForeignRuntimeService` remains the lifecycle owner and `runtime.close()` still stops all active foreign runtimes before backend shutdown. The cache is then cleared as transient host state.

A failed start is evicted so a later activation may make a fresh start attempt. A successful runtime call failure does not imply restart, retry or idempotency; those semantics remain explicit future work.

## Ordinary invocation path

The execution path is now:

```text
invokeBlock(Block)
        |
        v
ActivationExecutor
        |
        v
foreign-runtime-callable-interface/v1 executor
        |
        +-> resolve runtime-definition dependency
        +-> resolve transient provider binding
        +-> lazy start/reuse runtime instance
        `-> ForeignRuntimeService.call(canonical Values)
```

The caller does not receive or retain a `runtimeId`.

`installForeignRuntimeCallable()` creates the interface artifact and ordinary environment-free Block together, analogous to the existing foreign-WASM installer.

## Real Cuis proof

The authoritative integration path becomes:

```text
Cuis base artifacts + upstream JSON package
        |
        v
real Cuis ToolchainService build
        |
        v
derived Cuis image artifact containing JSON
        |
        v
smalltalk/cuis-runtime-definition-v1
        |
        v
foreign-runtime-callable-interface/v1
        |
        v
ordinary Block invocation
        |
        v
lazy artifact-backed OpenSmalltalkVM/Cuis runtime
        |
        v
JSON package executes
```

The runtime definition still contains no JSON package startup dependency in this proof. The package is present because the toolchain captured it in the derived image.

Two invocations of the same Block reuse one transient Cuis runtime instance.

## Guardrails

```text
callable interface != provider selection
runtime definition != running instance
provider binding != durable artifact data
runtimeId != caller-visible callable identity
runtime instance cache != durable state
runtime instance cache != restart policy
Block invocation != automatic RPC policy
interface descriptor != capability
reference != authority
foreign heap != image graph
```

## Not included yet

This first callable ABI does not define:

- receivers or lexical-environment semantics;
- capabilities/principal context;
- restart/reconciliation/retry/idempotency policy;
- remote/OCI/distributed placement;
- richer result/interface schemas;
- foreign object handles;
- snapshot writeback;
- generic service discovery;
- arbitrary Smalltalk `perform:` or eval.

## Consequence

Foreign runtimes have crossed the same execution boundary already crossed by image-native and foreign-WASM code: their implementation can now sit behind an ordinary durable Block.

The next useful pressure test is a mixed project in which image-native Symmetric Smalltalk calls both a foreign-runtime-backed Smalltalk service and a Rust/foreign-WASM service through ordinary Blocks without implementation-specific invocation code.
