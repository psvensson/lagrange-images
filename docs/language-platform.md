# Language platform

This document explains how several languages can share one image substrate without pretending their semantics are the same.

## 1. One substrate, many personalities

The platform supplies durable identity, artifacts, dependencies, Blocks/callables, compilation/toolchains, execution and later capabilities/debugging.

A language personality owns what is actually language-specific:

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

There are three useful integration levels.

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
  -> explicit image callable interface or native install
```

This is the preferred route when an established compiler ecosystem already exists.

### Foreign runtime

```text
image callable/interface
  -> adapter
  -> live JVM/OpenSmalltalkVM/native/etc. runtime
```

This maximizes compatibility but gives weaker automatic image integration. Foreign heap objects do not automatically become durable image objects.

The three modes may coexist for one language.

## 3. Artifact graph, not source-only pipeline

Source is one artifact kind rather than the boundary of the platform.

```text
source ------------------+
semantic IR -------------+
bytecode / JAR / image --+
manifest / lock ---------+
vendored package --------+--> compiler/toolchain --> derived artifact
WASM/component ----------+
```

The generic carrier today is `CodeArtifact` with explicit `dependencies` and separate `derivedFrom` provenance.

Binary-only dependencies remain binary if that is what we possess. A JAR need not be decompiled. A WASM component need not become source. A compatible Smalltalk runtime image may legitimately remain an image artifact.

## 4. Blocks and callables

The durable closure substrate is:

```text
Block
  code -> CodeArtifact
  environment -> LexicalEnvironment | null
```

Smalltalk and Lisp closures map naturally to this. Java/Rust do not need every source-level function to become Smalltalk-shaped; imported callable interfaces can still be referenced by a Block when that is useful for common invocation.

Receiver remains an optional distinguished Value:

```text
Smalltalk instance method -> receiver = self
Java instance method      -> receiver = this
free/static function      -> receiver = null
```

The current foreign scalar-WASM ABI uses only the last form.

## 5. Smalltalk has two complementary paths

The long-term Smalltalk model is deliberately not one implementation:

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
                  shared image/project
                     infrastructure
```

The native path explores what Smalltalk looks like when Blocks, persistent identity, artifacts and Lagrange execution are designed together.

The compatibility path should reuse a real mature Smalltalk runtime/compiler rather than first reproducing all of Cuis/OpenSmalltalkVM semantics inside Lagrange Images.

These paths can share projects, source/package artifacts, interfaces, tools, history and eventually migration support without sharing one physical heap or VM.

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

Smalltalk owns parser, lexical capture and message lookup semantics. The common image/execution layers do not know what a selector or class is.

Nested Blocks capture stable lexical binding IDs. `self` crossing a Block boundary is a lexical capture.

This remains the image-native language experiment. It does not need to become byte-for-byte compatible with OpenSmalltalkVM in order for the platform to support existing Smalltalk code.

## 7. OpenSmalltalkVM compatibility direction

OpenSmalltalkVM should first be integrated through the same external-toolchain/foreign-runtime boundaries being developed for other mature ecosystems.

### Compatibility runtime

```text
image project/interface
  -> Smalltalk runtime adapter
  -> OpenSmalltalkVM
  -> Cuis/Squeak-style runtime image
```

This is the quickest route to real packages, primitives, compiler behavior and existing image semantics.

The runtime may initially be a live OCI-managed foreign runtime. Its heap stays foreign runtime state:

```text
Spur object memory != Lagrange image graph
Spur oop != durable ObjectRef
```

If arbitrary runtime objects later need stable cross-boundary identity, use explicit foreign-object handles resolved through the runtime adapter. Prefer explicitly exported Smalltalk services/interfaces before making every object remotely addressable.

### Existing Smalltalk toolchain

The same environment can be used as a real compiler/toolchain:

```text
Cuis source/package artifacts
  -> OpenSmalltalkVM + compiler image
  -> real Smalltalk compiler/tooling
  -> runnable image and/or structured compiled artifacts
```

This is analogous to using Cargo/rustc instead of writing a Rust compiler. Lagrange Images should orchestrate the compiler and preserve inputs/outputs/provenance rather than reimplement it as a prerequisite for compatibility.

### Migration/bootstrap engine

The real Smalltalk environment can later export structured semantic information:

```text
classes
methods / selectors
compiled methods / bytecodes
literals
package/source relationships
inheritance/runtime metadata
```

That gives a gradual migration path:

```text
foreign Cuis runtime
  -> foreign Cuis + native Lagrange services
  -> image-visible Cuis classes/methods/packages
  -> selected native compilation
  -> deeper native compatibility where useful
```

Compatibility does not imply mandatory migration. Code may remain on OpenSmalltalkVM indefinitely when that is the best engineering choice.

### Longer-term WASM-hosted runtime

A later target is a headless interpreter-style OpenSmalltalk/Spur runtime compiled to WebAssembly and hosted through the foreign/component-WASM layer:

```text
OpenSmalltalk interpreter + Spur runtime
  -> WebAssembly
  -> explicit runtime/component interface
  -> Lagrange placement/sandboxing
```

This is not required for the first compatibility proof. It depends on richer foreign interfaces for runtime initialization, image loading, memory/string transport, controlled callbacks, capabilities, snapshots and possibly async effects.

A native-code-generating/JIT VM should not be required for the first WASM-hosted proof.

See ADR 0022 for the complete end-state and guardrails.

## 8. Rust

Rust support reuses Cargo and `rustc`.

```text
rust/cargo-manifest-v1
rust/cargo-lock-v1
rust/source-v1
optional explicit vendor config/files
        -> Cargo/rustc in digest-pinned OCI
        -> wasm-binary/v1
```

The build stays closed-input: Cargo frozen, container network disabled, vendored package bytes explicit in the graph.

Repeated deterministic builds can reuse the existing toolchain output when provider identity, target/options and the complete explicit input graph are unchanged.

`wasm-binary/v1` is still just external WASM. It becomes callable only through an explicit interface.

## 9. First foreign-WASM callable contract

The durable shape is:

```text
Block
  -> wasm-callable-interface/v1
       dependency(role=implementation)
          -> wasm-binary/v1
```

The interface and implementation have separate identities. One binary can therefore expose multiple callables without duplicating the code artifact.

The first ABI is `wasm-scalar-call/v0`:

```text
export: one named function
parameters/result:
  boolean | i32 | i64 | f32 | f64
imports: none
receiver: none
lexical environment: none
instance: fresh per activation
```

This is intentionally a narrow proof.

It does **not** cover:

```text
strings / bytes through guest memory
records / arrays
multiple return values
WASI
host callbacks/imports
async operations
capabilities
component interfaces
```

Those need new explicit contracts.

The callable interface describes ABI shape. It grants no authority.

## 10. Internal vs foreign WASM

Do not blur these paths.

### Internal Lagrange WASM

```text
lagrange-code/v0
  -> wasm-module/v1
  -> wasm-function/v1
```

Uses `lagrange-value-handle/v0`, host imports/effects and the normal image semantics.

### Foreign WASM

```text
external toolchain/runtime port
  -> wasm-binary/v1
  -> wasm-callable-interface/v1 or later component/runtime interface
```

The foreign binary may have entirely different internal runtime conventions. The interface is the boundary.

A future WASM-hosted OpenSmalltalkVM belongs in this foreign/runtime lane unless it is deliberately recompiled to the native Lagrange ABI.

## 11. Java

Java should reuse existing Java tooling, not acquire a new compiler here.

Two likely paths:

```text
Java source + JARs
  -> existing Java AOT/WASM toolchain
  -> imported executable/interface artifacts
```

and:

```text
image interface
  -> JVM/OCI foreign-runtime adapter
```

JAR/class artifacts should remain reusable binary dependencies where appropriate.

A deeper Java personality may later model Java classes/methods/interfaces as image objects while still using external compilation/runtime machinery.

## 12. Common Lisp

Common Lisp can reuse durable identity, artifacts, lexical environments, projects and execution infrastructure without being forced through Smalltalk semantics.

A Lisp personality may own:

```text
reader / macroexpansion
function/generic-function semantics
dynamic bindings
multiple values
conditions/restarts
compiler integration
```

The common substrate should remain neutral enough that these are personality/runtime concerns rather than special cases in storage.

## 13. Cross-language libraries

A portable executable library should have an explicit interface independent of its implementation language.

The current scalar-WASM interface is the first small example. The longer-term boundary is likely to include WASM Component/WIT-style contracts for richer values and language-neutral library calls.

Conceptually:

```text
Smalltalk ---+
Rust --------+--> callable/component interface --> implementation artifact
Java --------+
Lisp --------+
```

Interface identity is not authority. Capability checks remain separate.

OpenSmalltalkVM-backed Smalltalk should use the same explicit interface/capability model when crossing into native image services or other runtimes.

## 14. Toolchain reuse and language semantics

Toolchain cache keys are mechanical build equivalence contracts, not language semantics.

A provider opts in explicitly. The key includes provider identity, target/options and complete build-relevant artifact snapshots. ToolchainService does not infer equivalence from class names, crate names, selectors or filenames.

The first cache is identity-sensitive so output provenance remains truthful. Cross-install content reuse needs an installation wrapper rather than deleting provenance distinctions.

OpenSmalltalkVM toolchain integration should follow the same rule: VM/compiler image/version, source/package inputs, target/runtime options and imported dependencies must be explicit cache/provenance material.

## 15. Current frontier

The substrate has now proved:

```text
image-native Smalltalk
external Rust/Cargo toolchain
explicit package dependencies
external toolchain caching
raw foreign WASM
first explicit foreign callable ABI
```

The next multilingual proofs should come from pressure on this shared model rather than from adding generic abstractions speculatively:

- OpenSmalltalkVM/Cuis compatibility runtime + toolchain spike
- richer Component/WIT-style foreign interfaces
- Java/JAR integration
- Common Lisp personality/compiler spike
- standard Cargo package importer
- capability-aware host/foreign calls
- distributed placement through Lagrange

The Smalltalk end state is intentionally a continuum: native Symmetric Smalltalk, real OpenSmalltalkVM compatibility, optional WASM-hosted compatibility runtime, and selective migration between them where it is useful.

See [architecture.md](architecture.md) for the layers, [roadmap.md](roadmap.md) for ordered work and [decisions/README.md](decisions/README.md) for detailed ADRs grouped by topic.
