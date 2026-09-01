# ADR 0074: portable graph bundle contract — a design investigation

Status: accepted — investigation outcome; **decision-only, nothing implemented here**

**Decides the smallest generic, language-neutral contract that turns one or more durable graph
roots into portable, deterministic material — preserving cycles and shared identity, never
mistaking Image-local `ObjectRef` identity for portable identity — so that Project release
materializers (and later a target-Image importer) have one owner for transitive graph material.
This ADR builds **no** exporter, importer, bundle writer, or authorized lane. It names owners and
freezes the semantic rules so the first implementation slice cannot drift.**

The motivating gap: `captureCurrentProjectRelease -> materializeRecord({member, source, record})`
(PR #159/#160) is deliberately **direct-record-only**. A representation whose portable/material
identity depends on a transitive closure (an object with a Shape and child objects, a Block with
its CodeArtifact and LexicalEnvironment chain, a CodeArtifact dependency graph) cannot be captured
truthfully by a single record. ADR 0073 already assigns `{representation, contentIdentity}` to the
representation/materializer owner and forbids the Project coordinator from becoming a graph
exporter. This ADR defines the generic substrate materializer such an owner can build on.

## Owners (single-owner principle)

| Concern | Owner | Rationale |
|---|---|---|
| **Portable graph bundle semantics** (closure, bundle-local identity, external-ref rule, canonical form, content identity) | **Graph bundle model — a NEW module under the image/object layer, `src/graph/bundle.js`** | The semantics are exactly the language-neutral graph semantics of `src/graph/references.js` (which owns edge enumeration) and `src/object/`/`src/execution/` (which own record payloads). One owner; NOT split across Project, CodeArtifact, language personalities, or import code. |
| **Interaction: durable records → portable bundle (export)** | The **same graph bundle model**, reading through `GraphImageService` | `GraphImageService` keeps owning record read/storage. The bundle owner consumes `getRecord`/`referencesOfRecord`; it never duplicates graph storage or invents a second traversal. |
| **Interaction: portable bundle → target Image records (import)** | The **same graph bundle model**, writing through `GraphImageService.putObjects`/the ADR 0067 atomic batch | One owner for both directions of the translation so the identity/closure rules cannot diverge. Import is a **later slice**; this ADR only proves the format is importable. |
| **Project release semantics** | `src/project/model.js` + release-capture coordinator (unchanged) | The Project layer keeps owning release/manifest/frontier semantics and stays **not** the exporter. A graph materializer is a *representation owner* that the coordinator calls, exactly as today. |
| **Authorized public export lane** | A future binding executor (separate ADR) | The generic graph materializer is initially an **unguarded host-level substrate function** like the current release-capture internals. An authorized lane is designed only after these semantics exist (question G). |

`src/graph/references.js::referencesOfRecord` remains the single owner of "which references a
record has." The bundle owner **consumes** it; it must not re-implement per-kind traversal (a
guardrail). If a new record kind appears, `referencesOfRecord` is the one place that learns its
edges — the bundle closure inherits that for free.

## A. Closure — which edges participate

The closure is the **reflexive-transitive reachability under `referencesOfRecord`, starting from
the explicit roots**. This is derived from existing reference semantics, not invented:

- **generic Object** (`src/object/model.js`): `shape` ref, optional `behavior` ref, every ref in
  `slots` Values, every ref in `indexed` Values (ADR 0047: indexed Values are as much graph as
  named slots).
- **Shape**: no outgoing refs (`referencesOfRecord` returns `[]`) — a Shape is a closure leaf.
- **CodeArtifact** (`src/execution/model.js`): refs inside `content` (a canonical Value),
  `dependencies[].artifact`, `derivedFrom[]`.
- **LexicalEnvironment**: `parent` ref, refs inside each `bindings[id].value`.
- **Block**: `code` ref, optional `environment` ref.

**The decisive rule — every ref `referencesOfRecord` returns participates in the closure
automatically.** There is no per-kind traversal and no "some refs are special" inside the walk.
The ONLY distinctions the bundle makes are per-ref, at encode time (question C), never per-record-kind.

Why this is safe: ADR 0002 forbids refs in `metadata` ("graph relationships must remain explicit so
reachability cannot be hidden"), so `metadata`/`updatedAt` are **never** graph edges — they are
payload/provenance, exactly the fields question E excludes from identity. Provenance fields like
CodeArtifact `derivedFrom` DO appear in `referencesOfRecord`, so they are closure edges; whether a
specific `derivedFrom` target is bundled-internal or declared-external is a **per-root policy the
caller states**, not a property the exporter infers (question C).

## B. Identity — bundle-local, never source ObjectRef

A portable bundle is:

```text
{
  format: 'lagrange-graph-bundle/v1',
  roots:   { <rootKey>: <localId>, ... },          // semantic root keys -> bundle-local ids
  records: { <localId>: <canonicalRecordPayload>, ... },
  externals: { <externalKey>: <externalRef>, ... } // declared external references (question C)
}
```

- **`<localId>`** is a bundle-local identity assigned by a deterministic traversal (canonical BFS
  order from canonically-ordered roots; ties broken by canonical ref order). It is **not** the
  source `(imageId, objectId)`. Two names for the same source record resolve to **one** `<localId>`
  (aliasing preserved); cycles terminate because a record is assigned its `<localId>` on first
  visit and re-emitted as a ref thereafter.
- **Edges** inside `records` payloads are encoded as `{kind:'local-ref', localId}` for bundled
  targets and `{kind:'external-ref', externalKey}` for declared externals (question C). Source
  ObjectRefs never appear as edge identity.
- **Source `(imageId, objectId)` MAY be recorded as non-semantic provenance** (a separate,
  clearly-labeled provenance block) if a caller wants traceability — but it is **excluded from
  content identity** (question E) and an importer must **never** mint target ids from it. Fresh
  target ObjectRefs are always server-minted (ADR 0046 §6, ADR 0067).
- **Project member keys are NOT used as generic graph identity.** A Project materializer may use
  its own member key as a *root key* when it calls the bundle owner, but that is the materializer's
  choice of root label, not a bundle-identity rule. Root keys are arbitrary caller-chosen semantic
  labels.

## C. External vs internal references — one explicit per-ref rule

This is the sharpest question, and it gets **one explicit representation, not importer/exporter
heuristics**. When the closure walk reaches a ref, the target is classified into exactly one of:

1. **bundled internal** — the target is reachable and included; the edge is a `local-ref`.
2. **declared external** — the target is deliberately NOT bundled; the edge becomes an
   `external-ref` naming an `externalKey`, and the bundle records the external target's
   *identity requirement* (see below) so an importer can resolve it.
3. **illegal / unavailable** — the source record is missing or the caller's policy forbids
   crossing it; export **fails explicitly** (never silently drops, never silently chases).

**The boundary is a caller-supplied policy, evaluated per-ref, with a strict default.** The default
policy is:

- **ObjectRef (unpinned) to a record in the SAME closure reachable within the declared root set:**
  internal. The walk crosses it and bundles it.
- **Cross-Image ObjectRef:** *not* chased silently forever. The default policy treats a cross-Image
  ref as **declared external** unless the caller explicitly opts it into the closure. This is the
  "do not silently chase every cross-Image ref forever" guardrail, encoded as a default rather than
  a heuristic.
- **pinned-ref:** **always external by construction.** A pinned ref names `(imageId, objectId,
  revision)` — a *historical* position, not evolving identity (ADR 0002). Bundling the "current"
  record it points at would falsify the pin. A pinned ref is therefore encoded as an `external-ref`
  whose external descriptor carries the full pin, and the closure never crosses it.
- **missing target:** export fails (illegal/unavailable), matching the release-capture rule that a
  genuinely missing source is an explicit error, never an omission.

An **external descriptor** records what an importer needs to resolve the requirement WITHOUT
bundling it: for a cross-Image ObjectRef, the stable `(imageId, objectId)` *as an external
requirement* (the target Image is expected to resolve or already contain it); for a pinned ref, the
full `(imageId, objectId, revision)`. Externals are **requirements/inputs to import**, never
material the bundle claims to contain.

## D. Shapes and behaviors — the generic rule

**The generic rule: whatever `referencesOfRecord` returns is in the closure, and a Shape/Behavior
is an ordinary record in the closure like any other.** A copied Object whose Shape/Behavior is not
available is not a truthful portable object — you cannot interpret its slots without the Shape, nor
its behavior without the behavior record. So the **default** is: Shape and behavior refs are
bundled-internal (they are same-closure records).

**The representation-policy override is narrow and explicit:** a caller may declare a *well-known*
Shape/behavior (e.g. a kernel/canonical structure the target is guaranteed to already hold) as
**declared external**, so it is referenced as a requirement rather than duplicated. That is a
per-root caller decision using the SAME external mechanism as question C — never a special case the
exporter hard-codes for "Shape" or "kernel". The bundle owner does not know what a kernel is.

## E. Determinism / content identity

The bundle has a host-independent canonical form, and its `contentIdentity` is derived from it:

- **Canonical record ordering:** `records` keyed by `<localId>` assigned in canonical BFS order;
  emitted in that order.
- **Canonical key ordering:** all maps (`roots`, `records`, `externals`, slot maps, binding maps)
  emitted in host-independent code-unit key order — the same ordering rule ADR 0073 already uses
  for release manifests.
- **Canonical Value encoding:** the existing canonical Value form (ADR 0002: tagged Values,
  canonical decimal integers, hex float64 bits, canonical base64 bytes). No new Value codec.
- **Excluded from identity:** `metadata`, `updatedAt`, source `(imageId, objectId)` provenance, and
  any frontier/revision. These are provenance/payload annotations, not semantic material. A record
  payload that differs ONLY in `metadata`/`updatedAt` has the **same** content identity.
- **`contentIdentity` is SHA-256 over the canonical bundle bytes** (roots + records + externals,
  post-exclusion), using the **existing** provider seam (`src/support/crypto-provider.js`) and the
  **existing** portable byte machinery (`src/support/portable-bytes.js`). **No new generic binary
  codec is invented** merely because PR #161 added portable-bytes; the canonical form is a
  canonical JSON byte encoding hashed once, exactly as the Project release identity already is.

**Reuse, don't duplicate:** the bundle owner uses `referencesOfRecord` (edges), the canonical Value
machinery (payloads), the crypto provider (SHA-256), and portable-bytes (encoding). It contributes
ONLY: closure walk, local-id assignment, external classification, canonical assembly, hash.

## F. Frontier relationship — stability stays OUTSIDE the bundle

The bundle algorithm reads current records and has **no** frontier concept. Current-state stability
remains the capture coordinator's bracket, exactly as PR #159 proved for direct records:

```text
capture coordinator:  frontier-before  ->  graph materializer reads closure  ->  frontier-after  ->  accept/refuse
```

Image frontier does **not** enter bundle identity. The same semantic/material graph read at a
different (later, unrelated) stable frontier yields the **same** `contentIdentity`; the frontier
belongs in **provenance** (ADR 0073's `sourceFrontiers`), which is separate data. This is precisely
the identity-vs-provenance invariant PR #159 already proved for direct records, now generalized to
closures. A *meaningful* change to the graph material (a field, an edge, a bundled record) changes
`contentIdentity`; an unrelated write elsewhere in the source Image does not.

## G. Authority — never in the bundle

Bundles contain **no** grants, principals, capabilities, or authority hints. Reachability is **not**
authority: being in a closure does not grant anything, and authority is never inferred from the
bundle. The generic graph materializer is, initially, an **unguarded host-level substrate function**
(like the current release-capture internals) — the trusted host calls it directly. An **authorized
public export lane** is a separate interaction owner (a future binding executor with its own
`require` policy), designed only after these generic semantics exist and proven. Nothing here
decides that lane's authority model.

## H. Import — proven importable, implemented in a later slice

The format is designed so a target-Image importer can be built on the **existing ADR 0067 atomic
creation batch** rather than a second multi-object creation path:

- **local-id → fresh ObjectRef mapping:** the importer walks `records` in canonical order and, for
  each `<localId>`, mints a fresh server-side target id (ids are server-minted; the bundle's
  localIds and any source provenance are never reused as target identity). It builds a
  `localId -> freshObjectRef` map.
- **Cycles:** because edges are `local-ref`, the importer first *reserves/mints* a fresh id for
  every `<localId>` (so every edge target has a known fresh ref), then writes payloads with edges
  rewritten through the map. ADR 0067's transaction-local fresh-object provenance already justifies
  intra-batch edges to freshly created objects, which is exactly what a cycle needs.
- **Creation order / staging:** Shapes before the objects that reference them is satisfied by
  canonical BFS order from roots (a record's Shape is reached no later than the record); the
  two-phase mint-then-write makes ordering non-load-bearing for correctness anyway.
- **Atomicity:** one ADR 0067 batch / `putObjects` commit — all records or none (insert-only,
  `expectedVersion: 0`, CAS retry). No partial import.
- **External resolution:** each `external-ref` is resolved by the caller against the target
  environment (already-present well-known record, or an explicit provided mapping) BEFORE the batch
  is written; an unresolvable external fails the import explicitly.
- **Collision / replay / idempotency:** a fresh import always mints new ids, so there is no id
  collision with existing target records. Re-importing the same bundle yields a **new, aliasing-
  preserved copy** (new ids), not an overwrite; reconciliation/dedup against an existing target is
  installation-layer policy (ADR 0073), not bundle-import semantics.

This ADR does **not** implement the importer. It records that the export format carries everything
the ADR 0067 machinery needs, so import is a following slice, not a redesign.

## Adversarial examples — concrete answers

1. **One ordinary object + Shape.** Closure = object + its Shape (Shape is a leaf). Two records;
   the object's `shape` edge is a `local-ref`; slots hold no refs. Deterministic; importable as two
   fresh records.
2. **Two objects sharing one child.** Both parents' slot refs reach the same child record → the
   child gets ONE `<localId>`; both parents emit a `local-ref` to it. Sharing preserved on import
   (both fresh parents point at the one fresh child).
3. **A cycle A → B → A.** A assigned `localId` 0, B `localId` 1; B's ref back to A is a `local-ref`
   to the already-assigned 0 — traversal terminates. Import mint-then-write resolves the cycle.
4. **Block → CodeArtifact + LexicalEnvironment.** Block's `code` and `environment` edges are
   internal; the LexicalEnvironment's `parent` chain and binding-Value refs are walked the same
   way. One closure; behavior-bearing records included.
5. **CodeArtifact dependency graph.** `dependencies[].artifact` and `derivedFrom[]` are closure
   edges; each is bundled-internal (same closure) or declared-external per caller policy. `content`
   refs are walked via `referencesOfValue`.
6. **One root pointing twice to the same record.** Both occurrences resolve to one `<localId>`;
   one record in `records`, two `local-ref` edges.
7. **Cross-Image internal dependency.** Default policy: cross-Image ObjectRef is **declared
   external** (not chased) unless the caller explicitly opts it in. If opted in, it is bundled like
   any internal record; its source Image id is provenance, never target identity.
8. **Explicit external dependency.** Caller declares it external; the edge becomes an
   `external-ref` + external descriptor; import resolves it against the target environment.
9. **Pinned ref.** Always external-by-construction; the full `(imageId, objectId, revision)` is the
   external descriptor; the closure never crosses it.
10. **Same semantic graph, different source ObjectIds.** Identical `contentIdentity` — source
    ObjectIds are excluded provenance. (Proves ObjectRef is not portable identity.)
11. **Same semantic graph at a later unrelated frontier.** Identical `contentIdentity`; different
    provenance frontier. (Generalizes the PR #159 invariant.)
12. **One meaningful field change.** A changed slot Value / edge / bundled record changes the
    canonical bytes → different SHA-256 → different `contentIdentity`.

## What this ADR does NOT decide / guardrails honored

- No Project-owned serialization; no Project-specific bundle; no per-kind serializers;
  `referencesOfRecord` stays the single edge owner; no source-ObjectRef-as-identity; no
  flatten-refs-to-strings; no authority-from-reachability; reachability is not Project membership;
  no Git/filesystem concepts; no historical/as-of reads; no GC/retention; no CodeArtifact-only fix.

## Recommended FIRST implementation slice

The investigation supports the candidate the task named, with one clarification:

> **One-root (and multi-root) generic graph bundle → ordinary durable records → cycles + shared
> refs → deterministic canonical identity → EXPORT ONLY.**

External-reference and import **policy is represented in the format now** (the `externals` block
and the per-ref internal/external rule), but the **importer itself is the following slice**. The
first slice lands `src/graph/bundle.js` (the model owner) plus the export interaction through
`GraphImageService`, with the adversarial examples as its acceptance tests and the cross-frontier /
cross-ObjectId identity invariants as falsifiable proofs. A Project release materializer that needs
transitive material then becomes a *representation owner* calling this bundle owner — the Project
coordinator remains a non-exporter.

**Clarification on root count:** the contract is defined for *one or more* roots (the `roots` map),
because a CodeArtifact dependency graph and a Block+environment are naturally multi-root; the first
slice may implement the single-root path and the shared/multi-root path together since they share
the closure walk, but it should NOT defer cycles/shared-refs — those are the point.
