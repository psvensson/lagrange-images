# ADR 0094: Authorized Cuis native import

Status: implemented — one public operation brings a canonical Cuis manifest into an image under ordinary authority, with a pure demand set computed before any read, progress and cancellation between declarations, and a truthful partial-result contract at the existing adapter.
Proven by: test/smalltalk-authorized-import.test.js, test/cuis-native-import.test.js

## Problem

The Object Environment's E4 step ("inhabit a real imported application object graph", its bead
eij.4) needs a public import operation and cannot have one: `importCuisNativePackage` is a
privileged helper with no authorization, no progress or cancellation protocol, and a partial
publication rule that only its documentation states. The Environment must own the human
interaction (choose, start, watch, cancel, retry) and must not wrap the privileged helper, invent
its own retry policy, hide partial state or keep a shadow import model (ADR 0085 §8). So the lower
contract has to exist here first.

## Decision

### 1. One seam, five responsibilities

`authorizedImportCuisPackage({images, compilation, imageId, manifest, scope, require, signal,
onProgress})` in `src/language/smalltalk-authorized-import.js` owns exactly:

1. caller-owned input validation, including the adapter's pure import plan (its own preflight of
   the caller's manifest, which reads nothing and is therefore caller input);
2. the authority demand SET, computed purely from that plan, and its ORDER before any read;
3. the progress and cancellation plumbing between the caller and the adapter;
4. the partial-result contract: what was admitted when an import stops, and why;
5. the public result and error taxonomy.

It owns no import semantics. The Cuis native-import adapter keeps translation, scope, preflight,
ordering and the partial-publication rule; the class builder, namespace and method owners keep
admission. The seam never writes, retries, rolls back or skips.

### 2. Authority is named from the manifest, never from the image

An import mutates three kinds of state; each demand names a resource the caller can compute from
its own manifest through the class builder's deterministic identity `smalltalk/class/<name>`:

| what the import does | demand |
| --- | --- |
| declares a class (a native Class object, with its Metaclass, Shapes, MethodDictionary, class-state companion, class-variable bindings and subclass registry as its storage representation, the ADR 0087/0088 rule) | `object/create` on `smalltalk/class/<name>` |
| appends the class to its mapped superclass's subclass registry (`Object`, `Array2D`, `TextModel`), which is the superclass's storage representation | `object/write` on that superclass's Class object |
| installs an extension method on a mapped existing class (`Integer`), advancing that class's selector-binding state | `object/write` on that Class object, exactly as ADR 0088 demands for a replacement |
| publishes the declared names into the root namespace | `object/write` on `smalltalk-global-namespace/v1` whenever the plan declares a class |

An in-manifest superclass or method target is covered by its own create. The set is deduplicated,
demanded in canonical order, and every demand precedes the adapter's first read (the kernel
lookup), so a denied caller learns nothing the manifest did not already say: whether the image has
a kernel, a namespace or any of the named classes stays undisclosed, and an image that does not
exist answers the same `AuthorityError`. The adapter gains a pure `planCuisNativeImport` export and
a pure `mappedCuisClassName` so the seam can do this without a second spelling of scope or mapping
semantics.

### 3. Progress and cancellation belong to the adapter's loop

The adapter takes `signal` (AbortSignal-like: a boolean `aborted`, an optional `reason`) and
`onProgress`. It checks the signal before each class declaration, before namespace publication and
before each class's method group, never inside an owner's write, and reports `begin`/`admitted`
events per declaration, per publication and per method group. One class's methods are one
reconciliation (one MethodDictionary publication), so the unit of progress and cancellation is the
group: admitted whole or not at all. A cancelled import is `CuisNativeImportAbortedError` with the
canonical identities that landed and the signal's reason. Without a signal or callback the adapter
behaves exactly as before.

### 4. Partial results are the adapter's rule, restated once and never widened

- `CuisNativeImportError`: an adapter refusal, before the first native write; nothing admitted.
- `CuisNativeImportAbortedError`: cancelled between declarations; `admitted` is exact.
- `SmalltalkImportRefusedError`: a native owner refused a covered declaration after earlier ones
  were admitted. It names the declaration being admitted (`phase`, `identity`), what landed
  (`admitted`), and carries the owner's own refusal as `cause` — a compiler diagnostic or an
  admission conflict is what the caller needs to correct the package, and the identities it names
  are the caller's own. This is a deliberate asymmetry with ADR 0088, whose replacement seam
  restates owner refusals; an import's actionable diagnostic is the compiler's, with its source
  position, and hiding it would make every refusal "something in the package is wrong".
- `SmalltalkImportInputError`: malformed caller input.
- `AuthorityError`: the caller's own `require` denied a demand.

In every case the image is not corrupt and a corrected or repeated import converges through the
owners' admission rules: exact replay is write-free, and the retry reports the already-landed
declarations as admitted again. The seam's success value is `{imported, admitted}`, where
`imported` is the adapter's transient result (semantic identity to native class ref) and
`admitted` the canonical identities this call admitted.

### 5. Publication

`authorizedImportCuisPackage` is re-exported by name from `src/runtime.js` and, once the portable
execution surface (bead `lagrange-images-hygu`) is on main, from `src/portable-runtime.js`. The
module is deliberately NOT in `src/language/index.js`: that barrel is `export *` and would publish
the seam's internal error classes; consumers discriminate by `error.name`.

## Ownership

- **Authorized Cuis native import seam** (`src/language/smalltalk-authorized-import.js`): the five
  responsibilities above.
- **Cuis native-import adapter**: unchanged ownership, plus the pure plan export, the mapped
  native class names, the progress events and the cancellation checkpoints of its own loop.
- **Class builder**: unchanged, plus the exported spelling of its deterministic Class identity.
- **Lagrange Object Environment**: the human interaction (choose, start, watch, cancel, retry) over
  this operation; it never wraps the privileged helper or keeps import state of its own.

## Rejected

- **A new authority operation (`smalltalk-package/import`) on an image-level resource.** ADR 0037's
  vocabulary is deliberately minimal and exact-match; the three mutations an import performs
  already have operations and resources, and naming them keeps "who may define a class under
  `Object`" the same question whether it is asked by an import or by a class browser.
- **Demanding a write on every record the import creates.** Metaclasses, Shapes, dictionaries,
  companions and registries are a Class's storage representation; the ADR 0087 precedent covers
  them under the Class's demand, and per-record demands would make the set depend on what the
  owners happen to write.
- **Restating owner refusals as the replacement seam does.** See §4; the compiler's diagnostic is
  the deliverable of a failed import.
- **Rollback of admitted declarations.** Admitted classes are ordinary image state that later
  declarations may depend on; rolling them back would need a second transaction authority and
  would destroy state a retry converges on for free.

## Consequences

- The Environment's E4 can start against a public contract: its ImportWorkflow owns choose,
  start, progress, cancel and retry presentation; every semantic outcome is one of the five errors
  or the success value.
- Importing a package that declares a class under `Object` requires `object/write` on the kernel
  `Object` class. That is honest — the definition mutates `Object`'s subclass registry — and it is
  the grant an Environment host issues for an import session.
- The M5 witness and the M3/M4 harnesses keep calling the privileged adapter directly; they are
  trusted internal proofs, not consumers.
