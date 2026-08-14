# ADR 0011: automatic WASM Block tree installation

Status: accepted for the bootstrap WASM compiler pipeline.

## Problem

ADR 0010 made nested semantic Blocks executable from WASM, but assembling a complete WASM-backed Block tree still required callers to compile every nested semantic program manually, create prototype Blocks bottom-up, and pass explicit `blockPrototypes` maps into each parent `wasm-function/v1` derivation.

That low-level API is useful, but it is the wrong default for normal compilation. A caller starting with one root `lagrange-code/v0` artifact should be able to ask for a complete WASM execution tree without knowing the nested prototype wiring protocol.

## Decision

Add `installWasmBlockTree()` as the high-level recursive compiler/installer.

Input:

```text
root lagrange-code/v0 CodeArtifact ref
```

Output:

```text
root WASM-backed Block
plus every derived nested semantic artifact,
wasm-module/v1,
wasm-function/v1,
and prototype Block needed by the tree
```

The existing `compileWasmFunctionArtifact()` API remains available as the lower-level assembly primitive.

## Recursive derivation

For each semantic program, the installer discovers only its direct nested Block expressions. It handles each child recursively before compiling the parent:

```text
parent semantic program
       |
       | discover direct nested Blocks
       v
child semantic program(s)
       |
       | recurse first
       v
child WASM function(s)
       |
       v
child prototype Block(s)
       |
       | explicit prototype refs
       v
parent WASM function
       |
       v
parent Block
```

This is bottom-up derivation rather than a second compiler. Actual module/function generation still goes through the existing WASM compiler and `compileWasmFunctionArtifact()`.

## Nested semantic artifacts

A nested semantic program already exists inside its parent `lagrange-code/v0` content. The tree installer also persists a derived child semantic CodeArtifact so every compiled node has its own inspectable semantic source artifact and provenance edge.

Each child semantic artifact:

- uses representation `lagrange-code/v0`
- contains the nested semantic program
- derives from its immediate parent semantic artifact
- records only non-reference metadata such as semantic block ID and tree root ID

The semantic meaning therefore remains available independently of all WASM artifacts.

## Prototype graph edges

Each recursive child returns an ordinary prototype Block ref. The parent supplies those direct-child refs to `compileWasmFunctionArtifact()`.

ADR 0010 still applies unchanged:

- closure prototype refs are explicit `wasm-function/v1.derivedFrom` graph edges
- metadata contains indices/descriptors only
- no prototype ref is hidden in module or function metadata

The high-level installer automates those edges; it does not weaken them.

## Complete WASM trees

All automatically generated prototype Blocks are WASM-backed. A three-level semantic Block tree therefore becomes:

```text
root wasm Block
  -> child wasm prototype
       -> grandchild wasm prototype
```

At runtime, materialized closures are still ordinary `Block + LexicalEnvironment` image objects. `value*` sends continue through the normal language dispatcher and common ActivationExecutor.

Automatic compilation affects derived executable representation only, not closure identity or invocation semantics.

## Preflight rule

Before writing any derived tree artifacts, `installWasmBlockTree()` recursively validates every semantic program with the current WASM compiler.

If any deep node contains unsupported semantics, such as a non-tail asynchronous effect, installation fails before the first derived child semantic/module/function/prototype artifact is written.

This avoids leaving a partially assembled executable tree merely because a deep descendant cannot currently compile to WASM.

The caller-supplied root semantic artifact already exists and is not modified.

## Artifact identity

The caller supplies one root Block tree ID, or receives a generated UUID. Derived artifact IDs are deterministic within that tree namespace.

Nested semantic Block IDs are encoded into collision-resistant textual keys for derived semantic/module/function/prototype IDs. Semantic Block identity itself remains the ID stored in `lagrange-code/v0`; these derived IDs are build/install identities, not replacements for semantic identity.

## Root captures

The root installed Block may still point at a caller-supplied LexicalEnvironment. Nested prototype Blocks are environment-free. Runtime closure materialization supplies their actual captured environments in the same way as before.

## Consequences

Normal callers no longer need to manually construct prototype maps.

A compiler/tooling path can now:

```text
source
  -> syntax
  -> one root lagrange-code/v0 artifact
  -> installWasmBlockTree(...)
  -> complete WASM-backed executable Block tree
```

The low-level APIs remain useful for mixed execution-representation experiments, custom prototype selection, caching research, and future module grouping.

## Deferred

- compiling several semantic Blocks into one shared WASM module
- incremental reuse/deduplication of previously derived tree nodes
- transactional backend installation of a whole derived tree
- automatic choice between interpreter and WASM targets
- non-tail asynchronous WASM continuation/resumption
- transient/non-materialized optimized closures
- distributed placement/cache policy for compiled WASM trees
