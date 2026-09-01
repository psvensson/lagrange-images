# ADR 0075: portable Project release materialization — a design investigation

Status: accepted — investigation outcome; **stable-session prerequisite + graph release
materializer + ProjectReleaseMaterial/v1 implemented; the installation coordinator remains pending**
Proven by: test/stable-current-read-session.test.js, test/project-release-capture.test.js,
test/graph-project-release.test.js

**Decides how ADR 0073's Project release capture composes with ADR 0074's portable graph bundle,
so that a selected set of Project members becomes ONE portable, content-addressed release material
— preserving cross-member aliasing and cycles, keeping source ObjectRefs/frontiers out of release
identity, and keeping every existing single owner single. This ADR builds no materializer, no
read-session helper, no installer and no authorized lane. It names the owners and freezes the
semantic rules so the first implementation slice cannot drift.**

The motivating gap: `captureCurrentProjectRelease -> materializeRecord({member, source, record})`
deliberately hands each member's **direct immutable record snapshot** to a callback with no graph
access. That isolation was correct — but ADR 0074 now supplies a transitive multi-root graph
transport (`exportGraphBundle`/`importGraphBundle`, `contentIdentity`), and PR #165 supplies the
atomic heterogeneous publication owner (`GraphImageService.createRecords`). The question is how
these compose **without** making Project own graph serialization, giving an arbitrary callback
unrestricted `GraphImageService` access, creating a second capture/frontier owner, losing
cross-member aliasing, or letting source ObjectRefs leak into release identity.

## Owners that stay single

| Concern | Owner (unchanged) |
|---|---|
| Manifest / releaseId / provenance / installation / reconciliation semantics | `src/project/model.js` (ADR 0073) |
| Truthful CURRENT capture sequencing / frontier stability | `src/project/release-capture.js` (ADR 0073) |
| Portable graph export/import/content identity, bundle validation | `src/graph/bundle.js` (ADR 0074) |
| Graph records/history/atomic heterogeneous publication | `GraphImageService` (PR #165) |

## Decision 1 — ONE new interaction owner

```text
selected Project members -> representation-specific portable release material
```

is owned by exactly one new module:

```text
src/project/graph-release-materialization.js   (the "graph release materializer")
```

It **orchestrates** the existing owners and absorbs none of them:

- it receives the selected members and a **scoped read facade** from the release-capture
  coordinator (Decision 4) — never `GraphImageService`, never a backend, never a frontier;
- it calls `exportGraphBundle` with that facade as the bundle owner's `images` seam (the bundle
  owner requires only `{getRecord}` and learns no frontier semantics);
- it supplies the internalize-all `referencePolicy` and the empty-externals gate (Decision 3);
- it derives the per-member `{representation, contentIdentity}` materializations (Decision 2);
- it assembles the release-material package (Decision 5).

It does not bracket frontiers (capture coordinator), does not walk durable graph edges itself
(bundle owner), does not define manifest/releaseId semantics (Project model), and is not a
callback handed graph access — the coordinator wires this ONE owner directly.

## Decision 2 — one multi-root bundle per release; per-member independent bundles rejected

**Option B (one multi-root bundle) is adopted.** The release material for a profile selection is
exactly one `exportGraphBundle` call whose roots are:

```text
roots = { memberKeyA: sourceRefA, memberKeyB: sourceRefB, ... }
```

- Cross-member aliasing is preserved: two members sharing one child share one bundled localId, and
  one import yields one shared fresh target child. **Option A (independent per-member bundles) is
  rejected**: `A -> C` and `B -> C` exported independently import as `A -> C1`, `B -> C2` — the
  source had ONE shared object; per-member bundles are not a lossless Project release.
- Cycles crossing member roots survive through the bundle's two-phase mint on import.
- One bundle = one coherent external-requirement set = one import producing all target roots
  together.
- Root keys ARE the Project member keys. They are caller-owned root **labels** at the bundle
  boundary (ADR 0074 treats root keys as opaque labels); this does not make member keys generic
  graph identity, and the bundle owner learns nothing about Projects.

## Decision 3 — per-member contentIdentity in manifest v1: the whole-bundle hash, coarse on purpose

Manifest v1 requires each member `{key, role, representation, contentIdentity}`, while one
multi-root bundle has ONE `contentIdentity`. The three candidates:

- **B. Per-root (per-member-closure) hashes — REJECTED by the headline falsifier (Decision 7).**
  Per-root identity cannot see sharing topology: `{a -> C, b -> C}` and `{a -> C1, b -> C2}` with
  value-identical C/C1/C2 produce identical per-root identities, so two different deployable
  releases would share one releaseId. Unacceptable.
- **C. Split release-wide vs per-member identity — DEFERRED, not adopted.** It requires an
  explicit manifest evolution (a release-level `materialIdentity` plus per-member sub-identities)
  AND reconciliation semantics that react to topology-only changes (per-member identities equal,
  release-wide identity different). That is real schema + planner complexity with no current
  consumer proving the precision is needed.
- **A. Whole-bundle hash per member — ADOPTED for v1.** Every selected member's materialization is
  `{representation: 'lagrange-graph-bundle/v1', contentIdentity: <the one bundle
  contentIdentity>}`. The member's immutable material is "the closure rooted at this member's root
  within bundle H", and H names that bundle immutably. Truthful: any change to ANY selected
  member's material — or to the sharing topology — changes H, changes every member identity,
  changes releaseId.

**The accepted v1 cost is coarseness:** one member changes, `planProjectUpgrade` marks EVERY
member `replace`, because every member's material identity is the bundle hash. This is recorded
deliberately, not discovered later. The smallest explicit evolution, IF upgrade-precision pressure
proves real, is a **manifest v2** adding a release-level material identity alongside per-member
identities with reconciliation semantics for topology-only changes — a new decision, not a silent
edit of ProjectReleaseManifest/v1, which this ADR leaves byte-identical.

## Decision 4 — release identity vs graph externals: fully closed portable material (Option A)

ADR 0073 requires: equivalent deployable content assembled from different development Images ->
same release identity. But a graph bundle's `contentIdentity` hashes its `externals` block, whose
descriptors carry exact source-side `{imageId, objectId[, revision]}`. So raw bundle identity is
source-independent ONLY when the externals block is **empty**.

The graph release materializer therefore enforces **fully closed portable material**:

1. `referencePolicy` **internalizes every unpinned ref** reachable from the selected roots,
   including cross-Image refs (the bundle owner already supports caller opt-in; the target Image
   receives those records on import). The default cross-Image-is-external policy is NOT used for
   release material.
2. If any **pinned ref** is reachable from the selected roots, the export necessarily externalizes
   it (ADR 0074: pinned is always external) and the release is **REFUSED loudly**. A pinned ref is
   a historical requirement; portable current material cannot carry it without pretending
   historical readability/retention that does not exist. This is not worked around.
3. After export, the materializer asserts `bundle.externals` is empty — the executable proof that
   no source identity can enter releaseId through the externals block.

**Option C (concrete externals, classified source-bound) is rejected as a release category**: it
cannot satisfy ADR 0073's portable-release identity claim, and a second "kind" of release material
would fork the identity contract.

**Option B (portable SEMANTIC external requirements) is the named future evolution.** Fully
closing the material duplicates well-known shared material (e.g. a kernel Shape/behavior many
releases reference) into every release's bundle and every target Image. That is the honest v1 cost
of a source-independent identity. When duplication pressure proves real, a NEW explicit contract —
a materialization-level external requirement with portable semantic identity, satisfied by an
explicit binding at install time — is the evolution. It must NOT be retrofitted into generic graph
bundle externals, which are exact source requirements by design.

## Decision 5 — truthful frontier capture for transitive reads: one scoped stable-read session

The release-capture coordinator remains the ONE stability owner; no second capture/frontier
algorithm is created. But a transitive materializer can discover an Image only while walking, so
eager pre-bracketing of known direct source Images is insufficient. The coordinator therefore owns
a **stable-current read session** with exactly one semantic contract:

```text
read(imageId, objectId):
    if imageId not yet bracketed:
        before[imageId] = await images.frontier(imageId)   // BEFORE the first record read
    return await images.getRecord(imageId, objectId)

assertStable():
    for every imageId actually read:
        after = await images.frontier(imageId)
        if after != before[imageId] -> ProjectCaptureConflictError(imageId)

frontierMap(): {imageId -> before} for every image actually read
```

Guarantee: for every dynamically-discovered Image, the FIRST frontier read precedes the FIRST
record read, and the after-check covers every Image actually read. The materializer receives ONLY
this facade — no write capability, no backend, no authority service, no raw frontier manipulation.

**This is enough pressure to extract the shared owner.** The existing direct-record capture path
and the new transitive materialization path must route through the SAME read-session owner rather
than maintaining two bracket implementations. The extraction is behavior-preserving for the direct
path under v1's truthfulness claim: v1 claims each participating Image was stable across the
capture and that all of its reads happened inside its bracket — it never claimed cross-Image
atomicity (ADR 0073: the frontier map is a map of independently stable positions). Lazy
bracket-on-first-read produces exactly the same frontier map for the direct path (host + every
direct source Image is read, hence bracketed) with the same conflict semantics. The first
implementation slice MUST make both paths share the one session owner; two independent bracket
implementations are a stop condition.

`exportGraphBundle` consumes the facade unchanged: it requires `images.getRecord` and nothing
else. The bundle owner never learns that frontiers exist.

## Decision 6 — materialization output: one ProjectReleaseMaterial/v1 package per release

```text
{
  format: 'lagrange-project-release-material/v1',
  projectId,
  releaseId,
  representation: 'lagrange-graph-bundle/v1',
  contentIdentity,            // the one bundle contentIdentity
  bundle                      // the one portable graph bundle
}
```

- One package per release; the bundle is NEVER stored independently per member.
- The material is immutable and content-addressed (`contentIdentity`); the release/package linkage
  is explicit (`releaseId`). Assembly order is acyclic: bundle -> bundle hash -> manifest ->
  releaseId -> package carrying releaseId.
- The Project manifest remains semantic deployment intent; the graph bundle remains generic graph
  transport (it does not know it is inside a Project package); no source frontier is inside the
  material identity; provenance remains the separate ADR 0073 descriptor.
- The name is part of the contract the first slice freezes; the exact module surface may follow
  repo convention, but the five properties above may not drift.

The capture-coordinator graph path therefore returns:

```text
{ release, provenance, material }
```

## Decision 7 — headline falsifier: sharing topology is release identity

```text
Release A: member a -> shared C     Release B: member a -> C1
           member b -> shared C                member b -> C2
           (C, C1, C2 value-identical)
```

Under Decisions 2+3 these are distinguished: A's bundle has 3 records with one shared localId;
B's has 4 records with two distinct localIds. Different canonical bundles -> different
contentIdentity -> different per-member identities -> different releaseId. Any design fragment
that makes them equal (per-root hashing, value-based child dedup at import, per-member bundles
with merge-on-install) is wrong by construction.

## Decision 8 — installation composition, and the pre-effect guarantee

A future Project installation coordinator (named here, NOT built) composes existing owners:

```text
release manifest + release material (+ external bindings ONLY if a future representation
                                           permits them — v1 material has empty externals,
                                           so bindings must be empty too)
  -> PRE-EFFECT validation:
       material.format is v1; material.releaseId === release.releaseId;
       material.contentIdentity === every member's contentIdentity (all equal);
       representation is 'lagrange-graph-bundle/v1';
       assertGraphBundleV1(material.bundle);
       bundle root keys EXACTLY equal the release's selected member key set
  -> importGraphBundle({images, targetImageId, bundle: material.bundle,
                        expectedContentIdentity: material.contentIdentity})
  -> imported roots: {memberKey -> target ObjectRef}
  -> createProjectInstallation({release, targetImageId, targets: importedRoots})
```

**The orphan-graph failure question is decided by the root-key check.** After `importGraphBundle`
succeeds, `createProjectInstallation` can only fail for: unknown target key, missing target key,
target outside `targetImageId`, or duplicate keys. Imported root keys ARE the bundle root keys
(the importer returns exactly them), and imported refs are in `targetImageId` by construction. So
if the pre-effect check `bundle.roots keys === release member keys` held, post-import installation
CANNOT fail for a semantic mismatch. Everything validatable is validated before the single durable
effect — the same discipline the bundle importer itself uses. The graph importer never learns what
a Project is; the Project installer owns the semantic member-key -> target mapping.

Durable/idempotent installation storage, recovery and drift/reconciliation execution remain later
work (ADR 0073 deferrals unchanged).

## Decision 9 — selection boundary: reachability is not membership

DeploymentProfile selects direct member keys explicitly; ONLY those keys become bundle roots.
A transitively-reached record belongs to the portable material because the representation requires
it — it does NOT become a Project member, gets no key/role, appears in no manifest member list,
and conveys no authority. Graph reachability, Project membership, deployment closure and authority
remain four separate things (ADR 0073 guardrails unchanged).

## Adversarial examples — what enters releaseId / provenance / material / import / installation

1. **One selected member, simple Object+Shape closure.** releaseId: bundle hash (2 records).
   Provenance: `{img: rev}` + memberSources. Material: bundle. Import: fresh Shape+Object.
   Installation: `key -> fresh Object`.
2. **Two selected members sharing one child.** One bundle, 3 records, shared localId; import
   yields ONE shared fresh child; installation maps both keys, both resolving to graphs over the
   same child.
3. **Cycle crossing two member roots.** Two-phase mint on import preserves it; both roots' refs
   participate in the cycle in the target.
4. **Two selected members from different Images.** One multi-root export across both Images;
   internalize-all makes every record internal; provenance frontier map covers both source Images
   (plus host as extra); import creates all records in the target.
5. **Transitive ref into a third Image discovered during the walk.** Internalize-all includes it;
   the read session brackets Image 3 lazily at its first read; its frontier enters provenance as
   an extra frontier (ADR 0073 permits extras); a mid-capture write to Image 3 refuses the capture.
6. **Same semantic release assembled in different source Images/ObjectIds.** Empty externals +
   stripped source provenance => identical canonical bundle => identical contentIdentity =>
   identical releaseId (ADR 0073 honored); provenance differs (different Images/frontiers).
7. **Cross-member sharing changed to duplicated-equal children.** Decision 7: different bundle,
   different releaseId. Falsifier passes.
8. **Pinned transitive ref.** Export externalizes it; the materializer REFUSES the release
   (Decision 4). No silent source leak, no fake historical read.
9. **Deliberately external well-known Shape/behavior.** Internalize-all overrides the would-be
   external classification: the well-known record is COPIED into the material and into every
   target. Lossless but duplicating — the recorded cost that motivates the future semantic-external
   contract (Decision 4, Option B deferred).
10. **One selected member changed, another unchanged.** Bundle hash changes => EVERY member's
    contentIdentity changes => new releaseId; upgrade plans replace-all. Accepted coarse v1 cost
    (Decision 3).
11. **Profile selects only one of two Project members.** One root; the unselected member is not a
    root; if the selected member's closure reaches it, it is internalized as transitive material
    with no membership/key/role.
12. **Same material at later unrelated frontiers.** Unrelated writes in non-read Images: capture
    unaffected. A write in a READ Image during capture: conflict, capture refused. A later fresh
    capture of unchanged material: same releaseId, new provenance frontiers.

## What this ADR explicitly does NOT do

- No `materializeRecord` closing over `images`; no unrestricted `GraphImageService` to any
  arbitrary callback. The coordinator wires the ONE materialization owner directly.
- No Project-owned graph traversal; no bundle-owned Project semantics.
- No second capture/frontier owner; no durable Project store; no Git/history/diff/merge; no
  historical/as-of reads; no authority lane; no durable installation storage/recovery.
- No change to ProjectReleaseManifest/v1, the bundle format, or `contentIdentity` semantics.

## Recommended FIRST implementation slice

1. **Extract the stable-current read session** (`src/project/` — the capture coordinator's owner):
   `read`/`assertStable`/`frontierMap` per Decision 5, and route the EXISTING direct-record
   capture path through it. Behavior-preserving; existing release-capture proofs stay green.
   **DONE** — implemented as `createStableCurrentReadSession({images}) ->
   {getRecord, getObject, assertStable, frontierMap}` inside
   `src/project/release-capture.js` (the coordinator owner, not a generic Image primitive).
   `readProjectDescriptor` receives the session as its images reader, so the Project object AND
   its backing member records sit inside the same host-Image bracket; `getObject` derives through
   `getRecord` (never a raw `images.getObject`); `frontierMap()` is gated on successful
   `assertStable()`. All eager bracket machinery (`beforeHostFrontier`, `sourceImageIds`,
   `beforeFrontiers`, the manual final loop) was removed — ONE bracket owner remains.
2. **`src/project/graph-release-materialization.js`** implementing Decisions 2–6: one multi-root
   export through the facade with internalize-all policy, empty-externals/pinned refusal,
   per-member whole-bundle materializations, the v1 material package; capture coordinator gains
   the graph path returning `{release, provenance, material}`. **DONE** —
   `materializeProjectGraphRelease({reader, members, crypto}) -> {bundle, contentIdentity,
   materializations}` (exactly one `exportGraphBundle`; `referencePolicy` = always-internal;
   empty-externals gate via `ProjectGraphReleaseMaterializationError`; every member gets the
   whole-bundle hash); `createProjectReleaseMaterial`/`normalizeProjectReleaseMaterial` own the
   `lagrange-project-release-material/v1` package (intrinsic + release-linkage validation incl.
   the root-keys === member-keys check; immutable isolated package). The capture coordinator was
   refactored around ONE private `runCurrentProjectCapture` (no second capture algorithm); the
   public graph path is `captureCurrentGraphProjectRelease(...) -> {release, provenance,
   material}`; the direct path is behavior-unchanged and gains no material field.
3. Proofs: all 12 adversarial examples, the Decision-7 headline falsifier, lazy-bracket
   conflict-on-third-Image refusal, and exporter/importer byte-compatibility (untouched owners).
   **DONE** (test/graph-project-release.test.js — 18 proofs, 8 falsifiers verified red).

The installation coordinator (Decision 8) is the slice AFTER, gated on real installation pressure;
its pre-effect contract is frozen here so it cannot inherit an orphan-graph failure mode.

## Guardrails

```text
ONE release = ONE multi-root bundle; per-member bundles are not a lossless release.
manifest v1 per-member contentIdentity = the whole-bundle hash (coarse, truthful, deliberate).
per-root member identities cannot see sharing topology; never use them alone.
release material is fully closed: internalize-all unpinned, pinned reachable => refuse.
empty externals is the executable proof that source identity cannot enter releaseId.
the capture coordinator is the ONE stability owner; the read session lazily brackets every
  Image actually read; the materializer never sees GraphImageService/frontiers/backend.
both capture paths share the ONE read-session owner; two bracket implementations = stop.
material package is immutable/content-addressed, linked by releaseId, never duplicated per member.
pre-effect check "bundle root keys === release member keys" makes post-import installation
  failure for semantic mismatch impossible.
reachability != membership != role != authority.
source ObjectRefs/frontiers are provenance, never releaseId.
```
