# ADR 0050: Class-scoped instance-variable binding and self-only slot access

Status: implemented — an instance-variable name is resolved to a stable Shape slot id by a class-scoped compilation entry point beside the class-independent one, the durable method carries that id rather than the name, and a language-owned primitive reads or writes it only on the method activation's effective Smalltalk `self` and only for a slot its defining Behavior's visible layout declares, with both facts carried from dispatch to execution by a transient runtime-built envelope.
Proven by: test/instance-variables.test.js

## Problem

ADR 0046 made objects allocatable and ADR 0047 gave them an indexed part. ADR 0049 made dispatch
fast. What none of them did is let a program touch an object's named state:

```smalltalk
Point basicNew        "allocates, with x and y both nil"
                      "...and nothing can ever read or write x"
```

The kernel primitive set is `class-of`, `basic-new`, `basic-new-sized`, the three indexed
operations, `built-in-equals`/`built-in-hash`, and the five Dictionary operations. There is no named
slot read and no named slot write. `defineClass` accepts an instance Shape with named slots,
`basicNew` faithfully initialises every one of them to `nil`, and the language has no way to reach
them again. The only writer of a named slot is ADR 0042's authorized *foreign* mutation lane.

So every user-defined class is an inert record, and that blocks more than it first appears. ADR 0047
decision 6 promised:

> An `OrderedCollection` is an ordinary object holding an `Array` plus a size and a growth policy,
> written in Smalltalk, and it stays out of the primitive layer entirely.

It cannot be written in Smalltalk, because it needs two instance variables. The same is true of
`Association`, of any linked structure, and of every domain object. The collection library this
substrate has been building toward is blocked at its first step, and the block is not a missing
collection — it is missing access to state.

### Why this is not simply "add a slot operation"

ADR 0046 rejected the obvious answer in its own problem statement, and the reason still holds:

> A generic `object-slot` operation would let language code bypass encapsulation merely so
> `basicNew` could read `instanceShape`.

A generic read-any-slot-of-any-object operation is not an instance variable. It is a reflection
facility with a misleading name, and once it exists in the shared IR every language personality above
this graph inherits one language's answer about what encapsulation means.

Three separable concerns are tangled in "instance variables work", and the whole of this ADR is
keeping them apart:

```text
source name resolution      happens in the defining class
durable method semantics    carry the stable slot id
execution                   accesses that slot only on the method's Smalltalk self
```

## Decision

### 1. Names are resolved by a class-scoped binder, above a class-independent parser

The parser and the block compiler acquire no class state. A Block is still compilable with no class
in sight, which is what keeps `[ :a :b | a + b ]` meaningful on its own.

A *method* is different: it belongs to a class, and that is where its free names get their meaning.
So a new class-scoped binding step sits above the existing pipeline:

```text
source method
    |
    v
parse                          class-independent, unchanged
    |
    v
bind with the defining class   classRef + its complete instance Shape
    |
    +-- parameter / temporary / capture  -> lexical binding, exactly as today
    |
    +-- instance-variable name           -> stable Shape slot id
    |
    v
lagrange-code/v0
```

Concretely, this is a **sibling compilation entry point**, not a wrapper around a class-independent
resolver. `compileSymmetricSmalltalkSemanticBlock` already performs name resolution itself and
already rejects an unbound root name at that moment; there is no later stage where an unresolved name
survives for someone else to bind. `defineMethods` receives a semantic program well after that point
and must keep doing so.

```text
Block:   parse -> compile (class-independent)              -> semantic program
Method:  parse -> compile *with the defining class*        -> semantic program -> defineMethods
```

The ordinary Block compiler is unchanged, and neither entry point acquires ambient class state: the
class arrives as an argument to the method path, exactly as `captures` already arrives today.

This is also the seed of an eventual method-definition syntax, which remains deferred: today methods
arrive as hand-written semantic programs, and the binder is what a source-level `Point >> x` would
run through when it exists.

### 2. The durable method carries the slot id, never the name

The semantic artifact records the resolved stable slot id as a literal. The name appears in source
and in the class's Shape, and nowhere in between.

That gives a consequence worth stating as a decision rather than discovering later:

```text
slot renamed, id preserved     already-compiled methods keep reaching the same state
                               new source resolves against the new name
slot id removed or changed     an existing method fails structurally (decision 6)
```

This is exactly what stable slot identity is for — AGENTS.md already requires preserving slot ids
across renames when semantics are continuous — and it is why binding to the id rather than the name
is the load-bearing half of decision 1.

Inherited state then falls out with no extra machinery. A superclass method compiled against slot id
`point-x` runs correctly on a subclass instance, because ADR 0046 decision 4 already requires a
subclass's complete instance Shape to retain every inherited slot id, and ADR 0047 extended that to
the indexed declaration. Nothing here re-derives a layout; it consumes the one already settled.

### 3. Lexical bindings win, and assignment follows the same rule

```text
resolve a name:   parameter -> temporary -> capture -> instance variable -> unbound
```

An instance variable is consulted only when nothing lexical matches, so a parameter named `x` shadows
an instance variable named `x`, as in every Smalltalk.

Assignment uses the identical rule, which keeps one mental model rather than two:

```smalltalk
x := 5      "lexical cell assignment if x is lexical;
             otherwise instance-slot mutation on self"
```

One consequence has to be stated, because getting it wrong would quietly widen what assignment
means. Resolution finds the binding *first* and checks write legality *second*; it never keeps
searching for something assignable. So a parameter named `x` shadows an instance variable named `x`
for writes as well as reads, and `x := 5` still fails as "cannot assign to parameter x" — it must not
fall through to the instance variable:

```text
parameter x        shadows, and assignment stays illegal
capture x          shadows, and assignment stays illegal unless the capture is a mutable cell
temporary x        shadows, and assignment is an ordinary cell write
none of those      the instance variable, if the defining class declares one
```

The instance-variable fallback is consulted at exactly the point where resolution currently raises
`unbound Symmetric Smalltalk name`, and nowhere earlier. That keeps every existing write-legality
rule intact by construction rather than by re-stating it.
### 4. No generic object-slot operation; the primitives are language-owned

`lagrange-code` gains nothing. No `get-object-slot`, no generic field access on a Value, no
`readSlot(object, name)` on the executor context. `smalltalk-kernel-primitive/v1` gains two
operations, reached exactly as every kernel primitive since ADR 0046 is reached — a captured Block
ref sent `value:` — so neither execution lane learns anything new:

```text
instance-slot-read     (self, slotId)          -> the slot's Value
instance-slot-write    (self, slotId, value)   -> the stored Value
```

The binder lowers an instance-variable reference to an ordinary send of that primitive. `x` becomes
conceptually `primitiveInstanceSlotRead value: self value: 'point-x'`, and `x := v` becomes
`primitiveInstanceSlotWrite value: self value: 'point-x' value: v`.

### 5. Self-only is proved at execution, not merely arranged by the compiler

This is the sharpest decision in the ADR, and the one most worth getting right.

A primitive that means "read this slot from whatever object you are handed" *is* the generic
object-slot operation ADR 0046 rejected, wearing a Smalltalk costume. A hand-forged semantic
artifact — which the graph permits, since a method is ordinary durable data — could capture the
primitive Block and read the private state of any object of any class.

So the primitive must be able to prove its target is the receiver of the method activation that
invoked it. That is necessary, and it is **not sufficient**.

Consider a forged method installed on `Parent` that names a slot id declared only by `Child`:

```text
Parent >> peek        primitiveInstanceSlotRead value: self value: 'child-secret'

aChild peek           self really is self               ✓ passes the receiver check
                      Child's Shape really has the slot ✓ passes the layout check
                      and Parent has just read Child-private state
```

Both checks succeed and encapsulation is still broken, because a method may only name state that the
class it was *defined in* declares. So the frame carries two facts, and the primitive requires both:

```text
self              the effective Smalltalk receiver of the invoking method activation
definingBehavior  the Behavior whose method dictionary supplied the running method

require   target is that self
require   the slot id is declared by definingBehavior.instanceShape
```

The object's *current* Shape remains a second, independent structural check (decision 6). The two
answer different questions — "may this method name this slot" versus "does this object have it" —
and collapsing them is precisely how the `Parent`/`Child` hole opens.

`lookupSelector` already walks the superclass chain and knows which Behavior's dictionary matched, so
the dispatcher can report it. It rides the resolution alongside ADR 0045's `effectiveReceiver` and
becomes transient frame state; it does **not** become a field of the activation record, which stays
the closed structure ADR 0005 defined.

"Declared by" means the defining Behavior's **visible layout**, not its own `instanceShape` slot
alone. A `nil` layout in the middle of a chain declares nothing of its own and cancels nothing above
it — that is exactly the rule ADR 0049's implementation already encodes in
`nearestDeclaredInstanceShape`, and it exists because an abstract intermediate class's *methods* are
still inherited by concrete descendants:

```text
A          instanceShape {a}
B          instanceShape nil        abstract; declares no layout of its own
C          instanceShape {a, c}     concrete

B >> bump      may name `a`         it is ancestor-declared, and every concrete
                                    descendant of B carries it
B >> peek      may not name `c`     C-private, exactly as decision 5's Parent/Child case
```

So the permission check walks from the defining Behavior to the nearest ancestor that declares a
layout, and the binder resolves names against the same view. A class with no layout *and* no ancestor
with one — `Object`, for instance — can then name no instance variable at all, which remains the
right answer for a class that genuinely declares no state.

### 5a. The frame belongs to a method activation, and is not blindly inherited

A frame that propagated through every nested send the way `depth` and the dispatch image do would
hand an arbitrary Block the invoker's `self`, which is the same hole from a different direction.
Propagation is therefore by callee kind, not by nesting:

```text
a Smalltalk method dispatch      REPLACES the frame — new self, new definingBehavior
a kernel-primitive Block send    INHERITS the invoking frame — this is how the primitive sees it
a lexical closure activation     RESTORES the frame captured where the closure was created
anything else                    NO frame; the slot primitives are unusable there
```

The third rule is what makes decision 10's lexical `self` correct, and the fourth is what stops a
method from lending its identity to a Block it merely happens to invoke: `aBlock value` inside a
method must run `aBlock` with the frame `aBlock` was created in, never with the caller's.

An activation with no frame is not a lesser one — every existing execution path has no frame and is
unaffected. It simply cannot use the slot primitives, which is correct, because nothing outside a
Smalltalk method has a `self` whose state these operations are about.

That fact is not available to a primitive executor today: an executor sees its own activation, whose
receiver is the primitive Block itself, and its arguments, which are just Values. ADR 0050 therefore
introduces the smallest transient execution seam that carries the invoking activation's receiver
alongside the context values already threaded through nested sends — `depth`, `authority`, the cell
arena and the dispatch image.

The seam is bounded by the same rules those obey:

```text
transient            it exists for an execution and dies with it
never durable        it appears in no record, no artifact, no Value
never authority      it grants nothing; it is an identity check, not a capability
never caller-supplied  a program cannot name, forge or override it
```

**Effective** Smalltalk self, per ADR 0045 — the `true`/`false` singleton where the boolean bridge
nominated one, not the wire-level receiver the message was sent to. Reconstructing `self` from the
original request receiver would make `True`'s own methods unable to reach state that `True`'s
instances will eventually have, and would reintroduce exactly the distinction ADR 0045 spent an
`effectiveReceiver` key to remove.

The compiler will of course only ever emit `self` as the target. That is not the point: the check
exists precisely for the code the compiler did not write.

### 5b. The trusted frame needs a transport, and it is an explicit sidecar

Decisions 5 and 5a leave one thing unsaid, and it is the seam the implementation would otherwise
improvise. Dispatch is where `definingBehavior` is *known*: `lookupSelector` walks the chain and sees
which Behavior's dictionary matched. Execution is where it is *needed*. And the only thing crossing
between them today is the activation request, which decision 5 forbids extending.

Both endpoints already have a transient side channel, so this is a third one rather than a new idea:

```text
into invocation     sendMessage(input, {dispatchImage})
into execution      execute(activation, {depth, authority, cellArena, dispatchImage})
```

So the invocation layer produces, beside the activation request, an explicit transient
**invocation envelope** carrying the trusted facts of this dispatch — the effective receiver and the
defining Behavior — and the caller hands it to `execute` the way it already hands over the dispatch
image. Its exact spelling is implementation detail; its properties are not:

```text
runtime-created            built by the invocation layer from the *normalized* resolution,
                           never assembled from anything the guest supplied
unforgeable by a program   a message-send request cannot carry it; `createMessageSendRequest`
                           validates exact keys, and the envelope is not one of them
never durable              no record, no artifact, no Value, no metadata
never authority            it authorizes nothing; it identifies, and decision 8 still applies
absent by default          `invokeBlock` produces none, so a directly invoked Block has no frame
                           and cannot use the slot primitives at all
```

The trust root is the registered dispatcher, and that is not a new dependency: a dispatcher already
decides *which Block executes at all*. Believing it about which Behavior supplied that Block adds no
trust that dispatch did not already require.

Once execution begins the envelope is consumed and the executor owns the frame from then on;
decision 5a's replace/inherit/restore/none rules operate on executor state, not on a value the guest
or the language can reach again.

Two shortcuts are ruled out explicitly, because both are tempting and both are wrong:

**Do not reopen the activation request.** Adding `definingBehavior` to it would make a permission
fact part of the closed activation model that ADR 0005 defined and every executor consumes, and would
put it within reach of code paths that have nothing to do with Smalltalk methods.

**Do not recover it afterwards by asking which Behavior holds this Block.** This is the shortcut that
needs no new plumbing, and it is unsound twice over. A Block ref may legitimately appear in more than
one method dictionary, since durable graph reuse is permitted and nothing forbids installing one Block
under two classes — so the question has no unique answer. And where it does have one, the answer comes
from graph data that a forged artifact can arrange, which is precisely the input decision 5 refuses to
trust. The defining Behavior must be the one that *this dispatch actually walked to*, not one
reconstructed later from a lookup that corruption can steer.

### 6. Access is by slot id against the object's *current* Shape

At execution the primitive loads the target, loads its Shape, and requires the slot id to be present
in it.

```text
slot id present in the object's Shape     read or write that slot
slot id absent                            structural language-state failure
```

Absent is not `nil`, not message-not-understood, and never an opportunity to add a slot. A method
saying "slot `point-x`" against an object whose Shape no longer declares `point-x` is stale or
corrupt state, and the three-way failure separation this substrate has maintained since ADR 0044
applies here as everywhere else.

Checking against the *current* Shape rather than the defining class's is what makes inherited access
work: a subclass instance carries the subclass's complete Shape, which contains the inherited id.

### 7. A write replaces one slot and preserves everything else

```text
preserved:  shape, behavior, every other named slot, the indexed part, metadata
replaced:   exactly the named slot the id resolves to
```

The indexed part is called out because this substrate has already been bitten there once: ADR 0047's
review found that the ADR 0042 mutation binding rebuilt a whole object record and would have *erased*
an indexed part it did not carry forward. A named-slot write rebuilds a whole record for the same
reason and must not repeat it.

### 8. This is image-native mutation, not an ADR 0042 authority check

```text
Smalltalk self slot write      intrinsic language semantics, no grant
foreign object mutation        ADR 0042's authorized lane, unchanged
```

The rule established by ADRs 0046, 0047 and 0048 continues without exception. A program that can
materialize closures, allocate objects and store into an Array without a grant, but cannot assign its
own instance variable, would have an incoherent boundary rather than a stricter one.

The primitive still uses `_version` internally for optimistic concurrency. That version is runtime
machinery, never supplied by the Smalltalk program and never an authorization token — the object-scoped
version token of ADR 0042 remains that lane's concern.

Named-slot mutation deliberately takes the **same** conflict semantics as ADR 0047's indexed
`at:put:` rather than inventing a second object-mutation model. If that policy later deserves better
retry behavior, named and indexed mutation change together.

### 9. No automatic accessors, and no reflection

Instance variables are implementation state. Generating `x`, `x:`, `y`, `y:` for every declared slot
would turn private state into public protocol as a side effect of declaring a layout, and would make
an implementation detail visible in the object model as sendable messages.

```text
direct instance-variable syntax     yes
automatically generated accessors   no
```

A class that wants public accessors defines them, and that decision is then visible in its protocol
where it belongs.

`instVarAt:`, `instVarAt:put:`, `allInstVarNames` and inspector-style facilities are deferred
entirely. They are privileged reflection with their own semantics, and letting them become the
mechanism by which ordinary methods reach state would collapse decision 5 immediately.

### 10. Instance-variable access is lexically bound to `self`, including inside Blocks

Smalltalk Blocks use lexical `self`, so the rule is:

```smalltalk
incrementer
    ^[ x := x + 1 ]        "x is the defining method receiver's slot,
                            not anything belonging to the Block"
```

The semantic rule is settled here even though the implementation may stage, because the alternative
is accidentally defining instance variables as "method-body only" and then having to widen a
shipped meaning later.

A Block activation's own receiver is the Block, so decision 5's check cannot naively compare against
it. The intended shape of the answer is the one the cell arena already uses: lexical frame state
established when a Smalltalk method activation begins, and inherited by closures created within it —
`createClosure` already associates a created Block ref with the cells of its defining frame, and
lexical self is the same kind of fact.

**A staged implementation must fail closed.** If instance-variable access inside a nested Block is
not implemented in the first landing, it must raise explicitly. It must never fall back to the
Block as the target, and it must never skip decision 5's check because the enclosing self was
inconvenient to obtain. Staging is permitted; a hole is not.

> **Implementation note:** the first landing staged this, refusing any method containing a Block
> literal at definition time. That staging is now removed and the rule above is implemented: a method
> may contain nested Blocks in both semantic representations and both execution lanes, and a closure
> created inside a method restores that method's frame when activated within the same execution.
> Method installation and standalone Block installation share one recursive publication
> implementation, with nested identities derived from the method's own deterministic id.
> Decision 10a below is unchanged.

### 10a. An ivar-using closure does not survive its execution

Decision 10's frame restore works because the frame is still there. A closure can outlive it.

ADR 0043 makes a *mutable-cell* capture unsupported across executions and says so with a named error,
but an immutable capture is different: a closure whose captures are all snapshots is an ordinary
durable Block plus lexical environment, and a later execution can invoke it perfectly well. So an
ivar-using closure that escapes has a frame that is simply gone.

The tempting repair is to persist `definingBehavior` as an ordinary captured ref. That must not
happen, and the reason is decision 5's reason: a lexical environment and a semantic artifact are
durable, forgeable graph data. A persisted defining Behavior is a claim the runtime cannot check,
which is exactly the forged-artifact vector the whole self-only design exists to close. Making the
frame durable would hand an attacker the one fact the check depends on.

So the boundary is drawn narrowly and honestly:

```text
ivar-using closure, same execution      the transient frame is restored; ordinary behavior
ivar-using closure, later execution     explicitly unsupported, and fails closed
```

The failure is a named, distinguishable error in the shape ADR 0043 already established for escaping
mutable cells — not `nil`, not an unbound name, and not a silent read of the wrong object.

Cross-execution access to private slots from a closure is a real capability and a real question, and
it needs a durable provenance or authenticity decision of its own: something that can *prove* which
class a stored method body belongs to, rather than believing a ref it carries. That decision is
deferred rather than smuggled in here, because getting it wrong quietly is worse than not having it.

## Proof required for implementation

```text
binding
    a method reading x compiles to a semantic artifact containing the stable slot id, not the name
    a parameter or temporary named x shadows an instance variable named x, for read and for assignment
    assigning to a shadowing parameter still fails as a parameter assignment, never as an ivar write
    a name matching neither is still an unbound-name compile failure
    binding needs the defining class; the block compiler still compiles a Block with no class

read and write
    x answers nil for a freshly allocated instance, and the value after assignment
    x := v mutates only that slot: shape, behavior, other slots, indexed part and metadata survive
    a write leaves the object's identity unchanged

inheritance and renaming
    a superclass method reads and writes an inherited slot of a subclass instance
    a subclass method reaches an inherited slot
    a slot renamed with its id preserved keeps existing compiled methods working
    a method whose slot id is absent from the target's current Shape fails structurally —
        never nil, never message-not-understood, never by adding a slot

self-only, adversarially
    a forged method that captures the slot primitive and passes some *other* object is refused,
        even when that object is the same class and genuinely has that slot
    the same forgery is refused for write as well as read
    the check uses the ADR 0045 effective receiver, not the wire-level request receiver
    the seam is transient: it appears in no record, no artifact and no Value

defining-behavior scope, adversarially
    a method defined on Parent naming a slot declared only by Child is refused when a Child
        instance runs it, even though the target is genuinely self and the Shape genuinely has it
    a Parent method still reaches Parent-declared slots on a Child instance
    a Child method reaches both its own and inherited slots
    a method on an abstract intermediate class with a nil layout may still name an
        ancestor-declared slot, and runs correctly on a concrete descendant
    a method defined on a class with no layout and no ancestor layout can name no instance variable

frame transport
    the defining Behavior reaches execution through the transient envelope, not the activation request
    a message-send request that tries to carry one is refused
    invokeBlock produces no envelope, so a directly invoked Block cannot use the slot primitives
    the envelope appears in no record, artifact, Value or metadata
    a Block installed in two method dictionaries still resolves by the dispatch that happened,
        which is why the defining Behavior is never recovered by a later lookup

frame lifetime
    a nested Smalltalk method dispatch replaces the frame; the callee sees its own self
    `aBlock value` inside a method runs aBlock with aBlock's own defining frame, never the caller's
    a closure created in a method restores that method's frame when activated
    an activation with no frame cannot use the slot primitives at all

blocks
    a closure created in a method restores that method's frame and mutates the defining receiver
    a closure invoked from a *different* method does not inherit that method's frame
    a closure created inside a forged method gets that method's defining Behavior, not a chosen one
    a published prototype Block is not a runnable closure on its own
    an ivar-using closure invoked in a *later* execution fails closed with a named error
    no defining Behavior is ever written into a durable environment or artifact to make that work

boundaries
    a slot write succeeds with no authority context at all
    a foreign primitive Block cannot read or write a local object's slot
    the compiler recognizes no accessor selector, and no accessors are generated
    concurrent writes take the same conflict semantics as indexed at:put:

both lanes
    the same semantic method derived into neutral and WASM Blocks, both executed
    an assignment whose result feeds a further send exercises non-tail WASM resumption
    the installer publication sequence is enumerated by the pre/post-commit sweep, not sampled
```

## What is deferred

- source-level class-definition and method-definition syntax; the binder is its seed, not its arrival
- `instVarAt:`, `instVarAt:put:`, `allInstVarNames` and every other reflection facility
- automatically generated accessors, per decision 9
- changing a class's instance Shape under existing instances, and `become:`-style migration
- class variables, class instance variables and pool dictionaries
- a second object-mutation model with different retry behavior from ADR 0047's indexed `at:put:`
- reading another object's state at all, including a same-class sibling; that is reflection
- cross-execution private-slot access from an escaped closure, which needs a durable provenance or
  authenticity decision able to prove which class a stored method body belongs to
- the legacy shape-backed MethodDictionary reader, which stays until a real old image needs
  migrating or an explicit compatibility cutoff is decided

## Guardrails

```text
names resolve in the defining class; the parser and block compiler stay class-independent
the durable method carries the stable slot id, never the source name
a rename that preserves the slot id does not break a compiled method
lexical bindings shadow instance variables, for reads and for assignment alike
no generic object-slot op in lagrange-code, and no slot access on the executor context
the slot primitives are language-owned and reached as ordinary captured Block sends
self-only is proved at execution, not arranged by the compiler
self-only is necessary and not sufficient: the slot must also be declared by the defining Behavior
"may this method name this slot" and "does this object have it" are separate checks; never collapse them
visibility is the defining Behavior's nearest declared layout; a nil layout declares nothing and cancels nothing
the frame is per method activation and propagates by callee kind, never by nesting depth
the defining Behavior travels in a runtime-built transient envelope, never in the activation request
never reconstruct the defining Behavior by asking which dictionary holds a Block; that answer is
    neither unique nor trustworthy
an arbitrary Block invoked by a method never borrows the invoker's self
the self seam is transient, non-durable, never a Value, never authority, never caller-supplied
resolution finds a binding then checks write legality; it never searches on for something assignable
self means the ADR 0045 effective receiver, not the wire-level request receiver
a slot id absent from the target's current Shape is structural failure, never nil and never a new slot
a write preserves shape, behavior, other slots, the indexed part and metadata
instance-variable mutation is image-native semantics, not an ADR 0037/0042 grant
the internal _version is runtime machinery, never a program-supplied authorization token
named-slot mutation shares indexed at:put:'s conflict semantics; change them together or not at all
declaring a layout never generates protocol; accessors are written, not implied
instance-variable access is lexically bound to self, Blocks included; staging must fail closed
an ivar-using closure works within its execution and fails closed after it; the frame is never made durable
a persisted defining Behavior would be forgeable data, which is the vector self-only exists to close
```
