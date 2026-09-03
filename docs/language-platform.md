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

The compatibility path reuses the mature runtime/compiler/package ecosystem rather than first reproducing Cuis/OpenSmalltalkVM semantics inside Lagrange Images.

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

## 7. OpenSmalltalkVM compatibility and tooling

The compatibility runtime now proves a real VM/image and real upstream package code:

```text
ForeignRuntimeService
  -> smalltalk/opensmalltalk-cuis
  -> headless OpenSmalltalkVM
  -> pinned Cuis 7.9 image
  -> fixed provider bridge
  -> explicit upstream .pck.st packages
  -> real package code
  -> canonical Lagrange Values
```

`createOpenSmalltalkCuisProvider()` uses explicit VM/image identities separate from local installation paths. PR-only integration pins the OpenSmalltalkVM release by SHA-256, the Cuis image by repository commit + Git blob identity, and package fixtures by immutable package identity/blob.

### Service boundary

The bridge remains intentionally tiny:

```text
lagrange-cuis-stdio/v1

proof/add
proof/factorial
json/package-proof
cluster/package-proof
```

The bridge is compiled in the pristine image before guest packages are loaded. It then keeps one service object alive while several calls arrive over stdin/stdout.

V1 transports canonical boolean, integer, float64, text and bytes Values. The additional value kinds
do not widen the service namespace: every operation remains explicitly allowlisted.

There is deliberately no:

```text
arbitrary perform:
source eval
Spur oop lookup
ambient image callback
capability hidden in a runtime handle
```

This proves the real VM/compiler/object model/package ecosystem and persistent runtime lifecycle without defining a generic remote Smalltalk protocol.

### Runtime package loading

Runtime start may include explicit package inputs:

```text
host path
  + immutable package identity
  -> private provider workspace
  -> validated original .pck.st basename
  -> CodePackageFile installPackage:
```

The real package proof established that these concepts must remain distinct:

```text
host path != guest package basename
package basename != package identity
package identity != provider identity
```

Host directory paths remain transient. The safe package basename is preserved because Cuis package tooling treats the package filename as meaningful. Runtime metadata records immutable identity plus the guest-visible basename.

Provider-owned bridge/control-plane code is established before guest packages are installed. This avoids making provider bootstrap dependent on application package side effects.

### Existing package proof

The first unchanged package is Cuis' upstream `JSON.pck.st`. It is installed with Cuis' own `CodePackageFile` machinery. The package-backed proof then uses the real `Json` class to:

```text
parse nested JSON
  -> render
  -> parse rendered JSON
  -> validate arrays/dictionaries/boolean/string content
  -> canonical true
```

Normal bridge calls are exercised before and after the package call, proving that package installation participates in the same persistent managed runtime rather than replacing its lifecycle.

### Multi-package dependency proof

The next package-depth step is also complete. A real upstream six-package cluster exercises this
dependency graph:

```text
ExtendedClipboard -> FFI + Graphics-Files-Additional
FFI               -> WeakDictionaries + Alien-Core
Alien-Core        -> WeakDictionaries
Graphics-Files-Additional -> Compression
```

The package artifacts are deliberately declared in anti-dependency order. Cuis resolves their own
`!requires:` relationships, and a fresh runtime built entirely from the resulting artifact graph
performs real Compression and WeakDictionaries behavior without runtime package injection. A
separate build names a provably absent requirement and must fail with the guest's explicit
diagnostic, so success cannot mean merely saving a broken image.

### Real Smalltalk toolchain

The same mature environment now also implements a real `ToolchainService` provider:

```text
smalltalk/cuis-build-v1
  +-> smalltalk/cuis-image-v1
  +-> smalltalk/cuis-changes-v1
  +-> smalltalk/cuis-sources-v1
  `-> smalltalk/cuis-package-v1 ...
          |
          v
smalltalk/opensmalltalk-cuis-toolchain
          |
          v
OpenSmalltalkVM + real Cuis package/compiler machinery
          |
          +-> derived smalltalk/cuis-image-v1
          `-> derived smalltalk/cuis-changes-v1
```

The VM executable path is local deployment state; stable `vmIdentity` is provider identity material. The compiler-bearing base Cuis image is an explicit artifact input, so changing the Cuis compiler/environment changes the build graph rather than hiding behind the provider.

The base `.changes`/`.sources` files and every package are explicit graph inputs as well. Package dependency order on the build root is the install order for this first provider contract.

The derived image keeps the unchanged base sources artifact as an explicit dependency. Generic `ToolchainService` provenance records the whole build graph on both derived outputs.

The authoritative integration proof does not stop after saving bytes. It launches the derived image in a fresh OpenSmalltalkVM runtime **without passing JSON as a runtime package**, then requires `json/package-proof` to succeed. So package compilation/loading is genuinely captured in the toolchain-produced image.

The toolchain provider does not implement `cacheKey()` yet. Closed inputs are established, but Cuis snapshot byte determinism has not. Reuse will be enabled only after reproducible snapshot bytes or a safe normalization contract are demonstrated.

### Structured semantic export

The same environment now exports structured semantic information as a deterministic
`smalltalk/cuis-semantic-export-v1` artifact:

```text
packages / requirements
classes / inheritance
methods / selectors / normalized source
```

The export uses semantic package-scoped identities and is byte-identical across equivalent builds.
It carries no Spur oop or raw heap identity. A second stage translates the manifest into ordinary
image objects representing Cuis packages/classes/methods through one authorized atomic creation
batch. Those representation objects do not become native Symmetric Smalltalk classes.

Bytecodes, literals, class comments, instance-variable definitions, live editing and repeat-import
reconciliation remain later pressure. Package work should now be driven by broader ecosystem inputs,
package-specific support files or a concrete service/interface need rather than another proof of the
already-established dependency DAG.

### Heap boundary

```text
Spur object memory != Lagrange image graph
Spur oop != durable ObjectRef
```

If arbitrary runtime objects later need stable cross-boundary identities, explicit foreign-object handles must mediate them. Prefer explicitly exported services before making every object remotely addressable.

### Migration/bootstrap engine

The real Smalltalk environment can eventually export structured semantic information so compatible code remains runnable while selected parts become image-visible or natively compiled:

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

The current native proofs use Cog/Spur because compatibility with the current Cuis image is the goal. A native-code-generating JIT is not required for the later WASM proof.

See ADR 0022 for the end state, ADR 0023 for the generic lifecycle, ADR 0024 for the real Cuis runtime proof, ADR 0025 for the first unchanged upstream-package proof and ADR 0026 for the real Cuis toolchain provider.

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
unchanged upstream Cuis package loading + execution
real Cuis ToolchainService build -> fresh runnable package-bearing image
real six-package Cuis dependency DAG -> fresh runtime cross-package behavior
deterministic Cuis Package/Class/Method export -> ordinary image objects
durable Project working state -> portable graph-backed release -> fresh target install
portable runtime closure -> deterministic source artifact -> public Environment adapter bindings
```

The next multilingual proofs should be concrete rather than generic:

- relate exported Cuis structures into mixed-language Projects and define repeat-import reconciliation;
- broaden Cuis ecosystem inputs or services only under concrete package/interface pressure;
- a mixed native/compatible Smalltalk project;
- richer Component/WIT-style interfaces;
- Java/JAR integration;
- Common Lisp compiler/runtime spike;
- capability-aware cross-runtime calls;
- distributed placement through Lagrange.

See [architecture.md](architecture.md), [roadmap.md](roadmap.md) and [decisions/README.md](decisions/README.md).
