# ADR 0092: Object residency, placement and remote resolution are generic Images owners over Lagrange routing

Status: accepted — `ObjectLocator` (`whole-image/v1` + `per-object/v1`), `PlacementPolicy` (`src/graph/placement.js`), and `RemoteRecordResolver` (`resolveAt`, `resolveImageAt`, `writeRecordAt`) are implemented and proven across both shared-server and two-node SQLite `LagrangeBackend` runtimes (`test/object-locator.test.js`, `test/cuis-life-m6-distributed-acceptance.test.js`); real Lagrange shared-server Life acceptance remains open (`lagrange-images-0pxf.4`)

**Decides WHERE the generic owners M6 needs live and WHAT each may own.** ADR 0085 M6 asks whether the exact M5 application runs unchanged when its ordinary objects
are placed across Lagrange nodes, with no placement or routing logic in the application, the Cuis
importer or the Cuis personality. The M6.1 census (bead `lagrange-images-0pxf.2`) found that
residency and placement have no owner at all and that resolution, routing and execution placement
have single-node owners only. The M6.2 witness (bead `lagrange-images-0pxf.3`,
`test/cuis-life-m6-two-node-red.test.js`) then measured the refusals those gaps produce. M6.3-M6.6
(`lagrange-images-0pxf.4`, `lagrange-images-0pxf.12`) implement the generic owners: the object
locator (`src/graph/locator.js`), the placement policy owner (`src/graph/placement.js`), and the
remote record resolver (`src/graph/remote-resolution.js`), keeping the boundary fixed so that the
repair does not become a second distribution system inside Images.

## Context

### What M6.2 measured

Two independent Images nodes (two runtimes, two durable backends, no providers). Node B holds the
exact M5 Life installation and runs the frozen blinker fixture to S0. The split is chosen from the
real graph: the `cells` LifeArray instance that the unchanged `LifeModel>>nextState` reads and
writes on every send, named by an ordinary slot ref of the model. Placement is then attempted
through existing owners only:

| step | owner asked | measured refusal |
| --- | --- | --- |
| read the ref on node A | image service | `image not found: life-native` |
| admit the record on node A with the image scope present | object owner (`putObject`) | `shape not found: life-native/smalltalk/point-agnostic-array2d-instance-shape/v1` |
| release the record from node B | backend contract, image service | no `delete`, `remove`, `detach`, `relocate` or `move` exists; a "move" through existing owners is a copy, which duplicates identity |
| unchanged `nextState` on node B after the record was relocated as raw evidence | dispatch | `Symmetric Smalltalk receiver not found: life-native/<cells>` |
| `cells at:` on node A, which holds the record alone | dispatch | `Symmetric Smalltalk behavior not found: …` |

Every refusal is an owner doing its job against the ONE composed backend it has. None of them is a
defect; all of them say the same thing: a record's residency has no representation, no owner
decides it, and no owner can answer for a record that lives elsewhere.

### What already exists and must not be duplicated

- **Identity** is complete: an ObjectRef is `(imageId, objectId)` and is independent of backend
  row, version and location (a graph invariant since the bootstrap). Residency must attach to
  that identity, never replace or qualify it.
- **Lagrange** (pinned at v0.2.5 by the real backend lane) owns partitions, replicas, Raft
  consensus, membership and the routing of database and service work to the node that holds a
  partition. It knows tables, partition keys and rows. It does not know the Images object graph,
  Shapes, Behaviors or sends, and must not learn them.
- **The Lagrange backend adapter** maps the image backend contract onto public Lagrange sessions.
  Its five tables carry composite primary keys chosen so that Lagrange can route by them; today
  one runtime composes one adapter over one session.
- **ADR 0037** keeps authority transient and per call; nothing in distribution may cache it.
- **The M6 prohibition ledger** (epic `lagrange-images-0pxf`): no placement conditionals in the
  importer, no remote/local branches in the personality, no Life-specific routing, no duplicate
  identity, no serialization shortcut around ObjectRefs, no test-declared answers.

## Decision

### 1. Residency is graph data with ONE owner: the object locator

A record's **residency** — which node scope holds it — is a fact about the record, owned by a new
generic owner, the **object locator** (`src/graph/locator.js`). It answers, for a
ref, where the record can be read and written. Identity `(imageId, objectId)` is unchanged by
residency; a moved record is the same record.

The first form of residency is **whole-image** (`WHOLE_IMAGE_RESIDENCY = 'whole-image/v1'`): an
image resides where its backend session does. That is exactly what the M6.2 refusals describe
("image not found" is a residency answer given by accident), so the first owner makes the
accidental answer explicit rather than inventing a finer one. When peer node backends are registered
with `ObjectLocator` (`peers` / `registerPeer`), `ObjectLocator.locate(ref)` also resolves
**per-object residency** (`PER_OBJECT_RESIDENCY = 'per-object/v1'`) from durable relocation markers
(`{kind: 'relocated', id, imageId, node}`) stored in the per-image record collection, returning an
opaque `ObjectResidency` (`{kind: 'per-object/v1', imageId, objectId}`) without exposing any backend,
node, partition or replica handle on the residency value.

### 2. Placement is a separate generic owner, never consulted by a language

**Placement policy** (`PlacementPolicy` in `src/graph/placement.js`) decides where a record is
placed, when a record moves (`relocateObject({ref, fromNode, toNode})`,
`relocateObjects({refs, fromNode, toNode})`, `inspectResidency(ref)`), and which node executes an
object-rooted message send (`selectExecutionNode(ref)`,
`dispatchSend({fromNode, receiver, message, arguments, languageId})`).
When `relocateObject` moves an object record from `fromNode` to `toNode`, it preserves the exact
`(imageId, objectId)` identity, writes the object record to `toNode`'s backend with an `object.put`
history event, and atomically replaces `fromNode`'s copy at its current `_version` with a durable
`{kind: 'relocated', id, imageId, node: toNode}` marker (`object.relocated` history event) while
refusing any relocation that would create duplicate live object records across nodes. Placement is
never an argument of a send, a slot, a Value, a class or an import; language personalities and
importers cannot observe it.

Residency and placement are two owners on purpose: one answers "where is it" (`ObjectLocator`), the
other "where should it be and where should work for it run" (`PlacementPolicy`); the M6.5 restart
proof verifies that both identity and per-object placement survive a full two-node runtime restart
from durable SQLite state alone.

### 3. Remote resolution is an interaction owner over Lagrange routing, and Images never owns transport

The arrow **Images runtime -> a record resident on another node** has one owner: **remote
resolution** (`src/graph/remote-resolution.js`). It translates a read or write of a ref whose
located residency points to another node's backend session (`resolveAt(ref, residency)`,
`resolveImageAt(imageId, residency)`, `writeRecordAt(ref, residency, ...)`), exposes round-trip
telemetry (`stats()`, `resetStats()`) distinguishing local vs cross-node and per-object vs
whole-image reads/writes via `isRemoteResidency(residency)`, and owns the error
mapping, read idempotency, and the rule that authority is checked at the executing runtime and never
cached in durable state. `GraphImageService.getImage`, `GraphImageService.getRecord` and
`GraphImageService.putObject` delegate through `ObjectLocator` and `RemoteRecordResolver`.

Images does **not** implement transport, membership, replication or consensus. Those are Lagrange's
(ADR 0033's placement of the durable backend below Images stands). An Images-side RPC, gossip or
"node registry" would be a second distribution system and is rejected. Because Lagrange does not
yet route an arbitrary Images record request between separately composed embedded servers, the
first vertical uses the lowest form that needs no new transport: **two Images runtimes over ONE
shared Lagrange server** (`LagrangeBackend` with `ownsRuntime: false`), where residency is shared
durability and "remote" is a different runtime reading and mutating the same partitioned store.
Placement across separately composed backends waits for Lagrange routing of Images' requests.

### 4. Compute-near-object execution placement

`PlacementPolicy.selectExecutionNode(ref)` and
`PlacementPolicy.dispatchSend({fromNode, receiver, message, arguments, languageId})` route a
message send to the registered node runtime where `receiver` is currently resident. The M6
distributed Life acceptance witness (`test/cuis-life-m6-distributed-acceptance.test.js`) proves
that relocating the blinker data closure (`model`, `cells`, `cells elements`) to node A and
dispatching `model nextState` via `PlacementPolicy.dispatchSend` eliminates all cross-node reads
and writes of the relocated blinker objects (`perObjectRecordReads === 0`,
`perObjectRecordWrites === 0`, `localRecordWrites > 0` on node A) while producing identical
`FROZEN_STATES` transitions without rewriting `LifeModel>>nextState`. Nothing here decides
Lagrange WASM placement.

### 5. Ownership map and proof discipline

`docs/ownership.md` records the whole-image object locator (`src/graph/locator.js`) and the
remote-resolution interaction owner (`src/graph/remote-resolution.js`) as **candidate** rows while
real-Lagrange shared-server Life acceptance (`lagrange-images-0pxf.4`) remains open, and keeps
placement policy **planned** until the first non-default placement is introduced.

Two proofs exist today, and one remains open:

1. **Unit and shared-SQL two-runtime Life proof (`test/object-locator.test.js`,
   `test/lagrange-backend.test.js`, `test/real-lagrange-suite.test.js`)**: `ObjectLocator` and
   `RemoteRecordResolver` resolve whole-image records by canonical ref; `ImageService.getRecord`
   delegates through both owners; two attached `LagrangeBackend` instances (`ownsRuntime: false`)
   share one running application server without owning its lifecycle; and `proveSharedLife`
   (`fixtures/real-lagrange-m6-scenario.js`) installs the recovered M5 Life application on runtime
   1, steps `S0 -> S1` on runtime 1, observes `S1` on runtime 2, steps `S1 -> S2` on runtime 2, and
   observes `S2` on runtime 1 with zero changes to Life, the Cuis importer or the Smalltalk
   personality.
2. **Real Lagrange shared-server Life witness (`fixtures/real-lagrange-m6-shared-server-process.js`,
   `fixtures/real-lagrange-backend-process.js` `life` mode) — open under `lagrange-images-0pxf.4`**:
   Measured against `lagrange-server` `a43ce6a9fe3c2ffd17fcb084e596a0c709ba88c9`, `proveSharedLife`
   exceeds the 340 s phase budget for two quantitative reasons:
   - **Write amplification (`1,783` transactions / `1,859` records)**: `installRecoveredLife`
     executes `1,703` `backend.transaction` calls (`1,544` in
     `installSymmetricSmalltalkStandardImage`, `154` in `importCuisNativePackage`, `4` in
     `installManagedProjectRelease`, `1` in `createImage`) writing `1,859` records, plus `80`
     transactions during `buildBlinkerModel`, `stateString` and `nextState`. Each record write in
     `commitCandidateRecords` issues 3 SQL write statements (`records`, `stream_heads`, `events`),
     and each SQL write statement in Lagrange's `SqlQueryEngine` opens an internal
     `writeTransaction` performing 41 system-table metadata writes (~1.28 s/record, ~1.56 s/tx).
   - **Read and scan amplification (reduced by `97.6%` for point reads, `99.5%` for full scans, and `97.2%` for total SQL queries)**:
     Before owner-scoped memoization, `proveSharedLife` issued `1,091,137` `backend.get` calls and
     `193` full-collection `backend.scan` calls (`174,190` scanned rows, ~`1,280,000` total SQL
     queries) because every `ImageService.getRecord` re-read `images/<imageId>` via
     `ObjectLocator.locate(ref)` (`546,568` reads), every `CompilationService` compilation rescanned
     all image records via `listCodeArtifacts` (`187` scans), and every nested activation re-read
     immutable `Block`/`CodeArtifact`/`Shape`/`LexicalEnvironment` records, Smalltalk protocol
     objects, durable `Object` records (`Class`, `MethodDictionary`, receiver/slots), and duplicate
     Behavior/kernel records. Caching confirmed `ObjectResidency` per `imageId` in `ObjectLocator`,
     indexing reusable derivations per `imageId` in `CompilationService`, memoizing immutable
     records, protocol objects, and durable `Object` reads (invalidated/updated on in-execution
     `putObject` and promotion) within a single `LexicalCellArena` execution view, and eliminating
     duplicate in-call Behavior/kernel reads reduces `proveSharedLife` to `25,722` `backend.get`
     calls (`-97.6%`), `1` `backend.scan` call (`67` rows, `-99.96%`), and `36,181` total SQL
     queries (`-97.2%`, including a reduction in post-install `buildBlinkerModel` / `nextState` SQL
     queries from `78,440` to `14,965`, `-80.9%`).

The M6.2 witness (`test/cuis-life-m6-two-node-red.test.js`) remains the separate two-backend
per-object relocation falsifier: it stays RED until per-object residency and cross-backend routing
are implemented.

## Consequences

- M6.3 lands the candidate whole-image locator (`src/graph/locator.js`), the shared-server remote
  record resolver (`src/graph/remote-resolution.js`), the storage-layout owner
  (`src/image/storage-layout.js`), and `LagrangeBackend` shared-runtime attachment
  (`ownsRuntime: false`), proven in `test/object-locator.test.js` and `test/lagrange-backend.test.js`,
  while keeping the `ownership.md` rows at `candidate` status until the real-Lagrange Life witness
  completes within budget.
- The Lagrange backend adapter stays the sole translation between the backend contract and
  Lagrange sessions; the locator and remote resolution sit above it and consume it.
- `docs/lagrange-integration.md` checklist items 7 to 10 remain unchecked until the real
  process-restart and multi-node proofs exist; this ADR does not claim them.
- The roadmap's section 6 items keep their order: locator and placement first, call semantics
  second, WASM placement later.

## Rejected

- **Teaching the importer or the personality where an object lives.** M6 succeeds precisely when
  they do not know; the prohibition ledger already forbids it.
- **An Images-owned transport or node registry.** A second distribution system beside Lagrange's
  routing, replication and membership; every failure mode Lagrange already owns would be reowned.
- **Per-object placement before whole-image residency works.** It would need a residency
  representation on every record before the simplest residency has a proof.
- **Making residency part of identity** (a node-qualified ref). Identity is stable across
  location by invariant; a ref that changes when a record moves would break every stored edge.

## Revisit when

- Lagrange exposes a way to route an Images record request to the node holding it; then the
  shared-server form is replaced by real cross-node resolution under the same interaction owner.
- A real workload needs an object placed apart from its image; then per-object residency gets its
  own decision, with the whole-image form as the measured baseline.
