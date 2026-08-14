# Language platform

## One image substrate, multiple language personalities

The platform should not be one VM per language. It provides a small shared substrate for durable values, refs, objects, code artifacts, compilation, execution, debugging and capabilities. A language personality maps its own semantics onto that substrate.

Implemented now includes the language-neutral graph/Block model, single-artifact and group compiler registries, `lagrange-code/v0`, `neutral-expression/v0`, transient compilation groups, compiler-declared derivation reuse, the first Symmetric Smalltalk seed, and a real WASM backend with a Value-handle ABI, tail host effects, recursive Block-tree installation and multi-function shared modules.

## Symmetric Smalltalk first, not Smalltalk-only

The first language experiment is **Symmetric Smalltalk**: Smalltalk's object/message feel with Blocks pushed much further toward a universal executable/compositional form.

Smalltalk owns its parser, lexical rules and message lookup. Those choices are not image-, compilation-group- or WASM-level contracts. Later Common Lisp, Java, Rust and other personalities may keep different semantic representations, grouping rules and ABIs while reusing durable identity, CodeArtifacts, derivation caching, activation/execution and WASM where useful.

## Semantic code versus executable code

The durable chain is conceptually:

```text
language source
  -> language syntax / semantic artifacts
  -> shared/lower semantic representation when useful
  -> derived execution artifacts
```

For Symmetric Smalltalk today:

```text
Smalltalk source
  -> Smalltalk syntax
  -> lagrange-code/v0
       |-> neutral-expression/v0
       `-> wasm-module/v1 + wasm-function/v1
```

`lagrange-code/v0` is an early shared semantic IR, not a requirement that every future language express its full semantics as Smalltalk-like sends/Blocks. Java, Rust or Lisp may need different language-semantic artifacts before lowering to shared execution concepts.

Executable artifacts remain rebuildable state. Blocks point at CodeArtifacts; they do not contain WASM-specific identity or layout.

## Compilation groups

A transient `CompilationGroup` describes a compiler planning unit:

```text
policyId
targetRepresentation
members: semantic CodeArtifact refs
options
```

The substrate validates the shape but does not interpret why the members belong together.

Natural future policies may look like:

```text
Smalltalk / Lisp   nested code tree, package, compilation unit
Java               class/package/codegen unit
Rust               crate/codegen unit
```

A logical group does **not** prescribe physical layout. A compiler may map it to one module, several modules or a different executable representation.

### Group compiler registry

Grouped compilation now has its own language-neutral registry parallel to the single-artifact compiler registry:

```text
policyId + targetRepresentation
  -> group compiler
```

`CompilationService.compileGroup()` resolves all members, currently requires them to be in one image, applies the same compiler-declared cache contract as ordinary compilation, and persists every group member as an explicit `derivedFrom` edge on the resulting artifact.

The first registered group compiler is:

```text
wasm-nested-block-tree/v0 -> wasm-module/v1
```

Its physical layout is now:

```text
shared-module
```

## Multi-function shared WASM modules

A grouped Block tree now produces one WASM module with one exported entry per semantic member:

```text
semantic root  ----\
semantic child -----+--> one wasm-module/v1
semantic grandchild/

exports:
  run_0
  run_1
  run_2
```

The module stores module-global literal and host-effect tables plus per-entry descriptors:

```text
functions[N]
  entry
  memberIndex
  parameters
  captures
  sendSiteIndices
  closureSiteIndices
```

`memberIndex` refers to the matching semantic member in the module artifact's `derivedFrom` list. No graph ref is hidden in metadata.

Each member still has a separate `wasm-function/v1` artifact and Block/prototype identity:

```text
semantic A + shared module -> function A -> Block A
semantic B + shared module -> function B -> Block B
semantic C + shared module -> function C -> Block C
```

The shared module is executable packaging, not language identity.

### Host-effect isolation inside a shared module

One physical module contains imports needed by all entries, but an activation selects exactly one function descriptor. The executor validates that descriptor against the `wasm-function/v1` artifact and enables only the send/closure sites assigned to that entry.

So sharing a module does not make another entry's host-effect boundary ambiently available.

This matters later for capability-aware host calls as well as for today's message-send and closure effects.

## Compiler-declared reuse

`CompilationService` reuses an immutable derived artifact only when the compiler explicitly declares:

```text
identity
cacheKey(request, context)
```

The compiler owns executable equivalence. The platform does not infer it from filenames, Block IDs, Java classes, Rust crates or selectors.

The derivation key includes compiler identity, target representation, compiler-provided deterministic key material and requested artifact metadata.

Both the single-member and grouped WASM compilers opt into this contract.

For grouped trees, two equivalent independent installations can therefore share one multi-function module:

```text
installation A semantic group ----\
                                   -> shared multi-function module
installation B semantic group ----/

A functions/Blocks stay separate
B functions/Blocks stay separate
```

The shared module keeps the provenance of the first exact artifact that produced it. Each later `wasm-function/v1` still derives from its current semantic artifact plus that shared module, so reuse does not erase the current installation path.

The bootstrap cache lookup scans image CodeArtifacts by compiler identity + derivation key. The durable backend may later index that pair without changing the contract.

See ADR 0012 and ADR 0013.

## WASM backend

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

General non-tail asynchronous effects are still rejected explicitly.

### Value-handle ABI v0

The generic ABI is `lagrange-value-handle/v0`:

```text
entry(receiverHandle,
      argumentHandle0, ...,
      captureHandle0, ...)
  -> resultHandle
```

Handles are invocation-local `i32` references to host-owned canonical Values. They are not image object IDs, addresses or capabilities.

Future Java/Rust/etc. backends may add optimized direct scalar or WASM-GC ABIs for proven cases while retaining explicit ABI identities and the generic Value path where required.

### Tail host effects

Image-resident dispatch and closure materialization are asynchronous while ordinary WASM imports are synchronous. The bootstrap ABI therefore permits one final host effect after pure WASM work:

```text
WASM -> send_site_N       -> return 0 -> normal dispatch -> Value
WASM -> make_block_site_N -> return 0 -> create closure  -> Block ref
```

Tail position propagates through `if`. Intermediate asynchronous results still require a later continuation/trampoline or other explicit async-WASM contract.

### Closure graph edges

Closure-site metadata contains only semantic block/capture descriptors. Prototype Block refs remain explicit `wasm-function/v1.derivedFrom` edges.

Runtime closure materialization still creates the ordinary `LexicalEnvironment + Block` image representation. Shared modules do not change that.

## Automatic complete Block trees

`installWasmBlockTree()` now runs roughly as:

```text
preflight complete semantic tree
  -> plan deterministic compilation group
  -> preflight multi-entry WASM module
  -> persist nested semantic artifacts
  -> compile/reuse one shared module
  -> assemble per-entry function artifacts + prototype Blocks bottom-up
  -> install root Block
```

Callers still start from one root semantic artifact and do not construct prototype maps manually.

A tree corresponding to:

```smalltalk
[ :x | [ :y | [ :z | x ] ] ]
```

now uses one physical module with three exported entries, while the three semantic/function/prototype identities remain distinct.

The existing whole-tree preflight still rejects unsupported deep non-tail effects before derived installation writes begin.

## Blocks and invocation

The durable closure substrate remains:

```text
Block
  code --------> CodeArtifact
  environment -> LexicalEnvironment | null
```

Smalltalk maps naturally to it; Lisp closures can too. Java/Rust do not need every source-level function to become Smalltalk-shaped. They can use the callable/activation substrate according to their language personality.

Receiver remains an optional distinguished Value rather than argument zero:

```text
Smalltalk instance method -> receiver = self
Java instance method      -> receiver = this
static/free function       -> receiver = null
```

Language dispatch owns dynamic lookup. Sharing a compiler/runtime substrate does not make Smalltalk sends, Java virtual calls and Lisp generic-function semantics identical.

## Compatibility and future personalities

A Cuis compatibility kernel can add dialect/package conventions above the shared substrate without freezing the core into Cuis semantics.

Common Lisp can reuse durable code identity, lexical environments, conditions, compilation groups and executable reuse while remaining Lisp.

Java can layer JavaClass/JavaMethod/etc. objects plus Java-specific dispatch/class initialization over the same image and compiler substrate. Rust can keep ownership/borrowing mostly at compile time and use its own codegen groups and ABI choices.

## Next open questions

- module-size/budget driven splitting of one logical group into several modules
- direct optimized calls between entries inside a shared module
- compiled `WebAssembly.Module` / instance caching in the host
- group policy/planner selection once several policies exist
- indexed derivation-key lookup and cache lifetime policy
- general non-tail asynchronous WASM effects/continuations
- transient/non-materialized optimized closures and possible WASM-GC use
- Object/Behavior/Class/Metaclass bootstrap and inheritance
- assignment, temporaries, sequences and mutable lexical cells
- capability-aware host imports and distributed/local send policy
- optimized/unboxed ABI variants
- Java/Rust/Common Lisp compiler-personality spikes
- distributed placement of compiled artifacts through Lagrange
- debugger activation durability and conditions/exceptions
