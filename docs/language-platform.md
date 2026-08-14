# Language platform

## One image substrate, multiple language personalities

The platform should not be one VM per language. It provides a small shared substrate for durable values, refs, objects, code artifacts, compilation, execution, debugging and capabilities. A language personality maps its own semantics onto that substrate.

Implemented now includes the language-neutral graph/Block model, compiler and executor registries, `lagrange-code/v0`, `neutral-expression/v0`, the first Symmetric Smalltalk seed, and a first real WASM backend.

## Symmetric Smalltalk first

The first language experiment is **Symmetric Smalltalk**: Smalltalk's object/message feel with Blocks pushed much further toward a universal executable/compositional form.

The seed parses Smalltalk-shaped expressions, preserves source/syntax/semantic provenance, automatically analyzes nested Block captures, materializes bootstrap closures, and sends messages through image-resident behavior objects. Those semantics are independent of the execution backend.

## Semantic code versus executable code

The durable compilation chain is:

```text
language source
  -> language syntax
  -> lagrange-code/v0 semantic code
  -> derived execution artifact
       |-> neutral-expression/v0
       `-> wasm-module/v1 + wasm-function/v1
```

`lagrange-code/v0` describes literals, arguments, receiver, lexical bindings, sends, conditionals and nested Blocks without choosing a machine/runtime representation. `CodeCompilerRegistry` and `CompilationService` create immutable derived artifacts linked with `derivedFrom`.

Executable artifacts remain rebuildable state under ADR 0007. Blocks point at CodeArtifacts; they do not contain WASM-specific identity or layout.

## First WASM backend

The first backend compiles a pure subset of `lagrange-code/v0` into validated WebAssembly bytes and executes `wasm-function/v1` through the same `ActivationExecutor` used by the interpreter.

The current supported semantic operations are:

- scalar literals
- positional arguments
- receiver
- captured bindings
- arbitrary-precision integer addition through a host import
- canonical Value equality
- `if`

Message sends and nested closure creation are intentionally rejected by the WASM compiler for now rather than falling back implicitly.

### Value-handle ABI v0

The first ABI is `lagrange-value-handle/v0`. WASM receives invocation-local `i32` handles to host-owned canonical tagged Values:

```text
run(receiverHandle,
    argumentHandle0, ...,
    captureHandle0, ...)
  -> resultHandle
```

Handle `0` means no receiver/ABI value. Positive handles live only for one activation; they are not image object IDs, addresses, capabilities or persistent references.

This lets arbitrary-precision integers, object refs, text and other tagged Values cross the boundary without making WASM linear-memory or scalar layout part of image semantics. For example, an object-ref receiver can enter and leave a WASM-backed `yourself` method unchanged while WASM sees only a temporary integer handle.

The initial `lagrange` imports are `literal`, `integer_add`, `equals`, and `is_true`. Host imports validate handles and operate on canonical Values. Later sends/object/Lagrange operations must be added as explicit capability-aware imports.

The interpreter remains the reference implementation. Differential tests lower the same semantic artifact to interpreter and WASM representations and require identical canonical Value results.

See ADR 0007 and ADR 0008.

## Blocks and closures

The semantic closure remains:

```text
Block
  code --------> CodeArtifact
  environment -> LexicalEnvironment | null
```

The bootstrap interpreter currently materializes nested closures as Block + LexicalEnvironment records. This is not a required execution layout: a future WASM backend may inline, flatten, stack-allocate or eliminate nonescaping closures while preserving the same semantic capture identities.

## Invocation and dispatch

Direct Block calls and language message sends converge on transient activation requests. Language dispatch resolves a message to a Block; execution then depends on the Block's CodeArtifact representation.

This separation already allows the same neutral activation machinery to execute `neutral-expression/v0` and `wasm-function/v1`. A future Smalltalk send can therefore resolve to WASM without changing method lookup semantics.

References still identify objects rather than granting authority. WASM Value handles likewise do not grant capabilities.

## Compatibility kernels

A Cuis-oriented compatibility kernel can provide dialect conventions, class/library shims, file-in/package readers and primitives above the shared substrate without freezing the core into Cuis semantics.

Common Lisp can reuse durable data/code identity, lexical environments, conditions, namespaces, history and tooling while remaining Lisp rather than Smalltalk-through-an-adapter.

## Next open questions

- WASM message-send import and capability context
- nested closure creation/optimization in the WASM backend
- Object/Behavior/Class/Metaclass bootstrap and inheritance
- assignment, temporaries, sequences and mutable lexical cells
- immediate-value Smalltalk objects/primitives
- module grouping and compilation/cache policy
- optimized/unboxed ABI variants and possible WASM-GC use
- distributed placement of WASM execution through Lagrange
- debugger activation durability and conditions/exceptions
