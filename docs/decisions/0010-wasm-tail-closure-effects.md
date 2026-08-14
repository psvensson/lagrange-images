# ADR 0010: WASM tail closure effects

Status: accepted for the bootstrap WASM backend.

## Problem

Creating a semantic closure currently materializes durable image records: a `LexicalEnvironment` for captured Values and a `Block` pointing at a precompiled prototype's CodeArtifact. Image writes are asynchronous, while ordinary WebAssembly imports are synchronous.

The WASM backend must support nested Block semantics without pretending those writes are synchronous, hiding prototype graph refs in metadata, or making WASM references the identity of image closures.

## Decision

`lagrange-value-handle/v0` supports nested Block creation as a **tail host effect**, using the same pending-effect discipline as tail message sends.

A semantic Block may be lowered to WASM when its creation is in tail position. Its capture initializer expressions must be pure under the current WASM subset. Tail position continues to propagate through `if` branches.

A non-tail Block creation is rejected explicitly.

## Closure sites

Each nested semantic Block creates derived module metadata containing no graph refs:

```text
closureSites[N]
  blockId
  captures:
    id
    name
```

The module imports a typed function for the site:

```text
lagrange.make_block_site_N(captureHandle0, ...) -> 0
```

Capture Values cross only as invocation-local Value handles.

The prototype Block ref is **not** stored in module metadata. When `wasm-function/v1` is assembled, every closure site must be paired with an explicit prototype Block ref. Those refs are appended to the function CodeArtifact's `derivedFrom` edges. Function metadata stores only `{blockId, derivedFromIndex}` descriptors.

This keeps prototype graph edges visible to the generic reference walker.

## Execution

The synchronous `make_block_site_N` import validates capture handles, resolves them to canonical Values, pairs them with the stable capture IDs/names from the closure site, records one pending closure request and returns reserved handle `0`.

After the WASM entry returns, the executor resumes outside WASM:

```text
WASM entry
  -> make_block_site_N records prototype + captures
  -> WASM returns 0
  -> executor awaits context.createClosure(...)
  -> ActivationExecutor materializes LexicalEnvironment + Block
  -> ordinary Block ObjectRef is returned
```

The resulting closure is exactly the same image-level shape as one created by `neutral-expression/v0`. It contains no WASM-specific identity.

## Prototype representation independence

A closure prototype is a normal Block. Its CodeArtifact may therefore use any registered execution representation.

A WASM-backed parent may materialize:

- an interpreter-backed prototype, or
- a `wasm-function/v1` prototype.

Subsequent `value*` sends use the ordinary Symmetric Smalltalk dispatcher and ActivationExecutor. Closure creation does not introduce WASM-specific invocation semantics.

## Why tail-only

Materialization is currently asynchronous because it creates image records. Tail effects allow the host operation to happen after WASM has completely returned, so there is no suspended WASM stack to resume.

For example, this shape can be compiled to WASM:

```smalltalk
[ :x | [ :y | x ] ]
```

The returned Block can later receive `value:` normally.

This shape remains unsupported in WASM for now:

```smalltalk
[ :x | [ :y | x ] value: 1 ]
```

because closure creation is needed as an intermediate value before the tail send. Supporting that requires the same future continuation/trampoline or async-WASM work needed for non-tail message sends.

## Optimization consequence

Materializing Block + LexicalEnvironment is a bootstrap execution choice, not semantic law. A future backend may inline, stack-allocate, flatten or eliminate nonescaping closures while preserving `lagrange-code/v0` Block/capture semantics.

The v0 host effect intentionally chooses correctness and shared image semantics before optimization.

## Security/capability consequence

Closure-site imports grant no ambient image access. They may only materialize the prototype explicitly linked from the current `wasm-function/v1` and capture Values already present in the activation.

Value handles remain invocation-local and are not capabilities.

## Follow-up

Automatic bottom-up WASM compilation/installation of complete nested Block trees is implemented by ADR 0011. The explicit prototype-edge and tail-effect rules above remain unchanged; ADR 0011 automates their assembly.

## Deferred

- non-tail closure creation and resumed WASM execution
- transient/non-materialized runtime closure handles
- mutable lexical cells and assignment
- optimized closure layouts and WASM-GC representations
- capability-aware privileged host effects
