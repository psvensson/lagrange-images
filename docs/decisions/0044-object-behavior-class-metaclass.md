# ADR 0044: Object, Behavior, Class and Metaclass bootstrap

Status: proposed — the object model the language has been deferring to, and the first thing that
makes `3 + 4` an ordinary message send.

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
`boolean | integer | float64 | text | bytes | ref | pinned-ref`, and only the two ref kinds can carry
a `behavior`. So:

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

Class-side methods live in the metaclass's method dictionary, which is what makes `Point new` an
ordinary send.

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

### 6. `+` is an ordinary method whose body is the existing `integer-add` op

This is the decision that makes the wall fall over, and it needs no new machinery at all:

```text
Integer >> + aNumber
    body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}}
```

A method Block whose code is a `neutral-expression` artifact using `integer-add` on the receiver and
its argument. Every piece of that already exists and already runs in both execution lanes.

So `+` becomes reachable from source *without* becoming a compiler primitive, and without the front
end learning arithmetic. The compiler keeps emitting sends; the Integer class supplies the meaning.
That is the right shape: `+` is a message, and it always was.

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

`UNBOUND` stays a host sentinel — it is still never a Value — but a declared temporary's initial
contents become the `nil` ref. This is exactly the change ADR 0043 was shaped to allow, and it
touches no cell machinery.

### 9. The bootstrap is an installer, not a hardcoded table

Well-known objects are created in an image by an explicit bootstrap function that returns their
refs. The dispatcher learns nothing new about specific classes; it learns only the *rules* in
decisions 3 and 5. An image without a bootstrap keeps working exactly as it does today.

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

Then the metaclass knot, which is what distinguishes a real Smalltalk from a prototype table:

```text
Point new                             "class-side method found on the metaclass"
Point class class == Metaclass        "the knot holds"
the bootstrap closes its own cycle    "created in any order, resolving afterwards"
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
- both execution lanes agree, per the standing rule, and equivalent failures agree in reason as well
  as in fact

## What is deferred

- `ifTrue:`/`ifFalse:` and the bridge between the `boolean` Value and the `True`/`False` objects.
  That is a protocol decision, and decision 7 deliberately stops short of it
- collections, and therefore a MethodDictionary that is not a shape
- `doesNotUnderstand:` as a reified message; for now a missing selector is an explicit failure
- class variables, class instance variables and traits
- becoming/migration when a shape changes under existing instances
- the bootstrap *image* as a distributable artifact, as opposed to the bootstrap function

## Guardrails

```text
a Behavior has a fixed shape; a MethodDictionary's shape is its selector set
instance variables and selectors are different namespaces
lookup walks superclasses and detects cycles by (imageId, objectId) tuple
a Class is a Behavior; a Metaclass is the Behavior of a Class
the metaclass knot is a real cycle, and the image may hold it
an immediate Value gets its class from its kind, and gains no field
the Value set is unchanged: no boxing, no nil kind, no collection kind
`+` is a method whose body is integer-add, never a compiler primitive
nil, true and false are objects; a boolean Value is not the true object
UNBOUND stays a host sentinel and never becomes a Value
the bootstrap is an installer; the dispatcher knows rules, not class names
both lanes agree on results and on failure reasons
```
