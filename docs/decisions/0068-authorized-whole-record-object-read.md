# ADR 0068: authorized whole-record object/read lane — seam decision

Status: implemented
Proven by: test/image-object-read-binding.test.js

**Adopted and implemented**: an installed callable binding, `image-object-read-binding/v1`, symmetric
with the existing projection/mutation/creation lanes. This closes a privileged-read seam; it is not
"the read counterpart to the batch lane." Because the composite codec is ref-free and schema-directed,
the whole record is carried as a record of lists — each slot/indexed Value in its existing canonical
JSON form — so refs and pinned refs cross the boundary as identity data, never followed.

## Problem

`lagrange-object-environment` is now a **security-sensitive client** of the substrate, but its normal
object-navigation and Perspective-load reads still rely on **privileged host access** that performs no
authority check:

- `ObjectNavigator.navigate()` calls `adapter.readObject(...)` (env `object-navigator.js:101`), which
  is `images.getObject(imageId, objectId)` (env `image-client-adapter.js:340`) — no `require`, and it
  cannot distinguish **unauthorized** from **unavailable** (both surface as `null`).
- `ImageClientAdapter.loadPerspective()` also calls `images.getObject(...)` directly (env
  `image-client-adapter.js`), so the persisted-Perspective read path bypasses an authorized boundary.

This is not a newly-invented requirement. lagrange-images#119 explicitly asked for an "indexed-aware
read," and ADR 0064 §4 deliberately declined to complicate projection, noting "a future whole-record
object/read lane would be trivially sufficient." The two authorized read lanes that exist are
**projections** (`image-projection-binding`, `image-versioned-projection-binding`), and projection v1
**refuses indexed objects** (it maps named slots only), so there is today **no authorized read that
returns a complete indexed object** — e.g. a Perspective. Rendering, inspectors, browsers, debuggers
and collaboration will all multiply reads; the correct authority boundary should exist before those
layers grow to depend on `getObject`.

## The invariant under tension

ADR 0037: `ImageService` (the host facade, `src/image/graph-image-service.js`) is **below** authority —
it takes no authority context and is what every authorized lane calls internally. Authority lives in
the callable lanes, which get a **check-only** `require` (§2) and exact-match grants (§6). The
environment's authorized operations (`createObject`, `mutateObject`, `runCreate`, `savePerspective`)
all reach the substrate through `invocations.invokeBlock` + `executor.execute(activation,
{authority})` — the **callable-binding idiom**. The seam for the authorized read must fit that idiom,
not invent a parallel one.

## Options

- **(a) Installed callable binding** — a new `image-object-read-binding/v1` lane, invoked via
  `invokeBlock` + `executor.execute({authority})`, doing `require(object/read)` then returning the
  whole record. Symmetric with projection/mutation/creation; the environment swaps the *body* of its
  unguarded `readObject` to invoke this lane.
- **(b) Authorized image-client/service operation** — add an authority parameter to an
  `ImageService`/client read method. Rejected: `ImageService` is below authority (ADR 0037); every
  lane calls it internally with no context. Putting authority on it is a category error and would
  force authority plumbing through a layer that is deliberately authority-free.
- **(c) Thin authorized wrapper around `ImageService.getObject`** — bolt a `require` onto the host
  path ad-hoc. Rejected: this creates exactly the **two public "read an object" abstractions** — one
  secure, one insecure — that this ADR is required to avoid, and it is not invocable by the
  environment through its established lane idiom.

**Scope honesty (what (a) does and does not close).** Adopting (a) closes the **environment-facing**
read seam only. `ImageService.getObject` remains the privileged internal primitive and is reachable
authority-free **by design** inside the substrate — the executor-context `images` view
(`src/execution/lexical-cells.js:371`) and the language/mutation/creation lanes call it with no
`require`, because they are below or beside authority. So the two-abstraction invariant ("one secure
public read, not two") is **not** delivered by the seam alone; it holds **only if** the `images`
handle handed to `lagrange-object-environment` does **not** expose `getObject` for user-facing reads
— i.e. the lane is the *only* env-facing "read an object," and the env adapter's internal class/record
lookups are not user-facing. This ADR mandates that discipline; it does not claim the seam creates it.

## The `_version` question

Should the result expose the raw `_version`, or an opaque version token? The versioned-projection
precedent (ADR, `image-versioned-projection-binding`) already decided this: it returns
`objectVersionToken(imageId, objectId, object._version)` — an **opaque token** — and deliberately
couples token and value from a single read so a caller never pairs a value with a version that never
described it. Raw `_version` is a backend storage detail (ADR 0042 keeps it unreachable from the
callable surface). **Adopt the opaque token**: the read returns the complete object plus a version
token derived from the same read, never raw `_version`.

## Decision

**Adopt (a): an installed callable binding, `image-object-read-binding/v1`.** The contract is
deliberately narrow:

- **authority**: exactly `require({operation: 'object/read', resource: objectResource(imageId, objectId)})`;
- **result**: the **complete generic object** — named slots **and** the indexed part (no projection
  field mapping, no slot selection). Slot and indexed Values are returned **verbatim**, including
  `ref`/`pinned-ref` Values: refs are disclosed as **identity only, never followed** — no traversal
  `require` is implied, matching projection's no-follow rule. Disclosing identity under `object/read`
  is accepted because that grant authorizes the object itself (projection's own comment: `object/read`
  "authorizes the object itself"), and identity-without-read-authority is not a capability;
- **denied authority** ⇒ `AuthorityError` (distinguishable from not-found);
- **authorized but nonexistent** ⇒ a distinct not-found outcome (a thrown not-found error, **not**
  conflated with `AuthorityError` and not a silent `null`). This is **machine-readable**: the lane
  throws `ObjectReadNotFoundError` (a `TypeError`) with a stable `code = 'OBJECT_NOT_FOUND'`
  (`OBJECT_NOT_FOUND_CODE`), so a consumer distinguishes it from both `AuthorityError` and an
  operational `TypeError` by `code`, not by matching message text;
- **backend failure** remains a failure (propagates), never reported as "unavailable";
- an **opaque version token** from the same read (never raw `_version`);
- **no** new grant type (reuses `object/read`); **no** indexed-projection work; **no**
  historical/as-of semantics (that is the separate `gyr` investigation).

`ImageService.getObject` remains the privileged internal primitive and is unchanged. The single
**public** authorized read abstraction is the lane; the environment replaces the bodies of
`ObjectNavigator.readObject` and `loadPerspective` to invoke it, ending its dependence on whole-image
host authority for user-facing object reads.

## Consequences

- The environment's two unguarded read sites gain a real authority boundary; denied navigation becomes
  observably **unauthorized** rather than "missing," and a Perspective's indexed presentations become
  readable under authority.
- Projection lanes are untouched (they remain the *field-mapping* read; this lane is the *whole-record*
  read — a distinct, single abstraction, not a second projection).
- `gyr` (revision-pinned read) is deliberately **out of scope** and gets its own investigation:
  "authorized ref → authorized current-state read" (this lane) is established first, then "authorized
  pinned-ref → authorized read of exactly revision R," which touches history retention / revision
  identity / GC frontiers.

## Guardrails

```text
image-object-read-binding/v1: an installed callable binding — the ONLY environment-facing authorized
  "read an object". ImageService.getObject stays the privileged INTERNAL primitive, unchanged; it is
  reachable authority-free inside the substrate (executor images view, language lanes) BY DESIGN.
TWO-ABSTRACTION INVARIANT: holds only if the images handle given to lagrange-object-environment does
  NOT expose getObject for user-facing reads — the lane is the sole env-facing read; the seam alone
  does not create this, the env facade discipline does.
authority: exactly object/read(imageId, objectId) — check-only require, exact-match, no new grant type
result: the COMPLETE generic object (named slots + indexed part); NO projection field mapping; ref/
  pinned-ref Values returned as identity, NEVER followed (no traversal require implied)
denied authority -> AuthorityError (BEFORE any existence check, so no existence oracle);
  authorized-but-nonexistent -> a DISTINCT not-found error; backend failure propagates (never
  "unavailable"); never conflate denied with missing
version: an opaque objectVersionToken from the same read; NEVER raw _version (versioned-projection
  precedent; ADR 0042 keeps _version off the callable surface)
OUT OF SCOPE: indexed-projection work, historical/as-of reads (separate gyr investigation),
  any change to ImageService.getObject or the projection lanes
```
