# ADR 0089: Super sends

Status: implemented — `super` is a reserved pseudo-variable and never a Value; a super send keeps the receiver and moves only where lookup starts, which is `superclass(the defining Behavior of the running method)` taken from the ADR 0050 trusted dispatch frame, resolved through the existing lookup owner and activated through the existing invocation owner.
Proven by: test/super-send.test.js, test/cuis-yaxo-native-import-real.test.js

## Problem

ADR 0006 deferred exactly one bullet that is still open and now blocking: **"inheritance and `super`"**.
Inheritance arrived with ADR 0044 — lookup walks the superclass chain — but a super SEND never did.
Nothing has implemented it since, so the semantic compiler treated `super` as an ordinary name and
refused with `unbound Symmetric Smalltalk name: super`.

The consumer that forced it is not a fixture. The ADR 0085 M4 vertical (bead `lagrange-images-xxm`)
stops at the very first method it needs, and that method is the pinned upstream YAXO package's own
public entry point, unedited:

```text
cuis-method/YAXO/XMLDOMParser/class/parseDocumentFrom:

    parseDocumentFrom: aStream
        ^(super parseDocumentFrom: aStream) document
```

Measured on the M4 harness: the nine-class DOM/parse import scope constructs natively with Cuis
gone, keeping three levels of real upstream inheritance, and the overridden implementation
(`SAXHandler class>>parseDocumentFrom:`) is in the same manifest and the same scope. Nothing about
the class graph, the declared scope or the canonical export was short — the missing thing was the
language semantic.

Two wrong repairs are named because both would have made the import test pass. Rewriting `super` to
`self` in the Cuis adapter silently changes which method the package calls. Binding `super` as a
global gives it an object to denote, which it does not have.

## Decision

1. **`super` is a reserved pseudo-variable, and it is NOT a Value.**

   It joins `self`, `true`, `false` and `nil` in `isReservedWord`, which is the single place ADR 0056
   decision 3 enforces the rule across all four sites that could otherwise drift: block parameters,
   temporaries, assignment targets and programmatic captures. The parser gives it its own syntax node
   exactly as `self` has one, so no later stage can mistake it for a name.

   It exists only as the RECEIVER MARKER of a message send. A bare `super`, `super` as an argument,
   and `super` as an assigned value are all refused — `super is not a value: it may only be the
   receiver of a message send` — rather than answering a proxy object. A proxy would be a second
   receiver, and a second receiver is precisely what a super send does not have.

2. **`self` is unchanged; only lookup moves.**

   ```text
   super foo: x        the message goes to the running method's own self
                       lookup starts at superclass(the DEFINING Behavior of that method)
   ```

   The starting Behavior is **not** the receiver's class, **not** the receiver's class's superclass,
   **not** a class named in source, **not** a Block's metadata, and **not** any Cuis class identity.
   Those coincide whenever the receiver's class *is* the defining class and diverge for every deeper
   subclass, which is exactly why a two-level proof on an instance of the immediate subclass proves
   almost nothing. The load-bearing case is three levels: `A`, `B < A`, `C < B`, with `answer` on both
   `A` and `B` and `viaSuper` defined on `B`. Sent to a **C** instance, `viaSuper` must answer `1`.
   Ordinary lookup of `answer` from C finds B's; a super send written inside B's method starts above
   B. Lowering `super answer` to `self answer` answers `2`.

3. **The defining Behavior comes from the trusted dispatch frame, and is never reconstructed.**

   ADR 0050 decision 5 already rejected recovering it by asking which dictionary holds a Block: the
   answer is neither unique — a Block may legitimately sit in two — nor trustworthy, because it comes
   from graph data a forged artifact can arrange. ADR 0050 decision 5b already transports the correct
   fact: the invocation owner validates a frame as exactly `{self, definingBehavior}`, where
   `definingBehavior` is the Behavior whose dictionary actually supplied the running method.

   The super primitive reads `context.invocationFrame` exactly as the instance-slot primitives do, and
   for the same reason. No frame means no defining Behavior, so it fails closed with
   `SmalltalkSuperFrameMissingError` rather than guessing one from the receiver.

4. **`super` lowers to an ordinary send of a language-owned primitive; `lagrange-code` learns nothing.**

   ```text
   super answer            ->  $superSend value: 'answer'
   super + x               ->  $superSend value: '+' value: x
   super at: k put: v      ->  $superSend value:value:value: 'at:put:' k v
   ```

   No `super-send` IR operation was added, and no IR version was cut. This is the same shape ADR 0055
   used for `^`, ADR 0056 used for `nil` and Symbol, and ADR 0050 used for instance slots: Smalltalk
   syntax lowering to an ordinary send reached through a reserved capture, so nothing downstream of
   the compiler — neither execution lane, the dispatcher, nor the shared model — learns that Smalltalk
   has inheritance. Unary, binary and keyword forms all fall out of the one lowering because they all
   arrive at the compiler as the same `send` node.

   The compiled artifact carries the SELECTOR and the arguments and nothing else. It names no class,
   because which Behavior to start above is a runtime fact of the frame and must not be statable by
   source or by a durable artifact.

   4a. **The binding seam is the existing one.** Reserved capture `$superSend`, Block id
   `smalltalk/primitive/super-send`, offered by the CLASS-SCOPED binder as an intrinsic — made
   available rather than declared, so a method that never writes `super` carries no binding for it —
   and bound to that image's Block at installation. The semantic artifact stays image-independent.

   4b. **It is the one variadic primitive**, because the message it forwards is. Its arity entry is a
   minimum (the selector) and the executor consults an explicit `SMALLTALK_PRIMITIVE_VARIADIC` set;
   every other primitive keeps its exact-arity guard untouched. The alternative — a family of
   `super-send-0`, `super-send-1`, … Blocks — would be N durable primitive names for one operation.

5. **A super send needs a method home, exactly as `^` does.**

   A compilation with no method home has no defining Behavior to start above and never could have, so
   this is a fact about the compilation and is reported there: `super requires a method home:
   \`super\` is only valid inside a method`. `installSymmetricSmalltalkBlock` refuses it; the
   class-scoped method compiler permits it. This is ADR 0055 decision 6a's rule applied to the second
   construct that needs it.

6. **Lookup is delegated. There is no second superclass walk and no second dictionary reader.**

   The primitive reads the defining Behavior through `readBehavior` (the Behavior owner), takes that
   Behavior's existing `superclass` edge, and calls `lookupSelector` (the lookup owner) with it as the
   starting point. It contains no loop, no method-dictionary decode and no Shape read.

   There is deliberately **no branch for a root-defined method**. A kernel-nil superclass makes the
   shared walk terminate on its first comparison, which is exactly the ordinary
   message-not-understood outcome a super send off the top of the hierarchy should have. A special
   case here would be a second place deciding when lookup ends.

   The ADR 0044 three-way split therefore survives unchanged through a super send: a malformed
   Behavior, a dangling superclass or method-dictionary edge, and an ordinary selector miss stay three
   different answers, and none of them is `unbound Symmetric Smalltalk name`.

7. **The callee gets the ACTUALLY resolved defining Behavior, through the existing invocation owner.**

   `lookupSelector` answers `{method, definingBehavior}`. The callee's trusted frame becomes
   `{self: the unchanged receiver, definingBehavior: the Behavior that supplied the method}` — not the
   Behavior the send started above, and emphatically not the caller's frame.

   ```text
   1  read the caller frame                 {self: S, definingBehavior: D}
   2  readBehavior(D).superclass             the Behavior owner's edge
   3  lookupSelector(from that, selector)    the lookup owner            -> {method M, Behavior E}
   4  invokeResolvedMethod(M, S, {S, E})     the invocation owner
   ```

   Step 4 is a small INTERNAL seam, `InvocationService.prepareResolvedDispatch`, reached from the
   executor context as `invokeResolvedMethod`. It exists because `prepareDispatch` asks the dispatcher
   to look the selector up, and the dispatcher starts at the receiver's own Behavior — the one
   starting point a super send exists to avoid. What the language must NOT do instead is build its own
   activation and hang its own frame beside it, because those are the invocation owner's rules. So the
   language supplies the Block its own lookup owner chose plus the frame that lookup produced, and the
   frame then travels through the SAME `normalizeDispatchResolution` validation, into the SAME
   weakly-held envelope keyed on the SAME activation identity, discovered by the executor's existing
   priority walk. The callee therefore OWNS its frame, exactly as a dispatched method does.

   That is what makes a chained super work: `A>>answer`, `B>>answer ^ super answer`,
   `C>>answer ^ super answer`, sent to a C instance, walks C -> B -> A. A primitive that reuses the
   caller's frame makes B's own `super answer` start above C again, find B's `answer`, and recur until
   the depth limit.

   **One owner for lookup, one owner for activation and frame attachment; this facility composes
   them.**

8. **Class-side falls out of the same generic rule, with no branch.**

   The real consumer is class-side. `readBehavior(frame.definingBehavior).superclass` walks the
   METACLASS hierarchy when the defining Behavior is a metaclass, because ADR 0044 decision 4 derives
   the metaclass chain from the class chain rather than writing it out per class. There is no
   `instance class superclass` step, no instance-side approximation, and no class-side code path.

9. **No importer semantics.**

   `super` is not rewritten during Cuis import, the canonical semantic export is unchanged, and no
   YAXO-shaped case exists anywhere. The Cuis-free instrument that proves this compiles an ordinary
   native class through the ordinary `reconcileMethodsFromSource` path — the same path the adapter
   uses — with material this repository wrote and no Cuis provenance at all.

10. **The boundary this slice actually supports, recorded honestly.**

    | construct | supported | why |
    | --- | --- | --- |
    | `super` in a method body, all three send forms | yes | the forcing consumer, and the whole of decision 4 |
    | `super` in a nested Block, same execution | yes | ADR 0050 decision 10 restores the creating method's frame, so it is genuinely lexical and needs no new durable state |
    | `super` in a closure that outlived its execution | **fails closed** | ADR 0050 decision 10a: there is no frame to restore, and the alternative is a persisted defining-Behavior claim that ADR 0050 forbids |
    | `super` as a cascade receiver | **refused** | the cascade lowering evaluates its receiver ONCE into a hidden temporary, and `super` denotes no value to put there |

    The nested-Block row is proved rather than assumed, and it is the honest limit of the claim: the
    owner-correct implementation handles it because the frame-restore rule already existed, not
    because anything was added for it. No arbitrary Block is lent a caller's frame, and no durable
    method-home state was introduced. A cascade on `super` would need cascade semantics of its own;
    the forcing consumer is an ordinary keyword super send, so it is refused deterministically instead
    of half-supported, and stays available to a future slice with a real consumer.

## Alternatives rejected

- **Lower `super foo` to `self foo`.** Silently changes which method the package calls. Reddens the
  three-level lexical proof, which is why that proof is shaped the way it is.
- **Bind `super` as a global, or leave it an ordinary name.** `super` denotes no object; a global
  would give it one. Leaving it a name is the defect this ADR repairs.
- **Start lookup at the RECEIVER's dynamic superclass.** Correct only when the receiver's class is the
  defining class. A C instance running a B-defined method exposes the difference immediately.
- **Reconstruct the defining class by asking which dictionary holds the running Block.** Rejected
  already by ADR 0050 decision 5: not unique, and sourced from forgeable graph data.
- **Name the superclass in the compiled artifact.** It would make a durable artifact state a lookup
  starting point, which a forged artifact could then choose; the frame exists precisely so it cannot.
- **Add a `super-send` operation to `lagrange-code`.** The shared model is shared with every other
  personality and has no notion of Smalltalk inheritance. A composition through the existing
  primitive/capture machinery exists, so the IR stays frozen — the same conclusion ADRs 0051, 0053 and
  0055 reached for loops, ordering and `^`.
- **A family of fixed-arity `super-send-N` primitives.** N durable primitive names for one operation,
  and a new one every time a longer keyword message appears.
- **Let the super primitive build its own activation and attach its own frame.** Two owners for
  activation and frame attachment, and the second one would not be the one the executor's discovery
  walk consults.
- **Reuse the caller's `definingBehavior` for the callee.** Breaks chained super into unbounded
  recursion, and would hand the callee the wrong instance-variable permissions.
- **Implement `instance class superclass` or any instance-side approximation.** The real consumer is
  class-side; an instance-side rule leaves it red.
- **Rewrite `super` in the Cuis adapter, or teach the semantic export about it.** The manifest carries
  upstream source verbatim and the adapter translates headers faithfully. The gap was never theirs.

## Proof

`test/super-send.test.js` holds the language proof: the exact-receiver identity through a superclass
method that answers `self`; the three-level lexical-versus-dynamic falsifier on both the instance and
the class side, each paired with a control showing ordinary lookup really does answer differently for
that receiver; the chained `C -> B -> A` walk that only terminates if the callee owns the resolved
defining Behavior; the class-side consumer's own shape (`^ (super make) + 5`); all three send forms;
both execution lanes; `reconcileMethodsFromSource` compiling and running a super send with no Cuis
material in sight; an ordinary message-not-understood off the top of the hierarchy and from a
root-defined method; a dangling superclass edge staying corrupt graph state rather than a miss; the
four reservation sites; the three not-a-value refusals and the cascade refusal; the method-home
refusal; the nested-Block boundary in both directions; and a structural scan proving the facility
imports `lookupSelector` and `readBehavior`, activates through the invocation owner, and contains no
loop, method-dictionary decode or Shape read of its own.

`test/cuis-yaxo-native-import-real.test.js` (real pinned upstream lane,
`LAGRANGE_OPENSMALLTALK_INTEGRATION=1`) carries the acceptance: the unedited upstream
`XMLDOMParser class>>parseDocumentFrom:` now imports and compiles natively from the canonical export
with Cuis absent, and the harness records the vertical's NEXT first RED rather than this one.

Deliberate breaks, each applied, run and reverted, and each reddening exactly its intended proof:
`super` lowered to `self` (the three-level lexical proof, on both sides); the primitive answering the
superclass Behavior as the receiver instead of `self` (the exact-receiver proof); lookup started from
the receiver's own Behavior's superclass (the three-level proof, again — the two-level shape would
have stayed green, which is why it is not the central test); the caller's frame passed to the callee
(the chained proof, as a depth-limit failure); `super` left as an ordinary name (the reservation and
not-a-value proofs, and the YAXO import back to `unbound Symmetric Smalltalk name: super`); the
class-side proofs run against an instance-side `class superclass` approximation (both class-side
proofs); and a second superclass walk inlined into the primitive (the structural scan).

## Not in scope

`super` as a cascade receiver; `super` in a closure invoked in a later execution (fails closed, and
making it work is refused rather than deferred, for ADR 0050 decision 10a's reason); any reflective
reader of a method's defining Behavior; `thisContext`; and every remaining YAXO compatibility gap
behind this one on the M4 vertical, each of which is chosen by the executable vertical when it is the
first causally necessary failure.
