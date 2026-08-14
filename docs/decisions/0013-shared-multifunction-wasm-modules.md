# ADR 0013: shared multi-function WASM modules

Status: accepted for the first grouped WASM backend.

## Problem

ADR 0012 introduced language-neutral `CompilationGroup` planning and derived-artifact reuse, but the first WASM tree policy still emitted one physical `wasm-module/v1` per semantic member.

That preserved semantics but missed an important purpose of grouping: related executable functions should be able to share one physical module without merging their language/image identities.

The implementation must also remain useful to future Java, Rust, Lisp and other compilers. "Several members in one executable module" belongs to compiler policy, not to Smalltalk Blocks or the image substrate.

## Decision

Add a language-neutral grouped-compilation path parallel to single-artifact compilation:

```text
CompilationGroup
  -> CompilationGroupCompilerRegistry
  -> CompilationService.compileGroup(...)
  -> one derived CodeArtifact
```

A group compiler is registered by:

```text
policyId + targetRepresentation
```

and may opt into the same compiler-declared derivation cache contract used by single-artifact compilers.

The first registered group compiler is:

```text
wasm-nested-block-tree/v0 -> wasm-module/v1
```

with physical layout:

```text
shared-module
```

## Generic group compilation

`CompilationService.compileGroup()`:

- resolves every semantic CodeArtifact member
- currently requires all members to belong to one image
- looks up a compiler by group policy + target representation
- applies compiler-declared cache identity/key semantics
- stores every member ref as an explicit `derivedFrom` edge on the resulting artifact
- does not interpret source-language semantics or physical module policy itself

A future Java/Rust/Lisp compiler can register a different policy and compiler without changing this service.

## Shared WASM module shape

The grouped WASM compiler emits one valid module containing one exported entry per group member:

```text
wasm-module/v1
  export run_0
  export run_1
  export run_2
  ...
```

Module metadata contains one descriptor per exported function:

```text
functions[N]
  entry
  memberIndex
  parameters
  captures
  sendSiteIndices
  closureSiteIndices
```

`memberIndex` refers to the corresponding semantic member in the module artifact's `derivedFrom` list. It is an index, not a hidden graph reference.

Literals and host-effect site descriptors are module-global. Function descriptors say which send/closure sites belong to each entry.

## Function identity remains separate

A shared module is only a derived executable container.

Each semantic member still receives its own `wasm-function/v1` artifact:

```text
semantic A ----\
semantic B -----+--> shared wasm-module/v1
semantic C ----/

semantic A + shared module -> function A -> Block A
semantic B + shared module -> function B -> Block B
semantic C + shared module -> function C -> Block C
```

Function artifacts keep their own:

- semantic provenance
- exported entry name
- parameter/capture signature
- explicit closure-prototype graph edges

Blocks and runtime closures therefore remain separate image identities even when their code entries live in one module.

## Host-effect isolation

Being in one module does not grant one function ambient use of another function's host effects.

At execution the WASM executor:

1. resolves the active function descriptor by exported entry
2. validates the function artifact's parameter/capture metadata against that descriptor
3. instantiates all imports required by the physical module
4. enables only the active entry's declared send and closure sites
5. rejects an inactive site if it is somehow invoked

This keeps the previous explicit host-effect boundary intact while allowing one physical module to contain many entries.

## Tree installation

`installWasmBlockTree()` now works in phases:

```text
preflight complete semantic tree
  -> plan deterministic group members
  -> preflight the multi-entry module
  -> persist nested semantic artifacts
  -> compile/reuse one shared module
  -> assemble function artifacts + prototype Blocks bottom-up
  -> install root Block
```

The existing whole-tree unsupported-semantics preflight remains ahead of derived installation writes.

The first group policy uses the entire nested semantic Block tree as one shared module. This is a first physical policy, not a universal grouping rule.

## Reuse

The grouped WASM compiler has its own stable compiler/ABI identity and cache key derived from:

- group policy/options
- ordered semantic member language/representation/content
- target representation
- caller artifact metadata through the generic derivation-key layer

Two independent equivalent tree installations therefore reuse one immutable multi-function module while retaining separate function/Block identities.

ADR 0014 adds a second, runtime-only reuse layer: once an immutable `wasm-module/v1` is selected for execution, its host `WebAssembly.Module` compilation is cached per runtime. That execution cache does not change this artifact-level derivation contract.

## Backward compatibility

The single-artifact `lagrange-code/v0 -> wasm-module/v1` compiler remains supported.

Single-function modules now use the same internal multi-entry emitter with one `run` export. Existing low-level `compileWasmFunctionArtifact()` remains available for custom or mixed assembly.

The executor also retains compatibility with older single-function module metadata that predates the `functions` descriptor array.

## Multilingual consequence

Nothing in grouped compilation assumes Smalltalk selectors, Blocks, Java classes, Rust crates or Lisp forms.

Future policies may naturally choose:

```text
Java        class/package/codegen group -> one or several modules
Rust        crate/codegen unit           -> one or several modules
Common Lisp compilation unit             -> one or several modules
Smalltalk   nested Block tree/package     -> one or several modules
```

Each compiler owns member semantics, cache equivalence, ABI and physical layout.

## Deferred

- module-size/budget driven splitting of one logical group into several modules
- direct optimized calls between entries in the same module
- `WebAssembly.Instance` pooling/reuse policy
- cross-image grouped compilation and global artifact stores
- dependency fingerprints beyond explicit group members
- incremental recompilation of only affected members
- optimized/unboxed ABI variants inside grouped modules
- distributed placement and replication policy for shared compiled modules
