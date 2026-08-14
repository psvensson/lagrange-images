# ADR 0012: language-neutral compilation groups and derived-artifact reuse

Status: accepted for the compilation substrate.

## Problem

The first WASM backend compiled each semantic Block independently. ADR 0011 automated the recursive wiring, but two questions remain broader than Smalltalk or WASM:

1. which semantic code artifacts should be considered one compilation unit/group?
2. when may an immutable derived executable artifact be reused instead of rebuilt?

Those rules must not become "one Smalltalk Block tree == one WASM module" assumptions. Java, Rust, Lisp and later languages will naturally choose different grouping policies and calling/optimization strategies.

## Decision

Add two language-neutral compiler concepts:

- transient **CompilationGroup** descriptions
- compiler-declared **derivation cache contracts**

Neither concept defines source-language semantics or physical module layout.

## Compilation groups

A compilation group is a transient planning value:

```text
CompilationGroup
  policyId
  targetRepresentation
  members: semantic CodeArtifact refs
  options
```

The platform validates the shape but does not interpret `policyId` or infer why the members belong together. Grouping policy belongs to the compiler/tooling layer.

A policy may therefore mean very different things:

```text
Smalltalk / Lisp   nested code tree or package
Java               class/package/compilation unit
Rust               crate/codegen unit
other languages    their own useful unit
```

A logical group also does **not** imply one physical executable module. A compiler may map one group to one module, several modules, or another executable representation entirely.

The first policy is:

```text
wasm-nested-block-tree/v0
```

`installWasmBlockTree()` returns this group for the semantic artifacts in the installed tree. ADR 0013 later changed this policy's physical layout from the bootstrap `one-module-per-member` implementation to one shared multi-function module. The `CompilationGroup` contract itself did not change, which is exactly the separation intended here.

## Compiler-declared reuse

The compilation substrate never guesses whether two compiler invocations are equivalent.

A compiler is cacheable only when it explicitly declares:

```text
identity: stable compiler/ABI/version identity
cacheKey(request, context) -> deterministic key material
```

If either part is absent, `CompilationService` keeps the previous behavior and compiles every request.

For a cacheable compiler, the service hashes:

```text
key version
compiler identity
target representation
compiler-provided deterministic material
normalized caller artifact metadata
```

with SHA-256. Caller metadata is included because it is part of the observable CodeArtifact even when it does not change executable bytes; a request for different annotations must not silently receive an older cached artifact lacking them.

The resulting `derivationKey` and `compilerIdentity` are stored as non-reference artifact metadata.

The compiler owns executable cache-key meaning. The platform does not assume that source IDs, filenames, Blocks, classes, packages or any other language concept determine equivalence.

## Built-in WASM cache contracts

The first reusable single-source compiler is:

```text
lagrange-code/v0 -> wasm-module/v1
```

Its identity includes the current Value-handle ABI/compiler generation. Its safe key material is the source language ID, semantic representation and semantic CodeArtifact content.

ADR 0013 adds a separate reusable group compiler for:

```text
wasm-nested-block-tree/v0 -> wasm-module/v1
```

whose key includes the ordered semantic member contents and group policy/options. Group and single-source compiler identities remain distinct.

## Shared executable, distinct installation identity

Reusing executable material does not merge language/image identities.

A later installation's wrapper/function artifact links its current semantic artifact and the reused module, preserving current provenance without duplicating executable bytes.

With grouped compilation this becomes:

```text
semantic group A ----\
                     -> shared multi-function wasm-module/v1
semantic group B ----/

A function wrappers -> A Blocks
B function wrappers -> B Blocks
```

`wasm-function/v1` artifacts remain installation-specific because they carry current semantic provenance and explicit closure-prototype graph edges. Blocks and runtime closures remain distinct image objects.

## Reuse API semantics

`CompilationService.compileArtifact()` and `CompilationService.compileGroup()` reuse by default **only for compilers that opted into the cache contract**.

A caller may request `reuse: false` to force a new immutable artifact. A forced duplicate receives the same derivation key because it represents the same declared derivation and caller metadata.

When reuse succeeds, a caller-supplied artifact ID is ignored and the existing immutable artifact is returned.

## Cache-key material

Compiler key material is canonicalized with explicit type tags and sorted object keys before hashing. Plain records, arrays, strings, booleans, finite numbers, bigints and null are supported. Functions, undefined values and non-plain objects are rejected.

This avoids depending on incidental JavaScript property order and keeps future compiler cache contracts deterministic.

## Current lookup implementation

The bootstrap implementation finds reusable CodeArtifacts by scanning the image's CodeArtifacts for matching:

```text
target representation
compilerIdentity
derivationKey
```

This is intentionally a semantic contract before a performance contract. A durable backend may later index derivation keys without changing compiler or image semantics.

## Consequences for future languages

The cache and group layers know nothing about Smalltalk selectors, Lisp forms, Java classes or Rust ownership.

A future compiler may declare, for example:

```text
java-wasm/compiler-v3 + java-package/v1
rust-wasm/compiler-v2 + rust-codegen-unit/v1
common-lisp-wasm/compiler-v1 + lisp-compilation-unit/v1
```

and reuse the same grouping/cache substrate while choosing different semantic IR, ABI, physical module layout and optimization rules.

## Deferred

- group-policy/planner selection when more than one policy needs runtime choice
- splitting one logical group into several physical modules by size/budget
- indexed derivation-key lookup in the durable backend
- dependency fingerprints beyond explicit group members
- cache eviction/lifetime policy
- cross-image/global compiled-artifact stores
- optimized/unboxed ABI-specific caches
- distributed compiled-artifact placement
