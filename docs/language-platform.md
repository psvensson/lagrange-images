# Language platform

This document explains how several languages can share one image substrate without pretending their semantics are the same.

## 1. One substrate, many personalities

The platform supplies durable identity, artifacts, dependencies, Blocks/callables, compilation/toolchains, execution and later capabilities/debugging.

A language personality owns what is language-specific:

```text
syntax / editing
semantic objects
name / method / function lookup
exceptions / conditions
package/project conventions
compiler/runtime adapters
foreign-library conventions
```

The image backend should not learn Smalltalk selectors, Java classes, Cargo crates or Lisp packages.

## 2. Language personality does not mean compiler ownership

Three integration levels can coexist for one language.

### Image-native language

```text
language source
  -> language semantics
  -> common compiler/runtime substrate
```

Symmetric Smalltalk is here because the language itself is being designed in this repository.

### Existing compiler -> image execution

```text
Rust / Java / Lisp / Smalltalk / ...
  -> existing compiler/toolchain
  -> WASM/component/bytecode/image/other artifact
  -> explicit callable interface or native install
```

This is preferred when a mature compiler ecosystem already exists.

### Foreign runtime

```text
image callable/interface
  -> ForeignRuntimeService
  -> live JVM/OpenSmalltalkVM/native/etc. runtime
```

This maximizes compatibility but does not turn the foreign heap into durable image objects.

## 3. Artifact graph, not source-only pipeline

Source is one artifact kind rather than the platform boundary:

```text
source ------------------+
semantic IR -------------+
bytecode / JAR / image --+
manifest / lock ---------+
vendored package --------+--> compiler/toolchain --> derived artifact
WASM/component ----------+
```

`CodeArtifact.dependencies` and `derivedFrom` remain separate graph edges. Binary-only dependencies remain binary when that is the useful canonical form.

## 4. Blocks, callables and foreign runtimes

The native durable closure substrate is:

```text
Block
  code -> CodeArtifact
  environment -> LexicalEnvironment | null
```

Imported callable interfaces can also be referenced by Blocks where common activation is useful. Long-lived external runtimes are different: their process/VM instances are transient and are addressed through `ForeignRuntimeService` runtime IDs rather than ObjectRefs.

```text
runtime definition != running instance
foreign runtime ID != ObjectRef
foreign runtime ID != capability
```

## 5. Smalltalk has two complementary paths

```text
                         Smalltalk
                            |
              +-------------+-------------+
              |                           |
              v                           v
      Symmetric Smalltalk          Cuis/Squeak compatibility
      image-native model                  |
              |                           v
              |                    OpenSmalltalkVM
              |                           |
              +-------------+-------------+
                            |
                            v
                  shared project/artifact
                     infrastructure
```

The native path explores Smalltalk when Blocks, persistent identity, artifacts and Lagrange execution are designed together.

The compatibility path reuses the mature runtime/compiler rather than first reproducing Cuis/OpenSmalltalkVM semantics inside Lagrange Images.

These paths may share projects, source/package artifacts, interfaces, tools and history without sharing one physical heap or VM.

## 6. Symmetric Smalltalk

Current path:

```text
Smalltalk source
  -> Smalltalk syntax
  -> lagrange-code/v0
       |-> neutral-expression/v0
       `-> wasm-module/v1 / wasm-function/v1
  -> Block
```

Smalltalk owns parser, lexical capture and message lookup semantics. Nested Blocks capture stable lexical binding IDs; `self` crossing a Block boundary is a lexical capture.

This remains the image-native language experiment. It does not need to become byte-for-byte compatible with OpenSmalltalkVM.

## 7. OpenSmalltalkVM compatibility

The first compatibility-runtime proof is now implemented:

```text
ForeignRuntimeService
  -> smalltalk/opensmalltalk-cuis
  -> headless OpenSmalltalkVM
  -> real Cuis 7.9 image
  -> Cuis compiles LagrangeProofService
  -> explicit calls
  -> canonical Lagrange Values
```

`createOpenSmalltalkCuisProvider()` uses explicit VM/image identities separate from local installation paths. The current PR-only integration test pins an OpenSmalltalkVM release archive by SHA-256 and a Cuis image by repository commit + Git blob identity, then actually starts the VM.

### First service boundary

The first bridge is intentionally tiny:

```text
lagrange-cuis-stdio/v0

proof/add
proof/factorial
```

The bridge script asks the real Cuis compiler to create methods on `LagrangeProofService`, then keeps that object alive in the running image while several calls arrive over stdin/stdout.

Only integer and boolean Values are transported in v0.

There is deliberately no:

```text
arbitrary perform:
source eval
Spur oop lookup
ambient image callback
capability hidden in a runtime handle
```

This proves the real VM/compiler/object model and persistent runtime lifecycle without prematurely defining a generic remote Smalltalk protocol.

### Heap boundary

```text
Spur object memory != Lagrange image graph
Spur oop != durable ObjectRef
```

If arbitrary runtime objects later need stable cross-boundary identities, explicit foreign-object handles must mediate them. Prefer explicitly exported services before making every object remotely addressable.

### Existing Smalltalk toolchain

The same environment should next be used as a real compiler/toolchain host:

```text
Cuis source/package artifacts
  -> OpenSmalltalkVM + compiler image
  -> real Smalltalk compiler/tooling
  -> runnable image and/or structured compiled artifacts
```

This is analogous to using Cargo/rustc rather than writing a Rust compiler. VM/compiler-image version, package/source inputs and options must be explicit toolchain/provenance material.

### Existing-package proof

The runtime bridge is not yet evidence that arbitrary Cuis libraries work. The next compatibility test should load and exercise a useful existing Cuis package through the real runtime, without reimplementing that package in Lagrange Images.

That test should drive any needed package/runtime artifact conventions.

### Migration/bootstrap engine

Later, the real Smalltalk environment can export structured semantic information:

```text
classes / inheritance
methods / selectors
CompiledMethods / bytecodes / literals
package/source relationships
```

That supports gradual integration:

```text
foreign Cuis runtime
  -> foreign Cuis + native Lagrange services
  -> image-visible Cuis structures
  -> selected native compilation where useful
```

Compatibility never implies mandatory migration.

### Longer-term WASM-hosted runtime

A later target remains an interpreter-style OpenSmalltalk/Spur runtime compiled to WebAssembly:

```text
OpenSmalltalk interpreter + Spur runtime
  -> wasm-binary/v1
  -> explicit runtime/component interface
  -> Lagrange placement/sandboxing
```

The current native proof uses Cog/Spur because compatibility with the current Cuis image is the goal. A native-code-generating JIT is not required for the later WASM proof.

See ADR 0022 for the end state, ADR 0023 for the generic lifecycle and ADR 0024 for the real Cuis runtime proof.

## 8. Rust

Rust support reuses Cargo and `rustc`:

```text
rust/cargo-manifest-v1
rust/cargo-lock-v1
rust/source-v1
optional explicit vendor config/files
        -> Cargo/rustc in digest-pinned OCI
        -> wasm-binary/v1
```

Builds are closed-input and deterministic results can be reused when provider identity, target/options and the complete explicit graph are unchanged.

`wasm-binary/v1` remains external WASM until an explicit interface makes it callable.

## 9. Foreign-WASM callable contract

```text
Block
  -> wasm-callable-interface/v1
       dependency(implementation)
          -> wasm-binary/v1
```

The first ABI, `wasm-scalar-call/v0`, supports one synchronous no-import free function over boolean/i32/i64/f32/f64 parameters/result. It grants no authority.

Strings/bytes, records/arrays, multiple results, WASI, callbacks, async operations and capabilities require later explicit contracts.

## 10. Internal vs foreign WASM

### Internal Lagrange WASM

```text
lagrange-code/v0
  -> wasm-module/v1
  -> wasm-function/v1
```

Uses `lagrange-value-handle/v0` and known host effects.

### Foreign WASM

```text
external toolchain/runtime port
  -> wasm-binary/v1
  -> explicit callable/component/runtime interface
```

A future WASM-hosted OpenSmalltalkVM belongs in this lane unless deliberately compiled against a native Lagrange ABI.

## 11. Java

Java should reuse existing Java tooling. Likely paths are Java/JAR -> AOT/WASM artifacts and JVM/OCI as a foreign runtime. A deeper personality may later model Java semantic objects while retaining external compilation/runtime machinery.

## 12. Common Lisp

Common Lisp can reuse durable identity, artifacts, lexical environments, projects and execution infrastructure without Smalltalk semantics leaking into the substrate.

A Lisp personality may own reader/macroexpansion, functions/generic functions, dynamic bindings, multiple values, conditions/restarts and compiler integration.

## 13. Cross-language libraries and services

Portable executable libraries/services should have explicit interfaces independent of implementation language:

```text
Smalltalk ---+
Rust --------+--> interface --> implementation/runtime
Java --------+
Lisp --------+
```

Interface identity is not authority. Capability checks remain separate.

OpenSmalltalkVM-backed Smalltalk should use this same explicit interface/capability model when crossing into native image services or other runtimes.

## 14. Current frontier

The shared model has now been pressured by:

```text
image-native Symmetric Smalltalk
real Rust/Cargo external compiler
explicit package dependencies and build caching
raw + callable foreign WASM
language-neutral foreign-runtime lifecycle
real persistent OpenSmalltalkVM/Cuis runtime
```

The next multilingual proofs should be concrete rather than generic:

- an existing useful Cuis package on the real compatibility runtime;
- OpenSmalltalkVM/Cuis as a real ToolchainService compiler host;
- richer Component/WIT-style interfaces;
- Java/JAR integration;
- Common Lisp compiler/runtime spike;
- capability-aware cross-runtime calls;
- distributed placement through Lagrange.

See [architecture.md](architecture.md), [roadmap.md](roadmap.md) and [decisions/README.md](decisions/README.md).
