# Language platform

## One image substrate, multiple language personalities

The platform should not be one VM per language and should not be one compiler implementation per language. It provides a shared substrate for durable values, refs, objects, artifacts, dependencies, compilation/toolchains, execution, debugging and capabilities. A language personality maps its own semantics and ecosystem conventions onto that substrate.

Implemented now includes the language-neutral graph/Block model, single-artifact and group compiler registries, `lagrange-code/v0`, `neutral-expression/v0`, transient compilation groups, compiler-declared derivation reuse, the first Symmetric Smalltalk seed, and a real WASM backend with a Value-handle ABI, tail host effects, recursive Block-tree installation, multi-function shared modules, runtime-local compiled-module caching and explicit stateless instance reuse.

External toolchains, OCI-backed builds, imported JAR/component/native libraries and foreign-runtime adapters are architectural direction, not implemented capabilities yet.

## Symmetric Smalltalk first, not Smalltalk-only

The first language experiment is **Symmetric Smalltalk**: Smalltalk's object/message feel with Blocks pushed much further toward a universal executable/compositional form.

Smalltalk owns its parser, lexical rules and message lookup. Those choices are not image-, artifact-, compilation-group- or WASM-level contracts. Later Common Lisp, Java, Rust and other personalities may keep different semantic representations, grouping rules, ABIs, runtime-state models and external toolchains while reusing durable identity, history, projects, compilation infrastructure, activation/execution and WASM where useful.

A language personality does **not** imply that Lagrange Images implements that language's compiler.

It may own any combination of:

- syntax/editing conventions
- semantic object/runtime conventions
- dispatch rules
- project/package conventions
- adapters to an existing compiler/package manager
- adapters to precompiled libraries/components
- adapters to a foreign runtime

## Artifact graph, not source-only pipeline

The durable programming model should be understood as an **artifact/dependency graph**.

Source is important when it is editable meaning we own, but it is not the only valid durable input:

```text
source -------------------+
semantic / IR ------------+
bytecode / package -------+
precompiled library ------+----> toolchain/provider
WASM component/module ----+            |
manifest / lock / config -+            v
                                    derived artifacts
                                    + callable interfaces
```

Possible future artifact representations include, illustratively:

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

The generic image layer should not learn what a JAR, crate or shared library means. Those representations belong to language/tooling adapters.

### Source remains canonical when it is what we own

For editable code the durable chain is still:

```text
language source / semantic artifacts
  -> toolchain
  -> derived executable artifacts
```

For Symmetric Smalltalk today:

```text
Smalltalk source
  -> Smalltalk syntax
  -> lagrange-code/v0
       |-> neutral-expression/v0
       `-> wasm-module/v1 + wasm-function/v1
```

Executable artifacts remain rebuildable state when the source/semantic meaning exists in the image.

But this does **not** mean a binary-only third-party dependency must be reconstructed as source. If what we possess is a JAR or WASM component, that imported artifact can be the canonical dependency artifact.

Examples:

```text
editable Rust crate source -> canonical source + derived WASM
third-party Java JAR       -> canonical imported JAR dependency
third-party WASM component -> canonical imported component
```

`lagrange-code/v0` remains an early shared semantic IR, not a requirement that Java, Rust or Lisp express all of their semantics as Smalltalk-like sends/Blocks.

## External toolchains

The current registries model compilers in-process, but the architectural contract should generalize to a **toolchain/provider** that consumes explicit artifact inputs/options and produces derived artifacts, interfaces, diagnostics and provenance.

The physical toolchain may run as:

```text
in-process compiler
WASM tool
OCI build container
native process
remote build service
```

The platform should care about declared inputs/outputs, compiler/toolchain identity, deterministic cache inputs and provenance—not where the compiler process happens to live.

### Rust

Rust support should normally reuse Cargo and `rustc`, not implement another Rust compiler.

Conceptually:

```text
Rust source artifacts
Cargo manifest / lock artifacts
dependency artifacts
        -> Cargo/rustc toolchain
        -> WASM module/component + interface/debug metadata
```

The toolchain might be an OCI image for reproducibility or a native trusted compiler installation. Lagrange-specific APIs can be supplied as an SDK/crate rather than by changing the Rust compiler.

Rust compiler-private intermediate libraries may be useful build-cache artifacts but should not automatically be treated as stable portable language-level library formats. Source crates, stable native/C ABIs and WASM components are better long-lived interchange points.

### Java

Java can support more than one integration tier.

Deep/compiled integration:

```text
Java source + JAR dependencies
        -> javac / Java AOT / Java-to-WASM toolchain
        -> executable artifact
```

Compatibility/runtime integration:

```text
image callable/interface
        -> foreign-runtime adapter
        -> JVM in OCI
```

The JVM/OCI path preserves maximum compatibility with existing libraries/applications, but the JVM heap remains foreign runtime state rather than automatically becoming the durable image object graph.

A deeper Java personality may later model Java classes/methods/interfaces as image objects and lower executable code to WASM while keeping Java-specific runtime semantics above the common substrate.

These modes can coexist.

## OCI means two different things

### OCI as build environment

```text
artifact inputs
  -> compiler/package manager inside OCI
  -> derived artifacts
```

The container is toolchain machinery. After compilation, execution need not involve that container at all.

Toolchain identity/cache fingerprints should include the relevant OCI image digest/version plus compiler options, target/ABI, manifests/locks and dependency fingerprints that affect output.

### OCI as foreign runtime

```text
image callable/interface
  -> adapter
  -> live OCI JVM / native app / Python / ...
```

Here the container remains part of execution. This is a compatibility layer with a stronger process/runtime boundary and weaker automatic object integration.

Do not conflate build containers with runtime containers.

## Compiled libraries are reusable dependencies

Compiled libraries should be first-class dependencies whenever their format/runtime/ABI makes that meaningful.

### Java JAR/class libraries

A project may simply depend on byte artifacts:

```text
Java project
  source A
  source B
  dependency -> jackson.jar
  dependency -> customer-core.jar
        -> Java toolchain
```

The image retains dependency identity, history and provenance. It does not need to decompile those JARs into source objects.

### Rust/native libraries

Reuse depends more heavily on compiler/target/ABI. Source crates are natural editable dependencies; stable native/C ABIs and WASM components can be reusable binary interfaces; compiler-private formats remain version/configuration-sensitive build artifacts unless a stronger contract says otherwise.

### WASM components

WASM Component-style interfaces are an especially useful cross-language library boundary:

```text
Smalltalk caller ---+
Rust caller --------+--> geometry component
Java caller --------+
```

Once the component interface is stable, its implementation language can be irrelevant to callers.

The Component Model/WIT-style boundary therefore fits outer foreign-language/library interfaces well. It should not be imposed on every internal Smalltalk message send.

## Dependency roles are tooling policy

A dependency may participate as:

```text
static/link dependency
dynamic component dependency
foreign-runtime dependency
service dependency
build-only dependency
```

The durable graph records the dependency/provenance relationship. Compiler/toolchain/runtime policy decides how it is linked or invoked.

Do not encode one linkage choice into generic object identity.

## Callable/interface descriptions

An imported executable artifact cannot safely become callable merely because bytes exist.

The eventual interface contract should describe enough for dispatch/routing, ABI selection, tooling and capability checks, for example:

```text
artifact/interface identity
exported callable names/IDs
argument/result representation
ABI/component contract
required host capabilities
runtime/toolchain kind
version/provenance
```

Interface description is not authority. The platform's reference/capability separation remains unchanged.

## Compilation groups

A transient `CompilationGroup` describes a compiler planning unit:

```text
policyId
targetRepresentation
members: artifact/semantic CodeArtifact refs
options
```

The substrate validates the shape but does not interpret why the members belong together.

Natural policies may look like:

```text
Smalltalk / Lisp   nested code tree, package, compilation unit
Java               class/package/codegen unit
Rust               crate/codegen unit
```

A logical group does **not** prescribe physical layout. A compiler/toolchain may map it to one module, several modules or another executable representation.

Grouped compilation currently has its own language-neutral registry parallel to the single-artifact compiler registry:

```text
policyId + targetRepresentation
  -> group compiler
```

`CompilationService.compileGroup()` resolves all members, currently requires them to be in one image, applies compiler-declared cache rules, and persists every member as an explicit `derivedFrom` edge.

The first registered group compiler is:

```text
wasm-nested-block-tree/v0 -> wasm-module/v1
```

with physical layout `shared-module`.

A future external-toolchain provider should preserve the same explicit-input/provenance/cache principles rather than creating a second opaque build path.

## Compiler/toolchain-declared durable reuse

Reusable derived artifacts require an explicit stable compiler/toolchain identity plus deterministic key material.

Today `CompilationService` uses:

```text
identity
cacheKey(request, context)
```

The provider owns executable equivalence. The platform does not infer it from filenames, Block IDs, Java class names, Rust crate names or selectors.

For external toolchains, the derivation key may need to cover:

```text
toolchain/compiler identity and version
OCI image digest when applicable
target / ABI
compiler/linker options
ordered source/binary dependency fingerprints
manifest / lock artifacts
declared environment inputs that affect semantics
```

Outputs must retain explicit provenance to their inputs even if compilation happened in a container or remote process.

## Multi-function shared WASM modules

A grouped Smalltalk Block tree currently produces one WASM module with one exported entry per semantic member:

```text
semantic root  ----\
semantic child -----+--> one wasm-module/v1
semantic grandchild/

exports:
  run_0
  run_1
  run_2
```

The module stores module-global literal/host-effect tables plus per-entry descriptors. Each member still has separate `wasm-function/v1` and Block/prototype identity. Sharing a module is executable packaging, not language identity.

One physical module contains imports needed by all entries, but an activation selects one function descriptor and enables only that entry's send/closure sites. This effect isolation will matter even more once privileged/capability-aware foreign calls are added.

## Runtime-local host reuse

Durable artifact reuse and host execution reuse are separate layers:

```text
artifact/semantic group
  -> reusable immutable wasm-module/v1 CodeArtifact
  -> runtime-local compiled WebAssembly.Module
  -> optionally pooled WebAssembly.Instance
```

`WasmModuleCache` caches compiled modules by immutable module-artifact identity. `WasmInstancePool` only reuses instances for modules explicitly declaring a supported reset/reuse contract.

The built-in compiler currently emits:

```text
metadata.instanceReuse = "stateless-v0"
```

because its generated modules do not carry activation-persistent guest memory, mutable globals/tables or another guest runtime heap/state model.

Every pooled checkout receives fresh Value handles, active entry/effect policy, closure prototypes and pending-effect state. A trap or host/result-boundary violation retires the instance.

A future Java/Rust/Lisp backend with linear-memory heaps, mutable globals, TLS, GC/runtime state or meaningful initialization must not inherit `stateless-v0` merely because the current Smalltalk-oriented backend can use it. It may remain one-shot or define a later reset contract.

See ADR 0012 through ADR 0016.

## WASM backend

The current directly executable `lagrange-code/v0` operations are:

- scalar literals
- positional arguments
- receiver
- captured bindings
- arbitrary-precision integer addition through a host import
- canonical Value equality
- `if`
- tail-position language message sends
- tail-position nested Block materialization

General non-tail asynchronous effects are still rejected explicitly.

The generic ABI is `lagrange-value-handle/v0`:

```text
entry(receiverHandle,
      argumentHandle0, ...,
      captureHandle0, ...)
  -> resultHandle
```

Handles are invocation-local references to host-owned canonical Values. They are not object IDs, addresses or capabilities.

Future external-language backends may add optimized direct-scalar, component or WASM-GC ABIs behind explicit contracts.

## Blocks and invocation

The durable closure substrate remains:

```text
Block
  code --------> CodeArtifact
  environment -> LexicalEnvironment | null
```

Smalltalk maps naturally to it; Lisp closures can too. Java/Rust do not need every source-level function to become Smalltalk-shaped. They can use common callable/activation infrastructure according to their language personality and imported interface contracts.

Receiver remains an optional distinguished Value rather than argument zero:

```text
Smalltalk instance method -> receiver = self
Java instance method      -> receiver = this
static/free function       -> receiver = null
```

Language dispatch owns dynamic lookup. Sharing artifact/toolchain/runtime infrastructure does not make Smalltalk sends, Java virtual calls and Lisp generic-function semantics identical.

## Compatibility direction

A Cuis compatibility kernel can add dialect/package conventions above the shared substrate without freezing the core into Cuis semantics.

Common Lisp can reuse durable code/artifact identity, lexical environments, conditions, projects and compilation/toolchain infrastructure while remaining Lisp.

Java should reuse existing Java compilers/runtimes and compiled JAR libraries rather than require a home-grown compiler. Rust should reuse Cargo/`rustc` and source/binary ecosystems rather than require a home-grown compiler.

The useful continuum is:

```text
foreign OCI runtime
  highest compatibility, weakest automatic image integration

existing compiler/toolchain -> WASM/component
  high ecosystem compatibility + strong Lagrange execution integration

image-native language personality/compiler
  deepest image semantics/tooling integration
```

The platform should support all three where they solve real problems.

## Next open questions

- generic artifact dependency records/queries beyond current derivation edges
- external toolchain/provider registry and invocation contract
- OCI-backed compiler/toolchain provider
- reusable imported JAR/class dependency representation
- reusable WASM Component artifact/interface boundary
- foreign OCI runtime adapter and callable lifecycle
- Java toolchain/JAR compatibility spike using existing tooling
- Rust Cargo/`rustc` toolchain spike using existing tooling
- dependency linkage policy: static/component/foreign-runtime/service/build-only
- reset/reuse contracts for WASM modules with mutable guest state
- module-size/budget driven splitting of one logical group into several modules
- direct optimized calls between entries inside a shared module
- indexed derivation-key lookup and cache lifetime policy
- general non-tail asynchronous WASM effects/continuations
- capability-aware host/foreign/WASM interfaces and distributed/local call policy
- optimized/unboxed/component ABI variants
- distributed placement of compiled artifacts and foreign runtimes through Lagrange
- debugger activation durability and conditions/exceptions

See ADR 0016 for the source/artifact/toolchain/foreign-runtime boundary.