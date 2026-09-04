# Language platform

This document explains how several languages share one image substrate without pretending their semantics are the same. Detailed proof history belongs in the ADRs; [native-import.md](native-import.md) describes the current convergence path.

## 1. One substrate, many personalities

The platform supplies durable identity, artifacts, dependencies, Blocks/callables, compilation/toolchains, execution, authority boundaries and Projects.

A language personality owns what is language-specific:

```text
syntax / editing semantics
semantic objects
name / method / function lookup
exceptions / conditions
package/project conventions
compiler/runtime adapters
foreign-library conventions
```

The image backend does not learn Smalltalk selectors, Java classes, Cargo crates or Lisp packages.

## 2. Language personality does not mean compiler ownership

Three integration levels can coexist for one ecosystem.

### Image-native language

```text
language source
  -> language semantics
  -> common compiler/runtime substrate
```

Symmetric Smalltalk is here because its classes, objects, Blocks and execution semantics are native image structures.

### Existing compiler/toolchain -> image execution or import

```text
Rust / Java / Lisp / Smalltalk / ...
  -> existing compiler/toolchain
  -> semantic import input and/or WASM/component/bytecode/image/other artifact
  -> explicit native construction or callable interface
```

This is preferred when a mature ecosystem already owns package/compiler semantics.

### Foreign runtime

```text
image callable/interface
  -> ForeignRuntimeService
  -> live JVM/OpenSmalltalkVM/SBCL/native/etc. runtime
```

This maximizes compatibility but does not turn the foreign heap into durable image objects.

These levels are tools, not equal strategic destinations. ADR 0085 makes progressive native import the primary convergence path for existing application ecosystems when native object/storage semantics are the goal.

## 3. Artifact graph, not source-only pipeline

Source is one artifact kind rather than the platform boundary:

```text
source ------------------+
semantic IR -------------+
bytecode / JAR / image --+
manifest / lock ---------+
vendored package --------+--> compiler/toolchain/importer --> derived artifact or native semantics
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

Imported callable interfaces can also be referenced by Blocks where common activation is useful. Long-lived external runtimes are different: their process/VM instances are transient and addressed through `ForeignRuntimeService` runtime IDs rather than ObjectRefs.

```text
runtime definition != running instance
foreign runtime ID != ObjectRef
foreign runtime ID != capability
foreign heap != image graph
```

A foreign runtime may remain behind an explicit service boundary. It is not a transparent substitute for native object identity or persistence.

## 5. Progressive native import

For an existing application ecosystem, the preferred convergence shape is:

```text
existing application source/package graph
        |
        v
language-owned semantic extraction/import
        |
        v
existing native image owners
classes / Shapes / methods / Blocks / roots / Projects
        |
        v
lagrange-code / native execution artifacts
        |
        v
Lagrange objects + storage + history + placement
```

The importer owns translation. It does not own a second executable class model, object store, compiler runtime or persistence system.

Once a state domain is native-imported, the image graph is authoritative for that state. Do not transparently mirror mutable authoritative state between a foreign heap and Lagrange objects.

Unsupported native semantics are explicit failures or explicit foreign-service boundaries. There is no silent fallback to the original VM.

See ADR 0085 and [native-import.md](native-import.md).

## 6. Smalltalk: native substrate plus Cuis import/oracle

Smalltalk currently has two bodies of machinery with one convergence direction:

```text
                         Smalltalk
                            |
              +-------------+-------------+
              |                           |
              v                           v
      Symmetric Smalltalk          OpenSmalltalkVM/Cuis
      native image model           ecosystem/tooling/oracle
              |                           |
              +-------------+-------------+
                            |
                            v
                 progressive native import
                            |
                            v
                native Classes / objects /
                Blocks / Lagrange WASM
```

Symmetric Smalltalk owns the native semantics: parser/compiler policy, lexical capture, message lookup, Behavior/Class/Metaclass, Shapes/slots, method dictionaries, allocation, class state, collections and conditions.

OpenSmalltalkVM/Cuis supplies mature package/compiler semantics and a reference implementation. It does not own native Lagrange class/object identity.

## 7. Current Cuis compatibility/toolchain machinery

The compatibility/runtime path is real and remains supported:

```text
ForeignRuntimeService
  -> smalltalk/opensmalltalk-cuis
  -> headless OpenSmalltalkVM
  -> pinned/derived Cuis image
  -> narrow provider bridge
  -> canonical Lagrange Values
```

The bridge is explicitly allowlisted; it is not arbitrary remote `perform:` or source eval.

The real toolchain path is artifact-first:

```text
smalltalk/cuis-build-v1
  +-> base image
  +-> changes / sources
  `-> package artifacts
          |
          v
OpenSmalltalkVM + real Cuis package/compiler machinery
          |
          +-> derived image/changes
          `-> deterministic semantic export
```

The VM executable path is deployment state. Stable VM identity is provider identity material. Compiler-bearing base image and package/support files are explicit graph inputs.

Cuis snapshot bytes are not assumed reproducible; ADR 0083 records the measured negative result. The semantic export is deterministic.

## 8. Cuis semantic export -> native import

`smalltalk/cuis-semantic-export-v2` currently carries deterministic semantic information:

```text
packages / requirements
classes / inheritance / ordered local instance-variable declarations
methods / selectors / normalized source
```

It carries semantic identities, never Spur oops.

The existing second-stage `CuisExportPackage`/`CuisExportClass`/`CuisExportMethod` materialization is behaviorless representation for inspection/proof. It is not the executable destination.

ADR 0085 makes the next path explicit:

```text
semantic export
    |
    v
Cuis native-import adapter
    |
    +-> native class/Shape owners
    +-> native method/compiler owners
    +-> Project/artifact owners
    `-> native application roots/state
```

Frozen v1 remains readable for the existing inspection materializer. Extend v2 only when the next importer milestone requires more semantic facts. Do not broaden it into arbitrary heap export or flatten inherited/physical VM layout into declaration data.

### Role of OpenSmalltalkVM after import begins

OpenSmalltalkVM has three bounded roles:

- importer/toolchain for real Cuis ecosystem semantics;
- semantic oracle for differential compatibility proofs;
- explicit foreign-service escape hatch where a dependency deliberately remains foreign.

It is not an automatic fallback executor for failed native import.

## 9. Heap boundary

```text
Spur object memory != Lagrange image graph
Spur oop != durable ObjectRef
```

Native import is semantic import, not heap-pointer migration. If a deliberately foreign service later needs object-like handles, those handles require an explicit foreign-object contract and remain separate from native ObjectRefs.

## 10. Rust

Rust reuses Cargo and `rustc`:

```text
rust/cargo-manifest-v1
rust/cargo-lock-v1
rust/source-v1
optional explicit vendor config/files
        -> Cargo/rustc in digest-pinned OCI
        -> wasm-binary/v1 / Component artifacts
        -> explicit callable/binding interface
```

This is a mature existing-compiler -> portable executable path. It does not require Rust objects to become native image objects unless a future Rust-specific semantic import path has a concrete reason to do so.

## 11. Internal vs foreign WASM

### Internal Lagrange WASM

```text
lagrange-code/v0 | lagrange-code/v1
  -> wasm-module/v2 ---dependency(implementation)---> wasm-binary/v1
  -> wasm-function/v2 ---dependency(module)---> wasm-module/v2
```

This uses Lagrange Value-handle ABIs and known host effects. The semantic artifact remains independent of physical WASM ABI details.

### Foreign WASM / Components

```text
external toolchain/runtime port
  -> wasm-binary/v1 or wasm-component/v1
  -> explicit callable/component binding
```

Raw foreign WASM does not imply a Lagrange internal ABI. The referencing interface/binding makes it executable.

A future WASM-hosted language VM would still be a foreign-runtime implementation unless it deliberately implements native Lagrange language/object semantics.

## 12. Common Lisp

ADR 0084 proves real SBCL as an ordinary foreign runtime through unchanged generic source/definition/callable/Project/release contracts. That proof closes the current neutrality question.

Common Lisp native import is deliberately sequenced behind the Cuis forcing path. When it resumes, the Lisp personality owns genuinely Lisp semantics such as:

```text
reader / macroexpansion
packages / symbols / function namespace
CLOS / generic functions
dynamic bindings
multiple values
conditions / handlers / restarts
compiler integration
```

Do not pre-generalize the Cuis importer for Lisp. Reuse a common owner only after Lisp pressure proves that the concern is actually common.

## 13. Java and additional ecosystems

Java should reuse existing Java tooling when it becomes a concrete product pressure: JAR/class import, JVM/OCI compatibility or AOT/WASM are possible mechanisms.

Additional runtime spikes are not roadmap goals by themselves after ADR 0085. A new ecosystem should either advance a real application path or falsify a generic owner that the main path depends on.

## 14. Cross-language libraries and services

Portable executable libraries/services use explicit interfaces independent of implementation language:

```text
Smalltalk ---+
Rust --------+--> interface --> implementation/runtime
Java --------+
Lisp --------+
```

Interface identity is not authority. Capability checks remain separate.

Native-imported objects do not need a foreign interface to call other native image code; explicit interfaces remain the correct boundary for retained foreign/component implementations.

## 15. Current frontier

The main multilingual frontier is now the ordered Cuis native-import path:

1. import native classes/Shapes from unchanged Cuis package semantics;
2. compile/import methods into ordinary native Blocks/Lagrange WASM;
3. close Cuis base-library compatibility only under real application pressure;
4. establish native authoritative application roots/state and restart recovery;
5. import one real independently authored Cuis application without modifying its core source for Lagrange;
6. distribute that same application's objects through generic Lagrange placement/routing without language-level rewrites.

Foreign runtime/toolchain work continues only when it advances those milestones, serves as a semantic oracle, or implements an explicit retained foreign boundary.

See [native-import.md](native-import.md), [roadmap.md](roadmap.md), [architecture.md](architecture.md) and ADR 0085.
