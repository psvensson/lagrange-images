# ADR 0057: Global name resolution

Status: implemented — a global name is resolved at compile time to a stable first-class `GlobalBinding` identity and dereferenced at runtime by an ordinary `value` send, so rebinding is visible to already-compiled code, renaming preserves identity, and the semantic artifact carries a binding id rather than an image-specific ref.
Proven by: test/global-names.test.js, test/smalltalk-library.test.js

## Problem

Ordinary library source still cannot name a class:

```javascript
const ARRAY_CLASS_CAPTURE = Object.freeze({name: 'ArrayClass', id: 'smalltalk/library/array-class'});
const INDEX_ERROR_CAPTURE = Object.freeze({name: 'IndexError', id: 'smalltalk/library/index-error'});
const EMPTY_ERROR_CAPTURE = Object.freeze({name: 'EmptyError', id: 'smalltalk/library/empty-error'});
```

Every method that allocates an `Array` or signals an `IndexOutOfRange` declares a capture and has its
value supplied at installation. That was the honest thing to do while there was no namespace, and it
is now the largest remaining piece of scaffolding in code that otherwise reads like Smalltalk: the
source says `ArrayClass` where it means `Array`, and the installer has to know which classes each
method mentions.

ADRs 0051 to 0056 removed the other signals. This is the last one where source is still visibly
running inside a harness.

## Three models, compared

### A. Capture the current value at compile time

What the library does today, generalised: the compiler resolves `Array` to the class object and the
artifact (or its environment) carries that value.

```text
rebinding        invisible to compiled code — it holds the old class forever
rename           irrelevant; nothing refers to the name after compilation
deletion         irrelevant, for the same reason
portability      the value is image-specific, so either the artifact is too, or installation must
                 re-resolve by spelling and pretend identity was preserved
bootstrap        trivial — nothing new exists
runtime cost     none
image graph      a method's environment holds a class ref; rebinding leaves stale refs everywhere
namespaces       no help: nothing is named at all after compilation
```

Rejected. It is not what Smalltalk means by a global, and it makes rebinding a class a
recompile-the-world operation.

### B. Look the name up in a namespace at runtime

The artifact carries the *name*; every read consults a namespace Dictionary.

```text
rebinding        visible immediately
rename           breaks compiled code, which still asks for the old spelling
deletion         breaks compiled code at its next execution, far from the deletion
portability      good — a name is image-independent
bootstrap        needs a working Dictionary before any global is readable, which drags hashing,
                 equality and the collection library into the kernel's dependencies
runtime cost     a dictionary lookup on every global read, forever
image graph      clean
namespaces       natural
```

Rejected. The bootstrap pressure is real — `Dictionary` is library code installed long after the
kernel — and an unknown global becomes a *runtime* failure at an arbitrary later moment, when the
compiler could have refused it.

### C. Compile-time resolution to a first-class binding, dereferenced at runtime

```text
source name "Array"
      |  compile-time namespace lookup
      v
stable GlobalBinding identity          <- what the artifact carries
      |  runtime `value` send
      v
current Array class
```

```text
rebinding        visible to already-compiled code, with no recompilation
rename           keeps identity: the namespace maps a different name to the same binding
deletion         compiled code keeps working; the name simply stops resolving for *future*
                 compilations
portability      the artifact carries a binding id and no ref; installation binds it locally, and
                 fails clearly where that identity does not exist
bootstrap        needs only a class with one slot and instance-slot access — confirmed below
runtime cost     one ordinary send, no lookup
image graph      the name -> binding relation is durable and inspectable; rebinding mutates one
                 object rather than rewriting every referrer
namespaces       a later project or nested namespace is another mapping onto the same bindings
```

**Chosen.** It is also the model that already rhymes with the rest of the system: ADR 0043
distinguishes a binding from the value currently in it, and this is that distinction made
first-class and durable.

## Decision

### 1. Three things, kept apart

```text
name                a Text key in a namespace mapping
binding identity    a GlobalBinding object; stable across rename and rebinding
current value       what that binding holds right now
```

And separately: **class existence is not publication**. A class may exist without being visible in
the root namespace, so `ensureNamedClass` does not publish anything. Conflating them would make a
private or project namespace impossible later, and would mean every internal class became a global
the moment it was created.

### 2. The binding holds a value, not a name — and reading it is not permission to write it

```text
GlobalBinding v1     one current-value slot
                     an ordinary `value` read protocol, and nothing else
```

The *name* lives in the namespace mapping, which is what makes rename an operation on the mapping
rather than on the binding: identity survives it because nothing about the binding mentions the name.

**No `value:` in v1**, and the reason is architectural rather than stylistic. A compiled method
necessarily retains the binding identity in order to *read* the global — that is the whole mechanism.
If the binding answered an ordinary setter, possession of that identity would automatically confer
permission to rebind, so every reader would be a writer and this ADR would have settled the authority
question it says it defers.

```text
reference != authority
```

Keeping them separable is the elegant part of model C, and it would be a poor trade to establish the
distinction and then make the binding an unrestricted mutable cell in the same decision.

Rebinding therefore happens through the trusted namespace and language-management seam: the same
stable identity, a new value in its slot, and already-compiled code observing the change. What is
deferred is not rebinding — it is rebinding *from ordinary source*.

### 3. Compiled reads resolve identity, not value or name

A global read compiles to a `value` send to a captured binding, exactly as an instance-variable read
compiles to a slot-primitive send. The capture's binding id **is the GlobalBinding object's id**, so
the artifact carries a stable string and installation supplies `objectRef(thisImage, id)` — the
pattern ADR 0055's `$nonLocalReturn` and ADR 0056's `nil` already use.

Global **assignment is not part of this ADR**. Deciding its lowering now would decide its authority
contract with it, for the reason decision 2 gives, so both are deferred together:

```text
source `Global := value`    not part of ADR 0057
if later admitted           MUST target the already-resolved binding identity, never a fresh
                            lookup by name at assignment time
the operation and its       deferred together, because choosing the operation chooses who may
authority contract          perform it
```

The one thing fixed now is the target: an assignment, if it ever exists, acts on the binding the
compiler already resolved. That constrains the future decision without making it.

### 4. Resolution order

```text
parameters -> temporaries -> captures -> inherited captures -> instance variables -> globals
```

Globals last, so no future publication can change what an existing name means inside a method that
already binds it lexically or as an instance variable. The reserved pseudo-literals of ADR 0056 sit
outside this entirely: `true`, `false`, `nil` and `self` are not names and never reach resolution.

**An unknown global is a compile-time failure.** That is half the point of model C over model B: a
misspelled class name should be refused when it is written, not become a runtime surprise in a rarely
taken branch.

### 5. The namespace is a language-owned image object, not a Dictionary yet

```text
in the image graph      the name -> binding relation is durable and inspectable
not a host map          nothing about it may live outside the image
not a Dictionary (v1)   that would pull hashing, equality and library code into the kernel's
                        dependencies for no v1 benefit
one discoverable root   found by protocol, exactly as the kernel and the Block protocols are
```

The compiler learns the namespace *protocol* and never a list of classes. It must never be taught
that `Array` means `smalltalk/class/Array`: that would turn today's deterministic bootstrap ids into
language semantics, and they are an implementation detail of one installer.

Lookup cost does not matter here, because it happens only at compile time. A richer, Smalltalk-visible
namespace can replace the representation later without touching a single compiled artifact, since
artifacts reference bindings rather than the namespace.

### 6. Lifecycle, decided rather than implied

```text
rebind      already-compiled code observes the new value, with no recompilation
rename      the same binding under a new name; compiled code is unaffected because it never
            held the name
remove      the name stops resolving for future compilations; code already holding the binding
            keeps working. Removal withdraws a *name*, not an identity someone already has
missing     installing an artifact whose binding ids do not exist in the target image FAILS,
            naming them. It must never re-resolve by spelling: matching a name is not evidence
            that the identity is the same one, and quietly substituting a different binding is
            the worst available outcome
```

### 7. Bootstrap: the order works, confirmed by construction

The feared cycle — bindings needing the `Association` library, which needs classes, which need
bindings — does not exist. `GlobalBinding` needs only a class with one slot and instance-slot access,
both available immediately after the kernel:

```text
kernel identity and classes
  -> instance-variable protocol
  -> GlobalBinding class, with `value` as its only method
  -> namespace root, and publication of the kernel classes that already exist
  -> later installers publish Array, Dictionary, the condition classes explicitly
  -> ordinary source resolves those names
```

Verified against the current code rather than reasoned about: a `GlobalBinding` class and its
**read** protocol install with only the kernel and the instance-variable protocol present, a `value`
send dereferences it, and durably rebinding the same binding object changes what an already-compiled
Block answers with no recompilation. No allocation, equality, Dictionary or library protocol is
involved.

The shipped `GlobalBinding` answers `value` and nothing else, and rebinding goes through the
namespace-management seam, per decision 2. (The pre-ADR prototype used a `value:` method to perform
that rebinding, which was convenient for the experiment and was never a protocol commitment.)

### 8. Standalone Blocks reuse ADR 0056's environment seam

A standalone Block referencing a global needs its binding value supplied, which is the mechanism
`nil` already established. The intrinsic environment generalises from "the nil binding" to "the
bindings this program resolved", still written only when the program actually references one, and
still parenting any caller-supplied environment rather than copying it.

## Proof required for implementation

```text
the payoff
    OrderedCollection's ArrayClass, IndexError and EmptyError captures are gone, and its source
        says `Array`, `IndexOutOfRange` and `EmptyCollection`
    those methods read as ordinary Smalltalk, with no IR change and no class name in the compiler

resolution
    a global resolves to a `value` send against a captured binding id
    resolution order: a parameter, temporary, capture and instance variable each shadow a global
        of the same name, proven individually
    an unknown global fails at COMPILE time, naming it
    `true`, `false`, `nil` and `self` never reach global resolution

lifecycle
    rebinding a global changes what an already-compiled method answers, with no recompilation —
        performed through the namespace-management seam, NOT by source assignment and not by an
        exposed setter
    `GlobalBinding` answers no unrestricted rebinding protocol: holding the ref does not let
        ordinary source change what the global means
    renaming keeps the binding identity, and compiled code is unaffected
    removing a name leaves compiled code working and makes future compilation of that name fail
    class existence does not publish: a class installed without publication is unnameable

artifacts and images
    the semantic artifact carries binding ids and no image-specific ref
    the same semantic program installs into two images and binds each one's own bindings
    installing an artifact whose binding ids are absent fails, naming them, and never re-resolves
        by spelling

representation
    the name -> binding relation is durable and inspectable in the image graph; no host-side map
    the namespace is reached through one discoverable protocol root; the compiler contains no
        class name and no deterministic class id

both lanes and durability
    neutral and WASM agree on reads, and on a rebinding observed after compilation
    a standalone Block referencing a global gets one environment holding the bindings it uses,
        parented to any caller-supplied environment, and none when it references no global
    installation is exact-or-create and idempotent, and joins the exhaustive recovery sweeps
```

## What is deferred

- global *assignment* as a permitted source operation, its lowering, and the authority rule
  governing it — deferred together, since choosing the operation chooses who may perform it
- project, nested or private namespaces — the model admits them; this ADR ships one root
- making the namespace a Smalltalk-visible Dictionary, and the reflective protocol over it
- `Smalltalk at:put:`-style runtime publication from source
- publishing every existing class; installers publish deliberately, one at a time

## Guardrails

```text
name, binding identity and current value are three things; never collapse two of them
class existence is not publication — `ensureNamedClass` publishes nothing, and a class may exist
    unnameable
a compiled global read resolves the binding at COMPILE time and dereferences it at runtime with an
    ordinary send; never capture the current value, never look up the name at runtime
a GlobalBinding ref identifies the binding; it does not grant authority to rebind it. Every reader
    necessarily holds that ref, so an unrestricted setter would make every reader a writer
rebinding goes through the trusted namespace/language-management seam; `Global := value` is not
    part of ADR 0057, and if admitted must target the already-resolved binding identity
an unknown global is a compile-time failure, not a runtime lookup
globals resolve last, after instance variables; reserved pseudo-literals never reach resolution
the artifact carries binding ids and no image-specific ref; a missing identity fails loudly and is
    never re-resolved by spelling
the namespace lives in the image graph — never a host-side map — and is reached through one
    discoverable protocol root
the compiler learns the namespace protocol, never a class name and never a deterministic class id
```
