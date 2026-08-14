# Language platform

## One image substrate, multiple language personalities

The platform should not be one VM per language. It provides a small shared substrate for durable values, refs, objects, code artifacts, debugging and capabilities. A language personality maps its own semantics onto that substrate.

Implemented now:

- stable object identity
- canonical tagged Values
- ordinary and pinned historical refs
- immutable shapes with stable slot IDs
- separate shape and behavior refs
- reference walking across graph record kinds
- immutable code artifacts
- versioned lexical environments with stable binding IDs
- immutable blocks pairing code with an optional environment
- language dispatcher registry
- transient direct-call, message-send and activation-request protocol
- representation executor registry and activation execution
- code compiler registry and immutable derivation service
- explicit `lagrange-code/v0` semantic representation
- built-in `neutral-expression/v0` interpreter/lowering target
- executable Symmetric Smalltalk source/parser/compiler/dispatcher seed
- automatic nested Block capture analysis and bootstrap closure materialization
- record versions, history and snapshots

Likely later shared concepts include activation/debug metadata, conditions, namespaces/projects, WASM execution and capability contexts.

## The neutral layer does not define language objects

It deliberately does not decide what a class, method, cons cell, symbol, closure, `nil`, boolean or exception means.

The substrate has a compact boolean Value, but Symmetric Smalltalk may still represent `true` and `false` as ordinary objects. There is no substrate `nil` kind. Likewise `behavior` is only a ref: Smalltalk can point it at a Behavior/Class object while another language can use a different dispatch/type object or leave it null.

## Symmetric Smalltalk first

The first language experiment is **Symmetric Smalltalk**: Smalltalk's object/message feel with blocks pushed much further toward a universal executable/compositional form.

A useful test remains whether method bodies, conditionals, loops, exception handlers, module initialization, class construction, compiler passes and debugger actions can largely reduce to ordinary objects, messages and blocks.

Semantic regularity must not force expensive runtime allocations. A non-escaping block may compile away completely.

### Executable seed

The seed parses a deliberately small Smalltalk-shaped expression language. Unary, binary and keyword messages use ordinary Smalltalk precedence. Implemented primaries are integers, strings, names, `self`, parentheses and block syntax.

The compilation unit remains an outer Block, but nested Blocks are now executable too:

```smalltalk
[ :x | [ :y | x echo: y ] ]
```

Parameters have stable positional binding IDs. The semantic compiler automatically finds free lexical references in nested Blocks. Captured outer parameters retain their stable IDs; `self` becomes a lexical capture when it crosses a Block boundary; deeper nesting passes the same identity through intermediate scopes.

Smalltalk source no longer lowers directly into the interpreter representation. Installation preserves this chain:

```text
Smalltalk source
  -> Smalltalk syntax
  -> lagrange-code/v0 semantic code
  -> neutral-expression/v0 derived executable
  -> Block
```

Nested semantic programs are retained inside their parent semantic artifact and also installed as deterministic nested semantic artifacts. Derived executable prototypes are compiled bottom-up.

The bootstrap interpreter materializes a new LexicalEnvironment and Block when a nested Block expression executes. Only the exact capture set is stored. This is an interpreter implementation choice: a later WASM/compiler path may inline or eliminate the same closure without changing its semantics.

The first message lookup policy is image-resident. A receiver's `behavior` points to an ordinary behavior object whose shape slot names act as selectors and whose corresponding slot Values are Block refs. Block refs themselves understand `value`, `value:`, `value:value:`, and higher-arity value sends through the same dispatcher. This remains a bootstrap convention rather than the final Object/Behavior/Class/Metaclass model.

Immediate scalar Values are still not Smalltalk message receivers. Primitives remain a language-level problem rather than compiler special cases.

See ADR 0006 and ADR 0007.

## Semantic code versus executable code

`lagrange-code/v0` is the first explicit language-neutral semantic representation. It describes arguments, receiver, lexical bindings, sends, conditionals and nested Blocks without saying whether execution uses an interpreter, WASM or another backend.

`CodeCompilerRegistry` maps a source representation plus target representation to a compiler. `CompilationService` persists derived CodeArtifacts and automatically links them back to the semantic source with `derivedFrom`.

The first registered compiler is:

```text
lagrange-code/v0 -> neutral-expression/v0
```

Executable artifacts are rebuildable state. Keeping source/syntax/semantic artifacts means an image/export remains understandable and recompilable after interpreter/WASM artifacts are omitted from a build cache or projection.

The reserved future WASM contracts are `wasm-module/v1` (bytes) and `wasm-function/v1` (module ref plus entry name). Blocks do not know about WASM.

See ADR 0007.

## Blocks and code

The implemented neutral closure is:

```text
Block
  code --------> CodeArtifact
  environment -> LexicalEnvironment | null
```

A CodeArtifact is immutable and carries an opaque representation plus one tagged content Value and provenance refs. Source can be text, binary code can be bytes, and syntax/IR can be linked artifacts or graph refs.

A LexicalEnvironment is versioned. Its parent identity and binding-ID set form a stable layout; binding names and Values may change. Several Blocks can therefore share captured state without changing Block identity.

Durable graph representation does not dictate runtime allocation. The bootstrap interpreter currently materializes nested closures, while future compiler paths may stack-allocate, flatten or eliminate them.

Generic objects have no `source` property. Source, syntax, semantic code, WASM artifacts and provenance belong in CodeArtifacts or linked graph objects.

See ADR 0003.

## Invocation and message dispatch

A direct Block call and a message send converge on the same transient activation request.

A message send carries a language personality ID plus receiver, message and arguments as tagged Values. The neutral layer does not assume that a message is a Smalltalk selector string. A registered language dispatcher owns lookup semantics and resolves the send to a Block ref; it does not execute the Block.

The activation request identifies the resolved Block, CodeArtifact and optional LexicalEnvironment, together with receiver/arguments and message provenance where applicable. It is not persisted merely because it is invoked.

The language that performs message lookup is intentionally separate from the representation of the resolved CodeArtifact. A Smalltalk send can therefore resolve to interpreted semantic lowering today and WASM later without changing send semantics.

Refs still grant identity only; authorization and local/remote execution policy remain separate later layers.

See ADR 0004.

## Calling convention and execution

The common execution frame has a receiver Value or null, a positional array of argument Values, and the Block's optional captured LexicalEnvironment. Receiver is separate rather than being an implicit argument. Captured variables are looked up by stable binding ID.

Arity and parameter naming are representation-specific rather than Block fields. `ActivationExecutor` revalidates Block/code/environment relationships, chooses an executor by CodeArtifact `representation`, and requires one canonical tagged Value result.

`neutral-expression/v0` now supports literals, positional arguments, receiver, captured bindings, integer addition, equality, `if`, language-tagged nested sends and `make-block`. `make-block` is an execution operation for semantic closure construction, not Smalltalk syntax embedded in the neutral runtime.

Custom code representations register executors against the same activation path.

See ADR 0005.

## Compatibility kernels

A Cuis-oriented compatibility kernel can provide dialect conventions, class/library shims, file-in/package readers and primitives above the shared substrate without freezing the core into Cuis semantics.

Common Lisp can reuse durable data/code identity, lexical environments, conditions, namespaces, history and tooling while remaining Lisp rather than Smalltalk-through-an-adapter.

## Compilation direction

```text
language source
  -> language syntax
  -> lagrange-code/v0 semantic code
  -> derived execution artifact
       |-> neutral-expression/v0
       `-> WASM (next backend)
```

Execution artifacts may be aggressively optimized or regenerated. They are not the canonical source of program meaning.

## Next open questions

- first `lagrange-code/v0 -> WASM` backend and ABI
- Object/Behavior/Class/Metaclass bootstrap and inheritance
- assignment, temporaries, sequences and mutable lexical cells
- immediate-value objects/primitives without losing semantic symmetry
- when a runtime closure must acquire durable image identity
- which sends may cross image/node boundaries
- debugger activation durability
- condition/exception propagation
