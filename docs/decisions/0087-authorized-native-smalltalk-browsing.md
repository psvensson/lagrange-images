# ADR 0087: authorized native Smalltalk browsing

Status: implemented
Proven by: test/smalltalk-authorized-browse.test.js, test/cuis-json-native-import-real.test.js, test/portable-runtime-environment-api.test.js

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
   formats), the instance Shape (layout), and `authority/object-resource.js` (operation and resource
   name). The seam never decodes a Behavior slot id, a MethodDictionary bucket, a Block's code
   artifact or a compiled WASM representation. One consequence at the class builder: its
   single-selector reader and its selector enumerator are now ONE implementation
   (`selectorBindings`), so "which selectors does this class implement" and "which Block does this
   selector bind" cannot drift apart.

3. **Two independent authority checks; no transitive authority.**

   ```text
   class browsing    object/read on the Class (or Metaclass) OBJECT
   method browsing   that same class check, AND object/read on the method's Block
   ```

   A class's own MethodDictionary is covered by the class's single check, for the reason a Project's
   member records are covered by the Project's (ADR 0080 / `project/working-state.js`): it sits at an
   id derived from the Class, carries no behavior edge of its own (ADR 0049 decision 3) and is not an
   independently addressable semantic object — it is the Class's storage representation. The Blocks
   it BINDS are the opposite: a Block is executable and may legitimately sit in two dictionaries, so
   it is exactly the independent target ADR 0039 §2 refuses to reach by ref-following. Class
   authority therefore yields selector NAMES and never the method behind one. Authority is never
   inferred from Project membership, from a class reference, or from graph reachability: the
   `superclass`, `classSide` and `method` refs a description hands out are LOCATORS, and browsing what
   they name needs that object's own grant.

4. **Authorization strictly precedes existence disclosure.** Each entry point validates
   caller-supplied input (which touches no record), then requires, then reads. A denied caller cannot
   distinguish an existing class or method from a missing one — both are `AuthorityError`. Existence,
   malformed records and dangling edges are disclosed only to a caller already authorized for the
   object concerned.

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
   `src/portable-runtime.js` re-export the exact owner functions, never wrappers, so a portable
   Object Environment needs no private `src/...` path.

## Alternatives rejected

- **Broaden the ADR 0068 whole-record read with kind/shape/behavior so a browser can recognize a
  Behavior.** That teaches every consumer the kernel's storage layout and makes the generic read lane
  a second decider of what a Smalltalk class is.
- **A Cuis-aware class descriptor, or a provenance-carrying variant selected by origin.** Two lanes
  for one native concept; a native-imported class must browse as an ordinary native class.
- **Reconstruct method source by walking the Block's code-artifact `derivedFrom` chain.** That makes
  the browsing seam a second CodeArtifact decoder, contradicting decision 2, and would report a
  source for some methods and not others by accident of which installer wrote them.
- **Let class authority cover the method Blocks it binds ("the methods are the class's own").** They
  are not: a Block is independently addressable and independently shareable. Rejected as the
  transitive ref-follow ADR 0039 §2 exists to prevent.
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
selector list but refused for the Block, the Block grant alone refused because the class check comes
first, and both grants together succeeding; `superclass`/`classSide` refs refused under the
subclass's grant and accepted under their own; `object/write` refused as a read; denied existing and
missing classes, and denied implemented and unimplemented selectors, all indistinguishable, while an
authorized reader learns not-found; malformed input refused before any read; a Cuis-imported class
and a hand-declared one producing descriptions equal except for name and refs, with no Cuis identity
and no storage-layout token anywhere; and the seam's static module closure carrying no Cuis,
toolchain, foreign-runtime, Project or Environment module and no `node:` import.

`test/cuis-json-native-import-real.test.js` (real pinned upstream lane, `LAGRANGE_OPENSMALLTALK_INTEGRATION=1`):
the M1-imported real `Json` class and the M2-imported real `Json>>ctorMap` accessor browse through
the same public functions in a runtime with no Cuis toolchain or foreign-runtime provider, with exact
ref equality against the import result, the real declared layout `['stream', 'ctorMap']`, and no Cuis
identity, package name, export format or storage-layout token in either description.

Deliberate breaks, each turning exactly one intended proof red and then reverted: dropping the
Block's `require` (the class-versus-method authority test); moving the class `require` after the
existence read (the no-existence-oracle test); adding the instance-Shape id to `layout` (the
storage-layout scans).

## Not in scope

Durable native method source, protocol/category and a Cuis provenance association (bead
lagrange-images-jtz.1); inheritance-walking or image-wide browsing queries; method edit, rename,
recompile or removal; any change to dispatch, the MethodDictionary representation, the import
adapter, or the Object Environment.
