# ADR 0092: Object residency, placement and remote resolution are generic Images owners over Lagrange routing

Status: accepted — M6.3 implements the whole-image/shared-server baseline; per-object residency, routed cross-backend resolution and placement remain deferred

**Decides WHERE the generic owners M6 needs live and WHAT each may own, before any of them is
built.** ADR 0085 M6 asks whether the exact M5 application runs unchanged when its ordinary objects
are placed across Lagrange nodes, with no placement or routing logic in the application, the Cuis
importer or the Cuis personality. The M6.1 census (bead `lagrange-images-0pxf.2`) found that
residency and placement have no owner at all and that resolution, routing and execution placement
have single-node owners only. The M6.2 witness (bead `lagrange-images-0pxf.3`,
`test/cuis-life-m6-two-node-red.test.js`) then measured the refusals those gaps produce. This ADR
builds nothing; it fixes the boundary so that the first repair cannot become a second distribution
system inside Images.

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
generic owner, the **object locator** (planned locus `src/graph/locator.js`). It answers, for a
ref, where the record can be read and written. Identity `(imageId, objectId)` is unchanged by
residency; a moved record is the same record.

The first form of residency is **whole-image**: an image resides where its backend session does.
That is exactly what the M6.2 refusals describe ("image not found" is a residency answer given by
accident), so the first owner makes the accidental answer explicit rather than inventing a finer
one. Per-object residency is deferred until whole-image residency is green across two nodes.

### 2. Placement is a separate generic owner, never consulted by a language

**Placement policy** decides where a NEW record is created and when, if ever, a record moves. It
is a generic owner (planned; its locus is decided with the first placement that is not "the image
it belongs to"). Placement is never an argument of a send, a slot, a Value, a class or an import;
language personalities and importers cannot observe it. If a feature seems to need the Cuis
importer to know where a class will live, the boundary is wrong.

Residency and placement are two owners on purpose: one answers "where is it", the other "where
should it be"; the M6.5 restart falsifier records them separately because objects moving is not
identity loss.

### 3. Remote resolution is an interaction owner over Lagrange routing, and Images never owns transport

The arrow **Images runtime -> record resolution outside that execution instance** has one owner:
**remote resolution**. M6.3 implements its lowest transport-free form in
`src/graph/remote-resolution.js`: an ObjectRef plus an opaque locator-issued residency token is
resolved through the backend session selected by the locator. With two Images runtimes attached
to one real Lagrange server, each runtime has its own application-session adapter while Lagrange
remains the only owner of database routing. When a later proof crosses separately composed
Lagrange backends, this same interaction owner must also own classified transport/error mapping,
read idempotency and the rule that authority is re-checked at the resolving node and never carried.

Images does **not** implement transport, membership, replication or consensus. Those are Lagrange's
(ADR 0033's placement of the durable backend below Images stands). An Images-side RPC, gossip or
"node registry" would be a second distribution system and is rejected. If Lagrange cannot yet route
an Images record request, the first green vertical uses the lowest form that needs no new transport:
**two Images runtimes over ONE shared real Lagrange server**, where residency is shared durability
and "remote" is a different runtime process reading the same partitioned store. Placement across
separately composed backends waits for Lagrange routing of Images' requests.

### 4. Execution placement is deferred

Where a send RUNS is a later, measured question (roadmap section 6, "compute-near-object"). The
first M6 vertical proves residency and remote resolution only; a send still executes on the runtime
that received it and resolves its receiver's record remotely. Nothing here decides Lagrange WASM
placement.

### 5. Ownership map and proof discipline

`docs/ownership.md` keeps three distinct rows. M6.3 promotes the object locator and the
shared-server remote-resolution interaction to **current**, each with a proof list; placement
policy remains **planned**. A row may not become current without a falsifier.

The original M6.2 witness remains the falsifier for the **next** distribution step: it uses two
separately composed durable backends and raw evidence relocation of one `cells` record. M6.3
does not flip that witness, because doing so would require per-object residency plus a request
route across those separate backends — both are explicitly deferred above. Instead the first green
vertical reuses the exact unchanged M5 Life workload in
`fixtures/real-lagrange-m6-shared-server-process.js`: runtime B installs and creates S0, runtime A
opens a separate application session on the same caller-owned real Lagrange server, resolves the
same ObjectRefs and executes unchanged `nextState`, and runtime B observes S1. Both runtimes stay
provider-free. A repair that teaches Life, the importer or the language personality about
placement/routing, duplicates identity, or adds an Images transport is still a failed repair.

## Consequences

- M6.3 establishes the fixed baseline: whole-image residency in the locator, the shared-server
  form of remote resolution, the unchanged Life workload green across two Images runtimes, and
  ownership rows promoted or kept planned honestly. The separately composed-backend M6.2 RED stays
  red until a later per-object/routed-resolution decision owns that stronger shape.
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
