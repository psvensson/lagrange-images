# ADR 0044: Object, Behavior, Class and Metaclass bootstrap

Status: accepted — the object model, with immediate Values dispatching by kind under a transient dispatch image, and `+` as ordinary lookup over a primitive-backed method.

## Problem

Symmetric Smalltalk dispatches messages, but it has no object model. What it has is a bootstrap
convention, and the convention is load-bearing in ways that will not survive contact with classes.

Today `resolveMessage` walks: receiver object → its `behavior` ref → that behavior *object* → the
behavior's **shape** → a slot whose `name` equals the selector → the Block ref in that slot. So a
"behavior" is an object whose shape's slot names are selectors.

Three things follow, and all three are checkable:

```text
adding a method            changes the behavior's shape, because the shape *is* the selector set
instance variables         and method names live in one namespace, since both are shape slots
there is no superclass     so there is no inheritance, and no `Object` to inherit from
```

There is also no class. `receiver.behavior` points at a naked object; nothing names it, nothing
describes what its instances look like, and nothing distinguishes an instance-side method from a
class-side one. `Foo new` is not expressible, because there is no object to send `new` to.

### The immediate-value wall

The sharper problem is that most receivers are not objects at all. The canonical Value set is
`boolean | integer | float64 | text | bytes | ref | pinned-ref`, and only a stored object carries a
`behavior` at all — reachable through the unpinned `ref` kind, since `isObjectRef` tests `REF` and
the dispatcher does not accept `pinned-ref`. So:

```smalltalk
3 + 4
```

cannot dispatch. `resolveMessage` requires `isObjectRef(request.receiver)` and an integer Value is
not one. This is why `+` is still unreachable from source: `integer-add` exists in the neutral IR,
but no front end emits it, and making `+` a compiler primitive would decide the Integer class's
identity as a side effect of needing arithmetic.

That is the design pressure this ADR exists to answer. The object model is not merely a feature the
language lacks; it is the thing standing between the substrate and its first ordinary program.

## Decision

### 1. A Behavior is a fixed-shape object, not a shape full of selectors

```text
Behavior
    name            text
    superclass      Behavior ref, or nil
    methods         MethodDictionary ref
    instanceShape   Shape ref, or nil
```

Its shape is fixed and known to the bootstrap, so adding a method no longer changes the behavior's
own shape, and instance variables no longer share a namespace with selectors.

### 2. A MethodDictionary keeps the selector-as-slot-name trick, deliberately

The canonical Value set has no collection and this ADR does not add one. A name-to-Block mapping is
exactly what a Shape already expresses, so a MethodDictionary is an object whose shape's slot names
are selectors and whose slots hold Block refs.

```text
MethodDictionary
    shape slot named "+"        -> Block ref
    shape slot named "value:"   -> Block ref
```

**Selector names in a MethodDictionary shape must be unique.** Generic Shapes deliberately do not
require this — `normalizeShapeSlots` rejects a duplicate slot *id* and says nothing about names — so
two slots may both be named `+` today, and a `find`-based lookup would let one silently win by
position. That is a real defect waiting in the bridge, not a hypothetical: uniqueness is a
MethodDictionary invariant, checked when a dictionary is built, and never resolved by first-wins.
The restriction stays out of generic Shape, which has other legitimate users.

Adding a method therefore writes a new shape and a new dictionary. That is genuinely expensive and
genuinely honest: the cost is visible, it is confined to one object kind, and it disappears when
collections arrive. What it buys is that the *Behavior* stays structurally stable.

### 3. Lookup walks the superclass chain, and the chain is cycle-checked

```text
selector
   |
   v
behavior.methods         hit -> that Block
   |  miss
   v
behavior.superclass      nil -> message not understood
```

A superclass chain is graph data, so it can be made cyclic; lookup detects a repeat and fails rather
than looping, exactly as lexical-environment lookup already does. Cycle detection keys on the
`(imageId, objectId)` tuple, never a joined string.

### 4. A Class is a Behavior; a Metaclass is the Behavior of a Class

The Smalltalk twist arrives now rather than later, because retrofitting it means rewriting the
`behavior` pointer of every class that already exists.

```text
anInstance  --behavior-->  Point           (a Class)
Point       --behavior-->  Point class     (its Metaclass)
Point class --behavior-->  Metaclass
Metaclass   --behavior-->  Metaclass class
Metaclass class --behavior--> Metaclass          <-- the knot
```

That last edge is a cycle, and the image can hold it: `putObject` validates that the *shape* exists
but does not require `behavior` or ref-valued slots to resolve, so the bootstrap can create these in
any order and close the loop. Verified, not assumed.

Class-side methods live in the metaclass's method dictionary, so a class-side selector is found by
exactly the decision-3 walk, with no second mechanism.

The metaclass chain is parallel to the class chain, which is what makes class-side inheritance work
at all:

```text
C superclass  = S          ->   C class superclass = S class
```

Without that rule instance-side inheritance exists and class-side inheritance silently does not.

The root class needs its own answer, because `Object superclass` is `nil` and `nil class superclass`
would be meaningless:

```text
Object superclass        = nil
Object class superclass  = Class          <-- not nil
```

So the class-side chain of any class terminates at `Class`, then continues up `Class`'s own
superclasses. That is what lets a class-side selector defined on `Class` be found from any class.

### 5. Immediate Values get their class from their kind

A Value that is not a ref still has a class. The bootstrap registers one Behavior per Value kind:

```text
boolean   -> Boolean          integer -> Integer
float64   -> Float            text    -> Text
bytes     -> ByteArray
```

Dispatch resolves a non-ref receiver by kind rather than by a `behavior` field it cannot have. This
is a dispatch rule, not a change to the Value set: no Value gains a field, nothing is boxed, and
`canonicalizeValue` is untouched. The canonical Value model stays exactly as it has been for eleven
ADRs.

Note also that only the **unpinned** `ref` kind dispatches today: `isObjectRef` tests `REF`, and
`pinned-ref` is a distinct kind that the dispatcher does not accept. This ADR does not change that.
Dispatch against a pinned historical ref is deferred explicitly rather than left ambiguous, because
"which version of the class" is a real question and answering it by accident would be worse than not
answering it.

### 5a. Which image's `Integer`? A transient dispatch image, and a discoverable kernel

An integer Value contains no `imageId`, and a message send carries only language, receiver, message
and arguments. So "the Integer class" is underdetermined until execution says which image is being
dispatched in. That is execution context, exactly as `depth` and `authority` already are — never a
field on a Value.

```text
root Block invocation             dispatch image = the Block's image
send to an object ref             dispatch image = the receiver's image
send to an immediate Value        dispatch image = the sender's dispatch image
top-level send to an immediate    requires an explicit dispatch image
```

The classes themselves must be *discoverable*, not merely returned from a bootstrap call, or the
binding dies with the process while the image survives:

```text
SmalltalkKernel        one per bootstrapped image, at a known protocol location
    nil  true  false
    booleanClass  integerClass  floatClass  textClass  byteArrayClass
```

The dispatcher knows the kernel protocol and where to find it. It never knows an `Integer` object id,
and it holds no bootstrap state of its own.

### 6. `+` is an ordinary method whose body is the existing `integer-add` op

This is the decision that makes the wall fall over, and it needs no new machinery at all.

The method is defined **semantically**, as `lagrange-code/v0`, and whatever executable Block the
bootstrap installs is derived from it:

```text
Integer >> +          semantic, lagrange-code/v0
    integer-add(
        receiver,
        argument 0
    )
                          |
                          v
    derived executable Block   (neutral-expression/v0, or a WASM function)
```

Defining it directly as a `neutral-expression` artifact would collapse semantic meaning into one
executable representation, which is precisely the separation this substrate maintains everywhere
else. `+` is no different from any other method: semantic artifact first, derived artifacts after.

So `+` becomes reachable from source *without* becoming a compiler primitive, and without the front
end learning arithmetic. The compiler keeps emitting sends; the Integer class supplies the meaning.
That is the right shape: `+` is a message, and it always was.

One proof distinction is worth stating precisely, because it is easy to overclaim. A
MethodDictionary holds one Block ref, and that Block has one executable representation. So a neutral
caller and a WASM caller sending `+` to the same Integer method both reach the *same* Block — which
does **not** demonstrate that the `+` method itself ran through each backend. Proving that requires
deriving equivalent neutral and WASM Blocks from the same semantic method and exercising both. That
is a proof obligation, not a change to the decision.

### 7. `nil`, `true` and `false` are singleton objects with well-known identity

They are ordinary objects with a shape carrying no slots, reachable by well-known ids in the image.
`nil` is the sole instance of `UndefinedObject`; `true` and `false` are the instances of `True` and
`False`.

The canonical `boolean` Value and the `true`/`false` objects remain distinct things. A boolean Value
is what `if` and `is_true` consume; the objects are what `ifTrue:` is sent to. Bridging them is
deferred (see below), because conflating them would decide the Boolean protocol as a side effect.

### 8. An unassigned temporary now reads as `nil`

ADR 0043 decision 9 made reading an unassigned temporary an explicit error, on the stated grounds
that there was no `nil` to default to. There is now, and the reason for the divergence is gone.

`UNBOUND` stays a host sentinel — it is still never a Value — but in a bootstrapped image a declared
temporary's initial contents become that dispatch image's `nil` ref. This is exactly the change ADR
0043 was shaped to allow, and it touches no cell machinery.

The boundary has to be explicit, because durable records already exist that mean "unbound":

```text
bootstrapped image        newly declared temporary -> that dispatch image's nil ref
unbootstrapped image      newly declared temporary -> UNBOUND, exactly as today
old durable {unbound}     stays unbound, stays an error, never reinterpreted as nil
new capture after boot    captures nil like any other value
```

Reinterpreting a stored `{name, unbound}` record as `nil` would be migration by interpretation —
changing what an existing artifact means without rewriting it — which is the failure mode the
representation versioning throughout this substrate exists to prevent.

Initialization happens **once, in the common activation layer**, before the neutral and WASM lanes
diverge. Four executors independently learning about `nil` is the lane-dependent-semantics mistake
ADR 0043 decision 10 forbids, and doing it in the common layer is also why this needs no new WASM
ABI: a cell that starts out holding a `nil` ref is an ordinary bound cell as far as
`cell_get`/`cell_set` are concerned.

ADR 0043 decision 9 should later carry an explicit note that it is superseded for bootstrapped
Symmetric Smalltalk execution, rather than being quietly contradicted by this one.

### 9. The bootstrap is an installer, not a hardcoded table

Well-known objects are created in an image by an explicit bootstrap function, and are found again
through the kernel object of decision 5a rather than through refs the caller happened to keep. The
dispatcher learns nothing about specific classes; it learns only the *rules* in decisions 3, 4 and 5.
An image without a bootstrap keeps working exactly as it does today.

### 10. Installing the kernel never reinterprets an existing behavior record

The legacy convention is not merely code that this ADR replaces — it is **durable graph data**. An
already-stored object's `behavior` today means "an object whose shape slot names are selectors". If
installing `SmalltalkKernel` switched how dispatch reads that field, every such object would change
meaning without a single one of its records changing.

That is migration by interpretation, and decision 8 already forbids it for old `{unbound}` captures.
It would be incoherent to forbid it there and permit it here.

So the rule is additive, and keyed on what the behavior record *is*:

```text
behavior with the fixed Behavior shape     ADR 0044 method dictionary + superclass lookup
legacy behavior object                     existing selector-as-shape-name lookup, unchanged
installing the kernel                      reinterprets nothing that already exists
```

The alternative — refusing to bootstrap an image that already holds objects — is worse. It makes the
bootstrap a one-shot decision taken at image creation, offers no migration path, and would make
"bootstrap installer" a misnomer for something closer to an image format. Dispatch instead
recognizes the two shapes and reads each as what it is, which leaves a later explicit migration free
to rewrite legacy behaviors into Behaviors on purpose, as a change to the records rather than to
their meaning.

### 11. Blocks keep their existing special case

`resolveMessage` checks for a Block record before it consults generic object behavior, so `value`
and `value:` are answered without a class. That stays true here. Turning Blocks into ordinary
`BlockClosure` instances with a real method dictionary is a later change; broadening this bootstrap
to cover it would enlarge the first object-model landing for no proof it does not already have.

## Proof

The load-bearing case, because it is the one the language has never been able to express:

```smalltalk
3 + 4                     "7, through an ordinary send, in both execution lanes"
```

If that works, `+` is a method rather than a primitive, immediate-value dispatch resolves a class
from a kind, and a method body can reach its receiver.

Then inheritance, which the current model cannot express at all:

```text
a method found on the receiver's own class
a method found on its superclass
a method overridden by a subclass, with the subclass's version winning
a selector on neither, failing as message-not-understood
a cyclic superclass chain, failing as a cycle rather than looping
```

Then the metaclass knot, which is what distinguishes a real Smalltalk from a prototype table. Two of
the obvious proofs here — `Point new` and `Point class` — are deliberately **not** used, because
they claim machinery that does not exist: `new` needs object allocation, which is a durable graph
mutation and eventually an authority question, and `class` needs an operation exposing a receiver's
behavior. Neither has a semantic operation today, and dragging both into this ADR would make the
object model's first landing depend on two undesigned primitives.

So the knot is proven with a harmless class-side method and host-side assertions:

```text
Point classMarker                     "a class-side method, found via the metaclass"
a class-side method inherited from a superclass's metaclass
a class-side override winning over the inherited one
behavior(Point)            == Point class
behavior(Point class)      == Metaclass
behavior(Metaclass class)  == Metaclass          "the cycle holds and resolves"
the bootstrap closes its own cycle               "created in any order"
```

Then the singletons and their consequence:

```smalltalk
| x |
x                          "nil, not an error"
```

Also required:

- adding a method to a class does not change the Behavior object's shape
- instance variables and selectors no longer collide, so a class may hold a slot named like a
  selector it also implements
- a MethodDictionary shape with two slots named alike is rejected, rather than one winning by
  position
- a temporary in a bootstrapped image reads `nil`, while an image without a bootstrap still raises
  `UnboundBindingError`, and a durable `{unbound}` capture written before the bootstrap keeps raising
- an object stored under the legacy behavior convention keeps dispatching through it after the
  kernel is installed in its image, with its records untouched and its answers unchanged
- `+` sent from source, with the method's semantic artifact derived into both a neutral and a WASM
  executable Block, and both proven — not merely one Block reached from two callers
- both execution lanes agree, per the standing rule, and equivalent failures agree in reason as well
  as in fact

## What is deferred

- `ifTrue:`/`ifFalse:` and the bridge between the `boolean` Value and the `True`/`False` objects.
  That is a protocol decision, and decision 7 deliberately stops short of it
- collections, and therefore a MethodDictionary that is not a shape
- `doesNotUnderstand:` as a reified message; for now a missing selector is an explicit failure
- `new`/`basicNew`, which need an allocation semantic operation, and with it the question of whether
  allocation is authority-governed
- `class` as a message, which needs an operation exposing a receiver's behavior
- dispatch against a `pinned-ref` receiver, which needs a decision about which historical version of
  a class applies
- Blocks as ordinary `BlockClosure` instances, per decision 10
- class variables, class instance variables and traits
- becoming/migration when a shape changes under existing instances
- the bootstrap *image* as a distributable artifact, as opposed to the bootstrap function

## Guardrails

```text
a Behavior has a fixed shape; a MethodDictionary's shape is its selector set
instance variables and selectors are different namespaces
lookup walks superclasses and detects cycles by (imageId, objectId) tuple
a Class is a Behavior; a Metaclass is the Behavior of a Class
C class superclass == S class, and Object class superclass == Class
the metaclass knot is a real cycle, and the image may hold it
MethodDictionary selector names are unique; never first-wins
the dispatch image is execution context, never a field on a Value
the kernel object is discoverable in the image, not a ref the caller kept
only unpinned refs dispatch; pinned historical dispatch is undecided
a method is semantic first; executable Blocks are derived from it
an immediate Value gets its class from its kind, and gains no field
the Value set is unchanged: no boxing, no nil kind, no collection kind
`+` is a method whose body is integer-add, never a compiler primitive
nil, true and false are objects; a boolean Value is not the true object
UNBOUND stays a host sentinel and never becomes a Value
nil initialization happens once in the common activation layer, not per executor
an old durable {unbound} record is never reinterpreted as nil
the bootstrap is an installer; the dispatcher knows rules, not class names
installing the kernel reinterprets no existing behavior record
a legacy behavior keeps legacy lookup; migration rewrites records, never meanings
both lanes agree on results and on failure reasons
```
