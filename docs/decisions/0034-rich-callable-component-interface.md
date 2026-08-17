# ADR 0034: rich callable component interface

Status: accepted for the first WIT-backed structured callable boundary.

## Problem

The scalar callable proofs (`wasm-scalar-call/v0` and `foreign-runtime-value-call/v0`) have done their job. The mixed-language composition proof demonstrated that language personalities can invoke foreign WASM and live foreign runtimes through ordinary Blocks without implementation-specific calls.

But both boundaries are limited to scalar types. The Cuis bridge transports only integers and booleans. The WASM scalar ABI accepts only boolean/i32/i64/f32/f64. Text, bytes and richer structured data cannot cross any foreign boundary.

The roadmap identifies the next interface work as expanding useful data without turning the v0 scalar ABI into an ad-hoc memory protocol. The project has also established that a WASM Component/WIT-style boundary is better suited to foreign-library/service interfaces than home-grown type reconstruction (ADR 0016, ADR 0021).

The question is how to reach useful structured data exchange while preserving the project's central quality: the object/value model stays extremely small while richer language and tooling concepts sit above it.

## Decision

### Conceptual layering

The intended layering is:

```text
image semantics
    canonical Value
        |
        v
implementation-independent callable interface
        WIT
       /   \
      /     \
Component    foreign-runtime adapter
canonical     Cuis stdio v1
ABI
      \       /
       \     /
     language implementation
```

Canonical Values remain the universal image-side boundary. WIT is the implementation-independent interface description. The Component canonical ABI handles WASM-side lifting/lowering through existing tooling. The Cuis adapter handles Cuis-side encoding/decoding through a versioned stdio protocol. Both lanes share one durable callable interface shape.

### Canonical Value is unchanged

The canonical Value set remains:

```text
boolean | integer | float64 | text | bytes | ref | pinned-ref
```

No new Value kinds are introduced by this ADR. The richer type exchange happens at the callable interface boundary, not inside the image model.

### wasm-scalar-call/v0 remains frozen

The existing scalar ABI stays exactly as defined in ADR 0021. It continues to enforce:

- zero imports
- fresh instance per activation
- boolean/i32/i64/f32/f64 parameter and result types only
- no host capability surface

The new rich interface is a separate ABI, not an extension of the scalar ABI. Existing scalar callables are unaffected.

### First rich interface: WIT-backed callable

Add a WIT-backed callable interface representation alongside the existing scalar and foreign-runtime interfaces:

```text
wasm-wit-callable-interface/v1
```

The durable shape mirrors ADR 0021's interface/implementation separation:

```text
Block
  -> wasm-wit-callable-interface/v1
       dependency(role=implementation)
          -> wasm-component/v1
```

The interface artifact contains a WIT interface description. The implementation dependency points to a WASM Component binary. They have separate identity, exactly as scalar interface and wasm-binary/v1 already have separate identity.

### First proof types

The first proof supports exactly the canonical Value types that map cleanly to WIT core types:

```text
canonical Value         WIT type
    boolean             bool
    integer (signed)    s32
    integer (signed)    s64
    float64             f32
    float64             f64
    text                string
    bytes               list<u8>
```

Exactly one result value. No WASI or other imported capabilities in the first proof.

This deliberately excludes refs, pinned-refs, arrays, records, multiple results, option, result and other WIT composite types. Those belong in a later ADR.

### Component executor uses existing Component tooling

The executor for `wasm-wit-callable-interface/v1` uses existing WASM Component runtime tooling for canonical lifting and lowering rather than reconstructing the canonical ABI in Lagrange code.

The Component binary is compiled and instantiated through a Component-aware runtime. The runtime handles the canonical ABI: reading arguments from and writing results to the Component's canonical entry points. Lagrange code performs Value encoding before the Component call and Value decoding after, but does not implement the canonical ABI wire format itself.

This means:

- no home-grown WASM memory protocol
- no manual linear memory management in Lagrange code
- canonical ABI evolution is upstream's responsibility
- the Lagrange side stays focused on Value translation

### Interface identity remains separate from implementation identity

One Component binary may support several callable interfaces:

```text
                        -> interface: normalize
wasm-component/v1 ------+-> interface: transform
                        `-> interface: validate
```

The `wasm-wit-callable-interface/v1` artifact names one callable interface. Multiple interfaces over the same Component use multiple interface artifacts with separate identity, each depending on the same implementation.

### Cuis bridge upgrade to v1

The Cuis stdio bridge protocol is upgraded independently:

```text
lagrange-cuis-stdio/v0  (existing, integer/boolean only)
lagrange-cuis-stdio/v1  (new, text/bytes/float64 transport)
```

`ForeignRuntimeService` itself is unchanged. It already canonicalizes full Value arguments and results. The limitation is entirely inside the Cuis provider, where `encodeBridgeValue` and `decodeBridgeValue` currently handle only `i:` and `b:` tokens.

The v1 bridge adds transport for:

```text
canonical Value         v1 wire encoding
    boolean             b:0 / b:1
    integer             i:<decimal>
    float64             f:<hex-payload>
    text                t:<length>:<utf8-bytes>
    bytes               d:<length>:<base64>
```

The encoding is versioned through the bridge protocol identifier. The length-prefixed forms for text and bytes are delimiter-safe: the bridge reads exactly the declared byte count after the delimiter, avoiding ambiguity from tab or newline characters in content.

The existing v0 encoding remains valid for integer/boolean values. v1 is a strict superset for the values already supported and adds the new types.

### Proof: same interface, two implementation lanes

The first proof uses a deliberately mundane interface:

```text
normalize(text) -> text
```

Two implementations share this interface shape:

1. **Rust Component implementation**: a small Rust function compiled to a WASM Component through the existing Cargo/rustc OCI provider path. The Component exports a `normalize` function that lower/raises strings through the canonical ABI.

2. **Cuis implementation**: a Smalltalk method in the Cuis image exposed through the v1 stdio bridge as `text/normalize`.

Both are installed as callable Blocks through the same durable interface shape:

```text
Block
  -> callable interface artifact
       (interface description: text/normalize, one text parameter, one text result)
       dependency(role=implementation)
          -> wasm-component/v1  (Rust lane)
       -- or --
          -> runtime-definition artifact  (Cuis lane)
```

A Symmetric Smalltalk program calls both through ordinary Block sends without knowing which implementation lane is behind each Block. The test requires both lanes to produce the same result for the same input.

This directly satisfies the roadmap goal: *map the same interface shape to at least two implementation lanes*.

### What is explicitly deferred

The following belong in a later ADR after the first proof is established:

- `list<T>` (including `list<u8>` as a general parameter, not just return type)
- WIT records
- Multiple results
- `option<T>`, `result<T, E>` and other WIT composite types
- Mapping WIT composites to image objects/refs vs. a separate ephemeral interface-value layer
- Capability-aware imported host functions
- Async foreign callbacks/effects
- Reusable foreign instance/reset contracts

That later ADR must answer how a WIT record or list relates to the image model and the existing `Value[]` activation contract. It should not happen accidentally by adding `array` and `record` to `VALUE_KIND`.

## Consequence

The foreign interface boundary expands from scalars to structured data without changing the image Value model or the existing scalar ABI. The Component canonical ABI is the right abstraction for WASM-side lifting/lowering; Lagrange code stays focused on Value translation rather than memory protocol implementation.

The implementation order is:

1. Write this ADR.
2. Upgrade the Cuis bridge to v1 with text/bytes/float64 transport and real-VM round-trip tests.
3. Add the `wasm-wit-callable-interface/v1` executor using Component tooling.
4. Prove the same `text/normalize` interface through both Rust Component and Cuis lanes.
5. Write a follow-up ADR for list/record/multiple-result types.

## Guardrails

```text
canonical Value model unchanged
wasm-scalar-call/v0 frozen
wasm-wit-callable-interface != wasm-scalar-call/v0
wasm-wit-callable-interface != foreign-runtime-callable-interface/v1
Component canonical ABI != Lagrange memory protocol
Component tooling owns lifting/lowering, not Lagrange code
interface identity != implementation identity
callable interface != capability
text/bytes at boundary != ambient string conversion
Cuis bridge v1 != generic foreign eval
first proof types are deliberately narrow
list/record/multiple-result is a separate future ADR
```
