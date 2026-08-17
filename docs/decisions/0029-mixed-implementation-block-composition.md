# ADR 0029: mixed implementation Block composition

Status: implemented — the first mixed-language execution proof.
Proven by: test/mixed-language-execution.test.js

## Problem

The image model now has several ways to implement an ordinary `Block`:

```text
image-native semantic code
foreign WASM callable interface
foreign runtime callable interface
```

PR 31 made a durable foreign-runtime service callable through `Block` / `ActivationExecutor`, but the implementations had not yet been composed from one language program.

A real composition test exposes one remaining mismatch. Direct `invokeBlock()` activations have `receiver = null`, while Symmetric Smalltalk invokes a Block with `value`, `value:`, `value:value:`, etc. That language-level send resolves to the same Block but naturally carries the Block ref as the message receiver.

The foreign-WASM and foreign-runtime callable executors rejected every non-null receiver, so they were ordinary Blocks only from the host API, not yet from another language personality.

## Decision

Define one small language-neutral Block-application rule:

```text
direct application:
  activation.receiver == null

language-level Block application:
  activation.receiver == activation.block
```

Callable executors may accept either form. They must still reject any other receiver.

This is implemented by `assertBlockApplicationReceiver()` and used by both:

```text
wasm-scalar-call/v0
foreign-runtime-value-call/v0
```

The change does **not** add general receiver semantics to either ABI. It only recognizes the Block itself as the syntactic receiver of a language-level Block application.

Lexical environments remain disallowed for these foreign callable artifacts in v0.

## Mixed program proof

The proof intentionally has no mixed-language coordinator API. Symmetric Smalltalk sees two captured Values, both ordinary Block refs:

```text
rust -> foreign WASM Block
cuis -> foreign runtime Block
```

The source is:

```smalltalk
[ :x | cuis value: (rust value: x value: x) value: x ]
```

For `x = 14`:

```text
Symmetric Smalltalk
    |
    +-> rust value: 14 value: 14
    |      -> foreign WASM add
    |      -> 28
    |
    `-> cuis value: 28 value: 14
           -> artifact-backed OpenSmalltalkVM/Cuis
           -> proof/add
           -> 42
```

The Smalltalk program contains no provider ID, runtime ID, WASM export name, VM path or runtime protocol.

## Rust/Cargo side

The normal mixed test starts from explicit Rust/Cargo artifacts and runs them through the existing Cargo/rustc OCI provider contract. Its injected deterministic test runner writes the known tiny `add(i32, i32)` WASM fixture, so the test proves the artifact/toolchain/provenance/callable path without claiming that CI ran a real OCI Rust compiler.

```text
Rust source + Cargo manifest + Cargo.lock
        -> ToolchainService
        -> Cargo provider contract
        -> wasm-binary/v1 (languageId = rust)
        -> wasm-callable-interface/v1
        -> Block
```

The separate real pinned-OCI Cargo integration job remains roadmap work.

## Cuis side

The unit proof uses the real artifact-backed Cuis provider with an injected process runner. The PR-only integration proof uses the actual pinned OpenSmalltalkVM/Cuis environment and the toolchain-produced image from ADR 0026/0027.

The real proof still verifies that the JSON package is already present in the derived image without reinstalling it, then adds a `proof/add` callable from the same runtime definition for the mixed Smalltalk program.

```text
base Cuis + JSON package artifacts
        -> real Cuis toolchain
        -> derived Cuis image
        -> durable runtime definition
        -> foreign runtime callable Block
```

The mixed call reuses the same transient Cuis runtime instance already owned by the runtime-local definition cache.

## Symmetric Smalltalk execution lane

The orchestrating Smalltalk is image-native semantic Smalltalk and uses the ordinary language dispatch/Block model. In this proof it executes through `neutral-expression/v0`.

That distinction matters. The Lagrange-WASM backend currently supports tail sends/effects, but the mixed expression contains a nested send whose result becomes an argument to another send. General non-tail async effects/continuations remain separate work; this PR does not hide that limitation behind a special mixed-language opcode.

## Guardrails

```text
Block self-receiver != arbitrary method receiver
Block application != general foreign object dispatch
foreign callable interface != provider identity
provider binding != durable program identity
runtime definition != running runtime instance
mixed program != mixed-language coordinator API
Rust artifact provenance != claim of real rustc execution in this test
image-native Smalltalk semantics != claim of Lagrange-WASM non-tail effects
```

## Consequence

The implementation choice is now below the language-level Block boundary for a concrete mixed program:

```text
Symmetric Smalltalk source
        |
        v
ordinary Block sends + Values
        |
        +-> foreign WASM
        `-> live foreign runtime
```

This is the first end-to-end proof that a language personality can compose heterogeneous implementation lanes without implementation-specific calls.

Useful next pressure tests are richer shared value/component interfaces, a real pinned-OCI Cargo integration proof, and eventually the non-tail continuation/effect machinery needed for the same composition to run through image-native Lagrange WASM.
