# ADR 0056: Boolean protocol and reserved literals

Status: implemented — `true` and `false` are source spellings of the canonical boolean Values, `nil` is reserved syntax lowering to an image-bound intrinsic binding so the semantic artifact stays image-independent, and `not`/`and:`/`or:` are ordinary lazy methods on `True` and `False`.
Proven by: test/reserved-literals.test.js, test/smalltalk-control-flow.test.js

## Problem

Ordinary library source still spells a boolean by computing one:

```smalltalk
found := 1 = 2.                          "false"
(item = (contents at: index)) ifTrue: [ ^ 1 = 1 ]  "true"
```

and a method that needs `nil` captures it explicitly, because there is no way to write it:

```javascript
const NIL_CAPTURE = Object.freeze({name: 'NilObject', id: 'smalltalk/library/nil'});
```

Both were recorded as deliberate gap signals rather than style. `1 = 2` is not merely ugly — it is a
comparison the reader has to decode, and it means the library cannot express a boolean without
Integer protocol. The missing `not`, `and:` and `or:` are the same gap one level up: a two-part test
is written as nested `ifTrue:ifFalse:`, which is where `OrderedCollection >> at:` still is.

## Decision

### 1. `true` and `false` are the canonical boolean Values

```text
true    ->   {op: 'literal', value: {kind: 'boolean', value: true}}
false   ->   {op: 'literal', value: {kind: 'boolean', value: false}}
```

They do **not** compile to `kernel.true` / `kernel.false` refs. ADR 0045 separated the two on purpose:
a boolean is a canonical Value, and Symmetric Smalltalk *transiently* nominates the corresponding
singleton as the effective receiver only when a message is sent to one. That separation is what keeps
a boolean transportable between images and languages, and compiling the literal to a ref would undo
it at the source level while leaving the rest of the system believing it held.

So `true class` still reaches `True` through the bridge, while storing, passing or returning `true`
stores, passes or returns the Value.

`lagrange-code` needs no operation for this: it already has literal Values, and this is one.

### 2. `nil` is different, and the difference is the point

The generic Value model has no nil kind, deliberately. This ADR does not add one, and does not
compile `nil` to an image-specific object ref either — a semantic artifact must stay
image-independent, and embedding `image/smalltalk/nil` would make a compiled method mean something
only in the image that compiled it.

```text
true, false    language-neutral Values
nil            a language-owned image object, reached through an image-independent binding
```

So `nil` is reserved syntax that lowers to a **reserved intrinsic binding**, exactly as ADR 0055
lowers `^`: the semantic artifact carries a stable binding id and nothing else, and installation
supplies that image's existing `kernel.nil`.

```text
in the artifact     {op: 'binding', id: 'smalltalk/intrinsic/nil'}
at installation     bound to this image's kernel nil
```

That is the boundary this project has been careful about throughout: Smalltalk semantics may use the
generic substrate, but they may not leak into it. A `nil` Value kind would be Smalltalk's notion of
absence in a model shared with every other language.

### 2a. The pressure this creates, reported rather than worked around

The reserved-binding pattern needs *some* installer to supply the value, and the two compilation
entry points are not alike here:

```text
defineMethods / defineMethodsFromSource   already writes a LexicalEnvironment for method captures,
                                          so `nil` costs it nothing new

installSymmetricSmalltalkBlock            passes `environment` straight through to `putBlock` and
                                          has never written one
```

So `nil` in a standalone Block is where that changes: the installer must ensure an environment
binding the intrinsic. This is a real cost and worth naming — a durable record on a path that
previously wrote none — but it is the right one:

- the alternative of restricting `nil` to class-scoped compilation would make an everyday literal
  unavailable in exactly the Blocks people write by hand;
- and it stays proportional, because the environment is written only when the program actually binds
  the intrinsic. ADR 0055 already established requesting a reserved binding lazily rather than
  declaring it into every compilation, and the same rule applies.

Nested Blocks need nothing new: the binding propagates by the ordinary capture walk, as
`$nonLocalReturn` and the slot primitives already do.

**The intrinsic environment composes with the caller's; it does not replace it.** A standalone Block
may already be installed with an environment supplying the caller's own captures, and a Block that
also uses `nil` needs both. The rule:

```text
no nil                      the environment path is exactly what it is today, and no extra
                            record is written

nil, no caller environment  a deterministic environment holding only the intrinsic binding

nil, caller environment     a deterministic environment holding only the intrinsic binding,
                            whose PARENT is the caller's environment
```

Parenting rather than merging, for two reasons. Copying the caller's bindings into a new record
would duplicate durable state that already exists and could then drift from it — the caller's
environment is a record with its own lifecycle, and a copy is a second answer to the same question.
And the lexical environment chain is already the mechanism for exactly this: `lookupBindingRecord`
walks parents, so composing is what the substrate is for, while flattening would be a private
re-implementation of the walk.

### 3. All three are reserved pseudo-literals

```text
cannot be    a parameter, a temporary, a capture name, or an assignment target
cannot be    shadowed by a future namespace or global mechanism
```

Stated now rather than when globals arrive, because the failure mode is silent: if `nil` were
shadowable, adding a namespace later would change what existing source means without changing the
source. The tokenizer already refuses `self` as a temporary or assignment target; these join it.

### 4. `not`, `and:` and `or:` are ordinary methods

```smalltalk
True  >> not      ^ false          False >> not      ^ true
True  >> and: b   ^ b value        False >> and: b   ^ false
True  >> or: b    ^ true           False >> or: b    ^ b value
```

Reached through ADR 0045's existing bridge, like the four conditional selectors. **The compiler
recognizes no selector** — the rule that has held since ADR 0045 and is not relaxed here.

`and:` and `or:` take Blocks and are **lazy**: the skipped Block is not evaluated. That is the whole
reason they are methods on `True` and `False` rather than eager binary operators, and it is why they
must not be replaced by an IR operation or a host primitive.

An evaluated Block's value is answered as-is. No second boxing or coercion step is added for
`and:`/`or:`: correct ordinary source already produces canonical booleans, because the literals of
decision 1 and the existing comparisons do.

### 5. This is not the first global

`nil`'s intrinsic is a *reserved binding the compiler injects*, not a name the programmer may bind or
rebind. `True`, `False`, `Boolean`, `Array` and the rest stay unnameable from ordinary source until
the namespace question is decided on its own terms. Deciding it accidentally, as a side effect of
wanting `nil`, is what this decision exists to prevent.

### 6. The gap signals retire with the gaps

When the implementation lands, ordinary library source stops spelling `1 = 2` and `1 = 1` to obtain
booleans, and a method capturing `NilObject` only because there is no literal uses `nil` instead.
A capture that exists for some other reason stays — the rule is that a signal must not outlive the
gap it marks, not that captures are bad.

## Proof required for implementation

```text
literals
    true and false compile to literal canonical boolean Values, in v0 and v1 programs alike
    storing, passing and returning either preserves the canonical Value — no ref substitution
    `true class`, `false ifTrue:...` and `true not` still route through ADR 0045's
        effectiveReceiver bridge
    no durable Boolean wrapper object is created by any of it

nil
    `nil` evaluates to the image's exact kernel nil, in both lanes
    the semantic artifact contains no image-specific ref — proven by inspecting the artifact, and
        by compiling the semantic program once and asserting the artifact installed into each of two
        images equals that single result while each binds its own nil. Not one durable artifact
        shared by two images: a CodeArtifact's identity is image-scoped, and the claim is about the
        *program* being image-independent rather than the record being shared
    a nested Block using `nil` binds it by the ordinary capture walk
    a Block that does not use `nil` still installs with no lexical environment, and its
        environment path is byte-for-byte what it is today
    a Block using `nil` *and* caller-supplied captures resolves both, with the intrinsic
        environment's parent pointing at the caller's rather than copying its bindings
    the caller's environment record is unchanged by that composition
    installing the same standalone Block twice converges, including its intrinsic environment

reserved names
    true, false and nil are refused as parameters, temporaries, capture names and assignment
        targets, each with a message naming the reserved word

boolean protocol
    not answers correctly for both receivers, in both lanes
    and:/or: short-circuit: an observable counter proves the skipped Block never ran
    an evaluated and:/or: Block runs exactly once
    a non-tail WASM composition exercises the protocol rather than only direct calls
    the compiled artifact contains ordinary sends for not/and:/or:, and the compiler contains
        no special case for those selectors

what must not have changed
    no new lagrange-code operation and no new Value kind
    installation is exact-or-create and idempotent, and joins the exhaustive recovery sweeps
        under the `exhaustive-recovery:` prefix, both lanes, pre-commit and lost-ack

the library
    `1 = 2` and `1 = 1` no longer appear as boolean spellings
    `removeLast` uses `nil` rather than a `NilObject` capture
    every retired capture was retired because its gap closed, not because it was unused
```

## What is deferred

- globals and namespaces generally, including making `True`, `Array` and the condition classes
  nameable from source — the next conspicuous scaffolding, and its own decision
- `xor:`, `&`, `|` and the eager Boolean operators
- `ifNil:`, `ifNotNil:` and the nil-testing protocol, which are ordinary methods once `nil` exists
- `isNil` / `notNil`, for the same reason
- any nil-like Value kind, which decision 2 rejects rather than postpones

## Guardrails

```text
true/false are canonical boolean *Values*, never kernel singleton refs — ADR 0045's separation of
    value from dispatch personality is the thing being preserved
nil lowers to a reserved image-bound binding; the semantic artifact carries a binding id and never
    an image-specific ref, and the generic Value model gains no nil kind
`nil` in a standalone Block makes its installer write a lexical environment it otherwise would not;
    write it only when the program actually binds the intrinsic
the intrinsic environment PARENTS the caller-supplied one, never flattens or copies it — the
    chain walk is already the composition mechanism, and a copy is a second answer that can drift
the nil intrinsic is owned by the semantic compiler and offered to every compilation; a caller may
    add intrinsics but may not replace `$nil`, and both `$nil` and `smalltalk/intrinsic/nil` are
    reserved at every programmatic capture entry point. Reserving the name without the id would let
    a caller bind the id under another name and shadow `nil` from outside the compiler
true, false and nil are reserved: not parameters, temporaries, captures, assignment targets, and
    not shadowable by a later namespace
not/and:/or: are ordinary methods through ADR 0045's bridge; the compiler recognizes no selector
and:/or: are lazy — the skipped Block must not be evaluated, and no IR op or host primitive may
    replace them
an evaluated and:/or: Block's value is answered as-is; no boolean re-boxing step is added
this ADR introduces no global namespace; `nil`'s intrinsic is compiler-injected, not programmer-bound
when the literals land, delete the `1 = 2` spellings and the NilObject-only captures
```
