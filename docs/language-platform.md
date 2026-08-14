# Language platform

## One image substrate, multiple language personalities

The platform should not be one VM per language. It provides a small shared substrate for durable values, refs, objects, code artifacts, compilation, execution, debugging and capabilities. A language personality maps its own semantics onto that substrate.

Implemented now includes the language-neutral graph/Block model, compiler and executor registries, `lagrange-code/v0`, `neutral-expression/v0`, the first Symmetric Smalltalk seed, and a real WASM backend with Value-handle ABI, tail message/closure effects and automatic recursive Block-tree installation.

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
- tail-position nested Block materialization

General non-tail asynchronous effects are rejected explicitly rather than falling back or pretending the asynchronous image/runtime path is synchronous.

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

### Tail host effects

Image-resident dispatch and closure materialization are asynchronous, while ordinary WASM imports are synchronous. The bootstrap ABI handles that mismatch explicitly by yielding one final host effect after pure WASM execution.

A tail send becomes a derived send-site descriptor plus a typed import:

```text
lagrange.send_site_N(receiverHandle, argumentHandles...) -> 0
```

A tail nested Block becomes a derived closure-site descriptor plus a typed import:

```text
lagrange.make_block_site_N(captureHandles...) -> 0
```

The synchronous imports validate handles and record one pending request; they do not perform image lookup or writes. The WASM entry returns reserved handle `0`, then the executor resumes asynchronously outside WASM.

```text
WASM
  -> one tail host effect
  -> return 0
  -> executor awaits normal runtime operation
       |-> InvocationService/ActivationExecutor for send
       `-> ActivationExecutor.createClosure for Block creation
  -> canonical Value / Block ObjectRef
```

Tail position propagates through `if`, so pure WASM computation may choose a final send, a final closure materialization, or a pure return. Effects needed as intermediate expression results remain rejected for now.

### WASM closure sites and graph edges

A closure site stores only semantic data in module metadata:

```text
closureSites[N]
  blockId
  captures: [{id, name}, ...]
```

Prototype Block refs are never hidden there. `compileWasmFunctionArtifact()` requires an explicit prototype for every closure site and appends those refs to the `wasm-function/v1` CodeArtifact's `derivedFrom` edges. Function metadata stores only the corresponding `derivedFromIndex`.

At execution, capture Values cross as handles. Once WASM returns, the ordinary closure runtime creates the same `LexicalEnvironment + Block` representation used by the interpreter.

The prototype may itself be interpreter-backed or WASM-backed. A materialized closure therefore has no WASM-specific invocation semantics: later `value*` sends go through the ordinary Smalltalk dispatcher and common ActivationExecutor.

### Automatic complete Block trees

`installWasmBlockTree()` is now the normal high-level path when a whole semantic Block tree should use WASM. It starts from one root `lagrange-code/v0` artifact and recursively installs every nested semantic Block bottom-up:

```text
root semantic artifact
  -> nested semantic artifacts
  -> nested WASM functions
  -> nested prototype Blocks
  -> parent WASM functions with explicit prototype edges
  -> root WASM-backed Block
```

Callers no longer need to discover nested Blocks or construct `blockPrototypes` maps themselves. The lower-level `compileWasmFunctionArtifact()` remains available for mixed interpreter/WASM prototype experiments and custom assembly.

Before writing derived tree artifacts, the installer recursively preflights every semantic node with the current WASM compiler. If a deep descendant contains an unsupported non-tail effect, installation fails before leaving a partially built executable tree.

Nested semantic programs are persisted as derived `lagrange-code/v0` artifacts linked to their immediate semantic parent. All automatically created prototype Blocks are WASM-backed, while runtime materialized closures are still ordinary Blocks with ordinary lexical environments.

A three-level tree therefore stays uniform:

```text
root WASM Block
  -> child WASM prototype
       -> grandchild WASM prototype
```

with `value*` sends and capture lookup unchanged.

For example, the semantic tree corresponding to:

```smalltalk
[ :x | [ :y | [ :z | x ] ] ]
```

can now be installed from its single root semantic artifact and executed through three WASM-backed Block definitions without manual prototype wiring.

This remains unsupported inside one WASM activation:

```smalltalk
[ :x | [ :y | x ] value: 1 ]
```

because closure materialization is needed before the final send. Lifting that restriction requires an explicit continuation/trampoline or other async-WASM contract.

The interpreter remains the reference implementation. Differential/conformance tests require the same capture IDs, Block semantics and canonical results across execution representations.

See ADR 0007, ADR 0008, ADR 0009, ADR 0010 and ADR 0011.

## Blocks and closures

The semantic closure remains:

```text
Block
  code --------> CodeArtifact
  environment -> LexicalEnvironment | null
```

Both the interpreter and the bootstrap WASM closure effect currently materialize nested closures as Block + LexicalEnvironment records. This is not a required optimized layout: a future backend may inline, flatten, stack-allocate or eliminate nonescaping closures while preserving the same semantic capture identities.

## Invocation and dispatch

Direct Block calls and language message sends converge on transient activation requests. Language dispatch resolves a message to a Block; execution then depends on the Block's CodeArtifact representation.

This separation allows a Smalltalk send from interpreted code or WASM to resolve to either `neutral-expression/v0` or `wasm-function/v1` without changing method lookup semantics. The same is true for nested Block prototypes.

References still identify objects rather than granting authority. WASM Value handles likewise do not grant capabilities. Host effects currently request only explicitly compiled language sends or closure materializations; capability-aware privileged or distributed operations remain later boundaries.

## Compatibility kernels

A Cuis-oriented compatibility kernel can provide dialect conventions, class/library shims, file-in/package readers and primitives above the shared substrate without freezing the core into Cuis semantics.

Common Lisp can reuse durable data/code identity, lexical environments, conditions, namespaces, history and tooling while remaining Lisp rather than Smalltalk-through-an-adapter.

## Next open questions

- general non-tail asynchronous WASM effects/continuations
- transient/non-materialized optimized closures and possible WASM-GC use
- shared-module/grouped compilation across several semantic Blocks
- incremental reuse/deduplication of derived WASM tree nodes
- Object/Behavior/Class/Metaclass bootstrap and inheritance
- assignment, temporaries, sequences and mutable lexical cells
- immediate-value Smalltalk objects/primitives
- capability-aware host imports and distributed/local send policy
- optimized/unboxed ABI variants
- distributed placement of WASM execution through Lagrange
- debugger activation durability and conditions/exceptions
