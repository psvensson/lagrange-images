# ADR 0046: Allocation, initialization and class introspection

Status: accepted — `basicNew`, `new` and `class` stay ordinary Smalltalk messages; allocation and class lookup use language-owned primitive Blocks behind those methods, instance shape is explicit durable class data, and image-native allocation is not an ADR 0037 capability check.

## Problem

ADR 0044 made classes real graph objects and deliberately stopped before `Point new`:

```text
Point                a Class / Behavior object
Point instanceShape  Shape ref, or nil
Point class          the Behavior of Point
```

ADR 0045 then proved that ordinary Smalltalk control flow can stay ordinary dispatch even when the
implementation needs a host-side semantic bridge. The next missing operation is object construction,
and it looks smaller than it is:

```smalltalk
Point basicNew
Point new
anObject class
```

Those three messages hide several independent decisions:

- what makes a Behavior instantiable rather than merely a Behavior
- whether `nil` means "empty instance" or "not instantiable"
- whether an instance shape contains only locally declared slots or the complete inherited layout
- what values newly allocated slots contain
- where object identity comes from
- whether allocation is an ADR 0037 capability-gated host effect
- whether `new` is atomic with `initialize`
- how `class` works for both object refs and immediate Values without teaching the generic object
  model Smalltalk's class table
- how the image-native WASM lane reaches allocation without adding a Smalltalk-specific operation to
  the shared `lagrange-code` grammar or another WASM ABI merely for one language primitive

The tempting shortcuts all decide too much accidentally.

A compiler special case for `new` would undo the ordinary-message direction of ADRs 0044 and 0045.
A generic `object-slot` operation would let language code bypass encapsulation merely so `basicNew`
could read `instanceShape`. A Smalltalk-specific `allocate-instance` operation in `lagrange-code`
would teach the shared semantic IR one personality's class representation. Requiring ADR 0037
authority only for allocation would make pure Smalltalk unable to construct ordinary objects while
closure materialization already creates durable image records without that authority.

This ADR separates those concerns instead.

## Decision

### 1. `basicNew`, `new` and `class` are ordinary messages

The parser and source compiler learn no new selector and no allocation syntax.

```smalltalk
Point basicNew
Point new
anObject class
```

compile as ordinary sends and dispatch through the same Behavior/MethodDictionary walk as `+` and
`ifTrue:`.

There is no dispatcher special case for any of the three selectors.

The protocol is installed explicitly after kernel identity exists, just as ADR 0045 installs
conditionals after the bootstrap. An image with a kernel and no allocation protocol is coherent: it
answers these messages only if some installed method does.

### 2. Host-sensitive Smalltalk primitives are language-owned Blocks, not common-IR operations

Allocation and class introspection need image semantics that are not naturally expressible in the
shared IR. The answer is a language-owned primitive Block representation, conceptually:

```text
smalltalk-kernel-primitive/v1
    class-of
    basic-new
```

Each image that installs the protocol gets image-local primitive Blocks with stable protocol identity.
They are ordinary Blocks for invocation purposes, but their code is executed by a
Symmetric-Smalltalk-owned executor rather than by the neutral expression or Lagrange-WASM executor.

The visible methods remain semantic `lagrange-code` programs and capture those primitive Block refs:

```text
Object >> class
    primitiveClassOf value: self

Class >> basicNew
    primitiveBasicNew value: self
```

This matters for three reasons.

First, method semantics stay ordinary and inspectable: `class` and `basicNew` are found through method
lookup, not by selector recognition in the compiler or dispatcher.

Second, both neutral and Lagrange-WASM method implementations use the same ordinary `value:` send to
the primitive Block, so the existing send/resumption machinery carries the host effect. No new
Lagrange-WASM ABI is introduced merely for allocation.

Third, the common `lagrange-code` grammar learns nothing about Smalltalk's Behavior slot layout.
A language-owned primitive may inspect that layout because the language owns its meaning; the generic
executor does not.

The primitive Blocks themselves are implementation artifacts of the language kernel, not authority,
not object identity, and not hidden metadata. Methods reach them through explicit captured refs in
the ordinary lexical-environment graph.

### 3. An allocatable class is a fixed-shape Behavior with a non-`nil` `instanceShape`

ADR 0044 already gave every Behavior this slot:

```text
instanceShape   Shape ref, or nil
```

This ADR gives `nil` its allocation meaning:

```text
instanceShape == kernel.nil     not instantiable by basicNew
instanceShape == Shape ref      allocatable with exactly that layout
```

`nil` does **not** mean the empty shape. Reinterpreting it that way would change the meaning of every
Behavior already stored by ADR 0044 without rewriting a record.

An instantiable class with no instance slots therefore points explicitly at the image's empty Shape.
The difference is load-bearing:

```text
nil ref          no instance layout / basicNew refuses
empty Shape ref  a valid zero-slot instance layout / basicNew succeeds
```

There is no separate nominal `isClass` flag. In the symmetric object model, the allocation-relevant
fact is whether the receiver is a well-formed fixed-shape Behavior with an instance layout. Ordinary
message lookup still makes `Class >> basicNew` the normal route; the primitive independently validates
its receiver so direct Block invocation cannot bypass the object-model contract.

### 4. `instanceShape` is the complete immutable layout of an instance

Allocation does not walk the superclass chain to discover slots.

A class's `instanceShape` is the complete Shape an instance record will carry, including inherited
slots as well as slots introduced by the class itself.

```text
Superclass.instanceShape slots = [a, b]
Subclass adds              = [c]
Subclass.instanceShape     = [a, b, c]   // complete layout
```

Inheritance is compared by stable slot **id**, never by source name. The class-definition path owns
layout composition and must preserve inherited slot ids. Allocation merely consumes the already
settled Shape.

This keeps allocation simple and makes the durable record truthful: an object's own Shape is enough
to validate every slot it contains.

Changing the instance layout of an existing class remains explicit graph migration. This ADR does not
reinterpret `instanceShape`, mutate Shapes in place, or decide becoming/migration for existing
instances.

For the current builder, omission of an instance shape keeps the existing meaning and stores
`kernel.nil`. A caller that wants an instantiable class supplies an explicit local Shape ref. That
preserves retry/exactness semantics for class definitions created before this ADR instead of silently
turning every old class into an empty class.

### 5. `basicNew` creates one ordinary object and initializes every slot to that image's `nil`

For an allocatable class ref `C` in image `I`, the primitive performs conceptually:

```text
class      = readBehavior(C)
shapeRef   = class.instanceShape
require shapeRef != kernel.nil
shape      = resolve Shape(shapeRef)

object.id       = fresh opaque identity
object.shape    = shapeRef
object.behavior = C
object.slots    = every shape slot id -> kernel.nil
```

The result is the new object's ordinary unpinned ref.

The instance is not boxed, wrapped or given a Smalltalk-specific generic object kind. It is the same
language-neutral object record every other graph operation sees.

All slots begin as `nil`, including inherited slots. `UNBOUND` is lexical-cell machinery and never
appears in object slots.

The primitive validates before writing:

- receiver is an unpinned local ref in the primitive Block's image
- receiver resolves to a well-formed fixed-shape Behavior
- `instanceShape` is not that image's `nil`
- the Shape ref is local and resolves

A malformed Behavior, a missing Shape and a non-instantiable class are distinct failures rather than
being collapsed into a generic allocation error.

### 6. Allocation identity is fresh, opaque and non-deterministic

Ordinary instances are not named declarations. Their identity must therefore not be derived from the
class name, call site, selector, source position or slot values.

The allocation primitive chooses a fresh host-generated opaque object id, with `randomUUID()` as the
v1 default. The identity generator is runtime machinery, not durable class semantics; tests may inject
a deterministic generator.

Creation uses create-once storage semantics. A candidate id that already exists is never overwritten.
A genuine identity collision chooses another fresh candidate rather than treating the existing object
as an idempotent retry.

This is deliberately different from bootstrap and method installation. Those operations describe a
named durable thing and therefore use deterministic ids plus ensure-exact-or-create. `basicNew`
means "make another object"; two successful sends must produce two distinct identities even when every
input is identical.

### 7. `basicNew` is not idempotent across separate root executions

Fresh allocation is an effect.

```text
Point basicNew. Point basicNew.    -> two objects
```

A caller retrying an entire failed root invocation may allocate again. This ADR does not invent a
durable invocation id or exactly-once transaction spanning arbitrary message sends merely to hide
that fact.

Within one live execution, compiler-generated suspension/resumption must not replay a completed
allocation effect. That is the same requirement already imposed on other host effects: resume
continues after the effect; it does not re-execute the effect to rediscover its value.

The primitive chooses the candidate identity before its create-once write. If a future backend adds
transparent retry inside that one host operation, it must retry the same candidate rather than minting
one object per transport attempt.

A commit whose acknowledgement is lost may leave an allocated object after the activation fails. That
is not silently converted into a different semantic guarantee. Reachability/garbage collection is the
mechanism that may later reclaim such abandoned instances.

### 8. `new` is ordinary composition: `basicNew` followed by `initialize`

The minimal protocol is:

```smalltalk
Object >> initialize
    ^self

Class >> new
    ^self basicNew initialize
```

`new` is not a second allocation primitive.

It is an ordinary semantic method. In the WASM lane the result of the `basicNew` send feeds the later
`initialize` send, so this naturally exercises the existing resumable non-tail send machinery.

A subclass may override `initialize` by ordinary method lookup. `new` returns whatever `initialize`
returns because that is what the message composition says; the runtime does not secretly substitute
the newly allocated object afterwards.

Allocation and initialization are **not one transaction**. Once `basicNew` commits, an exception or
failure in `initialize` does not roll the object record back. Making `new` atomic would require a
transaction across arbitrary user message execution and would make a simple library method secretly
special.

Again, eventual graph reachability/GC is the right mechanism for abandoned failed-initialization
instances, not hidden rollback semantics inside `new`.

### 9. `class` returns the receiver's Smalltalk class without boxing immediate Values

`Object >> class` is an ordinary method that calls the image-local `class-of` primitive Block with
`self`.

The primitive answers according to the actual method receiver:

```text
ordinary object ref   -> object.behavior
integer Value         -> kernel.integerClass
float64 Value         -> kernel.floatClass
text Value            -> kernel.textClass
bytes Value           -> kernel.byteArrayClass
boolean Value         -> True or False class semantics, per ADR 0045
```

The boolean case usually arrives as an object ref rather than as a canonical boolean: ADR 0045 makes
`true`/`false` the effective receiver of a Smalltalk send, so inherited `Object >> class` sees the
singleton and returns its behavior (`True` or `False`). A direct low-level call of the primitive with
a boolean Value must produce the same language answer rather than resurrect the superseded
`boolean -> Boolean` dispatch rule.

The object-ref rule also gives the metaclass answers without any table:

```text
anInstance class     -> Point
Point class          -> Point class
(Point class) class  -> Metaclass
Metaclass class      -> Metaclass class
```

Only unpinned refs participate. Historical `pinned-ref` class semantics remain deferred with pinned
receiver dispatch.

`class` exposes identity already used by dispatch; it grants no authority and does not mutate the
receiver or class.

### 10. Image-native `basicNew` is not gated by ADR 0037 execution authority in v1

This is a deliberate decision, not an omission.

ADR 0037 authority governs capabilities exposed as host operations to an execution. Pure language
execution with no authority context remains valid, and a missing authority context means only that
capability-requiring host operations fail closed.

Image-native object construction is part of the language's own semantics. The image-native runtime
already creates durable lexical environments and Blocks when a program materializes closures, with no
`object/create` grant. Requiring authority only for `basicNew` would therefore create this incoherent
split:

```text
create a closure          ordinary language semantics, no grant
create an ordinary object capability-gated host effect
```

and a no-authority Smalltalk program could evaluate blocks but could not construct its own objects.

So the language-owned allocation primitive does not call `require` in v1.

This does **not** mean `ref == authority`, and it does not create a general object-creation capability.
The reason is the semantic boundary, not possession of the class ref.

If object creation is later exposed to foreign code, Components, external service interfaces or a
cross-image mutation API, that is a different boundary and should use an explicit authorized
`object/create` contract. Its likely useful granularity is class-scoped — permission to instantiate a
particular class — but that decision belongs to the external creation lane rather than being smuggled
into image-native `basicNew`.

Likewise, if image-native code eventually needs sandboxing for durable effects, the policy must cover
those effects coherently — allocation, closure materialization and other graph creation — rather than
retroactively treating this one primitive as special.

Storage quotas and resource limits are also not authority grants. They may reject allocation for
operational reasons without changing who is semantically permitted to execute `basicNew`.

### 11. Allocation stays in the receiver class's image

The primitive Block is image-local, and its class argument must be a ref in that same image.
`instanceShape` and `nil` are already local under ADR 0044.

Therefore one allocation produces one object in one image:

```text
class.imageId == shape.imageId == nil.imageId == newObject.imageId
```

No cross-image Shape, superclass walk or remote instance construction is hidden inside `basicNew`.
A send to a class object in another image already changes the dispatch image to that receiver's image;
if that image has the allocation protocol installed, its own primitive performs the allocation there.

This does not decide cross-image inheritance or distributed routing. It simply keeps allocation's
graph mutation local to the class whose layout defines the object.

### 12. Allocation protocol installation is separate from kernel bootstrap

`installSmalltalkKernel()` remains identity/bootstrap machinery. It does not gain executable primitive
Blocks or methods.

A separate allocation/class protocol installer owns:

```text
image-local primitive Blocks:
    class-of
    basic-new

semantic methods, derived per lane:
    Object >> class
    Object >> initialize
    Class  >> basicNew
    Class  >> new
```

The primitive Blocks are lane-independent host implementations. The methods that call them are still
derived into neutral and WASM executable Blocks from the same semantic definitions, and both lanes
must be proven.

This mirrors ADR 0045's installer-not-bootstrap rule: bootstrap establishes identity; protocol is an
explicit later layer.

## Consequences for class definition

The existing `defineClass()` default remains non-instantiable for compatibility: if no instance Shape
is supplied, `instanceShape` remains `kernel.nil`.

The implementation of this ADR should extend class definition with an explicit local
`instanceShapeRef` (or an equivalently explicit complete Shape description) and validate it before
writing the class/metaclass pair.

For a zero-slot class, callers use the explicit empty Shape ref. For a subclass whose superclass has a
non-`nil` instance Shape, class definition validates that the subclass's complete Shape preserves all
inherited stable slot ids. Allocation itself does not perform this hierarchy check on every object
creation.

A later source-level class-definition syntax may construct those Shapes for the programmer, but that
surface syntax is not required to settle allocation semantics.

## Proof required for implementation

The implementation PR should prove at least:

```text
Point with an explicit empty instance Shape
    Point basicNew -> fresh ref whose behavior == Point and shape == empty Shape
    Point basicNew twice -> two different refs
    Point new -> initialize is sent to the new instance

Point with slots x/y
    every allocated slot starts at kernel.nil
    host inspection shows exact Shape/slot agreement

non-instantiable class
    instanceShape == kernel.nil -> explicit basicNew failure, nothing written

bad graph
    dangling instanceShape -> graph/incomplete-state failure, not "not instantiable"
    malformed class Behavior -> malformed-Behavior failure

class protocol
    instance class == Point
    Point class == Point class
    Point class class == Metaclass
    integerValue(3) class == Integer
    booleanValue(true) class == True
    booleanValue(false) class == False

ordinary method semantics
    compiler recognizes no new/basicNew/class selector
    Object >> initialize may be overridden
    Class >> new is basicNew then initialize
    initialize failure does not roll back the already-created object

both execution lanes
    the same semantic methods are derived into neutral and WASM Blocks
    WASM `new` exercises a non-tail basicNew result feeding initialize
    allocation is performed once across suspension/resumption

primitive boundary
    direct basic-new primitive call validates receiver locality/Behavior/instanceShape
    primitive Blocks from another image cannot allocate this image's class
    pinned refs remain unsupported

authority boundary
    pure image-native new succeeds with no authority context
    no new foreign object/create surface appears as a side effect
```

The usual publication rules also apply to installation of primitive Blocks and protocol methods:
deterministic kernel-protocol records are ensure-exact-or-create, lost acknowledgement is idempotent,
and the write sequence is covered by the recovery sweep rather than sampled at convenient points.

## What is deferred

- source-level class-definition syntax and instance-variable read/write syntax
- changing the instance Shape of an existing class and migrating existing instances
- `basicNew:` / variable-sized indexed objects
- Array/String/collection allocation policy
- making currently non-instantiable kernel classes such as `Object` explicitly instantiable; doing so
  requires rewriting their stored `instanceShape`, not reinterpreting `nil`
- metaclass allocation and constructing new Class/Metaclass objects from inside Smalltalk
- object deletion
- garbage collection/reclamation of unreachable or failed-initialization instances
- allocation quotas and resource accounting
- an authorized foreign/external `object/create` lane
- image-native sandbox policy covering all durable language effects
- durable invocation identity / exactly-once retries across failed root executions
- pinned-ref `class` and allocation semantics

## Guardrails

```text
new/basicNew/class are messages; the compiler and dispatcher know no selector special case
host-sensitive Smalltalk semantics live behind language-owned primitive Blocks, not Smalltalk ops in lagrange-code
primitive Blocks are explicit graph refs captured by methods, never hidden metadata
instanceShape nil means non-instantiable; empty Shape means a valid zero-slot layout
instanceShape is the complete immutable instance layout; allocation never reconstructs it from superclasses
basicNew sets shape = class.instanceShape, behavior = class, and every slot = that image's nil
UNBOUND is never an object-slot initializer
ordinary instance ids are fresh opaque identities, never deterministic declaration ids
basicNew is an effect and separate root retries may allocate separate objects
resumption continues after one allocation effect; it never replays a completed allocation
new is ordinary basicNew-then-initialize composition and is not transactionally rolled back
class returns graph behavior for refs and the image's class semantics for immediate Values
ADR 0045 remains load-bearing: true class == True and false class == False without boxing the boolean Value
image-native allocation is not an ADR 0037 capability check; external object creation is a separate future boundary
ref != authority remains true; lack of an allocation grant is a language-boundary decision, not ref-derived permission
allocation is image-local to the receiver class and its instance Shape
bootstrap creates identity; allocation/class protocol is installed explicitly afterwards
old instanceShape == nil records are never reinterpreted as empty Shapes
```