# ADR 0034: rich callable component interface

Status: implemented — the first implementation-independent callable contract, proven through a real Rust WASM Component and a live Cuis image.
Proven by: test/two-lane-normalize-proof.test.js, test/two-lane-callable-real.test.js, test/callable-value-fidelity.test.js, test/callable-architecture-invariants.test.js

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
callable-interface/v1          <- one artifact, no implementation, no dependencies
    WIT type language
       /            \
      /              \
wasm-component-       foreign-runtime-
  binding/v1            binding/v1      <- implementation bindings
      |                     |
Component canonical    Cuis stdio v1
     ABI                (transport)
      |                     |
   Rust/WASM            live Cuis image
```

Canonical Values remain the universal image-side boundary. The callable interface is the
implementation-independent description, expressed in WIT's type language. Below it, each
lane brings its own mechanism: the Component canonical ABI for WASM, a versioned stdio
protocol for Cuis. Crucially the transport sits *below* the interface and never leaks
upward — `ForeignRuntimeService` exchanges canonical Values, and the `i:`/`e:`/`d:`
encoding exists only between the provider and the VM.

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

### First rich interface: an implementation-independent callable contract

The central decision of this ADR is not "add strings to WASM". It is to settle the
abstraction that lets Rust/WASM, Cuis, and later Java or Lisp expose the same callable
interface without that interface belonging to any of them.

```text
callable-interface/v1
```

A `callable-interface/v1` artifact describes a callable shape and nothing else. It names
no WASM module, no foreign runtime, no provider and no capability, and it declares **no
dependencies at all** — implementations point at it, never the reverse. That direction is
what allows one interface artifact to be shared by any number of lanes.

Implementations attach through separate binding representations:

```text
                    callable-interface/v1
                        "normalize"
                     {parameters, result}
                      /              \
                     /                \
      wasm-component-binding/v1   foreign-runtime-binding/v1
        dependency(interface)       dependency(interface)
        dependency(implementation)  dependency(runtime-definition)
            -> wasm-component/v1        -> cuis-runtime-definition/v1
                 |                            |
               Block                        Block
```

A binding carries no signature of its own. Arity and types come from the interface it
depends on, so both lanes are type-checked by the same code against the same descriptor.
What a binding does carry is the part that is meaningless to any other lane: for the
Component lane, which Component binary; for the foreign-runtime lane, which runtime
definition and which runtime-specific operation address (`{service, operation}`).

This is deliberately better than giving each lane its own interface representation. Two
representations holding "essentially the same logical signature" drift, and in practice
they had already diverged: the existing `foreign-runtime-callable-interface/v1` carries
only an argument *count* and an opaque record, with no type information whatsoever, so
"the same interface through two lanes" could not have been more than a coincidence.

`foreign-runtime-callable-interface/v1` and `wasm-callable-interface/v1` are not migrated.
They remain valid historical contracts for the callables already installed through them.

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
`list<u8>` is supported as a parameter and as a result: bytes are a canonical Value, so
carrying them in only one direction would have been an arbitrary restriction.

### f32 means a float64 rounded to f32 precision

`f32` is the one type in the table whose meaning had to be decided rather than merely
transported, because the canonical Value model has only `float64`.

The rounding happens in the shared interface, on the way in and on the way out, not in
either lane. That is what makes the lanes agree by construction rather than by each
happening to round the same way — and it is why the Cuis lane, whose image has no f32
notion at all, can satisfy an `f32` interface by echoing a float64 that is already
f32-precise. A lane that rounds again performs a no-op.

The alternative — letting each lane round — was rejected because it makes the observable
result depend on which implementation answered, which is exactly what a shared interface
exists to prevent.

### Numeric and binary fidelity are proven, not assumed

Text alone would not have exercised the boundary. `reverse(list<u8>) -> list<u8>` cannot
succeed unless every byte value and its position survived, and `scale(f64, f64) -> f64`
uses IEEE 754 multiplication, which is exactly specified, so any disagreement between
lanes is a boundary defect rather than a rounding difference. The proofs cover empty and
2000-byte sequences, all 256 byte values, negative zero, subnormals, overflow to infinity
and NaN.

This immediately found a real defect: Cuis `ByteArray>>base64Encoded` wraps its output
with a newline every 72 characters, which silently truncated any payload over 54 bytes on
a line-framed protocol. The text-only proof could never have caught it.

This deliberately excludes refs, pinned-refs, arrays, records, multiple results, option, result and other WIT composite types. Those belong in a later ADR.

### The Component lane uses real Component tooling

The `wasm-component-binding/v1` executor performs no canonical ABI work. The proof
Component is built and run entirely with upstream tooling:

```text
wit/normalize.wit          the interface, in WIT
   |  wit-bindgen           generates the guest-side canonical ABI glue
   v
Rust cdylib -> core wasm
   |  wasm-tools component new
   v
normalize.component.wasm   a real Component
   |  jco transpile (canonical ABI lifting/lowering)
   v
callable from Node
```

Lagrange contributes Value translation on either side of that pipeline and nothing else.
There is no linear-memory code, no `realloc`, and no pointer/length convention anywhere in
this repository. Canonical ABI evolution stays upstream's responsibility.

Finding on tooling practicality, recorded because it was a real risk: `cargo-component` is
not required. `wit-bindgen` plus `wasm-tools component new` produces the Component from an
ordinary cargo build, and `jco` runs it from Node with no native dependency. The awkward
part is only that a Rust toolchain is needed to *build* the fixture, so the built
`.wasm` is committed and `fixtures/normalize-component/build.sh` regenerates it.

`jco` is an optional peer dependency. Without it, Component bindings still install and
still type-check; they simply cannot execute, and say so.

### Known asymmetry: the interface function name doubles as the Component export name

The Component binding resolves `descriptor.function` against the Component's exports,
while the foreign-runtime binding carries an explicit `target` record. So the interface's
function name is lane-neutral in principle but is load-bearing for the Component lane in
practice.

This is tolerable while a WIT function name and an interface name are the same thing, and
the `echo-f32` proof deliberately binds one interface to a Component export and to an
unrelated Cuis operation (`proof/echo`) to show the foreign lane is unaffected. If a
Component ever needs an export name that differs from its interface name, the fix is an
optional export override in the Component binding, matching how `target` works — not a
lane-specific field on the interface.

WIT identifiers are kebab-case and jco emits camelCase, so `echo-f32` resolves to
`echoF32`. That mapping lives in the jco adapter, because the interface must not know that
one of its lanes is JavaScript.

### Interface identity remains separate from implementation identity

One Component binary may support several callable interfaces:

```text
                        -> callable-interface/v1: normalize
wasm-component/v1 ------+-> callable-interface/v1: transform
                        `-> callable-interface/v1: validate
```

Each callable interface is its own artifact with its own identity. Several interfaces over
one Component means several interface artifacts and several bindings, all naming the same
implementation. Symmetrically, one interface may be bound to many implementations — which
is exactly what the two-lane proof does.

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
    float64             f:<16 hex digits, big-endian IEEE 754>
    text                e:<percent-encoded utf8-bytes>
    bytes               d:<canonical base64>
```

The encoding is versioned through the bridge protocol identifier. Text and bytes are delimiter-safe by construction rather than by length prefix: percent-encoding emits only unreserved ASCII plus `%`, and base64 emits only its own alphabet, so neither can produce the tab or newline that frame the protocol. This keeps the bridge a pure line protocol, so the Smalltalk side never has to count bytes across a stream boundary.

Text is carried through Cuis `UnicodeString`, not `String`. Cuis `String` holds only code points 0-255 and truncates anything above silently, which would corrupt canonical `text` Values at the boundary without any error.

The bridge exports a fixed, closed set of operations; there is no `eval`. Alongside the proof operations (`proof/add`, `proof/factorial`, `json/package-proof`) and `text/normalize`, v1 adds `proof/echo`, which decodes an argument and re-encodes it unchanged. `echo` exists so the integration suite can round-trip every canonical scalar through a real VM and prove both directions of the encoding, rather than leaving the float64/bytes branches as untested code.

The existing v0 encoding remains valid for integer/boolean values. v1 is a strict superset for the values already supported and adds the new types.

### Proof: same interface, two implementation lanes

The first proof uses a deliberately mundane interface:

```text
normalize(text) -> text
```

Two independent implementations only prove anything if they are held to the same written specification, so `normalize` is defined exactly: lowercase the input, replace every run of ASCII whitespace (code points 9-13 and 32) with a single space, and drop leading and trailing whitespace. Nothing else changes.

Two implementations share this interface shape:

1. **Rust Component implementation**: `fixtures/normalize-component`, a Rust function
   built with `wit-bindgen` and wrapped by `wasm-tools component new` into a real
   Component, executed through jco's canonical ABI lifting/lowering.

2. **Cuis implementation**: a Smalltalk method compiled into the Cuis image and exposed
   through the v1 stdio bridge as `text/normalize`.

Both are installed as callable Blocks against **the same interface artifact**:

```text
      callable-interface/v1 "normalize"   (one artifact, one identity)
             ^                    ^
             | interface          | interface
wasm-component-binding/v1   foreign-runtime-binding/v1
   | implementation             | runtime-definition
   v                            v
wasm-component/v1          cuis-runtime-definition/v1
   |                            |
 Block                        Block
```

The proof is not that two lanes agree on one example. It is that both bindings resolve to
the identical interface object, are type-checked by the same code against the same
descriptor, and are invoked by a caller holding nothing but two Block refs. The tests
assert all three, and additionally that a wrong arity or a bytes-instead-of-text argument
is rejected identically on both sides — because the rejection comes from the shared
interface, not from either lane.

Two levels of proof exist: `test/two-lane-normalize-proof.test.js` runs the real Component
against a scripted Cuis session and always runs; `test/two-lane-normalize-real.test.js`
runs the real Component against a live OpenSmalltalkVM and runs in the integration job.

This satisfies the roadmap goal: *map the same interface shape to at least two
implementation lanes*.

### What is explicitly deferred

The following belong in a later ADR after the first proof is established:

- `list<T>` for any `T` other than `u8`; `list<u8>` is proven in both directions
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
3. Add `callable-interface/v1` plus the `wasm-component-binding/v1` and
   `foreign-runtime-binding/v1` implementation bindings.
4. Prove one `normalize(text) -> text` interface through a real Rust Component and a live
   Cuis image, invoked as ordinary Blocks.
5. Add bytes and float64 through both lanes (binary and numeric fidelity, no structure).
6. Write a follow-up ADR for list/record/multiple-result types.

Steps 1-5 are done. Step 6 is the next decision, and it is a decision rather than an
implementation: it must answer how a WIT record or list relates to the image model and the
existing `Value[]` activation contract before any code exists.

## Guardrails

```text
canonical Value model unchanged
wasm-scalar-call/v0 frozen
callable-interface/v1 != wasm-scalar-call/v0
callable-interface/v1 declares no dependencies, ever
interface != implementation binding
one interface, many bindings, no lane in the interface
transport encoding != interface
Component canonical ABI != Lagrange memory protocol
Component tooling owns lifting/lowering, not Lagrange code
interface identity != implementation identity
callable interface != capability
text/bytes at boundary != ambient string conversion
Cuis bridge v1 != generic foreign eval
first proof types are deliberately narrow
list/record/multiple-result is a separate future ADR
```
