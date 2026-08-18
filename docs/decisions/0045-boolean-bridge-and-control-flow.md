# ADR 0045: The Boolean bridge and message-send control flow

Status: implemented — the boolean bridge, `effectiveReceiver` on a dispatch resolution, and the four conditional selectors as ordinary methods on True and False, in both execution lanes.
Proven by: test/smalltalk-control-flow.test.js, test/message-dispatch.test.js, test/smalltalk-builder-recovery.test.js

## Problem

ADR 0044 decision 7 created `true` and `false` as durable singleton objects and then stopped:

> The canonical `boolean` Value and the `true`/`false` objects remain distinct things. A boolean
> Value is what `if` and `is_true` consume; the objects are what `ifTrue:` is sent to. Bridging them
> is deferred (see below), because conflating them would decide the Boolean protocol as a side
> effect.

A boolean Value dispatches through `Boolean` exactly as an integer dispatches through `Integer`, so
`True` and `False` exist in the graph, inherit from `Boolean` and carry method dictionaries that no
send can ever reach — unless a program is already holding a ref to the singleton, which is precisely
the case a language with boolean *literals* never produces:

```text
{kind:"boolean", value:true}   --dispatch by kind-->   Boolean     every boolean send lands here
kernel.true (an object)        --behavior-->           True        only if you hold the ref
```

That leaves Symmetric Smalltalk with no source-level conditional at all. The substrate has one:
`lagrange-code/v0` has an `if` op, both lanes implement it, and the neutral executor requires its
condition to be a boolean Value. But no front end emits it, because emitting it would mean the
compiler recognising `ifTrue:` — and the whole point of ADR 0044 decision 6 was that `+` reached
source *without* becoming a compiler primitive. Doing the opposite for conditionals one ADR later
would be incoherent.

So the question is not "how does Symmetric Smalltalk branch". It is which of three things a
conditional *is*:

```text
a compiler special case      the front end recognises ifTrue: and emits the if op
a primitive on Boolean       Boolean >> ifTrue:ifFalse: is a method whose body is the if op
a polymorphic method         True and False each implement it, and dispatch does the branching
```

The first is rejected on ADR 0044 decision 6's grounds. The second works and is cheap, and it is
worth being precise about why it is still wrong: it would make `Boolean` the only class in the image
whose subclasses exist for no reason, it would keep control flow inside the execution IR where a
program cannot extend it, and it would leave the `True`/`False` singletons as decoration. This ADR
takes the third.

## Decision

### 1. Canonical boolean Values do not change

No Value kind is added, removed or altered. A boolean is `{kind:"boolean", value:true}` everywhere:
in a slot, in an argument, in an `if` condition, in a WASM handle, on the way in and on the way out.
There is no boxing, no durable wrapper object, and no graph identity for a boolean.

That is the load-bearing constraint, not a preamble. Everything below is arranged so that a program
can send a message to a boolean and get the *same Value* back:

```smalltalk
[ :flag | flag ifTrue: [ flag ] ifFalse: [ flag ] ]      "answers the boolean Value, unchanged"
```

### 2. The bridge is a transient, language-owned receiver nomination

When Symmetric Smalltalk dispatches a message whose receiver is a boolean Value, the language
personality nominates the corresponding kernel singleton as the *effective receiver* of that one
send:

```text
canonical boolean true
        |
        |  Symmetric Smalltalk message-send boundary  (this send only)
        v
kernel.true object
        |
        v
True behavior
```

Nothing outside that boundary observes it. The request still carries the boolean Value, the
argument the caller passed is still a boolean Value, and another language personality dispatching
the same Value receives the boolean and nothing else. The bridge is a rule inside one dispatcher,
not a property of the Value and not a change to `canonicalizeValue`.

Which image's `true`? The one ADR 0044 decision 5a already answers with: the dispatch image. An
immediate Value carries no image, so the same execution context that says which `Integer` applies
says which `true` applies. The bridge introduces no new context and never changes the dispatch image
— the singleton lives in the dispatch image, so a nested send from inside `True >> ifTrue:` inherits
exactly the image it would have inherited anyway.

### 3. The effective receiver is the *actual* receiver of the method

`self` inside `True >> ifTrue:` is the `true` object, not a boolean Value whose class lookup merely
pretended to be `True`. This is the distinction that makes the bridge worth building rather than
faking, and it will start mattering the moment `True` and `False` acquire protocol beyond
conditionals: a method that stores `self`, compares it, or passes it on must be passing the object.

### 4. Source conditionals are ordinary sends, and the kernel implements them

The compiler learns nothing. `ifTrue:`, `ifFalse:`, `ifTrue:ifFalse:` and `ifFalse:ifTrue:` are
selectors like any other, parsed as keyword messages, compiled to `send` expressions, resolved by
the ordinary ADR 0044 walk, and answered by methods on `True` and `False`:

```smalltalk
True  >> ifTrue: aBlock                     ^aBlock value
False >> ifTrue: aBlock                     ^nil

True  >> ifFalse: aBlock                    ^nil
False >> ifFalse: aBlock                    ^aBlock value

True  >> ifTrue: t ifFalse: f               ^t value
False >> ifTrue: t ifFalse: f               ^f value

True  >> ifFalse: f ifTrue: t               ^t value
False >> ifFalse: f ifTrue: t               ^f value
```

That notation is how the methods read, not how they are written: Symmetric Smalltalk has no
method-definition syntax yet, so each one is installed as a semantic `lagrange-code/v0` program
whose executable Block is derived per lane, exactly as `+` is under ADR 0044 decision 6.

The block argument is invoked through the existing ordinary value path — a `send` of `value`, which
ADR 0044 decision 11 already answers without a class. So the whole conditional is: one dispatch that
picks a class, one dispatch that runs a block. There is no selector special case anywhere in the
compiler, the semantic representation, the executor registry or either lane.

The four selectors ship together. Three of them are named in the problem this ADR exists to answer;
`ifFalse:ifTrue:` is the mirror of one of those and omitting it would be an arbitrary hole rather
than a deferral.

### 5. The `if` operation keeps its jobs, and loses one of them

`lagrange-code/v0`'s `if`, the neutral executor's boolean-condition check and the WASM lane's branch
are all unchanged and all still useful: they are the lower-level semantic primitive that other
language personalities and compiler-generated code use. What changes is that they stop being how
*Symmetric Smalltalk source* expresses a conditional. That was never true in practice, since no
front end emitted `if`; this ADR makes it true by decision, so a later front-end optimisation that
lowered `ifTrue:` to `if` would be a deliberate change with a name rather than a quiet regression to
the rejected design.

### 6. `nil` on the untaken branch is a captured ref, not an IR operation

The one-arm forms have to answer something, and in Smalltalk that something is `nil`. The obvious
shortcut is a `nil` op in the common IR, and it is the wrong shortcut: `lagrange-code` is
language-neutral, and "absence" is a language's answer, not the substrate's. Adding a Smalltalk
`nil` to a shared grammar would teach every other personality what one language means by absence.

So `nil` arrives the way any other object arrives in a Block: as an ordinary captured binding.

```text
False >> ifTrue: aBlock
    captures    [{id: "smalltalk/control-flow/nil", name: "nil"}]
    body        binding("smalltalk/control-flow/nil")
    environment {smalltalk/control-flow/nil -> ref(app, smalltalk/nil)}
```

Both lanes already have exactly this machinery and neither needs a change: the neutral executor
resolves a `binding` through the Block's lexical environment, and the WASM lane passes captures as
trailing Value-handle parameters resolved from the same environment. A ref is a Value, so a
ref-valued capture is not a special case. `nil` therefore stays in the object graph, which is where
ADR 0044 decision 7 put it.

This means a method may now carry captures at all, which `defineMethods` did not previously support.
That is a builder capability, not a new representation — the semantic program already declares
`captures`, and the durable environment is an ordinary `putLexicalEnvironment` record written
ensure-exact-or-create like every other write in that sequence.

### 7. The generic substrate change: a resolution may name an effective receiver

This is the one change outside the language personality, and it is deliberately minimal.

```text
dispatch resolution:
    block
    effectiveReceiver?      absent -> the original request receiver
```

`InvocationService` installs `resolution.effectiveReceiver ?? request.receiver` into the activation.
For every send in the substrate today the key is absent and nothing changes. The alternative — the
dispatcher rewriting the receiver on the request — would make the request a mutable thing and would
lose the distinction between what was sent and what is running.

Three constraints keep this from becoming a general receiver-rewriting facility:

```text
must be an unpinned object ref     nominating an immediate Value would substitute one for another
                                   with nothing to detect it, and the purpose is to name an object
transient, never durable           it appears in an activation, never in a record, never on a Value
never changes the dispatch image   an immediate receiver's dispatch image is the sender's, and the
                                   nominated object lives in that image by construction
```

The ref restriction is the narrow choice on purpose. Relaxing it later is easy; discovering that a
personality has been quietly swapping integers is not.

### 8. Booleans no longer dispatch by kind

ADR 0044 decision 5 mapped all five non-ref Value kinds to a kernel class. The boolean row is
superseded here: a boolean resolves its behavior through the singleton object's `behavior` edge,
exactly as any object receiver does, and the other four kinds are untouched.

```text
integer, float64, text, bytes      class from kind          (ADR 0044 decision 5, unchanged)
boolean                            singleton, then its behavior edge   (this ADR)
```

`Boolean` does not become unreachable, and that matters: `True` and `False` inherit from it, so a
method defined on `Boolean` is still found from a boolean Value by the ordinary superclass walk. The
kernel's `booleanClass` slot stays, because it is how a program names the class. What is gone is the
*dispatch path* that treated a boolean as a classless immediate.

### 9. Kernel control-flow methods are installed, not bootstrapped

`installSmalltalkKernel` keeps creating identity only — classes, singletons, empty dictionaries. The
conditional methods are installed by a separate explicit call, per lane, exactly as `+` is defined by
`defineMethods` rather than by the kernel installer. An image with a kernel but no control-flow
protocol is a coherent state that fails as message-not-understood, not as a broken bootstrap.

## Proof

The conditional itself, from source, through the ordinary send path, in both lanes:

```smalltalk
[ :flag | flag ifTrue: [ 'yes' ] ifFalse: [ 'no' ] ]      "'yes' and 'no'"
[ :flag | flag ifTrue: [ 1 ] ]                            "1, and nil"
[ :flag | flag ifFalse: [ 1 ] ]                           "nil, and 1"
[ :flag | flag ifFalse: [ 1 ] ifTrue: [ 2 ] ]             "2, and 1"
```

Then the things that distinguish this design from the ones it rejected:

```text
self inside True >> ... is the true object, compared as a full ref against kernel.true
the same holds for false, and the two are distinguishable
a boolean Value passed through a conditional comes back out as the identical boolean Value
a method defined on Boolean is found from a boolean Value, through True's superclass edge
a method defined on True overrides the one on Boolean, for true only
sending directly to the kernel.true *ref* answers the same method, with no bridge involved
the compiler emits a send: the semantic artifact for the source contains no `if` op
```

And the boundaries:

```text
another language personality dispatching a boolean receives the boolean Value, not a singleton
a boolean send in an image with no kernel still fails as SmalltalkKernelMissingError
a selector missing on True names the singleton in its message, not "a boolean Value"
an effectiveReceiver that is not an unpinned object ref is refused by the invocation service
a resolution with an unknown key is still refused
```

Both lanes, per the standing rule: each conditional method is derived independently into a
neutral Block and a WASM Block and executed through both. The WASM proof includes a **non-tail**
block invocation —

```smalltalk
[ :flag | (flag ifTrue: [ 1 ] ifFalse: [ 2 ]) + 10 ]
```

— where the conditional's result feeds a further send, so the send effect cannot be a tail call and
the resumable ABI carries it. That is the case a tail-only proof would miss entirely.

The publication sequence for a capture-bearing method is enumerated rather than sampled, in the
existing recovery sweep: every write is interrupted, including the new lexical-environment write and
including a commit-then-throw that models a lost acknowledgement, after which an identical
definition must be idempotent.

## What is deferred

- `not`, `and:`, `or:` and the rest of the boolean protocol. These run the bridge *backwards*: a
  method that answers a boolean must decide whether it answers the canonical Value or the singleton,
  and answering the singleton would break every `if` in the substrate while answering the Value
  would make `True >> not` a method that cannot name its own answer without a literal. That is a
  real decision and it is not this one
- `whileTrue:`, which needs either recursion depth this substrate does not yet have or a loop
  semantic, and is a separate question from choosing a branch
- `true`, `false` and `nil` as source literals. They are compiler surface, like cascades. When they
  arrive, `true` must evaluate to the canonical boolean Value — evaluating it to the singleton would
  make the two spellings of a boolean observably different and undo decision 1
- `ifTrue:` sent to a non-boolean, which is `doesNotUnderstand:` and stays deferred with it
- the bridge for any other Value kind. Nothing else has a singleton to bridge *to*, and inventing
  one for integers is the boxing decision 1 refuses
- an effective receiver that is not an object ref, and any use of the seam other than this one

## Guardrails

```text
a boolean Value is never boxed, wrapped or given graph identity
the bridge is transient and per-send; the request still carries the boolean
only the Symmetric Smalltalk dispatcher bridges; other personalities see the boolean
self inside True/False protocol is the singleton object, not a boolean Value
the dispatch image decides which image's true; the bridge never changes it
effectiveReceiver is an unpinned object ref, absent by default, and never durable
the compiler knows no conditional selector; a conditional is a send in the semantic artifact
the `if` op keeps its meaning and its boolean-Value condition, for other producers
nil on an untaken branch is a captured ref, never an op in the common IR
Boolean stays reachable through True and False's superclass edge
kernel control-flow methods are installed explicitly, never by the kernel bootstrap
both lanes prove every conditional method, including a non-tail block send
```
