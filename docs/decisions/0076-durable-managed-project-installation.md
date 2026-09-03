# ADR 0076: durable managed Project installation — atomic first install, lost-ack idempotency, head + immutable snapshot state

Status: accepted — decision; prepared-import and installation-state slices implemented, managed-coordinator slice pending

ADR 0073 decided the ProjectInstallation/v1 semantics and explicitly deferred its durable storage
("durable storage of this descriptor as ordinary image objects remains follow-up work"). ADR 0075
Decision 8 + PR #172 built the effectful, non-durable `installProjectRelease` and recorded the
exact crash window: the importer's atomic `createRecords` commits the release graph, then the
process can die before the caller persists the returned descriptor — the graph exists, the managed
installation does not, and nothing can recover it. This ADR decides the durable managed-installation
protocol that closes that window: ONE current managed installation per `(targetImageId, projectId)`,
stored as ordinary target-Image objects (stable head -> immutable snapshot -> member records),
created in the SAME atomic `createRecords` batch as the imported graph, so that the target Image
can never contain the new release graph without also containing enough canonical durable
installation state to recover the exact ProjectInstallation/v1 mapping after restart.

## Evidence base (current code, current HEAD)

Every load-bearing mechanism below already exists and is proven:

- `ImageService.createRecords` (PR #165) commits N heterogeneous prepared candidates + N history
  events in ONE backend transaction; any failure aborts the whole batch (all-or-none, no cleanup
  path). Callers may supply record ids; duplicate candidate ids inside a batch are rejected in
  preparation.
- `createRecords` is insert-only (`expectedVersion: 0` per candidate). `LagrangeBackend.putRecord`
  throws `VersionConflictError` when the key already exists (`actualVersion >= 1 != 0`), inside the
  transaction, so the whole batch rolls back; `MockBackend.transaction` clones-and-commits, so a
  throw discards the draft. Two concurrent batches carrying the SAME deterministic id therefore
  have exactly one winner, and the loser loses its ENTIRE batch including its graph candidates.
- `importGraphBundle` (PR #167) is internally staged: validate -> identity gate -> external
  resolution (reads only) -> mint ALL target ids -> rewrite -> ONE `createRecords` -> return
  `{roots, contentIdentity}`. The split between "rewrite" and "publish" is a pure preparation seam:
  everything after it is one method call.
- Ordinary-object state with deterministic ids and well-known Shapes is the established pattern:
  `src/project/working-state.js` stores the working ProjectDescriptor as `project/<projectId>` +
  `project/<projectId>/member/<key>` objects under Shape ids like `lagrange-project/...`, with an
  idempotent `ensureShapes` bootstrap that is NOT evidence of Project state.
- The canonical Value domain (ADR 0002, `src/value/scalars.js`) is tagged scalars only:
  boolean/integer/float64/text/bytes/ref/pinned-ref. A slot holds ONE Value; the variable-length
  part of an object is its indexed part (an array of Values). There are NO array/map slot values.
- `releaseId` (model.js `releaseIdentity`) is content-derived over the canonical release body
  `{projectId, profileId, members(key, role, representation, contentIdentity), dependencies}`.
  Equal releaseId therefore implies identical member set, roles and member content identities —
  a durable snapshot's releaseId is a truthful witness for "this exact release is installed".
- `planProjectUpgrade` consumes exactly ONE current ProjectInstallation + one next release; the
  descriptor has no `installationId`; ADR 0073 already names "an installation-record switch as a
  visible commit point" for a future durable reconciler.

## Decision 1 — managed installation identity and cardinality (Q1: A)

ONE current managed installation per `(targetImageId, projectId)`.

- **Chosen: A.** The semantic conclusion is already implied by v1: `ProjectInstallation/v1` has
  `projectId + releaseId + targetImageId + members` and NO installation identity of its own;
  `planProjectUpgrade` takes ONE current installation; "the current managed target" is singular
  throughout ADR 0073. The stable durable key is `(targetImageId, projectId)`, realized as one
  deterministic head object id inside the target Image's record collection (the collection already
  scopes per Image, so the id embeds only the projectId).
- **Rejected: C (releaseId as installation identity).** Upgrade changes releaseId; current-
  installation identity must survive release change. releaseId is content of the installation,
  not its identity.
- **Deferred: B (multiple managed installations of one Project in one Image).** Requires a
  portable installation identity that v1 does not have. That is a ProjectInstallation/v2 decision
  and must be motivated by real pressure. No `installationId` is manufactured now — not even to
  make storage convenient.
- Multiple independent copies of the same release in one Image remain possible through the
  EXISTING unmanaged `installProjectRelease` (fresh-copy, PR #172). Only one of them is managed.

## Decision 2 — two APIs, one semantic core (Q2)

`installProjectRelease` keeps its proven contract: untracked fresh-copy materialization, no
durable installation state, install-twice means two copies. It is NOT silently redefined.

New managed lifecycle API (`installManagedProjectRelease` pending; durable read implemented):

```text
installManagedProjectRelease({images, targetImageId, release, material, crypto})
  -> ProjectInstallation/v1

  no current managed installation  -> atomic first install (Decision 5)
  current managed at SAME releaseId -> return the recovered EXISTING descriptor;
                                       NO new graph, NO new history (Decision 7)
  current managed at DIFFERENT releaseId -> REFUSE: managed-installation conflict naming
                                       current and desired releaseId; upgrade/reconciliation
                                       required (Decision 11); NO new graph

readManagedProjectInstallation({images, targetImageId, projectId})
  -> ProjectInstallation/v1 | null     (absent head = not installed; Decision 9)
```

Both APIs route through the SAME lower semantic owners: linked preflight
(`validateProjectReleaseMaterialForRelease`), the graph bundle owner, the Project model, and
`ImageService.createRecords`. `ensureProjectInstallation` was considered as the name and rejected:
the operation is the managed sibling of `installProjectRelease`, and the family resemblance
(install vocabulary, three explicit outcomes) is clearer than an ensure verb that hides the
first-install effect.

## Decision 3 — durable representation: stable head + immutable snapshot + member records (Q3, Q16)

Ordinary target-Image objects, following the working-state pattern — NO backend record kind, NO
JSON collection, NO storage bypassing GraphImageService:

```text
head object        id:  lagrange-project-installation/<projectId>/head   (DETERMINISTIC)
                   shape: lagrange-project-installation/head-shape/v1
                   slots: {projectId: text, snapshot: ref}

snapshot object    id:  <fresh uuid>   (minted per install; reachability only via head)
                   shape: lagrange-project-installation/snapshot-shape/v1
                   slots: {projectId: text, releaseId: text}
                   indexed: [memberRef, ...]              (canonical member order)

member record      id:  <fresh uuid>
                   shape: lagrange-project-installation/member-shape/v1
                   slots: {key: text, role: text, representation: text,
                           contentIdentity: text, target: ref}
```

Persisted content is exactly what ProjectInstallation/v1 means (Q16): projectId, releaseId,
member key/role/representation/contentIdentity, target refs; targetImageId is the containing
collection and is re-validated on read. NOT persisted: the release bundle/material, source
provenance, source refs, the DeploymentProfile, Git state, authority. Those belong to their
existing owners; nothing here is needed for recovery beyond the descriptor mapping (Decision 9).

**Why separate member records is FORCED, not merely preferred.** The canonical Value domain has
no array/map slot values: a slot holds one tagged scalar, and an object's only variable-length
part is its indexed array of Values. "One snapshot object with a members slot" is not expressible.
A member is five fields; the only faithful encodings are (a) member objects referenced from the
snapshot's indexed part — chosen — or (b) a parallel fixed-slot layout spreading members across
predeclared slots, which manufactures fake slot identity and breaks the Shape contract. The
snapshot's indexed part stores member refs in canonical (key-sorted) order; storage order is
nevertheless not semantic, because `normalizeProjectInstallation` re-sorts and rejects duplicate
keys on every reconstruction.

**Rejected: mutable installation root + mutable member records.** A mutable design makes the
first install no simpler (same records, one batch) and makes the future upgrade strictly worse:
upgrade would need many existing-record mutations + many fresh creates atomically — a broad
multi-record mutation transaction the substrate deliberately does not have (ADR 0075/0074
guardrails). With an immutable snapshot, upgrade pressure concentrates into ONE expected-version
head switch (Decision 11). working-state's mutable members are not a counter-precedent: member
retarget is a working-Project operation with stable member-key identity; installation members
have no per-member durable identity in the model — they are pure data of the snapshot.

**Fresh snapshot/member ids, deterministic head id only.** Snapshot and member records are
reachable only through the head and are created in the same transaction as the head, so they
need no stable identity. The head needs a deterministic id for three independent reasons:
idempotent retry must find the same commit point (Decision 7); concurrent installers must
collide on one insert-only key (Decision 8); recovery must not scan (Decision 9). The head id
embeds the portable `projectId` — never a releaseId, never a bundle localId, never a target
object id. Deterministic-id embedding of projectId follows the working-state precedent
(`project/<projectId>`).

## Decision 4 — owners (Q4, Q6, Q7)

Exactly one owner per concern; the new interaction has exactly one owner.

| Concern | Owner | Status |
| --- | --- | --- |
| ProjectInstallation/v1 semantics (canonicalization, validation, member ordering) | Project model (`src/project/model.js`) | current, unchanged |
| ProjectInstallation/v1 <-> ordinary target-Image installation objects | **Project installation-state translator (`src/project/installation-state.js`)** | current, implemented |
| bundle localId -> fresh target identity; portable ref -> target ref; durable graph candidates | Graph bundle model (`src/graph/bundle.js`) | current; gains a preparation seam (below) |
| N prepared candidates -> one atomic commit | `ImageService.createRecords` | current, unchanged |
| managed first-install sequencing: preflight -> prepare -> canonical installation -> installation record specs -> ONE createRecords -> idempotent return/conflict | **managed installation coordinator (`src/project/managed-installation.js`)** | NEW, pending |

The installation-state translator owns the well-known Shape ids, the deterministic head id,
`materializeInstallationRecords({installation, crypto}) -> record specs` (from an ALREADY
canonical ProjectInstallation), `readManagedProjectInstallation` assembly (ordinary state ->
`normalizeProjectInstallation`), and the corruption taxonomy (Decision 10). It does NOT decide
releaseId, plan upgrade, import graph material, or own transaction/recovery sequencing.

The graph bundle owner gains (Q6 — validated against the staged importer on current HEAD):

```text
prepareGraphBundleImport({images, targetImageId, bundle, externalBindings, expectedContentIdentity, crypto})
  -> frozen {roots, recordInputs, contentIdentity}     (NO durable effect)
```

`importGraphBundle(...)` is refactored onto it: prepare, then `createRecords(targetImageId,
plan.recordInputs)`, then return `{roots, contentIdentity}` — behavior unchanged. Guardrails:
bundle localIds stay out of the returned plan (no localId->target map); `roots` are already the
importer's semantic output; `recordInputs` are generated solely by the graph owner, returned
deeply frozen, and must not be reinterpreted, filtered, re-ordered or rewritten by callers;
the contentIdentity gate and external-binding rules stay exactly where they are (before any
minting, reads only); standalone import and managed install consume the SAME preparation owner.
NO importer callbacks, NO "extra records" hook, NO Project awareness, NO Project-specific import
mode in the graph bundle.

The atomic publication owner remains `ImageService.createRecords` alone (Q7). The managed
coordinator sequences `[...plan.recordInputs, ...installationRecords]` into ONE call. It never
calls `backend.transaction`, never appends history, never creates per-kind records through
side paths. This is NOT a general heterogeneous mutation transaction: every element is an
insert-only creation of an existing record kind through the existing batch owner.

## Decision 5 — closing the first-install crash window (Q5)

```text
installManagedProjectRelease (absent branch):
  1. normalizedRelease  = normalizeProjectReleaseManifest(release)
  2. validatedMaterial  = validateProjectReleaseMaterialForRelease({release: normalizedRelease, material, crypto})
  3. head               = await readManagedProjectInstallation({images, targetImageId, projectId})
     head present       -> same releaseId: return it | different: refuse (upgrade required)
  4. plan               = await prepareGraphBundleImport({images, targetImageId,
                            bundle: validatedMaterial.bundle,
                            expectedContentIdentity: validatedMaterial.contentIdentity, crypto})
  5. installation       = createProjectInstallation({release: normalizedRelease, targetImageId,
                            targets: plan.roots})
  6. installRecords     = installationState.materializeInstallationRecords({installation, crypto})
  7. await images.createRecords(targetImageId, [...plan.recordInputs, ...installRecords])
     - commit           -> graph + head + snapshot + members all exist: return installation
     - any failure      -> NOTHING exists; propagate; no cleanup, no partial state
     - VersionConflict  -> a concurrent/earlier install committed the head: re-read head and
        on head id       apply the same-release/different-release rule (Decision 8)
  8. return installation
```

Why this and not the weaker shapes:

- **Persist-after-import** leaves exactly the PR #172 window: commit, crash, descriptor lost.
  Rejected.
- **Pending-record-before-import** is not true idempotency: a retry that "completes the pending
  install" by importing a fresh graph orphans the first committed graph; a retry that tries to
  adopt the first graph has no durable name for it. Rejected.
- **One batch** makes the invariant structural: the graph candidates and the installation records
  are elements of the same insert-only transaction, so the graph cannot exist without the head.
  The ProjectInstallation descriptor is built from the plan's pre-publication roots — the same
  roots the importer would have returned after publication — through the model owner, so the
  descriptor is canonical before it is persisted. ADR 0075 Decision 8's pre-effect guarantee
  carries over: everything semantically checkable is checked before the single durable effect;
  `createProjectInstallation` cannot fail after step 4 for a semantic mismatch.

## Decision 6 — the head is the commit point (Q8)

The stable head object is the visible managed-installation commit point, created in the same
transaction as graph + snapshot + members:

- head present  => the WHOLE installation (graph, snapshot, members) committed;
- head absent   => NO managed installation committed (whatever else exists is unmanaged graph).

This is the recovery invariant. Reads never infer, merge or partially accept state: the head is
the only entry point, and schema/bootstrap objects (Decision 12) are never installation state.
The invariant's one assumption is the batch's all-or-none atomicity, which is the proven
`createRecords` contract — the same trust ADR 0075 Decision 8 already places in it.

## Decision 7 — lost-ack idempotency: the stable key is the witness (Q9)

Scenario: the transaction commits (graph + snapshot + head) but the caller sees a failure or the
process dies before acknowledgement. Retry of `installManagedProjectRelease` with the same
release:

1. reads the deterministic head -> snapshot -> assembles the descriptor via
   `normalizeProjectInstallation`;
2. snapshot.releaseId === candidate releaseId => returns the EXISTING descriptor with the
   EXISTING target refs. NO new graph, NO new history.

No idempotency key is introduced: `(targetImageId, projectId)` is the semantic stable key and
releaseId is content-derived over members/roles/content, so the durable snapshot is already a
truthful idempotency witness. A same-releaseId retry whose supplied material were somehow
different is impossible in canon: equal releaseId implies equal member content identities.
The retry never consults the bundle, the source Image, provenance or process-local import state.

## Decision 8 — concurrency: one winner by construction (Q10)

Two concurrent installs of the SAME release into the same target:

- both observe no head; both prepare DISTINCT fresh graph ids (minted uuids); both submit ONE
  batch containing the SAME deterministic head id;
- exactly one transaction commits; the loser's head put hits `expectedVersion: 0` against an
  existing record -> `VersionConflictError` -> its ENTIRE batch aborts, including its graph
  candidates. No duplicate durable graph can exist;
- the loser re-reads the head: same releaseId -> returns the WINNER's descriptor (the loser's
  prepared plan is discarded; its minted ids were never published).

Concurrent DIFFERENT releases: same mechanism; the loser re-reads, sees a different releaseId,
and gets the explicit managed-installation conflict (current vs desired releaseId) — upgrade
required. The loser's graph candidates do not persist.

This is falsifiable: if the head id were non-deterministic, or the publication were not a single
insert-only batch, or the loser retried blindly instead of re-reading, duplicate graphs would
appear. The design's concurrency story is entirely the existing insert-only conflict semantics;
no lock, no queue, no new backend primitive.

Cross-process note: `LagrangeBackend` serializes writers through the database transaction;
`MockBackend` serializes through its exclusive draft-commit. Both give the same winner/loser
semantics; the loser path is always "re-read the head, then decide".

## Decision 9 — restart recovery: the snapshot is the truth (Q11)

After a real backend restart:

```text
readManagedProjectInstallation({images, targetImageId, projectId})
  head absent -> null
  head present -> snapshot -> members -> normalizeProjectInstallation -> ProjectInstallation/v1
```

Every member target ref resolves in the target Image because the graph and the installation state
committed in one transaction. Recovery needs ONLY the durable installation state: never the
release material/bundle, the source Image, provenance, a process-local import mapping, or log
archaeology. `planProjectUpgrade({installation: recovered, nextRelease})` then operates on the
recovered descriptor unchanged — durable recovery is a drop-in current installation for the
existing pure planner (upgrade execution remains future work, Decision 11).

## Decision 10 — corruption is surfaced, never repaired (Q12)

The read path validates, in order, and every mismatch is a `ProjectInstallationStateError`
(corruption), never a silent repair, rescan or deletion:

| Stored state | Outcome |
| --- | --- |
| head absent | `null` — not installed (NOT corruption) |
| head.snapshot ref dangling (snapshot record missing) | corruption |
| snapshot.projectId != the head's projectId key | corruption (wrong Project under a stable head) |
| snapshot.releaseId malformed | corruption |
| member ref dangling, duplicate member key, member field malformed | corruption (assembly + `normalizeProjectInstallation`'s duplicate-key rejection) |
| member.target outside targetImageId | corruption (`normalizeProjectInstallation` enforces targetImageId membership) |
| malformed representation/contentIdentity text | corruption |
| snapshot/member exists WITHOUT head (only possible via external mutation) | invisible — not an installation; NOT scanned, NOT adopted |

With member records separated (Decision 3), "dangling member ref" is a distinct corruption mode;
with members inlined it would be unexpressible storage. Neither the reader nor any coordinator
ever deletes or rewrites suspicious state.

## Decision 11 — upgrade boundary and the recorded next pressure (Q14, Q15)

This slice ships first-install only:

- no current managed installation -> atomic first install (Decision 5);
- same releaseId -> idempotent return (Decision 7);
- different releaseId -> REFUSE with an explicit managed-installation conflict naming the current
  and desired releaseIds. No new graph. `planProjectUpgrade` can plan from the recovered current
  descriptor; execution is the FOLLOWING problem.

The future upgrade transaction shape is evaluated, not implemented: fresh next graph + fresh
immutable snapshot/members + ONE expected-version CAS update of the stable head. `createRecords`
is insert-only and cannot perform the head switch; the head switch is an UPDATE. The widening is
deliberately minimal — one single-record expected-version write through the existing
GraphImageService surface (the `expectedVersion` CAS contract already exists on the single-record
path), sequenced as: create fresh state (insert-only batch) -> CAS head. A crash between leaves
an unreachable fresh snapshot/graph — unmanaged garbage, NOT corruption (head still points at the
old, fully valid installation); garbage collection is its own future pressure and must not become
a delete-on-failure protocol. This is recorded as the next pressure; the first-managed-install
slice does NOT solve it, and must not grow a general multi-record mutation transaction to do so.

## Decision 12 — schema bootstrap is not installation state (Q13)

The installation-state translator owns three well-known Shapes (head/snapshot/member) plus an
idempotent `ensureInstallationShapes({images, targetImageId})`, run BEFORE the install batch,
following the working-state `ensureShapes` precedent:

- bootstrap is harmless substrate schema: Shape presence is NEVER treated as evidence that an
  installation committed; the head remains the sole commit point (Decision 6);
- a crash during bootstrap leaves some Shapes — no installation, no recovery action;
- bootstrap must be race-tolerant: two concurrent ensures may both attempt an insert-only Shape
  creation; the loser catches the version conflict and re-reads (Shape definitions are fixed
  constants, so a re-read either sees the identical Shape or a corruption-class divergence).

## Decision 13 — no authority (Q17)

Durable installation state confers NO authority: no Project-wide grant, no target-ownership
grant, no authorized install lane. The managed API is host-level substrate like the rest of the
Project/Graph surface. Authority for installation/upgrade remains the separate future pressure
ADR 0073 already names.

## Adversarial scenarios

For each: durable objects after the scenario / commit point / what retry or read returns /
orphaned graph possible? / deciding owner.

1. **First managed install into an empty target.**
   Objects: graph records + members + snapshot + head (one transaction). Commit point: head.
   Retry returns the same descriptor. Orphans: none. Owner: managed coordinator sequencing;
   createRecords commits.
2. **Commit, then lost acknowledgement.**
   Objects: full installation (committed). Commit point: head. Retry: same releaseId ->
   existing descriptor, no new graph. Orphans: none. Owner: coordinator's idempotent-return rule.
3. **Process crash after commit, before return.** Identical to 2 — indistinguishable by design;
   that is the point.
4. **Retry same release after restart.** As 2; recovery reads only durable state. Orphans: none.
5. **Concurrent same-release installs.** Objects: winner's full installation. Commit point:
   winner's head. Loser: batch aborted, re-reads head, same releaseId -> winner's descriptor.
   Orphans: none (loser's candidates never commit). Owner: insert-only conflict at createRecords
   + coordinator loser path.
6. **Concurrent different-release installs.** Objects: winner's installation only. Loser:
   aborted batch, re-reads, different releaseId -> conflict error naming both releaseIds.
   Orphans: none. Owner: same as 5.
7. **Current managed installation at same release.** No new objects. Returns existing descriptor.
   Owner: coordinator.
8. **Current managed installation at different release.** No new objects. Refusal naming both
   releaseIds; upgrade required. Owner: coordinator.
9. **Two different Projects into one target Image.** Objects: two independent heads
   (`.../<projectId-A>/head`, `.../<projectId-B>/head`) + their graphs, disjoint. Commit points:
   per-Project heads. No interference: head ids differ. Owner: coordinator per install.
10. **Same Project into two different target Images.** Objects: one head per target collection,
    independent installations with independent target refs. targetImageId membership is enforced
    on read. Owner: coordinator per target.
11. **Shared/cyclic Project graph under managed install.** Objects: ONE graph (one prepared
    plan; cross-member sharing/cycles preserved — the managed path consumes the same preparation
    owner as PR #172's installer) + installation records. Orphans: none. Owner: graph bundle
    (translation), coordinator (sequencing).
12. **Corrupted/missing snapshot member.** Read -> corruption error (dangling member ref /
    duplicate key / malformed field / target outside Image). No repair, no rescan. Owner:
    installation-state translator.
13. **Ordinary `installProjectRelease`.** Objects: fresh graph only, no installation records.
    Commit point: none (untracked). Managed reads do not see it; a later managed install of the
    same release creates ANOTHER fresh graph plus installation state — unmanaged copies are not
    adopted (adopting would require scanning; rejected). Owner: release-installation coordinator
    (unchanged PR #172 semantics).
14. **Upgrade planning from a recovered descriptor.** `planProjectUpgrade({installation:
    recovered, nextRelease})` -> plan; zero durable effects. Owner: Project model.
15. **Crash during schema bootstrap.** Objects: some well-known Shapes, maybe none. Commit
    point: none — Shapes are not state. Retry: ensure is idempotent; install proceeds. Orphans:
    none. Owner: installation-state translator.
16. **Backend transaction abort after some candidate writes.** Objects: none — the abort
    discards all puts/history appends (proven createRecords contract; `MockBackend` draft
    discard, `LagrangeBackend` transactional rollback). Retry: full re-prepare, fresh ids.
    Orphans: none. Owner: createRecords/backend.
17. **Backend commit + lost ack.** = 2.
18. **Loser prepared distinct fresh graph ids, then loses the head race.** Objects: winner's
    only. Loser's minted ids were never published — they are process-local values, not durable
    state; nothing references them. Orphans: none. Owner: insert-only conflict + coordinator
    re-read.

**Headline invariant, restated with its proof shape:** for a managed first installation, the
target Image can never contain the new release graph without also containing enough canonical
durable installation state to recover the exact ProjectInstallation/v1 mapping after restart —
because the graph candidates and the installation records are elements of ONE insert-only
`createRecords` batch whose all-or-none atomicity is already proven, and because the deterministic
head in that same batch is the sole commit point. This closes the PR #172 crash window
structurally rather than by apology, retry hint or post-hoc scan.

## Guardrails (binding)

- No persist-after-import "recovery"; no pending record whose retry imports a second copy.
- No movement of bundle localId -> target identity ownership into Project code; the localId map
  is never returned, persisted or used as Project semantic identity.
- No Project callbacks/hooks/awareness in the graph bundle; no Project-specific import mode.
- No backend ProjectInstallation record kind; no JSON collection; no bypass of GraphImageService.
- The Project model does not persist state; the translator does not decide semantics.
- No scanning arbitrary graph records to rediscover an installation; no inference of installation
  identity from releaseId alone (the head key is `(targetImageId, projectId)`).
- No upgrade/reconciliation execution in this slice; no general heterogeneous mutation
  transaction; no delete-on-failure or orphan deletion as a protocol.
- No authority in installation state.
- `installProjectRelease` semantics unchanged: unmanaged fresh copy, no installation records.

## Rejected alternatives, with revisit conditions

- **releaseId as installation identity (Q1-C).** Rejected: upgrade changes releaseId. Revisit
  only if installation identity is re-based on content addressing globally.
- **Multiple managed installations per Project per Image (Q1-B).** Deferred: needs a
  ProjectInstallation/v2 identity. Revisit on real multi-slot deployment pressure.
- **Mutable installation root + mutable member records (Q3).** Rejected: forces a broad
  multi-record mutation transaction at upgrade. Revisit if the substrate ever gains a principled
  multi-record CAS batch AND per-member installation identity becomes semantic.
- **Members inlined in the snapshot (single object).** Rejected as inexpressible: the canonical
  Value domain has no array/map slot values. Revisit only if the Value domain grows composite
  values (an ADR 0002-level change).
- **Pending-install record + completing retry (Q5).** Rejected: either orphans the first graph
  or cannot name it. Revisit only with a durable naming scheme for uncommitted graphs — which
  this ADR deliberately avoids inventing.
- **Two-transaction first install (graph, then state).** Rejected: it IS the PR #172 window.
- **`ensureProjectInstallation` naming.** Rejected for hiding the first-install effect; the
  three-outcome contract is stated explicitly on `installManagedProjectRelease`.

## First implementation slice (recommended)

1. **Prepared-import seam (implemented)** in `src/graph/bundle.js`: extract `prepareGraphBundleImport`;
   re-implement `importGraphBundle` as prepare + one `createRecords`; frozen plan; no behavior
   change (existing import proofs stay green; new proofs: plan immutability, no durable effect,
   no localId leakage, standalone/managed consume the same owner).
2. **Installation-state translator (implemented)** `src/project/installation-state.js`: well-known Shapes +
   race-tolerant `ensureInstallationShapes`; deterministic head id;
   `materializeInstallationRecords` (from canonical descriptor only);
   `readManagedProjectInstallation` with the Decision 10 corruption taxonomy, proven by real
   restart recovery on the Lagrange backend.
3. **Managed coordinator** `src/project/managed-installation.js`: `installManagedProjectRelease`
   with the three-outcome contract and the Decision 5 sequencing; proofs for every adversarial
   scenario 1-18, with falsifiers: state-persisted-after-import (crash-window proof red),
   non-deterministic head id (duplicate-graph proof red), loser-does-not-reread (conflict proof
   red), members-not-in-same-batch (head-without-graph / graph-without-head red),
   scan-based recovery (guardrail review, not a test).

Ownership/map consequences: add the two NEW owner rows from Decision 4 to `docs/ownership.md`
(marked pending implementation), extend the graph bundle owner's row with the preparation seam,
and mark ADR 0073's "durable storage ... remains follow-up work" deferral as decided-here.
