# ADR 0080: Project mutation service — version-aware read, replay identity and rename

Status: accepted — the version-aware authorized read is built (slice A); the replay-identity rule and `authorizedRenameProject` are decided and land as slice B.

## Problem

ADR 0073 shipped the pure Project model and deferred "durable Project object/member/relationship
Shapes and mutation service" by evidence. The Shapes half exists (`src/project/working-state.js`).
The mutation half now has a concrete consumer: the Object Environment's first Project write command
(issue #188, proposal `authorized-project-rename-lane.md` in that repository) needs to rename a
Project under optimistic concurrency. That requires two things it cannot obtain today:

- the Project object's **current version token** without learning storage ids.
  `authorizedReadProjectDescriptor` returns only the canonical descriptor; the ADR 0068 whole-record
  lane would require naming the Project's object id and discloses slot ids;
- an **authorized rename** that hides the private name slot and returns a fresh token.

A third question was elevated by the owner before rename may land: `createProject` compares
`projectId` **and** `name` on replay, so once `name` is mutable a replayed create would either
reject or silently restore an old name. A mutable field must not be an undeclared creation identity.

## Decision

1. **One version-aware authorized read.** `authorizedReadProject({images, imageId, projectId,
   require}) -> {descriptor, versionToken}` (frozen). It authorizes `object/read` on the Project
   object *before* any existence disclosure (no-existence-oracle, as the descriptor-only seam),
   reads the Project object **exactly once**, validates that record as the expected Project
   representation carrying the expected stable project id, and assembles both halves of the result
   from that one record. Backing member records are read while assembling (they are the Project's
   storage, per the unit-level read rule); the Project itself is never reread. The descriptor is the
   unchanged canonical `ProjectDescriptor/v1` from `normalizeProjectDescriptor`.

2. **The token is the Project object's version, nothing wider.** `versionToken` is the existing
   opaque object-scoped `objectVersionToken(imageId, project/<projectId>, _version)` (ADR 0042
   decision 5); raw `_version` never escapes. Its scope is deliberately the Project **object**:
   adding a member rewrites the Project's indexed linkage set, so the token changes; retargeting an
   existing member rewrites only the member record, so the token is unchanged even though the
   returned descriptor's target changed. `versionToken == version of the Project object`, not
   `version of everything recursively visible through the descriptor`. Hashing the descriptor or
   its graph closure is rejected: it would turn a storage precondition into a content digest,
   invalidate a rename because an unrelated member target moved, and create a second token
   representation.

3. **One implementation.** `authorizedReadProjectDescriptor` delegates to `authorizedReadProject`
   and discards the token. Its authorization ordering, single Project-object read and descriptor are
   thereby identical by construction. Internally, `projectStateFromRecord` is the single "one
   Project record -> `{descriptor, versionToken}`" assembly and `readProjectState` is the single
   "read once, validate, assemble" operation; there is no caching and no generic versioned-read
   framework — common provenance is the point, not read optimization.

4. **Replay identity (decided; slice B).** `projectId` is creation identity; `name` and `namespace`
   are mutable Project state. `createProject` becomes create-or-return-by-stable-id: absent
   `project/<projectId>` -> create with the supplied initial mutable state; an existing valid Project
   with that stable id -> return it **without** touching its current mutable state; a replayed old
   create neither rejects because mutable state changed nor restores it. Request input shape is
   still validated, and an occupant of `project/<projectId>` that is not the expected Project
   representation with the expected stable id is still a conflict. No `originalName`, creation
   fingerprint or other immutable copy of initial mutable state is persisted.

5. **First-class rename (decided; slice B).** `authorizedRenameProject({images, imageId, projectId,
   name, expectedVersionToken, require}) -> {versionToken}`: validate all non-storage inputs
   (including the mandatory opaque expected token) first; require `object/write` on the Project
   object before any existence read; only then read and validate the Project record; translate the
   semantic field `name` to its private slot inside the owner; persist through the existing
   conditional put with the caller's expected version as a **real storage precondition** (never
   read-compare-write). A stale token surfaces the existing opaque `ObjectMutationConflictError`
   shape with no actual version, replacement token or cause reachable. Success returns the new
   Project token. No namespace/member/delete mutation and no generic slot or semantic-write lane.

## Ownership

- `src/project/working-state.js` (row "Image-level Project working-state semantics") owns the
  versioned read, the one-record provenance, field-to-slot translation and rename semantics.
- `src/project/model.js` remains the sole owner of descriptor semantics (the token is not a
  descriptor field; `normalizeProjectDescriptor` asserts exact keys).
- `src/object/version-token.js` remains the sole token representation; the image/object conditional
  put remains the sole CAS. Authorization remains the caller-supplied check-only `require`.
- `src/portable-runtime.js` re-exports `authorizedReadProject` as an exact owner identity so the
  Object Environment's pinned artifact can consume it.

## Proof (slice A)

`test/project-versioned-read.test.js`: denied existing and denied missing Projects are
indistinguishable (AuthorityError, zero storage reads); exactly one Project-object read supplies
both halves; a competing rename injected right after that one read leaves descriptor and token
describing the same pre-change record (a two-read implementation fails it); the result and
descriptor shapes are exact and frozen, the token is `object-version/v0` scoped to the Project
object and `_version` never escapes; the descriptor-only seam returns a deep-equal descriptor with
the same ordering; member add changes the token while member retarget does not; a non-Project
occupant or mismatched stable id is refused; revocation fails closed.
`test/project-authorized-read.test.js` and `test/project-working-state.test.js` are unchanged and
green. For a valid Project the descriptor-only reads are behavior-identical; they are stricter only
for a malformed occupant of `project/<id>` (wrong Shape, or a stored project-id differing from the
requested one — previously that value leaked through as the descriptor's `projectId`) and for a
record lacking a backend `_version` (the token is always derived, even when discarded). Slice B adds its own proofs and promotes this ADR to
`implemented`.

## Not in scope

Namespace mutation, member mutation beyond existing operations, delete, a generic semantic-write
framework, Project slot exposure, descriptor-wide or recursive version tokens, changes in the Object
Environment, and whether `object/write` on the Project object should later cover backing member
records (recorded as an open question from #188, undecided here).
