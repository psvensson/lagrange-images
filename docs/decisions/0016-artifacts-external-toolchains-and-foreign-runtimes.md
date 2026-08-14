# ADR 0016: artifact graphs, external toolchains and foreign runtimes

Status: accepted as architectural direction. ADR 0017 implements the first artifact-dependency/toolchain-provider substrate; external process/container/runtime integration remains planned.

## Problem

The first executable language is Symmetric Smalltalk, so the first implementation naturally looked source-first:

```text
Smalltalk source
  -> syntax
  -> lagrange-code/v0
  -> interpreter / WASM
```

That is correct for a language we define, but it must not turn into a platform rule that every useful program or library must arrive as source or be compiled by a compiler implemented inside Lagrange Images.

Established ecosystems already have mature compilers, package managers, bytecode formats, binary libraries and runtimes. Reimplementing `rustc`, Cargo, `javac`, a JVM, or equivalent toolchains would be unnecessary and would make library compatibility much worse.

The image therefore needs a broader model for:

- source artifacts
- semantic/intermediate artifacts
- bytecode and package archives
- precompiled libraries
- WASM modules/components
- build manifests and lock data
- toolchains that may execute outside the image process
- foreign runtimes that remain deliberately less integrated than an image-native language

## Decision

The durable programming model is an **artifact/dependency graph**, not a source-code-only graph.

Source is an important artifact representation, especially when it is the editable meaning we possess, but it is not required for every dependency or executable participant.

Conceptually:

```text
                 durable artifact graph

source -------------------+
semantic/IR --------------+
bytecode/package ----------+
precompiled library -------+----> toolchain
WASM component/module -----+          |
manifest/lock/config ------+          v
                                  derived executable
                                  artifacts/interfaces
```

Artifact representations are owned by language/tooling plugins or conventions rather than hard-coded into generic image objects. Possible representations include:

```text
symmetric-smalltalk/source-v0
java/source-v1
java/class-v1
java/jar-v1
rust/source-v1
rust/crate-manifest-v1
wasm-module/v1
wasm-component/v1
native-static-library/...
native-shared-library/...
oci-image-ref/v1
```

These names are illustrative except for representations already implemented.

ADR 0017 keeps `CodeArtifact` as the bootstrap generic artifact carrier and adds explicit role-tagged dependency refs plus a generic toolchain-provider service. A broader universal Artifact record remains deferred until real integrations prove it necessary.

## Source remains special when it is the meaning we own

If the image owns editable source, executable outputs remain rebuildable derived artifacts:

```text
source / semantic artifacts
        -> toolchain
        -> executable artifacts
```

Deleting a rebuildable executable cache must not destroy the only copy of program meaning.

That invariant does **not** imply that a third-party dependency distributed only as bytecode or binary must be reverse-engineered into source. The canonical artifact for such a dependency may legitimately be the binary package we actually possess.

Examples:

```text
editable Rust crate source -> canonical source + derived WASM
third-party Java JAR       -> canonical imported JAR dependency
third-party WASM component -> canonical component dependency
```

## Toolchains are providers, not necessarily in-process compilers

The compiler/tooling substrate now has a first generic provider contract under ADR 0017. `ToolchainService` resolves an explicit artifact dependency graph and invokes a selected `ToolchainProvider` using the `lagrange-toolchain-provider/v0` protocol.

A toolchain may eventually physically run as:

```text
in-process compiler
WASM compiler/tool
OCI build container
native process
remote build service
```

The generic provider contract cares about declared artifact inputs, target/options, stable toolchain identity, outputs, diagnostics and provenance rather than where the compiler physically executes.

The current repository proves that contract with an in-process provider only. OCI/native/remote providers are separate follow-ups.

This means future Rust support should normally use the existing Rust toolchain, and Java support should normally use existing Java/JVM/AOT/WASM tooling rather than new compilers written by this project.

For example:

```text
Rust source + Cargo metadata + dependency artifacts
        -> OCI/native rustc + Cargo toolchain
        -> WASM module/component + interface/debug metadata
```

and:

```text
Java source/JAR dependencies
        -> javac / AOT / Java-to-WASM toolchain
        -> bytecode or WASM execution artifacts
```

## OCI has two distinct roles

OCI as a **build/toolchain environment** and OCI as a **runtime compatibility environment** are separate concepts.

### OCI build/toolchain

```text
image artifacts
    -> compiler invocation in OCI
    -> derived WASM/native/bytecode artifacts
```

The container is build machinery. It does not become part of language/image identity after compilation.

This is expected to be a normal way to use mature toolchains reproducibly.

### OCI foreign runtime

```text
image callable/interface
    -> foreign-runtime adapter
    -> OCI JVM/native/Python/etc. runtime
```

Here the runtime remains active. This gives high ecosystem compatibility but weaker object/image integration. Objects inside a JVM heap or another foreign runtime are not automatically durable image objects merely because the runtime is attached to an image.

Both approaches are useful and may coexist for one language.

## Integration is a continuum

The platform should support several integration tiers rather than force one model:

```text
foreign OCI runtime
  high compatibility, lower image integration

existing language toolchain -> WASM/component
  high compatibility, high execution integration

image-native language personality/compiler
  deepest image semantics/tooling integration
```

A Java personality may therefore eventually support both:

- JVM/OCI execution for compatibility with existing applications/libraries
- deeper Java-to-WASM/image integration for code that benefits from it

Rust will usually favor the existing compiler -> WASM/component path because much of Rust's distinctive ownership semantics is compile-time state.

## Compiled libraries are first-class dependencies

Precompiled libraries should be reusable when their format/runtime/ABI permits it.

The image should retain identity, history, provenance and dependency relationships without requiring source conversion.

ADR 0017 now provides the first explicit dependency edge:

```text
CodeArtifact.dependencies[]
  role
  artifact ref
```

`dependencies` is intentionally separate from `derivedFrom` provenance.

Examples:

### Java

JAR/class artifacts are natural reusable dependencies:

```text
Java project
  -> source artifacts
  -> dependency: jackson.jar
  -> dependency: customer-core.jar
  -> Java toolchain
```

The JARs can remain byte artifacts in the graph.

### Rust

Prefer source crates or stable portable outputs as canonical dependencies. Rust compiler-specific intermediate libraries may be useful as build-cache artifacts but are generally tied to compiler/target/configuration details and should not be assumed stable language-level library formats.

Portable WASM components or explicitly stable native/C ABIs can be reused according to their declared contracts.

### WASM components

A WASM Component-style interface is an especially useful language-neutral library boundary:

```text
Smalltalk caller ---+
Rust caller --------+--> geometry component
Java caller --------+
```

The implementation language can be irrelevant once the interface is stable.

The Component Model/WIT-style boundary is therefore better suited to foreign-library/service interfaces than to every internal Smalltalk message send.

## Dependency role is compiler/toolchain policy

A dependency may be consumed in different ways:

```text
static/link dependency
dynamic component dependency
foreign-runtime dependency
service dependency
build-only dependency
```

The artifact graph records role-tagged dependency edges and provenance. The relevant compiler/toolchain/runtime policy decides how a dependency participates in execution.

The generic graph deliberately does not define a closed enum of dependency roles.

Do not encode one linkage choice into generic image identity.

## Callable/interface boundary

Imported executable artifacts need an explicit interface description before the image can safely invoke them.

The eventual interface contract should describe enough information for routing, ABI selection, capability checks and tooling, for example:

```text
artifact/interface identity
exported callable names/IDs
argument/result representation
ABI/component contract
required host capabilities
runtime/toolchain kind
version/provenance
```

An interface description is not authority by itself. Existing reference/capability separation remains in force.

ADR 0017 permits a toolchain provider to emit an interface description as an ordinary named output artifact, but the callable/interface semantic contract itself remains future work.

## Provenance and cache consequence

External toolchains must participate in the same derivation principles as built-in compilers.

ADR 0017 already makes `ToolchainService` own output provenance: every resolved explicit toolchain input becomes a `derivedFrom` edge on every output. Providers cannot silently replace that with metadata-only provenance.

A reusable derived artifact should eventually be keyed by all inputs that can affect it, potentially including:

```text
toolchain identity/version
container image digest when OCI-backed
target/ABI
compiler/linker options
ordered source/binary dependency fingerprints
manifest/lock data
environment inputs explicitly declared as semantic
```

Toolchain result caching is not implemented yet.

## Multilingual consequence

A language personality no longer implies "Lagrange Images implements this language's compiler."

It may own any combination of:

- syntax/editing conventions
- semantic object conventions
- dispatch/runtime semantics
- project/package conventions
- adapters to an existing toolchain
- adapters to foreign runtime/library interfaces

This lets mature ecosystems remain themselves while sharing durable image identity, history, projects, capabilities, compilation groups, executable placement and tooling where useful.

## Current versus planned

Implemented now:

- generic CodeArtifacts and `derivedFrom` provenance
- explicit role-tagged CodeArtifact dependency refs
- dependency-aware graph walking and dependency target validation
- compiler/group-compiler registries
- compilation groups and compiler-declared derivation reuse
- generic `ToolchainProviderRegistry` / `ToolchainService`
- transitive explicit artifact-graph resolution for providers
- provider target/options, multi-output artifacts, transient diagnostics and automatic output provenance
- built-in Smalltalk -> semantic IR -> WASM path
- durable WASM module/function artifacts and runtime execution caches

Not implemented yet:

- OCI/native/remote toolchain execution providers
- external-toolchain derivation-key reuse
- Java/Rust toolchain adapters
- generic JAR/native/component importers
- callable WASM Component interface/import boundary
- OCI foreign-runtime adapter
- transactional toolchain multi-output installation/sibling output dependency edges

These belong on the roadmap before claiming broad Java/Rust/library compatibility.

## Guardrail

The platform should be described as:

> Lagrange Images stores a durable program/artifact graph and orchestrates toolchains that turn parts of that graph into executable artifacts.

not:

> Lagrange Images requires all programs and libraries as source and implements their compilers.
