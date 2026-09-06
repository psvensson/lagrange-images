# ADR 0087: authorized native Smalltalk browsing

Status: implemented
Proven by: test/smalltalk-authorized-browse.test.js, test/smalltalk-method-position-authority.test.js, test/cuis-json-native-import-real.test.js, test/portable-runtime-environment-api.test.js

## Problem

ADR 0085 M1/M2 (PRs #204, #205, #207, #209) creates ordinary native Classes and WASM-backed methods,
including from a real pinned upstream Cuis package. Object Environment E1 — a class browser and a
method inspector — cannot consume any of it through a truthful authorized semantic read:

- the authorized whole-record read (ADR 0068) deliberately returns a *generic* object and omits
  kind, shape and behavior, so a browser would have to recognize a Behavior itself and decode its
  slot ids;
- `readBehavior`, `methodBlockRef` and the MethodDictionary owners are internal `src/language`
  functions, not a public authorized contract; `readBehavior` reads through the privileged
  `images.getObject`;
- `src/portable-runtime.js` exposes neither, so a portable Object Environment would have to import a
  private `src/...` path;
- `importCuisNativePackage` returns transient associations only, so there is no durable native ->
  Cuis source/protocol/package association to read even if a caller asked for one.

The failure mode to avoid is specific: an Environment pinned before M1 learning the kernel's storage
conventions (Behavior slot ids, `<classId>/methods`, MethodDictionary buckets, `_version`), or a
Cuis-shaped browsing lane appearing beside the native one.

**Corrected 2026-09-06 by bead `lagrange-images-31l`, after consumer implementation reopened GitHub
#218.** The originally implemented decision 3 required `object/read` on the current Block. That was
circular: before a method read the public consumer knows only `{imageId, classRef, selector}`, while
the current Block identity is disclosed only by the read after both demands succeed. Object
Environment therefore had to cheat by calling `boundBlockFor` for first reads and predicting future
revision grants for rereads. The same defect affected first read, reread after successful replacement
and reread after staleness. The correction below records the superseding rule explicitly; it does not
reinterpret the old rule as if it had always worked.

## Decision

1. **One origin-neutral description owner.** `src/language/smalltalk-browse.js` owns WHICH native
   Smalltalk facts are publicly describable, in what canonical shape, and under which authority. It
   owns no fact of its own and writes nothing. Both results are frozen:

   ```text
   smalltalk-class-description/v1   {format, class, name, side, superclass, classSide, layout, selectors, provenance}
   smalltalk-method-description/v1  {format, class, side, selector, method, source, provenance}
   ```

   `side` is `instance`/`class`, decided the way the kernel ties the metaclass knot
   (`behavior(aMetaclass) == Metaclass`), never by an object-id spelling. `superclass` is `null` at
   the root rather than the kernel `nil`. `classSide` is the metaclass of an instance-side class and
   `null` for a Metaclass — without it a browser could reach the class side only by guessing
   `smalltalk/metaclass/<name>`, which is exactly the storage decoding this ADR forbids. There is
   deliberately no inverse field: the kernel stores a class -> metaclass edge and no metaclass ->
   sole-instance edge, so answering "which class is this the metaclass of" would mean deriving one
   object id from another. `layout` is
   `null` for a Behavior that declares no instance layout at all and `{instanceVariables, indexed}`
   otherwise: the complete native layout by NAME and in order, never a slot id. `method` is the exact
   Block ref the dictionary binds, so exact ref equality holds across the import result, the class
   description and the method description.

2. **Composition, not decoding.** Every fact comes from the owner that already decides it:
   `readBehavior` (Class/Metaclass identity, superclass, methods edge, instance-shape edge),
   `findSmalltalkKernel` (the image's `nil` terminator and `Metaclass` identity), the class builder's
   `methodBindings` (selector -> Block, representation-neutral across both ADR 0049 dictionary
   formats), the instance Shape (layout), `authority/object-resource.js` (object operation/resource
   naming), and `smalltalk-method-position-resource.js` (logical-position operation/resource naming).
   The seam never decodes a Behavior slot id, a MethodDictionary bucket, a Block's code
   artifact or a compiled WASM representation. One consequence at the class builder: its
   single-selector reader and its selector enumerator are now ONE implementation
   (`selectorBindings`), so "which selectors does this class implement" and "which Block does this
   selector bind" cannot drift apart.

3. **Two independent authority checks; no transitive authority.**

   ```text
   class browsing    object/read on the Class (or Metaclass) OBJECT
   method browsing   that same class check, AND smalltalk-method/read on the exact
                     {imageId, Class/Metaclass, selector} logical position
   ```

   A class's own MethodDictionary is covered by the class's single check, for the reason a Project's
   member records are covered by the Project's (ADR 0080 / `project/working-state.js`): it sits at an
   id derived from the Class, carries no behavior edge of its own (ADR 0049 decision 3) and is not an
   independently addressable semantic object — it is the Class's storage representation. Class
   authority therefore yields selector NAMES and never the method behind one.

   A method-position grant independently authorizes reading the CURRENT binding at exactly one
   semantic position through this seam. Its canonical resource is a pure, injective function of the
   public locator, so it can be granted before existence or revision identity is known. It follows
   that logical position across immutable Block revisions until revoked, which makes first read,
   successful-replacement reread and stale-conflict reread one contract rather than three bootstrap
   APIs. Exact-match `authority-grant/v0` is unchanged: image, Class versus Metaclass, class object id
   and selector all remain distinct resource identity.

   This grant is NOT `object/read` on the Block occupying the position. The returned Block ref
   remains a locator; direct generic inspection of that independently addressable Block still needs
   its own `object/read`, and the position grant authorizes neither another selector/class/side/image
   nor a historical or superseded revision addressed as an object. Authority is never inferred from
   Project membership, a class reference, graph reachability, a returned ref or a version token.

4. **Authorization strictly precedes existence disclosure.** Class reads validate caller input,
   require Class `object/read`, then read. Method reads validate caller input, require Class
   `object/read`, require exact `smalltalk-method/read`, and only then read the kernel, Behavior,
   MethodDictionary/current binding or Block. In particular the selector is not resolved between
   the two checks. A caller lacking position authority cannot distinguish present, absent, dangling
   or A-versus-B-current — all are `AuthorityError`. Naming a resource for an unimplemented selector
   is not evidence that it exists.

5. **`selectors` is the class's OWN protocol, never an inheritance walk.** An inherited selector is
   the declaring class's fact; reporting it here would let one grant speak for objects the caller was
   never authorized to read. `smalltalk-lookup.js` remains the sole owner of what a SEND resolves to.

6. **Cuis provenance is optional metadata on a native result, and today it is absent.** `provenance`
   and a method's `source` are `null` because Images owns neither association: the class builder
   installs a method's semantic program and retains no text it was compiled from (only the standalone
   Block installer writes a `symmetric-smalltalk/source-v0` artifact), and the import adapter writes
   no durable side table. Reporting `null` is the truthful answer, not a placeholder to fill from the
   importer's transient output or from a deterministic id. Because there is nothing origin-specific to
   report, a Cuis-imported class browses through this same seam with the same result shape — origin
   selects no second lane.

7. **Browsing only.** No edit, rename or recompile semantics enter this seam. E1 is a browser; a
   write lane needs its own consumer, its own owner decision and its own ADR.

> Non-normative pointer (bead lagrange-images-qax, slice C2). Decision 7's condition has since been
> met: the Object Environment named itself as the consumer (GitHub #218), and the write lane has its
> own owner and its own ADR in [ADR 0088](0088-authorized-native-smalltalk-method-replacement.md).
> Decision 7 is unchanged and still describes THIS seam — `src/language/smalltalk-browse.js` remains
> read-only, and `authorizedDescribeSmalltalkMethod` still answers no token. Replacement lives at a
> separate owner, `src/language/smalltalk-authorized-method-replacement.js`, which demands
> `object/write` on the declaring Class/Metaclass and shares nothing with the read seams but the
> canonical descriptor those seams answer.

8. **Public through the existing roots.** `src/language/index.js` (hence `src/runtime.js`) and
   `src/portable-runtime.js` re-export the exact owner functions and the canonical
   `smalltalk-method/read` / `smalltalkMethodPositionResource(...)` vocabulary, never wrappers. A
   portable host can name authority from the semantic locator but cannot resolve the current binding,
   mint/parse a token, derive a revision identity or mint a Block grant.

## Alternatives rejected

- **Broaden the ADR 0068 whole-record read with kind/shape/behavior so a browser can recognize a
  Behavior.** That teaches every consumer the kernel's storage layout and makes the generic read lane
  a second decider of what a Smalltalk class is.
- **A Cuis-aware class descriptor, or a provenance-carrying variant selected by origin.** Two lanes
  for one native concept; a native-imported class must browse as an ordinary native class.
- **Reconstruct method source by walking the Block's code-artifact `derivedFrom` chain.** That makes
  the browsing seam a second CodeArtifact decoder, contradicting decision 2, and would report a
  source for some methods and not others by accident of which installer wrote them.
- **Let class authority cover every method it binds.** Rejected as transitive authority: selector
  browsing and semantic method reading remain independently authorized.
- **Require the current Block's `object/read` for semantic browsing.** This was the original decision
  and is now rejected because it requires the consumer to know a revision identity that only the
  authorized read may disclose. Direct Block reads still require it.
- **Put authority in the version token or replacement receipt, or return the next Block from the
  write.** Concurrency data is zero authority, and displayed truth remains a fresh authorized read.
- **Widen `authority-grant/v0` with wildcards, hierarchy, enumeration or hidden derivation.** The
  stable exact semantic resource satisfies the required flows without weakening exact-match grants.
- **Include inherited selectors so a browser sees the full protocol at once.** Requires reading every
  ancestor under one grant. The browser composes the walk from separately authorized reads instead.
- **Persist a durable Cuis provenance association now, so `provenance` has something to carry.** No
  consumer has demonstrated it needs one, and the jtz owner gate requires naming an owner in
  `docs/ownership.md` before such a table exists (bead lagrange-images-jtz.1).

## Proof

`test/smalltalk-authorized-browse.test.js`: exact description key sets, frozen results and canonical
selector order (defined out of alphabetical order, described in it); complete native layout by name;
`layout: null` for a Metaclass versus `{instanceVariables: [], indexed: 'none'}` for a class
declaring none; the class side browsed through the same function with `side: 'class'`; inherited
protocol absent from the subclass and present on the declaring class; class authority yielding the
selector list but refused for the method, the position grant alone refused because the class check
comes first, and both semantic grants together succeeding; `superclass`/`classSide` refs refused under the
subclass's grant and accepted under their own; `object/write` refused as a read; denied existing and
missing classes, and denied implemented and unimplemented selectors, all indistinguishable, while an
authorized reader learns not-found; malformed input refused before any read; a Cuis-imported class
and a hand-declared one producing descriptions equal except for name and refs, with no Cuis identity
and no storage-layout token anywhere; and the seam's static module closure carrying no Cuis,
toolchain, foreign-runtime, Project or Environment module and no `node:` import.

`test/smalltalk-method-position-authority.test.js`: injective resource naming under adversarial
separator and Unicode text; one real `AuthorityService` context containing only pre-nameable Class
and logical-position grants performing first read A, public replacement A -> B and fresh discovery
of B, then stale B conflict and fresh discovery of C; no A/B/C Block grant; direct `object/read` of
A denied; the receipt remaining exactly `{replaced: true}`; selector, class, instance/class side and
image isolation; position-only authority denied at the class check; class-only authority denied
before any graph read; and a valid token conveying no reread authority.

`test/cuis-json-native-import-real.test.js` (real pinned upstream lane, `LAGRANGE_OPENSMALLTALK_INTEGRATION=1`):
the M1-imported real `Json` class and the M2-imported real `Json>>ctorMap` accessor browse through
the same public functions in a runtime with no Cuis toolchain or foreign-runtime provider, with exact
ref equality against the import result, the real declared layout `['stream', 'ctorMap']`, and no Cuis
identity, package name, export format or storage-layout token in either description.

Deliberate breaks, each turning exactly one intended proof red and then reverted: dropping the
position `require` (the class-versus-method and exact-scope tests); restoring current-Block bootstrap
(the A/B/C context has no Block grant); resolving before position authorization (the zero-graph-read
instrument); adding the instance-Shape id to `layout` (the storage-layout scans).

## Not in scope

Durable native method source, protocol/category and a Cuis provenance association (bead
lagrange-images-jtz.1); inheritance-walking or image-wide browsing queries; method edit, rename,
recompile or removal; any change to dispatch, the MethodDictionary representation, the import
adapter, or the Object Environment.
