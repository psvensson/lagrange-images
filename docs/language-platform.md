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
- record versions, history and snapshots

Likely later shared concepts include dispatch, activations/debug metadata, conditions, namespaces/projects, WASM calls and capability contexts.

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
- cross-personality dispatch contract
- which sends may cross image/node boundaries
- debugger activation durability
- smallest executable IR preserving live source/object identity
