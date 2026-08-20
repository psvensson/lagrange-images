# ADR 0053: Integer ordering and arithmetic

Status: implemented — ordering and the remaining arithmetic are ordinary Smalltalk methods backed by language-owned Integer primitives, so `lagrange-code/v0` stays frozen and the neutral IR never learns Smalltalk's numeric protocol.
Proven by: test/integer-protocol.test.js, test/smalltalk-library.test.js

## Problem

`OrderedCollection` cannot index. Everything it does walks from the front and stops on `=`, because
`=` is the only comparison the language has:

```smalltalk
do: aBlock
  | index | index := 1.
  [ index = (tally + 1) ] whileFalse: [ ... index := index + 1 ]
```

That idiom is why `at:`, `first`, `last` and `removeLast` are absent rather than merely slow: each
needs a bounds check, and a bounds check is an ordering question. Writing `at:` today would mean
either omitting the check — answering whatever the backing Array holds past the end — or simulating
one by counting up to the index, which turns a constant-time operation into a linear one and still
cannot detect an index below 1.

Arithmetic is the same shape of gap. `integer-add` is the only operation, so subtraction, scaling and
division are unavailable: `removeLast` cannot compute `tally - 1`, and growth cannot express anything
but doubling by repeated addition.

## Decision

### 1. Ordering is protocol, not an instruction

The same fork ADR 0051 faced, answered the same way: `<`, `<=`, `>` and `>=` are ordinary methods on
`Integer`, reached by ordinary dispatch, and backed by a language-owned primitive.

```text
lagrange-code/v0 and /v1   unchanged; no comparison op is added
the compiler               learns no comparison selector
executable representations unchanged
the neutral IR             never learns Smalltalk's numeric protocol
```

The alternative — a `less-than` op beside `integer-add` — was rejected because it puts a *language's*
numeric protocol into a language-neutral IR. `integer-add` is already the awkward precedent here
rather than the pattern to follow: it predates the dispatch machinery that makes a primitive-backed
method possible, and this ADR deliberately does not extend it.

### 2. One primitive, three derived methods

The primitive is a captured Block invoked by ordinary semantic wrapper methods, exactly as every
kernel primitive since ADR 0046 is reached — not something a method "is":

```text
primitive          integer-less-than    two Integers -> canonical boolean

Integer >> <       primitiveLessThan value: self value: other
Integer >> >       primitiveLessThan value: other value: self      the same primitive, swapped
Integer >> <=      if (primitiveLessThan value: other value: self) then false else true
Integer >> >=      if (primitiveLessThan value: self  value: other) then false else true
```

Each method is an ordinary installed method whose program captures the primitive Block by ref and
sends it `value:value:`. Nothing about the dispatch path is special-cased: `<` is found by the same
Behavior walk as `+` and `ifTrue:`.

Four primitives would be four chances for the set to become inconsistent — a `>=` that disagrees with
`<` at exactly one boundary is the classic bug, and it cannot happen if only one comparison exists.

The negation in `<=` and `>=` is a wrinkle worth naming rather than hiding: `not` does not exist, and
ADR 0045 deferred it deliberately. Inventing it here to spell two methods would be scope creep, so
these two are installed as programs whose body uses the existing `if` operation over the primitive's
result. That keeps the negation internal to two installed methods rather than making it language
surface, and `not` remains an open decision belonging to ADR 0045's deferred Boolean protocol.

### 3. Arithmetic completes the same way

```text
primitives     integer-subtract       integer-multiply
               integer-floor-divide   integer-modulo

methods        Integer >> -   *   //   \\
```

`integer-floor-divide` is named for what it does rather than for the operator it backs. A primitive
name becomes durable CodeArtifact content, so an image records `integer-floor-divide` forever; naming
it `integer-divide` would durably imply host division semantics that decision 4 explicitly rejects.

`+` keeps its existing `integer-add` implementation rather than being rewritten onto a primitive.
Changing it would touch the one arithmetic path every existing test already exercises, for no gain
beyond uniformity — and the ADR would rather have one documented inconsistency than a migration whose
only purpose is tidiness. Its rewrite belongs with `lagrange-code/v1`'s eventual successor.

### 4. Division is defined, not left to the host

Division is where "obvious" implementations silently disagree, so both operations are pinned:

```text
//    floored division      q = floor(a / b)
\\    modulo                r = a - q*b

the invariant that actually distinguishes this from truncation:
      for b > 0     0 <= r <  b
      for b < 0     b <  r <= 0

-7 // 2  =  -4        -7 \\ 2  =  1
 7 // -2 =  -4         7 \\ -2 = -1
```

Note what is *not* the distinguishing property: `(a // b) * b + (a \\ b) = a` holds for
truncating division too, in all four sign quadrants, so stating it alone would specify nothing. The
range of `r` is the real content — and specifically `0 <= r < b` for a positive divisor, which is
what makes `\\` directly usable for hashing and index arithmetic without a corrective branch at every
call site.

Host `BigInt` division truncates toward zero, so this is an explicit correction rather than a
pass-through — exactly the kind of place a "thin wrapper" quietly becomes wrong.

**Division by zero is an explicit failure.** No infinity, no null, no zero. A Value cannot represent
the result, and inventing one would put a non-number into an Integer-typed slot.

### 5. Arbitrary precision, with no silent narrowing

Integer Values are already arbitrary precision. Every primitive here computes in that precision and
answers an Integer Value:

```text
no overflow          a product wider than 2^53 is exact, not rounded
no coercion to float no operation answers a float64 for an Integer input
no host number path  the implementation never round-trips through a JavaScript number
```

### 6. Integers only; mixed-mode is deferred

These primitives accept two Integers and refuse anything else explicitly, naming the kind they got.
Mixed *ordering* and mixed *arithmetic* need coercion rules — what `1 < 1.5` answers, and whether a
mixed operation answers an Integer or a float — and that is a decision about the numeric tower rather
than about unblocking a collection, so it is deferred rather than guessed at.

Mixed **equality** is not deferred, because it is already decided: ADR 0048 says an Integer equals a
finite, integral Float representing the same mathematical value, so `1 = 1.0` is true and hashes
alike. This ADR changes nothing there. The distinction matters — equality is settled and must be
preserved, while ordering is open — and blurring the two would look like this ADR quietly reopening
a decision it has no business touching.

Sending `<` to a Float receiver is therefore an ordinary message-not-understood: `Float` has no
ordering protocol yet, and saying so is more honest than silently comparing through a coercion nobody
specified.

### 7. What this unblocks, and the debt it settles

```text
OrderedCollection >> at:           with a real bounds check
                     first  last   which are bounds checks in disguise
                     removeLast    which needs `tally - 1`
                     do: and friends stop counting up to compare with `=`
```

The library's count-up-and-compare-with-`=` idiom was recorded as a deliberate gap signal in ADR
0047 and in `AGENTS.md`. This ADR is what removes the gap, so the signal goes with it — the
awkwardness must not survive as decoration once the thing it pointed at exists.

## Proof required for implementation

```text
ordering
    <, <=, >, >= answer correctly across negative, zero and positive operands
    the four agree at boundaries: for equal operands, < and > are false and <= and >= are true
    exactly one of a < b, a = b, b < a holds, checked over a spread of pairs
    values beyond 2^53 compare exactly, including two that differ only in their low digit

arithmetic
    -, *, // and \\ answer correctly, including negative operands on both sides
    all four sign quadrants of // and \\ are covered explicitly: (+,+) (-,+) (+,-) (-,-)
    the *range* invariant holds in each: 0 <= r < b for b > 0, and b < r <= 0 for b < 0
        — the reconstruction identity alone would pass a truncating implementation
    a product beyond 2^53 is exact rather than rounded
    division and modulo by zero fail explicitly, and name the operation

refusals
    a non-Integer argument is refused explicitly and names the kind it received
    a Float receiver answers message-not-understood, not a coerced comparison
    ADR 0048's equality is unchanged: 1 = 1.0 is still true and still hashes alike

the library
    OrderedCollection gains at:, first, last and removeLast
    at: refuses 0, a negative index and one past the end, distinctly from answering nil
    the count-up-and-compare-with-`=` idiom is gone from do:, includes: and copyInto:
    a collection of a thousand elements still traverses

both lanes and durability
    neutral and WASM agree on every operation above
    installation is idempotent, and every write is swept pre-commit and commit-then-lost-ack

what must not have changed
    no new lagrange-code op, no new executable representation, no new Value kind
    the compiler recognizes no comparison or arithmetic selector
    `+` still runs through `integer-add`
    each method is an ordinary installed method capturing the primitive Block and sending
        `value:value:`, found by the same Behavior walk as `+`
```

## What is deferred

- `not`, `and:` and `or:` — still ADR 0045's, and deliberately not pulled in to spell two methods
- Float ordering, mixed-mode arithmetic and the numeric tower generally
- `min:`, `max:`, `between:and:`, which become ordinary Smalltalk once `<` exists
- a `Magnitude` or `Comparable` hierarchy; no class graph changes here
- rewriting `+` onto a primitive, which belongs with the IR's eventual successor
- bitwise operations, `gcd:`, `sqrt` and the rest of the numeric library

## Guardrails

```text
ordering is protocol backed by a primitive; lagrange-code stays frozen and gains no comparison op
one comparison primitive, three derived methods — four primitives is four chances to disagree
`not` is not invented here; the two negations live inside installed programs
// floors and \\ satisfies 0 <= r < b for b > 0 and b < r <= 0 for b < 0; the reconstruction
    identity alone does NOT distinguish floor from truncation, so never state it as the spec.
    Host BigInt truncates, so this is a correction rather than a pass-through
the durable primitive is named integer-floor-divide: the name outlives the decision in every image
    that records it, so it must not imply host semantics
division or modulo by zero fails explicitly; no infinity, no null, no zero
arbitrary precision throughout; never round-trip an Integer through a host number
two Integers only; a non-Integer is refused by name, and mixed-mode *ordering and arithmetic*
    stay deferred — mixed *equality* is already settled by ADR 0048 and must be preserved
a primitive is a captured Block a wrapper method sends `value:value:`; a method never "is" one
when the library's `=`-counting idiom becomes unnecessary, delete it — a gap signal must not
    outlive the gap
```
