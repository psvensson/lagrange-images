# Language platform

## One image substrate, multiple language personalities

The platform should not be one VM per language. It provides a small shared substrate for durable values, refs, objects, code artifacts, compilation, execution, debugging and capabilities. A language personality maps its own semantics onto that substrate.

Implemented now includes the language-neutral graph/Block model, compiler and executor registries, `lagrange-code/v0`, `neutral-expression/v0`, the first Symmetric Smalltalk seed, and a real WASM backend with a Value-handle ABI and tail message effects.

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

## WASM backend

The WASM backend compiles `lagrange-code/v0` into validated WebAssembly bytes and executes `wasm-function/v1` through the same `ActivationExecutor` used by the interpreter.

The current directly executable semantic operations are:

- scalar literals
- positional arguments
- receiver
- captured bindings
- arbitrary-precision integer addition through a host import
- canonical Value equality
- `if`
- tail-position language message sends

Nested closure creation remains unsupported in WASM. Non-tail asynchronous sends are also rejected explicitly rather than falling back or pretending the asynchronous image/runtime path is synchronous.

### Value-handle ABI v0

The ABI is `lagrange-value-handle/v0`. WASM receives invocation-local `i32` handles to host-owned canonical tagged Values:

```text
run(receiverHandle,
    argumentHandle0, ...,
    captureHandle0, ...)
  -> resultHandle
```

Handle `0` is reserved. Positive handles live only for one activation; they are not image object IDs, addresses, capabilities or persistent references.

This lets arbitrary-precision integers, object refs, text and other tagged Values cross the boundary without making WASM linear-memory or scalar layout part of image semantics. An object-ref receiver can enter and leave a WASM-backed method unchanged while WASM sees only a temporary integer handle.

The base `lagrange` imports are `literal`, `integer_add`, `equals`, and `is_true`.

### Tail message effects

Image-resident language dispatch is asynchronous, while ordinary WASM imports are synchronous. The bootstrap ABI handles that mismatch explicitly with tail effects.

Each semantic tail send becomes a derived send-site descriptor plus a typed import:

```text
sendSites[N]
  languageId
  message : non-ref Value
  arity

lagrange.send_site_N(receiverHandle, argumentHandles...) -> 0
```

The synchronous import validates the handles and records one pending send request. It does **not** perform image lookup. The WASM entry then returns reserved handle `0`; outside WASM the executor awaits the normal `InvocationService`/`ActivationExecutor` path and returns the resulting canonical Value.

```text
WASM
  -> send_site_N
  -> return 0
  -> executor awaits normal language dispatch
  -> resolved Block may be interpreted or WASM
  -> Value
```

Tail position propagates through `if`, so pure WASM computation may choose which final send occurs. Sends used as operands, send receivers/arguments, conditions, or other non-tail expressions are rejected by the compiler for now.

A WASM caller may resolve to another WASM-backed Block because message lookup remains language-owned and execution-representation-neutral. There is no separate WASM method-lookup mechanism.

This is intentionally a first asynchronous-effect contract. General non-tail sends will need an explicit continuation/trampoline or other async WASM design later.

The interpreter remains the reference implementation. Differential tests require interpreted and WASM callers to produce identical canonical Values.

See ADR 0007, ADR 0008 and ADR 0009.

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

This separation allows a Smalltalk send from interpreted code or WASM to resolve to either `neutral-expression/v0` or `wasm-function/v1` without changing method lookup semantics.

References still identify objects rather than granting authority. WASM Value handles likewise do not grant capabilities. Tail-send imports currently request language dispatch only; capability-aware privileged or distributed host operations remain later boundaries.

## Compatibility kernels

A Cuis-oriented compatibility kernel can provide dialect conventions, class/library shims, file-in/package readers and primitives above the shared substrate without freezing the core into Cuis semantics.

Common Lisp can reuse durable data/code identity, lexical environments, conditions, namespaces, history and tooling while remaining Lisp rather than Smalltalk-through-an-adapter.

## Next open questions

- general non-tail asynchronous WASM sends/continuations
- nested closure creation/optimization in the WASM backend
- Object/Behavior/Class/Metaclass bootstrap and inheritance
- assignment, temporaries, sequences and mutable lexical cells
- immediate-value Smalltalk objects/primitives
- capability-aware host imports and distributed/local send policy
- module grouping and compilation/cache policy
- optimized/unboxed ABI variants and possible WASM-GC use
- distributed placement of WASM execution through Lagrange
- debugger activation durability and conditions/exceptions
