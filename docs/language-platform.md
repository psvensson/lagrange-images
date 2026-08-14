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
- built-in `neutral-expression/v0` interpreter
- record versions, history and snapshots

Likely later shared concepts include activation/debug metadata, conditions, namespaces/projects, WASM calls and capability contexts.

## The neutral layer does not define language objects

It deliberately does not decide what a class, method, cons cell, symbol, closure, `nil`, boolean or exception means.

The substrate has a compact boolean Value, but Symmetric Smalltalk may still represent `true` and `false` as ordinary objects. There is no substrate `nil` kind. Likewise `behavior` is only a ref: Smalltalk can point it at a Behavior/Class object while another language can use a different dispatch/type object or leave it null.

## Symmetric Smalltalk first

The first language experiment remains **Symmetric Smalltalk**: Smalltalk's object/message feel with blocks pushed much further toward a universal executable/compositional form.

A useful test is whether method bodies, conditionals, loops, exception handlers, module initialization, class construction, compiler passes and debugger actions can largely reduce to ordinary objects, messages and blocks.

Semantic regularity must not force expensive runtime allocations. A non-escaping block may compile away completely.

## Blocks and code

The implemented neutral closure is:

```text
Block
  code --------> CodeArtifact
  environment -> LexicalEnvironment | null
```

A CodeArtifact is immutable and carries an opaque representation plus one tagged content Value and provenance refs. Source can be text, binary code can be bytes, and syntax/IR can be a graph ref.

A LexicalEnvironment is versioned. Its parent identity and binding-ID set form a stable layout; binding names and Values may change. Several Blocks can therefore share captured state without changing Block identity.

The durable graph representation does not dictate execution layout. WASM/compiler paths may specialize or eliminate Blocks and environments aggressively.

Generic objects have no `source` property. Source, syntax, IR, WASM artifacts and provenance belong in code artifacts or linked graph objects.

See ADR 0003.

## Invocation and message dispatch

A direct Block call and a message send converge on the same transient activation request.

A message send carries a language personality ID plus receiver, message and arguments as tagged Values. The neutral layer does not assume that a message is a Smalltalk selector string. A registered language dispatcher owns lookup semantics and resolves the send to a Block ref; it does not execute the Block.

The activation request identifies the resolved Block, CodeArtifact and optional LexicalEnvironment, together with receiver/arguments and message provenance where applicable. It is not persisted and preparing it does not append image history.

The language that performs message lookup is intentionally separate from the language/representation of the resolved CodeArtifact. This leaves room for compiled neutral IR and cross-personality implementation techniques without changing send semantics.

Refs still grant identity only; authorization and local/remote execution policy remain separate later layers.

See ADR 0004.

## Calling convention and execution

The common execution frame has a receiver Value or null, a positional array of argument Values, and the Block's optional captured LexicalEnvironment. Receiver is separate rather than being an implicit argument. Captured variables are looked up by stable binding ID through the lexical parent chain.

Arity and parameter naming are deliberately representation-specific rather than Block fields. `ActivationExecutor` revalidates Block/code/environment relationships, chooses an executor by CodeArtifact `representation`, and requires the executor to return one canonical tagged Value.

The first built-in executable representation is `neutral-expression/v0`. Its CodeArtifact content is a JSON expression program stored inside a text Value. It supports literals, positional arguments, receiver, captured bindings, integer addition, equality and `if`. This is a small executable contract used to prove the common calling convention, not a source language or final bytecode.

Custom code representations register executors against the same activation path, so later interpreters, neutral IR and WASM can coexist without changing dispatch.

See ADR 0005.

## Compatibility kernels

A Cuis-oriented compatibility kernel can provide dialect conventions, class/library shims, file-in/package readers and primitives above the shared substrate without freezing the core into Cuis semantics.

Common Lisp can reuse durable data/code identity, lexical environments, conditions, namespaces, history and tooling while remaining Lisp rather than Smalltalk-through-an-adapter.

## Compilation direction

```text
source
  -> language AST / syntax objects
  -> language-neutral executable IR
  -> optimized IR
  -> WASM component / interpreter bytecode / host fast path
```

The portable object/value/code-artifact format is not the executable IR. Keeping those layers distinct lets storage stay inspectable while runtime representation becomes efficient.

## Next open questions

- whether methods are specialized blocks or distinct semantic objects
- concrete Smalltalk method/selector lookup
- mutation/assignment semantics
- which sends may cross image/node boundaries
- debugger activation durability
- condition/exception propagation
- smallest executable IR preserving live source/object identity
