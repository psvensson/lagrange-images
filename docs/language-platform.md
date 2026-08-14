# Language platform

## One image substrate, multiple language personalities

The platform should not be one VM per language. It provides a small shared substrate for durable values, refs, objects, code artifacts, compilation, execution, debugging and capabilities. A language personality maps its own semantics onto that substrate.

Implemented now includes the language-neutral graph/Block model, compiler and executor registries, `lagrange-code/v0`, `neutral-expression/v0`, transient compilation groups, compiler-declared derivation reuse, the first Symmetric Smalltalk seed, and a real WASM backend with Value-handle ABI, tail message/closure effects and automatic recursive Block-tree installation.

## Symmetric Smalltalk first, not Smalltalk-only

The first language experiment is **Symmetric Smalltalk**: Smalltalk's object/message feel with Blocks pushed much further toward a universal executable/compositional form.

Smalltalk owns its parser, lexical rules and message lookup. Those choices are not image- or WASM-level contracts. Later Common Lisp, Java, Rust and other personalities may keep very different source and runtime semantics while reusing object identity, CodeArtifacts, compilation groups, derivation caching, activation/execution infrastructure and WASM where useful.

## Semantic code versus executable code

The durable compilation chain is:

```text
language source
  -> language syntax / language semantic artifacts
  -> language-neutral/lower semantic representation when useful
  -> derived execution artifact
       |-> interpreter form
       `-> WASM / another backend
```

For the first language this currently becomes:

```text
Smalltalk source
  -> Smalltalk syntax
  -> lagrange-code/v0
       |-> neutral-expression/v0
       `-> wasm-module/v1 + wasm-function/v1
```

`lagrange-code/v0` is an early shared semantic IR, not a requirement that every future language express all of its semantics as Smalltalk-like sends/Blocks. Java, Rust or Lisp may need additional or different semantic representations before lowering to a common executable substrate.

Executable artifacts remain rebuildable state under ADR 0007. Blocks point at CodeArtifacts; they do not contain WASM-specific identity or layout.

## Compilation groups and derived-artifact reuse

Grouping policy belongs to compilers, not languages in the substrate.

A transient `CompilationGroup` contains:

```text
policyId
targetRepresentation
members: semantic CodeArtifact refs
options
```

The substrate validates those fields but does not interpret why the members belong together. That lets different compiler personalities make natural choices:

```text
Smalltalk / Lisp   nested code tree, package or compilation unit
Java               class/package/compilation unit
Rust               crate/codegen unit
```

A logical group does not mean one physical WASM module. One policy may emit one module, another several, and a later optimizer may change physical layout without changing source-language or image semantics.

The first policy is `wasm-nested-block-tree/v0`. `installWasmBlockTree()` returns a group containing the semantic artifacts in that tree. Its current physical layout is explicitly `one-module-per-member`; shared-module generation is a later compiler optimization.

### Compiler-declared cache equivalence

`CompilationService` only reuses a derived artifact when the registered compiler explicitly declares both:

```text
identity
cacheKey(request, context)
```

The compiler therefore owns equivalence. The platform does not infer it from a source filename, Block ID, Java class, Rust crate, selector or any other source-language concept.

The key is hashed with the compiler identity and target representation. Cacheable artifacts record non-reference `compilerIdentity` and `derivationKey` metadata. Compilers without this contract behave exactly as before and always compile.

The first cacheable compiler is `lagrange-code/v0 -> wasm-module/v1`. Its identity includes the current compiler/Value-handle ABI generation, and its key is based on the semantic content actually used to emit the module.

As a result, two independent installations of equivalent semantic Block trees can share immutable WASM modules while retaining distinct installation identities:

```text
semantic A ----\
                -> shared wasm-module/v1
semantic B ----/

function A -> Block A
function B -> Block B
```

The `wasm-function/v1` wrappers remain separate because they carry the current semantic provenance and explicit closure-prototype graph edges. Module reuse therefore saves executable duplication without merging image objects or language identities.

The bootstrap lookup scans image CodeArtifacts by compiler identity + derivation key. The durable backend may later index that pair without changing the contract.

See ADR 0012.

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

This generic handle path is deliberately conservative. Future Java/Rust/etc. backends may use optimized direct scalar or WASM-GC conventions for proven cases while retaining explicit ABI identities and a generic path for image Values.

### Tail host effects

Image-resident dispatch and closure materialization are asynchronous, while ordinary WASM imports are synchronous. The bootstrap ABI handles that mismatch explicitly by yielding one final host effect after pure WASM execution.

```text
WASM -> send_site_N       -> return 0 -> normal dispatch -> Value
WASM -> make_block_site_N -> return 0 -> create closure  -> Block ref
```

Tail position propagates through `if`. Effects needed as intermediate expression results remain rejected until an explicit continuation/trampoline or other async-WASM contract exists.

### Closure graph edges

A WASM closure site stores only semantic block/capture descriptors in module metadata. Prototype Block refs remain explicit `wasm-function/v1.derivedFrom` edges; metadata stores only the corresponding indices.

At execution, capture Values cross as handles. Once WASM returns, the common closure runtime creates the same `LexicalEnvironment + Block` representation used by the interpreter. Prototype code may itself be interpreted or WASM-backed.

### Automatic complete Block trees

`installWasmBlockTree()` recursively compiles a root semantic Block tree bottom-up, persists nested semantic artifacts, builds WASM-backed prototypes, wires explicit child prototype refs, and returns the root Block plus its transient compilation group.

The whole tree is preflighted before derived installation writes. Unsupported deep semantics therefore fail without leaving a partial executable tree.

This automation is the first **grouping policy consumer**, not the generic definition of a compilation group.

See ADR 0008 through ADR 0012.

## Blocks and closures

The current neutral closure substrate remains:

```text
Block
  code --------> CodeArtifact
  environment -> LexicalEnvironment | null
```

Smalltalk naturally maps source Blocks to this record. Lisp functions/closures can map to the same durable concept. Java/Rust do not need every ordinary function to become a source-level Smalltalk-style Block; they can use the shared callable/activation substrate according to their language personality while retaining the same durable code identity and backend choices where appropriate.

Durable representation does not dictate optimized runtime allocation. A future backend may inline, flatten, stack-allocate or eliminate nonescaping closures while preserving semantic capture behavior.

## Invocation and dispatch

Direct Block calls and language message sends converge on transient activation requests. Receiver remains a distinguished optional Value rather than argument zero:

```text
Smalltalk instance method -> receiver = self
Java instance method      -> receiver = this
static/free function       -> receiver = null
```

Language dispatch owns dynamic lookup. A Smalltalk send, future Java virtual call policy, or Lisp generic-function layer need not become the same source-language operation merely because they can eventually converge on a callable activation.

References still identify objects rather than granting authority. WASM Value handles likewise do not grant capabilities.

## Compatibility and future personalities

A Cuis-oriented compatibility kernel can provide dialect conventions, class/library shims, file-in/package readers and primitives above the shared substrate without freezing the core into Cuis semantics.

Common Lisp can reuse durable data/code identity, lexical environments, conditions, namespaces, history, compilation groups and executable reuse while remaining Lisp rather than Smalltalk-through-an-adapter.

Java can layer JavaClass/JavaMethod/etc. objects and Java-specific virtual/interface/class-initialization semantics above the same image and compiler substrate. Rust can keep ownership/borrowing largely at compile time and use its own semantic/codegen grouping and ABI choices.

## Next open questions

- shared physical WASM modules for several compilation-group members
- group policy/planner registry once several policies need runtime selection
- indexed derivation-key lookup and cache lifetime policy
- general non-tail asynchronous WASM effects/continuations
- transient/non-materialized optimized closures and possible WASM-GC use
- Object/Behavior/Class/Metaclass bootstrap and inheritance
- assignment, temporaries, sequences and mutable lexical cells
- immediate-value Smalltalk objects/primitives
- capability-aware host imports and distributed/local send policy
- optimized/unboxed ABI variants
- Java/Rust/Common Lisp compiler-personality spikes
- distributed placement of compiled artifacts through Lagrange
- debugger activation durability and conditions/exceptions
