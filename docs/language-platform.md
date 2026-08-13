# Language platform

## One image substrate, multiple language personalities

The useful split is not "one VM per language". The platform should provide a small shared substrate for durable objects, references, code artifacts, activations, debugging and capabilities. A language personality maps its own semantics onto that substrate.

That makes two kinds of reuse possible:

- new languages reuse image/distribution/tooling machinery
- compatibility layers reuse a language personality while emulating dialect libraries and conventions

## Shared substrate

The language-neutral runtime will probably need concepts along these lines:

- object identity and references
- object shape / slots
- code objects
- lexical environments
- blocks/closures
- message or callable dispatch
- activation records and stack/debug metadata
- exceptions/conditions
- modules/namespaces/projects
- foreign/WASM calls
- capability-bearing references

These should be semantic objects, not necessarily one-to-one storage records.

## Symmetric Smalltalk first

The first language experiment is **Symmetric Smalltalk**.

The design goal is Smalltalk's minimal object/message feel with more structural regularity. In particular, blocks should be pushed much further toward being the universal executable/compositional form, roughly playing the role that S-expressions play for Lisp without copying Lisp syntax.

A useful test is whether traditionally special things can be expressed in terms of ordinary objects, messages and blocks:

- method bodies
- conditionals
- loops
- exception handlers
- module initialization
- class construction
- compiler passes
- debugger actions

"Everything is a block" should not become a slogan that creates inefficient runtime objects everywhere. The semantic model can be regular while the compiler specializes aggressively.

## Symmetry

Things worth keeping symmetric:

- code is inspectable data in the image
- classes and metaclasses use the ordinary object model
- methods/blocks have identity and metadata where useful
- tools manipulate the same objects programs execute
- compiler/interpreter components can eventually live in the image

Things that do not need fake symmetry:

- immediate values may use compact representations
- local sends should compile to direct fast paths where safe
- distributed sends must retain policy and failure semantics
- host/WASM boundaries are real boundaries

## Compatibility kernels

Porting existing ecosystems should happen above the shared substrate.

### Smalltalk dialects

A Cuis-oriented compatibility kernel could provide:

- selector and collection conventions
- class/library shims
- source/file-in readers
- package/category mapping
- dialect-specific primitives implemented against the shared runtime

The aim is to port useful libraries incrementally, not to freeze the core into Cuis semantics.

### Common Lisp

Common Lisp is a different semantic fit, but many substrate pieces still carry over: durable code/data objects, lexical environments, conditions, namespaces, compilation artifacts and tooling.

A Lisp personality should be allowed to be Lisp. It should not be forced through Smalltalk message syntax just because Smalltalk came first.

## Compilation strategy

A plausible long-term pipeline is:

```text
source
  -> language AST / syntax objects
  -> language-neutral executable IR
  -> optimized IR
  -> WASM component / interpreter bytecode / native host fast path
```

The IR boundary is more important than picking a bytecode now. It should preserve enough source/object identity for live tools and history.

## Bootstrapping

Do not make the first compiler self-hosted. Start with a tiny host implementation that can parse/compile enough language to build the next layer into the image. Then move implementation pieces inward as they become stable.

The endpoint is a system that can explain and modify much of itself. The bootstrap path should remain reproducible from an empty image.

## Open questions

- What is the minimal uniform block representation?
- Are methods specialized blocks or a distinct object kind?
- How are lexical variables represented durably without making activation state absurdly heavy?
- What is the exact reference/value encoding shared across languages?
- Which sends may cross image/node boundaries, and how explicit must that be semantically?
- What part of an activation/debug stack is durable?
- What is the smallest IR that supports both live editing and good WASM generation?
