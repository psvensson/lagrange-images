# ADR 0021: foreign WASM callable interface

Status: accepted for the first executable foreign-WASM boundary.

## Problem

The external toolchain path can now produce and reuse `wasm-binary/v1`, but a valid WASM binary is not enough information to invoke it safely through the image runtime.

The internal Lagrange WASM representation already has a specific meaning:

```text
wasm-module/v1 / wasm-function/v1
  -> lagrange-value-handle/v0
  -> known host imports/effects
```

Treating arbitrary external WASM as that representation would lie about its ABI, runtime state and authority.

We need a separate interface layer.

## Decision

Add an explicit callable CodeArtifact representation:

```text
wasm-callable-interface/v1
```

The durable shape is:

```text
Block
  -> wasm-callable-interface/v1
       dependency(role=implementation)
          -> wasm-binary/v1
```

The interface artifact contains invocation shape. The implementation dependency contains executable bytes.

They have separate identity.

## Why interface and implementation are separate

One binary may export several useful functions or support several later interface contracts.

```text
                    -> interface: add
wasm-binary/v1 -----+-> interface: compare
                    `-> interface: transform
```

Duplicating the WASM artifact for every callable would confuse executable packaging with callable identity.

The explicit dependency also keeps the graph edge visible to reachability/history instead of hiding implementation identity in metadata.

## First ABI

The first ABI is:

```text
wasm-scalar-call/v0
```

Interface content is a small text/JSON descriptor:

```json
{
  "abi": "wasm-scalar-call/v0",
  "export": "add",
  "parameters": ["i32", "i32"],
  "result": "i32"
}
```

Supported scalar types are:

```text
boolean
i32
i64
f32
f64
```

The ABI intentionally supports exactly one result Value.

## Activation contract

`wasm-scalar-call/v0` is a free synchronous function boundary:

```text
receiver = null
environment = null
argument count = declared parameter count
```

A receiver or lexical environment fails explicitly.

This keeps the first foreign boundary independent of Smalltalk method semantics and closure state.

## Value mapping

Image Values remain canonical at the boundary.

```text
boolean Value -> i32 0/1 -> boolean Value
integer Value -> signed i32/i64 -> integer Value
float64 Value -> f32/f64 -> float64 Value
```

`i32` and `i64` inputs are range-checked before guest execution.

`f32` inputs are explicitly rounded to f32 before invocation; returned f32 values become canonical float64 Values because float64 is the image's durable floating scalar representation.

No implicit integer/float coercion is performed.

## No host imports in v0

A module used through `wasm-scalar-call/v0` must have zero WebAssembly imports.

This is a deliberate authority boundary.

The first ABI cannot silently acquire:

```text
WASI
filesystem
network
clock/random host APIs
image callbacks
ctx.call
other host capabilities
```

Those require a later explicit ABI/interface contract plus capability policy.

## Instance lifetime

The immutable `wasm-binary/v1` is compiled to a host `WebAssembly.Module` once per runtime and cached by artifact identity.

Each activation then creates a fresh `WebAssembly.Instance`.

```text
wasm-binary/v1
   -> runtime-local compiled module cache
   -> fresh instance per activation
```

This is conservative by design. Foreign modules may contain memory, mutable globals, tables, start behavior or language-runtime state. They do not inherit the internal compiler's `stateless-v0` pooling promise.

A later foreign-WASM reset/reuse contract may permit instance pooling where a toolchain can prove it safe.

## Interface declarations are explicit, not inferred

The runtime does not attempt to reconstruct source-language semantics from the WASM binary.

The interface declares which export and scalar ABI the caller intends to use. The executor validates the interface record, argument Values, module import set and named exported function at the boundary.

Richer type/interface discovery belongs in a later Component/WIT-style contract rather than a home-grown WASM type reconstruction layer.

## Interface is not authority

A callable interface says how an implementation can be called.

It does not grant permission to call it.

```text
interface identity != capability
implementation ref != authority
```

Capability checks remain a separate runtime/security concern. The no-import scalar ABI simply has no host capability surface yet.

## Installation helper

`installWasmScalarCallable()` is the first convenience seam.

It:

1. validates the referenced artifact is `wasm-binary/v1`
2. persists a `wasm-callable-interface/v1` with one explicit `implementation` dependency
3. creates an environment-free Block whose code points to that interface

The resulting Block uses the normal InvocationService and ActivationExecutor path.

## Execution registry

`WASM_CALLABLE_INTERFACE_V1` is registered in the default `CodeExecutorRegistry`.

This keeps the common activation path:

```text
Block
  -> CodeArtifact representation
  -> registered executor
  -> canonical Value result
```

There is no second foreign invocation subsystem.

## Raw WASM remains raw WASM

The new callable path does not change the meaning of:

```text
wasm-binary/v1
```

It still means external/foreign WASM bytes.

Likewise:

```text
wasm-module/v1
```

still means the internal Lagrange Value-handle/effect ABI.

The interface layer bridges the former into common activation without relabeling it as the latter.

## Current limitations

Not implemented in this ABI:

- strings or bytes through guest memory
- arrays/records
- multiple results
- imported host functions
- WASI
- callbacks
- asynchronous effects
- capability-bearing host calls
- Component Model/WIT interfaces
- foreign instance pooling/reset contracts
- automatic interface generation from Cargo/toolchain metadata

## Consequence

The external-language path now reaches ordinary image activation without pretending that foreign code is image-native code:

```text
source/package graph
  -> existing external toolchain
  -> wasm-binary/v1
  -> explicit wasm-callable-interface/v1
  -> Block
  -> normal activation/execution
```

This gives richer foreign/component interfaces a clean place to evolve while preserving the existing image and Lagrange WASM contracts.
