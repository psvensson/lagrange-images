# ADR 0048: Smalltalk equality, hashing and durable Dictionary

Status: accepted — Symmetric Smalltalk gains a stable default `=`/`hash` contract and a hashed `Dictionary` whose durable identity points at immutable table snapshots; general lookup uses ordinary `hash`/`=` message sends, while the table representation is deliberately readable by a later Text-only MethodDictionary fast path without executing arbitrary Smalltalk during dispatch.

## Problem

ADR 0047 gave the image a real indexed object part and made `Array` usable from ordinary Smalltalk.
That is enough to store a sequence. It is not enough to store a map.

A real `Dictionary` forces three decisions that should be made together:

```text
what does `=` mean?
what must `hash` guarantee?
how is a hash table mutated without corrupting durable graph state?
```

The third question matters unusually much here. A conventional in-memory dictionary can update a
bucket, a tally, and perhaps several arrays under one process lock. In this image those are durable
records. Updating several records one after another would expose partial state on failure, and a grow
that snapshots one table while another writer mutates it can silently lose an insertion.

ADR 0047 also deliberately did not migrate `MethodDictionary`. Its reason was algorithmic: replacing
the current host-readable Shape lookup with a linear collection scan would make every message send
worse. A Dictionary representation is therefore useful only if it is both semantically Smalltalk and
structurally suitable for an eventual O(1)-ish selector lookup that does **not** recursively execute
Smalltalk while the dispatcher is trying to find the Smalltalk method to execute.

This ADR settles the general Dictionary and designs that later seam. It does not perform the
MethodDictionary migration.

## Decision

### 1. `=` and `hash` are Smalltalk protocol, not new generic Value semantics

The generic graph remains language-neutral. No `hash` field, hash cache, equality mode, or Dictionary
record kind is added to `src/value` or `src/object`.

Likewise, the existing `lagrange-code` `equals` op remains what it already is: a language-neutral
structural comparison used by semantic code. It is **not** redefined to mean a Smalltalk `=` send.

Smalltalk installs ordinary methods:

```smalltalk
Object >> = other
Object >> hash
```

Both methods reach language-owned primitive Blocks through the same
`smalltalk-kernel-primitive/v1` route used by ADRs 0046 and 0047. A user class may override either
method normally. The compiler and dispatcher learn neither selector.

This separation is important: changing a language method must not mutate the meaning of a frozen
common IR operation, and another language may choose a different equality/hash contract over the
same canonical Values.

### 2. Default equality is value equality for immediates and identity for objects

The default `Object >> =` primitive defines one stable built-in relation.

For object refs:

```text
ref(image A, object X) = ref(image B, object Y)
    iff A == B and X == Y
```

No record is fetched merely to compare identity. `_version`, location, Shape, behavior and slots do
not participate.

For immediate Values:

```text
boolean     equal by boolean value
text        equal by exact text contents; no Unicode normalization is invented here
bytes       equal by byte contents
integer     equal by mathematical integer value
float64     equal by IEEE numeric value, with +0 = -0 and NaN unequal to everything
integer/float64
            equal when the Float is finite, integral and represents exactly the same integer
```

Different nonnumeric kinds are unequal.

The ADR 0045 boolean bridge needs one explicit rule: the dispatch image's `true`/`false` singleton is
the language receiver for a boolean send, so the equality/hash primitives normalize those exact local
singleton refs back to the corresponding boolean value before applying the built-in relation. The
bridge therefore does not make `true = true` depend on an accidental ref-vs-immediate mismatch.

A `pinned-ref` remains a graph/history Value, not a Smalltalk receiver in the current kernel. This ADR
does not invent a PinnedReference class merely to make it a Dictionary key. A pinned ref used as a
key therefore fails at the ordinary `hash` send boundary until a later language decision gives it
behavior.

### 3. The built-in hash is stable, deterministic and versioned by this ADR

A persistent Dictionary cannot tolerate a host-randomized or process-random hash. Bucket placement
must survive restart, and the default hash must satisfy:

```text
a = b  =>  a hash = b hash
```

The built-in hash normalizes the value according to the equality relation and hashes a domain-tagged
canonical JSON tuple with SHA-256. The first eight digest bytes are read big-endian and the high bit
is cleared, yielding a non-negative 63-bit Integer Value.

The normal forms are conceptually:

```text
boolean                  ["boolean", true|false]
text                     ["text", exact-string]
bytes                    ["bytes", canonical-base64]
integer                  ["number/integer", decimal]
integral finite float    ["number/integer", exact-decimal-integer]
finite nonintegral float ["number/float64", normalized-ieee-bits]
+/- infinity             ["number/infinity", "+"|"-"]
NaN                      ["number/nan", ieee-bits]
object ref               ["ref", imageId, objectId]
```

`+0` and `-0` normalize to the same integer zero form. For two finite nonintegral Float64 values,
IEEE64 already has one representation per numeric value, so no additional numeric canonicalization is
needed. NaN is deliberately non-reflexive under `=`; its hash is stable but Dictionary does not repair
a key whose equality relation says it is unequal to itself.

This algorithm is a durable Smalltalk contract, not an implementation detail to be replaced for a
faster host hash. A later built-in hash algorithm requires an explicit compatibility/migration
decision because existing persistent tables were laid out using this one.

### 4. Overriding `=` carries the ordinary Smalltalk hash obligation

A class may override `=` and `hash`. Dictionary lookup uses those methods, not the built-in helper,
for general keys.

The language contract is:

```text
a = b  =>  a hash = b hash
```

and equality used as a key relation is expected to be reflexive and symmetric enough to behave as an
equivalence relation. The runtime does not attempt to prove this. A class that makes every instance
`=` but returns different hashes has defined a broken Dictionary key. A key mutated so that its
`hash`/`=` meaning changes while resident likewise invalidates its own lookup, as in ordinary
Smalltalk systems.

The default methods satisfy the contract by construction. A user-defined semantic equality must
supply the matching user-defined hash.

### 5. Dictionary identity is stable; its table is an immutable snapshot

A `Dictionary` is an ordinary Smalltalk object with stable identity and one named instance slot:

```text
Dictionary
    table -> ref(DictionaryTable snapshot)
```

`DictionaryTable` is a language-owned internal graph object, not a public Smalltalk class. Its Shape
has one named slot plus an indexed Value part:

```text
DictionaryTable
    tally    Integer Value
    indexed  bucket triples
    behavior null
```

The table object is immutable **by the Dictionary implementation contract** after publication. Generic
`putObject` does not learn a new immutable-record kind; the language simply never updates a published
table snapshot.

This makes one Dictionary version the serialization point for every visible mutation. A reader sees
the old complete table or the new complete table, never a partly changed key/value/hash set.

### 6. The table is open-addressed and uses triples so `nil` is a valid key

Capacity is a power of two, at least 8. The indexed part has exactly `capacity * 3` Values:

```text
bucket i:
    indexed[3*i + 0]   stored hash Integer, or image nil when empty
    indexed[3*i + 1]   key, or image nil when empty
    indexed[3*i + 2]   value, or image nil when empty
```

An occupied bucket is identified by the first element being an Integer Value. The key itself may
therefore be `nil`; no user key is stolen as an empty sentinel.

Lookup uses linear probing from the mathematical floor-modulo of the key's Integer hash by capacity.
A stored hash mismatch skips equality dispatch. A matching stored hash sends:

```smalltalk
storedKey = queryKey
```

and requires a boolean result.

There is no deletion in v1, so there are no tombstones and no tombstone semantics to get subtly
wrong. `removeKey:`, weak keys and identity dictionaries are later collection decisions.

### 7. `at:put:` is copy-on-write plus one CAS-visible swap

A mutation never changes the published table object. It:

1. reads the Dictionary and its table snapshot,
2. sends `hash` to the query key,
3. probes and, on matching stored hashes, sends `=` to stored keys,
4. constructs a complete next table snapshot in memory,
5. writes that new table as a fresh internal object,
6. rewrites only the Dictionary's `table` slot with `expectedVersion` equal to the Dictionary version
   read in step 1.

An update copies the existing capacity. An insertion grows first when the post-insert load would
exceed 3/4, doubling capacity and reinserting existing entries by their **stored hashes**. Existing
keys are not sent `hash` again merely because the table grew.

Copy-on-write makes mutation O(capacity) in durable bytes. That is a conscious first tradeoff. The
current backend stores an object as a whole record anyway, and the alternative — mutating a child
table in place while separately swapping/growing metadata — needs a real multi-record transactional
contract to avoid lost updates. That optimization should be designed when evidence says Dictionary
write throughput, rather than lookup or semantic correctness, is the limiting problem.

Lookup remains expected O(1) at the chosen load factor, which is the property ADR 0047 required before
considering a MethodDictionary migration.

### 8. Arbitrary user code may run during hash/equality, so CAS happens after it

General Dictionary lookup deliberately uses ordinary message sends:

```smalltalk
key hash
storedKey = key
```

Those methods may themselves send messages or mutate state, including the Dictionary being operated
on. The Dictionary primitive therefore cannot assume its initial read is still current after the
calls finish.

The final Dictionary rewrite uses the initially observed Dictionary `_version`. If any intervening
Dictionary mutation committed, the compare-and-set fails rather than installing a table snapshot built
from stale state and losing that mutation.

The implementation must not silently retry such a conflict, because retrying would re-execute
user-defined `hash`/`=` methods and could duplicate their effects. Surface the conflict explicitly.
A failed swap may leave the newly written table unreachable; that is garbage, not corrupt visible
Dictionary state.

### 9. The first public Dictionary protocol is deliberately small

Install:

```smalltalk
Dictionary >> initialize
Dictionary >> size
Dictionary >> includesKey:
Dictionary >> at:
Dictionary >> at:put:
```

`Dictionary` inherits `Class >> new` from ADR 0046. `basicNew` creates the normal one-slot instance
with `table = nil`; `initialize` creates the empty table and rewrites that slot, then answers `self`.
This preserves ADR 0046's existing rule that allocation and initialization are separate durable
operations. A failed initialize may leave an uninitialized Dictionary object and/or an unreachable
empty table; `new` does not pretend to be a transaction across arbitrary Smalltalk code.

`at:` on a missing key raises a distinct host-side `SmalltalkDictionaryKeyNotFoundError` for now.
Language-level `KeyNotFound` conditions, `at:ifAbsent:` and resumption belong with the deferred
exceptions/conditions mechanism rather than being improvised as a second error system here.

The first protocol does not include removal, iteration, associations, keys/values collections, or
capacity tuning.

### 10. Dictionary operations are image-native semantics, not ADR 0037 authority checks

The rule from ADRs 0046 and 0047 continues:

```text
image-native Smalltalk mutation       no ADR 0037 grant
foreign/external object mutation      ADR 0042 authorization
```

`initialize` and `at:put:` mutate image-owned language objects and need no execution authority
context. Cross-image primitive misuse is still refused where an operation would act on foreign image
state. Pure identity comparison of a foreign ref argument may answer false without reading that
foreign object; equality does not turn reference comparison into authority.

### 11. Both execution lanes reach the same ordinary methods and primitive family

No new `lagrange-code` op and no new executable representation is introduced.

The implementation extends `smalltalk-kernel-primitive/v1` with the language operations required by
this ADR and installs semantic methods through the existing `defineMethods` route. Neutral and WASM
therefore execute the same method definitions and use the existing send/suspension machinery when a
Dictionary primitive calls `hash` or `=`.

The non-tail case is load-bearing: an `at:put:` result feeding a further send must resume correctly in
the WASM lane, just as ADR 0047 proved for Array mutation.

### 12. The table representation is designed for a later MethodDictionary fast path

This ADR does **not** rewrite any Behavior's `methods` ref. Shape-backed MethodDictionaries continue
to mean exactly what ADR 0044 says they mean.

However, the language-owned built-in equality/hash helpers are pure for built-in immediate values.
A later MethodDictionary migration may therefore store selector Text Values as keys in this exact
hashed-table representation and let dispatcher lookup do:

```text
built-in Text hash(selector)
probe stored hashes
built-in exact Text equality
```

without sending `hash` or `=` and therefore without recursively executing Smalltalk while trying to
find the method that would implement those sends. That fast path is valid only for the representation
and key kind the later ADR explicitly nominates; general Dictionary lookup continues to use dynamic
methods.

The old Shape-backed representation remains readable until an explicit migration rewrites records.
`assertUniqueSelectorShape` therefore remains necessary after this ADR.

### 13. The generic graph and backend need no new collection concept

Dictionary keys, values and table refs are ordinary slots/indexed Values, so ADR 0047's walker already
sees every ref. Metadata may tag the internal table protocol but may not hide keys, values, hashes or
refs.

The durable Lagrange adapter serializes whole records and therefore needs no Dictionary-specific
schema. This ADR should not add a backend table, index, SQL shortcut or generic hash service.

`putShape` unknown-field validation is useful hardening after ADR 0047 but is orthogonal to this
semantic decision and should land as its own small PR (tracked separately).

## Proof required for implementation

```text
default equality
    two refs compare equal iff imageId/objectId are equal, independent of object version/contents
    integer equality is exact and integer/float equality succeeds only for exactly equal numbers
    +0 = -0; NaN is unequal to itself
    text and bytes compare by contents
    boolean sends survive the true/false effective-receiver bridge
    Array inherits Object equality and therefore remains identity-equal only

stable hash
    every built-in equal pair above has equal hash
    hash is identical across two fresh runtimes/restarts for the same built-in value/ref
    object hash ignores backend _version and mutable slots
    numerically equal Integer/Float pairs have identical hash
    +0 and -0 have identical hash
    changing the hash implementation would be observable, so the exact SHA-256/63-bit contract is tested

user overrides
    a class overriding both = and hash can make two distinct refs act as one Dictionary key
    Dictionary actually sends hash/=; it does not bypass overrides with the built-in helper
    a non-Integer hash result fails explicitly before publishing a new table
    a non-boolean = result fails explicitly

Dictionary representation
    Dictionary new has stable identity and points at a complete empty table of minimum capacity 8
    nil is a valid key because occupancy is the hash cell, not the key cell
    a table indexed length is exactly capacity*3 and tally matches occupied buckets
    every published table is left untouched by later mutations
    keys/values that are refs remain visible to referencesOfRecord through indexed table elements

protocol
    size starts at 0 and counts unique keys, not writes
    at:put: inserts and answers the value
    at:put: for an equal key replaces the value without increasing size
    includesKey: distinguishes present/absent keys
    at: returns the stored value and missing at: raises SmalltalkDictionaryKeyNotFoundError
    collisions probe correctly even when distinct keys have the same hash
    insertion past 3/4 load doubles capacity and preserves every mapping

concurrency/failure
    mutation publishes a fresh table then CAS-swaps exactly one Dictionary slot
    a conflict after user hash/= code is surfaced, never silently retried
    a failed/preempted swap leaves the old Dictionary mapping complete and unchanged
    a lost acknowledgement after the Dictionary swap is retry-safe: the mapping is found rather than duplicated
    an orphan next-table snapshot is unreachable state, not a half-published Dictionary

boundaries
    initialize and at:put: succeed with no authority context
    foreign primitive use cannot mutate a local Dictionary in another image
    pinned-ref as key fails at the ordinary missing-behavior/hash boundary; no hidden PinnedReference class appears
    compiler recognizes none of =, hash, initialize, size, includesKey:, at:, at:put:

both lanes
    the same semantic Object and Dictionary methods derive into neutral and WASM Blocks
    general lookup exercises nested hash and = sends in both lanes
    an at:put: result feeding a further send exercises WASM non-tail resumption
    installation is idempotent after success
    every publication write in the equality/Dictionary installer is covered by the existing exhaustive recovery-sweep style
```

## Implementation map for the coding agent

The exact filenames are not semantic, but the implementation should stay close to the existing seams:

```text
src/language/smalltalk-primitives.js
    extend the existing representation/arity table; do not create a new executor representation

src/language/smalltalk-equality.js (recommended new module)
    built-in equality normalization + stable hash helper
    Object >> = / hash installer
    pure built-in helper reusable by a later Text-only dispatcher path

src/language/smalltalk-dictionary.js (recommended new module)
    Shape ids and table validation
    immutable table snapshot construction/probing
    Dictionary class/protocol installer
    Dictionary primitive helpers

src/language/index.js
    public installer exports

docs/seams.md
    document the new post-bootstrap installers/primitives without adding a fake new executable representation

test/smalltalk-equality-hash.test.js
    built-in and override contract, both lanes where execution matters

test/smalltalk-dictionary.test.js
    representation/protocol/collision/growth/concurrency/authority/both-lane proofs

test/smalltalk-dictionary-recovery.test.js (or folded into the main Dictionary test)
    exhaustive pre/post-commit publication sweep, not sampled checkpoints
```

Prefer pure helpers for table validation/probing/hash normalization so tests can prove the durable
representation directly rather than only through surface sends.

Do not add instance-variable syntax, a generic Map Value, backend-specific indexes, `Dictionary` logic
to `src/execution`, or a dispatcher dependency on arbitrary Smalltalk execution to make this task
convenient.

## What is deferred

- migrating ADR 0044 MethodDictionary records to the hashed representation
- removing `assertUniqueSelectorShape` or the legacy Shape-backed lookup path
- `IdentityDictionary`, weak dictionaries, ephemerons and GC-sensitive key semantics
- key removal/tombstones, `removeKey:`, association enumeration and collection iteration
- user-selectable capacity/load factor and write-performance optimizations
- multi-record image transactions solely to optimize Dictionary mutation
- language-level conditions/exceptions, `at:ifAbsent:` and resumable missing-key handling
- `==` as a distinct public identity selector; this ADR only needs default `=` and `hash`
- Unicode normalization/collation semantics for Text
- changing mutable-key behavior; keys whose equality/hash changes while resident remain the program's responsibility
- a Smalltalk class/behavior for pinned refs

## Guardrails

```text
= and hash are Smalltalk methods; lagrange-code equals stays frozen and unchanged
default ref equality is image/object identity, never revision or contents
default immediate equality is the built-in relation specified here
built-in hash is deterministic SHA-256 -> non-negative 63-bit Integer over the equality normal form
built-in hash/equality are language-owned helpers, not generic Value API
a = b implies equal hash; user overrides own that obligation
Dictionary identity is stable; published table snapshots are immutable by language contract
bucket occupancy is the hash cell, so nil remains a legal key
v1 uses open addressing, linear probing, minimum capacity 8, max load 3/4, no deletion
at:put: builds a complete next table and CAS-swaps one Dictionary ref after user hash/= sends finish
conflicts after user code are surfaced and never silently retried
image-native Dictionary mutation is not an ADR 0037 authority check
general Dictionary lookup sends hash/=; later MethodDictionary Text lookup may use only the pure built-in fast path
MethodDictionary migration is enabled by the representation, not performed here
no new generic collection Value, backend schema, common IR op, or executable representation
```