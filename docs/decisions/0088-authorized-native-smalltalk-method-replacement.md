# ADR 0088: Authorized native Smalltalk method replacement

Status: implemented
Proven by: test/smalltalk-authorized-method-replacement.test.js, test/portable-runtime-environment-api.test.js, test/smalltalk-expected-current-binding.test.js, test/smalltalk-replacement-lane.test.js

## Problem

ADR 0087 decision 7 stopped at browsing on purpose: "a write lane needs its own consumer, its own
owner decision and its own ADR." That consumer now exists. The Object Environment (GitHub #218,
originating `lagrange-object-environment-eij.3`) has E1 and E2 merged on the ADR 0087 read seams and
is blocked on E3 — replacing one imported native method through an ordinary authorized Command.

Its audit of the pinned revision is the problem statement:

- of the five `authorized*` operations, the only write is `authorizedRenameProject`, a Project field;
- `smalltalk-method-description/v1` carried no version token, so the Environment held no legitimate
  replacement assumption for a method;
- `defineMethods` / `reconcileMethods` / `reconcileMethodsFromSource` contain no `require(` and no
  authority at all — they are trusted construction helpers, and calling one from a consumer would
  bypass the authority model entirely.

The Environment stated it would stay blocked rather than call compiler or reconciliation internals.
The failure mode to avoid is therefore specific: a consumer reaching a private `src/language/...`
path, or an authorized wrapper that re-decides concurrency, compilation or storage rules that
already have owners.

ADR 0086 supplied the substrate (a logical position `{Class/Metaclass, selector}` whose currently
bound Block is the immutable current revision) and bead `lagrange-images-qax` supplied the two
slices below this one: the opaque selector-position token minted by
`authorizedReadSmalltalkMethodForUpdate` (slice B), and the class builder's `expectedCurrent`
precondition with its rebase, staleness and contention semantics (slice C1).

## Decision

1. **One public authorized replacement operation, and it replaces only what already exists.**

   ```text
   authorizedReplaceSmalltalkMethod({images, compilation, imageId, classRef, selector,
                                     source, expectedVersionToken, require})  ->  {replaced: true}
   ```

   `src/language/smalltalk-authorized-method-replacement.js` owns it. No method addition when the
   selector is absent, no removal, no class editing, no batch editing, no durable method source, no
   protocol/category, no Cuis provenance, no public compiler and no public reconciliation API.

2. **The seam owns six things and no others**: caller-owned input validation; the token's syntax and
   scope for THIS `{image, class, selector}`; the authority demand and its order relative to every
   graph read; the current-position resolution that bridges a token to an expected binding; the
   pre-compilation admission of that expectation; and the public result/error contract.

   Everything else stays where it already was. What "still current" means once a write is in flight,
   the unrelated-selector CAS rebase, the bounded contention budget, immutable revision publication
   and source lowering all belong to the class builder and the from-source compiler owner, reached by
   handing `reconcileMethodsFromSource` the caller's original observation as `expectedCurrent`. The
   current binding is read through the ONE current-binding reader (`methodBlockRef`). This module
   decodes no MethodDictionary bucket, Shape or backend `_version`, opens no dictionary, and runs no
   write, retry, rebase or loop of any kind.

3. **Order is the contract.**

   ```text
   1  validate caller-owned shape           pure; cannot be an existence oracle
   2  validate the token's scope            a token for another position is REFUSED, never reinterpreted
   3  require object/write on the Class     before ANY record is read
   4  resolve the current binding           through the one current-binding reader
   5  admit the token's observed binding against it
   6  stale -> refuse, BEFORE any compilation is invoked
   7  reconcileMethodsFromSource(...) with expectedCurrent = the caller's ORIGINAL observation
   8  map only public semantic outcomes
   ```

   Steps 1 and 2 precede step 3 so a malformed call is diagnosed as one rather than as an authority
   failure, and they disclose nothing: both are pure. Step 3 precedes step 4 so existence is never
   disclosed to a caller who may not write the class.

4. **Authority is exactly one `object/write` on the declaring Class or Metaclass.** A replacement
   mutates that Behavior's selector-BINDING state. It is deliberately NOT demanded on the previously
   bound Block: that Block is immutable revision material (ADR 0086 decision 1) and is not what
   changes — the binding stops pointing at it — so requiring write there would authorize a mutation
   nobody performs and refuse a caller who owns the class but not the method's previous revision.

   Write is never inferred from a class `object/read`, a Block `object/read`, possession of refs,
   Project membership (ADR 0039 §2), or possession of the token. **A version token is an assumption
   about state and confers zero authority**; it is minted by a read that asserts no write authority,
   and treating it as permission would let every reader rewrite every method it had browsed.

   Authorization strictly precedes existence disclosure, exactly as ADR 0087 decision 4 requires: an
   implemented selector, an unimplemented one and a missing class are one `AuthorityError`, and the
   refusal is a pure function of what the caller supplied.

5. **The admission check in front of compilation is not a second authority on staleness.** The class
   builder's earliest expectation check is at plan time, which is after `reconcileMethodsFromSource`
   has compiled the source. Relying on it alone would answer a compiler diagnostic to a caller whose
   real problem is that its observation was overtaken, and would compile source already known to be
   inadmissible. So the same observation is admitted here first and then passed down, where the owner
   re-asserts it at plan time and at every rebase boundary; the owner's verdict is final. Removing
   this check changes which error a stale caller sees and how much work a doomed call does — it could
   never let a stale replacement land.

   **The caller's token remains the assumption throughout.** The binding read in step 4 admits the
   token; it never replaces it. A hidden fresh read substituted for the caller's observation would
   make a stale conflict impossible to observe, which is exactly the property #218 point 2 asks this
   operation to prove it cannot have. An ABSENT selector is stale rather than a fresh definition —
   the same rule the class builder applies — because E3 adds no method.

6. **No execution lane is published, and replacement does not change one.**

   > **AMENDED by bead `lagrange-images-it3`, after this ADR was implemented and before GitHub #218
   > was handed back.** As first written, this decision said that `reconcileMethodsFromSource`
   > compiles in its own default lane, so a method installed in the WASM lane — every Cuis-imported
   > method is — is replaced by one in the NEUTRAL lane, and that this observable representation
   > change was the accepted consequence of publishing no lane knob. That consequence was real and
   > tested, but it was never the E3 contract, and it is corrected below rather than deleted so the
   > record of what shipped in PR #222 stays legible. Decisions 1-5 and 7-10 are unchanged.

   A `lane` parameter is still deliberately absent, for the reason originally given: it would publish
   a compiler/execution knob on a seam whose point is that E3 exposes no compiler. And this seam
   still may not discover the current method's lane itself — that would mean reading the bound
   Block's code artifact, making it a second CodeArtifact decoder, which ADR 0087 rejected for the
   read seam.

   What was wrong was the conclusion drawn from those two facts. `{Class/Metaclass, selector}` is the
   logical method position and the Block bound there is the immutable current revision (ADR 0086
   decision 1). A caller's E3 operation says *replace the semantics of the method I observed*; it
   does not say *and also migrate its execution representation*. Because E3 exposes no compiler and
   no lane knob, a lane change underneath it is a SECOND mutation the caller neither requested nor
   can observe through the public contract — which is a worse property than the one the missing knob
   was protecting.

   **The rule is therefore: authorized replacement does not expose execution-lane choice, and the
   native method evolution owner PRESERVES the execution lane of the revision the caller observed.**
   Observed WASM revision -> replacement compiled and published in the WASM lane; observed neutral
   revision -> replacement in the neutral lane. **Changing execution lane is not part of E3**, and
   there is no fallback in either direction: if the observed lane cannot compile the replacement
   source, the replacement FAILS and the observed revision remains current. A later explicit lane
   migration, should real consumer pressure ever appear, is a separate operation with its own policy.

   The owner is the class builder, which already decides revision identity, lane-specific Block/code
   production, exact replay and revision publication. It answers the lane question from
   `metadata: {smalltalk: 'method', selector, lane}` — a fact it PUBLISHES ITSELF on every method
   Block it installs and already compares in `isSameInstalledMethod` — so this is the owner reading
   its own record, not a CodeArtifact or executable-representation decode. That distinction is
   exactly why the question is answerable there and not here. Missing, malformed or unknown lane
   metadata is refused as `SmalltalkMethodLaneError`; there is deliberately no "default to neutral
   because we could not tell", since that would migrate precisely the records whose provenance is
   least trustworthy. This seam is UNCHANGED by the amendment: it still passes only the caller's
   observed binding down, contains no lane selection, no representation branching and no
   CodeArtifact read, and a structural proof keeps it that way.

7. **Source is explicitly supplied and is not persisted.** ADR 0087 decision 6's `source: null`
   remains truthful after a successful replacement, and #218 point 5 says explicitly that changing it
   is not a precondition for E3. This is replacement from supplied source, not a source editor.

8. **The receipt is frozen `{replaced: true}`.** No new Block ref, no descriptor, no replacement
   token, no source. A successful replacement legitimately rebinds to a FRESH Block identity, and the
   consumer has already committed to a fresh authorized reread as displayed truth (#218 point 4); a
   richer receipt would only tempt it to skip that reread and patch local state from a write result.

   It says "the position now denotes the source you supplied", not "a record was written": supplying
   source that means exactly what is already bound is ADR 0086 exact replay against the very state
   the caller observed, so it is a write-free success with the same receipt and an unmoved binding.

9. **The public taxonomy is discriminated by `error.name`**, the only discriminator available through
   `src/portable-runtime.js`, where these classes are deliberately not published:

   | `error.name` | Meaning |
   | --- | --- |
   | `SmalltalkMethodReplacementInputError` | malformed caller-owned input |
   | `SmalltalkMethodPositionTokenError` | malformed token, or one issued for another image/class/selector |
   | `AuthorityError` | the caller's own `require` denied `object/write` |
   | `SmalltalkMethodTargetError` | after authorization: no such native method position |
   | `SmalltalkStaleMethodPositionError` | the observed binding is no longer current (the class builder's own class) |
   | `SmalltalkMethodReplacementContentionError` | transient: the position is unchanged and was not advanced |
   | `SmalltalkMethodLaneError` | the observed revision records no usable execution lane, so decision 6 cannot preserve it (the lane owner's own class, passed through unrestated because it already names only the caller's position) |
   | anything else | the native compiler/source owner rejected the source |

   Malformed caller input gets its own class because the native semantic compiler also rejects bad
   SOURCE with a bare `TypeError`, and those two demand opposite responses from a consumer. The
   target and contention verdicts are restatements rather than pass-throughs because the owner's
   corresponding errors name the class's MethodDictionary RECORD; the contention verdict covers both
   an exhausted rebase budget and a dictionary sealed for migration, because the caller's response to
   both is the same and neither is a statement about the request. Only the class builder's own
   semantic refusals are restated: a host or transport failure of the binding read propagates as
   raised, because it is not a statement about this position.

   No backend `VersionConflictError` escapes raw or as a `cause`, and no MethodDictionary ref,
   representation, seal or version, backend version, winning Block ref or replacement token appears
   in any refusal. Current truth comes only from a fresh authorized read.

10. **Published by name from both reviewed roots, and deliberately not through the language barrel.**
   `src/runtime.js` and `src/portable-runtime.js` re-export the exact owner function.
   `src/language/index.js` does not list the module: that barrel is `export *` and `src/runtime.js`
   re-exports it, so adding it there would publish the module's internal error classes — and any
   helper a later change adds — on the package's `.` and `./language` surfaces. This is the barrel
   trap that has already produced three defects in this bead's PR family, and it is verified by
   enumerating each root's BINDINGS rather than by a module count.

## Alternatives rejected

- **Publish `reconcileMethodsFromSource` (or a thin renaming of it) as the write seam.** It contains
  no authority at all; #218 says in terms that the Environment will stay blocked rather than call it.
- **Make the token the Block ref.** The browse seam already discloses that ref, so a ref-as-token
  would be locally derivable and could not express an assumption ABOUT the ref (bead
  `lagrange-images-qax`, slice B).
- **Require `object/write` on the currently bound Block**, on the grounds that storage points at it.
  It is immutable and is not modified; see decision 4.
- **Let the wrapper own the stale decision, the CAS or a retry budget.** Two owners for one rule, and
  a race in the gap between reading a binding and writing it. The precondition lives at the class
  builder for the same reason the CAS classification does.
- **Report an absent selector as a missing target rather than as staleness.** The class builder
  already decided absent-under-an-expectation is stale; a second answer here would make the public
  verdict depend on whether the selector vanished before or during the call.
- **Return the new Block ref, descriptor or a replacement token in the receipt.** Each invites the
  consumer to skip the authoritative reread it has committed to, and a token in particular would let
  a caller chain writes on an assumption it never read.
- **Persist the supplied source so `descriptor.source` stops being `null`.** ADR 0087 rejected
  reconstructing source, and #218 explicitly declines to make durable source an E3 precondition.
- **Add rollback so a failed replacement leaves no immutable material.** ADR 0086 already decided
  create-before-publication and states the consequence honestly; the load-bearing invariant is that a
  failed, stale or uncompilable replacement never makes its revision CURRENT.
- **Let the replacement land in the from-source owner's default lane** (what shipped, and what
  decision 6 originally accepted). It is a second mutation the caller neither requested nor can
  observe: E3 publishes no lane knob, so no consumer can ask for it, ask against it, or see that it
  happened. See the amendment.
- **Try the observed lane and fall back to the other when it rejects the source.** That performs the
  migration E3 does not offer, silently, and precisely when the caller has least reason to expect it.
  A replacement the observed lane cannot compile fails.
- **Default to neutral when the observed revision's lane cannot be read.** It would migrate exactly
  the records whose provenance is least trustworthy — a binding without lane metadata came from a
  generic graph write, not from this owner. `SmalltalkMethodLaneError` instead.
- **Answer the lane question inside this seam by reading the bound Block's code artifact.** The
  second CodeArtifact decoder ADR 0087 rejected. The lane owner reads its OWN published
  `metadata.lane` instead, which is not a decode.

## Proof

`test/smalltalk-authorized-method-replacement.test.js`: a still-current position advances while its
sibling does not, with a frozen one-key receipt and a fresh Block identity; `descriptor.source` still
`null` afterwards; a WASM-lane method replaced, still dispatching, with the replacement still in the
WASM lane; replacing a method with what it already means answering the same receipt write-free; denial before existence, with an implemented selector, an unimplemented one and a
missing class producing refusals that are a pure function of caller input; class read, class read
plus Block read, and write on the OLD BLOCK all refused, while the class write succeeds; a valid
current token with no grant refused; exactly one demand, issued with zero records read; wrong-scope,
malformed, non-base64url and absent tokens all refused as token verdicts with nothing mutated; a
stale position refused with the compiler owner never invoked, using an uncompilable source so the
verdict alone separates the two orderings; the caller's token still stale against a winner this seam
has just seen; a stale refusal disclosing no winning ref, version or MethodDictionary record; a
mid-flight move still refused with the winner surviving; an unrelated selector's winner preserved
through a real rebase; sustained contention answering a position-scoped transient verdict with no
backend conflict, cause or storage identity; a dictionary sealed for migration answering the same
transient verdict without naming the sealed record; a non-semantic read failure NOT reinterpreted as
a missing target; malformed caller input as its own verdict before any demand or read; an invalid
source rejected as a source with the exact old binding still current; a structural check that the
module imports only owners, carries the caller's observation, and contains no `putObject`, storage
version, bucket, Shape, dictionary ref, loop, lane name, Block/CodeArtifact read or representation
branch; the export matrix by binding on all four roots; and
the read/replace pair used end to end through `src/portable-runtime.js` alone.

`test/smalltalk-replacement-lane.test.js` (bead `lagrange-images-it3`) owns decision 6's rule and its
refusals at the lane owner: a WASM-lane revision replaced in the WASM lane and a neutral one in the
neutral lane, each asserted on BOTH the Block's recorded lane and the code artifact's representation,
with the replacement answering through a real send; an exact guarded replay staying write-free IN the
observed lane, which is what proves the preserved lane actually participates in revision identity
rather than merely being computed; a replacement the observed lane cannot compile failing with the
observed revision still current and the same source still compiling in the other lane; a stale
position refused on the observation, with the WINNER'S Block record never read; a bound revision
with no lane metadata refused rather than defaulted, planted by a generic graph write into an
otherwise well-formed dictionary; a caller-named lane other than the observed one refused as the
migration it is; a guarded batch spanning both lanes refused whole; unguarded calls keeping the lane
they name and the neutral default when they name none; and a genuinely Cuis-imported WASM method,
driven through the real `importCuisNativePackage` adapter with no Cuis runtime present, preserved in
the WASM lane when replaced.

Deliberate breaks for decision 6, each turning exactly its intended proof red and then reverted: the
shipped `?? 'neutral'` default restored; the derivation forced to neutral anyway, observed both at
the owner and at this seam; a blanket-WASM derivation, which the neutral-direction proof alone
catches; defaulting to neutral when the metadata cannot be read; a WASM-failure fallback to neutral;
resolving the lane from a fresh current read; dropping the caller-named-lane refusal; dropping the
mixed-batch refusal; and teaching this seam a lane, which the structural scan catches.

Deliberate breaks, each turning exactly its own intended proof red and then reverted: authorization
moved after the lookup; `object/read` demanded instead of `object/write`; write demanded on the old
Block; the pre-compilation admission removed; a fresh read substituted for the caller's observation;
`expectedCurrent` dropped on the way to the from-source owner; the module added to
`src/language/index.js`; malformed input refused with a bare `TypeError`; the owner's dictionary-
scoped contention error re-thrown unmapped; the sealed-dictionary refusal escaping unmapped; the
target verdict forwarding the owner diagnostic as a `cause`; and the non-semantic-failure narrowing
removed.

## Not in scope

Method addition, removal, class editing, batch editing, durable native method source,
protocol/category, a durable Cuis provenance association, a public compiler or a generic
reconciliation API. Real Cuis-origin E3 acceptance over the pinned upstream import path is the next
slice of bead `lagrange-images-qax`; GitHub #218 stays open until it lands.
