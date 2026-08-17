# ADR 0007: semantic code and derived execution

Status: accepted — the bootstrap compiler architecture.

## Decision

Separate language meaning from executable artifacts explicitly.

The durable compilation chain is:

```text
language source
    -> language syntax
    -> lagrange-code/v0 semantic code
    -> derived execution artifact
```

Source, syntax and semantic code preserve enough meaning for inspection, tooling and recompilation. Execution artifacts are derived state. They may be deleted from an export/cache and regenerated without changing the program's semantic identity.

`CodeCompilerRegistry` maps `(source representation, target representation)` to a compiler. `CompilationService` loads an immutable source CodeArtifact, invokes the registered compiler and persists a new CodeArtifact whose `derivedFrom` points at the source artifact.

The first registered lowering is:

```text
lagrange-code/v0 -> neutral-expression/v0
```

`neutral-expression/v0` remains the bootstrap interpreter format. It is no longer the Smalltalk compiler's semantic output.

## Semantic Blocks

`lagrange-code/v0` represents parameters with stable binding IDs and has language-neutral expressions for literals, arguments, receiver, captured bindings, sends, conditionals and nested Blocks.

A nested Block records:

- a stable semantic block ID within its containing compilation unit
- its own semantic program
- the exact captured binding IDs/names it requires
- expressions describing the values to capture from the enclosing execution frame

Symmetric Smalltalk performs capture analysis while producing semantic code. A captured outer parameter keeps its positional stable binding ID. `self` becomes an ordinary lexical capture when it crosses a Block boundary. Deeper closures pass the same binding identity through intermediate scopes.

## Bootstrap closure execution

The `lagrange-code/v0 -> neutral-expression/v0` lowering maps semantic nested Blocks to `make-block` expressions referring to precompiled prototype Blocks.

The current interpreter materializes a `LexicalEnvironment` containing exactly the evaluated capture set and a new `Block` using the prototype's code. Smalltalk `value`, `value:`, `value:value:`, and higher-arity value sends resolve that Block through the normal language dispatcher.

This materialization is **not** a language guarantee. A future executor may stack-allocate a nonescaping closure, keep it in a WASM reference, flatten its environment, inline it, or eliminate it entirely while preserving the same observable Block/capture semantics. Durable graph identity is required only when the closure is actually materialized into the image.

## Derived nested artifacts

Installation creates nested semantic CodeArtifacts, lowers them bottom-up, and creates environment-free prototype Blocks. Their IDs are deterministic relative to the installed outer Block ID and semantic block path. The outer executable artifact therefore depends only on semantic code plus references to derived nested prototypes.

The semantic parent artifact still contains the nested semantic programs themselves. The prototype/executable layer is rebuildable state, not the only copy of nested code meaning.

## WASM artifact contract

Reserve two executable representations now without implementing the WASM compiler in this PR:

```text
wasm-module/v1
  content: Bytes

wasm-function/v1
  content: ref -> wasm-module/v1 CodeArtifact
  metadata.entry: function/export entry name
```

A WASM compiler should derive these from semantic code. Blocks continue to point at CodeArtifacts rather than gaining WASM-specific fields.

The intended future chain is:

```text
lagrange-code/v0
   |-> neutral-expression/v0
   `-> wasm-module/v1 + wasm-function/v1
```

## Invariant

Deleting all derived executable artifacts from an export or build cache must not destroy the source/syntax/semantic information needed to understand and rebuild the program.

Execution representation is disposable; semantic identity is not.

## Deferred

- first `lagrange-code/v0 -> WASM` compiler
- WASM calling ABI and host imports
- transient non-materialized closure handles in the bootstrap interpreter
- optimization/inlining
- source-level assignment and mutable lexical cells
- Class/Metaclass and inheritance
