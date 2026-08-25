# ADR 0067: authorized atomic image-local creation batch — a design investigation

Status: implemented
Proven by: test/atomic-creation-batch.test.js

**Adopted and implemented.** The investigation concluded that transaction-local *fresh-object
provenance* — not "transaction authority" — cleanly justifies intra-batch edges to freshly created
objects, with no grant-algebra change, no capability, and no executor widening. The narrow contract
is an **authorized atomic creation batch**, not a general multi-object transaction system. The lane
is `image-creation-batch-binding/v1` (multi-class: each member carries its own `class`, with a
per-class `object/create` require), committed atomically via `images.putObjects` (one
`backend.transaction`, insert-only `expectedVersion: 0`, CAS retry).

## Problem

The motivating operation is the environment's Perspective save (`savePerspective`, env PR #15): create
`N` child Presentation objects **and** one Perspective that references them, publishing all `N+1`
records plus their history **atomically, or none**. Today the shipped creation lane (ADR 0062) and the
indexed/mutation lanes (ADR 0064, ADR 0065) write **one object per backend transaction**, so the
composition is `N+1` separate commits. That has two demonstrated costs (ADR 0064 §6, ADR 0066):

1. **Non-atomicity / orphan children.** A failure between child creation and the Perspective write
   leaves children on the change feed with no parent — mitigated only by treating the Perspective as
   the commit point downstream, which is an application-level apology for a substrate gap.
2. **Authority re-issuance between stages.** Because the children's durable ids are server-minted and
   unknowable before creation, the caller cannot pre-hold `object/edge-write` on them, so a staged
   control-plane `authorityProvider` must re-issue grants once ids exist (the pressure ADR 0066
   evaluated and declined to solve with a capability).

ADR 0066 revisit condition 3 said a multi-record transaction lane would subsume the composition. ADR
0062 §8 deferred "multi-object transactions" on the specific open question of *authority across a
transaction boundary*. This ADR investigates a deliberately **narrower** shape that may dissolve that
question rather than answer it.

## The invariant under tension

ADR 0037's root model is unchanged and load-bearing here:

- `issue` is the only authority root, held by the trusted host/control plane (§1, §5);
- an executor gets a **check-only** `require` — never the authority and never a grant (§2) — and
  `attenuate` only narrows, so no executor ever widens (§5, §6);
- grants are **exact-match** — no wildcards (§6);
- authority is transient execution context, **never program data** — it cannot be a Value, a durable
  identity, or a bearer token (§1, §11; reaffirmed by ADR 0066 Option 3).

The existing edge rule (ADR 0042, ADR 0062) is: writing an edge **to** object `T` requires
`object/edge-write(T)`. For an intra-batch edge to a *freshly created* object, `T`'s durable id does
not exist at authorize time, so a literal reading would force either pre-holding a grant on an
unknowable id (impossible — ids are server-minted, ADR 0046 §6) or a wildcard (forbidden, §6). The
question is whether a third reading exists that neither widens authority nor touches the grant
algebra.

## The investigated rule: transaction-local fresh-object provenance

The candidate rule, stated precisely:

```text
edge to an EXISTING object T          -> requires object/edge-write(T)   (unchanged)
edge to an object created in THIS     -> justified by the successful authorized
  SAME atomic batch                        creation of that fresh target IN THIS BATCH
```

The justification is **provenance inside one operation**, not authority over the target. The fresh
target has no pre-existing state to protect; the only authority-relevant question for it — "may this
caller create an instance of this class in this image?" — is answered by the `object/create` grant the
batch *already* requires for that class. Referencing the object one has *just been authorized to
create* is part of the same authorized act, not a second act needing a second grant.

**What the fresh-target rule is *not*:**

- **Not a capability.** Nothing is returned, stored, or reusable. The local name exists only for the
  duration of the batch call; after commit it denotes nothing.
- **Not a wildcard.** The rule does not generalize `object/edge-write` to "any id"; it applies only to
  targets the *same batch* creates, and is justified per-target by that creation, not by a broadened
  grant.
- **Not executor widening.** The lane calls the same check-only `require` for every grant it relies
  on (`object/create` per class, `object/edge-write` per existing target). It derives *no new grant*.
  The fresh-target edges are justified by provenance, a fact about the batch, not by any grant the
  lane manufactured.

## The contract

An image-local **authorized atomic creation batch**. The request carries an ordered list of create
specs; each may reference already-existing objects by durable ref **and** other batch members by a
**boundary-local symbolic name** that is not an `ObjectRef`, not a canonical Value, and not authority:

```text
batch create, within one image:
  create "a" as Presentation(subject = <existing-ref>, ...)   # local name "a"
  create "b" as Presentation(subject = <existing-ref>, ...)   # local name "b"
  create "p" as Perspective(subject = <existing-ref>,
                            presentations = [local:a, local:b])
```

The lane then, in order:

1. **Parse** all specs. Resolve each `local:name` to a not-yet-minted fresh member of *this* batch;
   reject any `local:` name with no matching member, and reject a `local:` name where an existing-ref
   is required (and vice-versa). Local names are request-syntax only.
2. **Authorize the whole batch before any write** (require-before-effect):
   - `require(object/create, <image>/<class>)` for **every** member's class;
   - `require(object/edge-write, objectResource(imageId, T))` for **every** edge whose target `T` is
     an **existing** object (e.g. each `.subject`);
   - intra-batch edges (`local:a`, `local:b`) require **no** grant — they are justified by step-2a's
     per-class create grant via provenance.
   If **any** `require` throws, the batch is denied **before the first durable write**.
3. **Mint durable ids** server-side for every member (the lane mints; `newObjectId`, ADR 0046 §6 —
   never a caller-supplied or local-name-derived id).
4. **Resolve** each `local:name` to its freshly minted durable id, building complete canonical slot
   records (the same slot/edge construction ADR 0062/0064 already perform, with pinned
   `ref@revision` resolution against the resolved id).
5. **Validate** every complete record (shape conformance, indexed-part rules, edge-target rules)
   before any write.
6. **Commit all `N` records + their `N` history events in one `backend.transaction`** — N
   `transaction.put(collection, id, record, {expectedVersion: 0})` plus N
   `transaction.append(history(imageId), event)`, all-or-none. Id-collision is handled by
   `expectedVersion: 0` insert-only semantics; on `VersionConflictError` the whole transaction aborts
   and the lane retries with freshly minted ids (bounded by `maxIdentityAttempts`, as ADR 0062).
7. **Return** the durable ids (and per-member version tokens, exactly as ADR 0062's chainable token)
   to the caller. **No local name, no authority, and no special capability escapes the call.**

After commit, every member is an **ordinary durable object**. Any future edge to it requires the
normal `object/edge-write(thatId)`; any future mutation requires the normal mutation authority (ADR
0042, ADR 0065). Nothing about the batch persists.

## What this is explicitly NOT (the anti-tarpit fence)

The name is "authorized atomic creation batch" precisely to exclude the questions "multi-object
transaction" invites. **Out of scope, each deferred to its own ADR if ever needed:**

- arbitrary **mutation of several existing** objects in one transaction;
- **deletes** and **edge removal** (ADR 0062 §8, with their GC/history/pinned semantics);
- **cross-image** or **distributed** transactions;
- **nested** transactions or a user-visible transaction object/rollback API;
- **effects / WASM calls** inside the transaction (side effects cannot be rolled back with state);
- **caller-selected durable ids** (server-mints only, ADR 0046 §6);
- a broad grant such as `transaction/execute on image X` — **the batch confers nothing**; it is an
  atomicity envelope over individually-authorized creates, not a grant.

Authority remains **operation-by-operation**: each `object/create` and each `object/edge-write` on an
existing target is a normal exact-match requirement. The one exceptional-*looking* case — an edge to a
fresh batch member — is justified by the batch's own creation provenance, not by any new general
grant. If a second consumer later needs "create A + mutate existing B + delete C," that is a
generalization **from a proven atomic batch**, decided then, not now.

## The five things this ADR must establish

### 1. Fresh-target rule — why in-batch creation justifies the edge, without `object/edge-write` on an unknowable id

`object/edge-write(T)` protects `T`'s referential boundary from being named by someone with no
business naming it. For a fresh target, there is **no prior boundary to protect** — the object does
not exist until this batch creates it, and it is created *by* this caller under an `object/create`
grant for its class. The authority question "may this caller bring this object into existence?" is
fully answered by that create grant. Constructing an edge to it within the same authorized act adds no
new exposure: the edge is to an object the caller was already authorized to create and now does. The
unknowable-id problem dissolves because the rule never names the id at authorize time — it names the
*batch member* (provenance), and the id is only minted after authorization (step 3).

Two binding invariants make this airtight rather than approximate:

- **Per-target binding.** Each `local:name` resolves to **exactly one** batch member, and the edge is
  justified by **that member's own** `object/create` grant — not by *any* create grant the batch
  happens to hold. A `local:` name may not alias two members, and a member may not be referenced as a
  justification for a class other than its own. (Otherwise the provenance could silently detach from
  the grant that authorized it.)
- **Justified only by a creation that was itself authorized.** An intra-batch edge is justified only
  by a member whose `object/create` require *passed* in step 2a. Because require-before-effect denies
  the whole batch the moment any member's create is denied, no edge is ever justified by a creation
  that did not (and will not) happen — the dual of the negative test below.

This is meaningfully different from ADR 0066's rejected created-object capability: that granted
**post-commit, reusable** authority over the new object (a bearer fact); this grants **none** — it
merely recognizes that "create X" already subsumes "reference X within the same act of creating it."

### 2. No widening — no post-commit authority over the fresh object is conferred

The lane calls `require` only with the standard operations and exact resources (per-class create,
per-existing-target edge-write). It never constructs, stores, or returns a grant. The local name is
request-syntax with no post-commit denotation. Therefore after commit the caller holds **exactly** the
grants it held before, plus durable objects; an edge to a now-existing member from a *later* call
still requires `object/edge-write(memberId)`. Induction over the grant table: the set of grants is
unchanged by the batch (the lane adds none), so any post-commit authority must already have existed
pre-batch — the batch conferred nothing. ∎

### 3. Require-before-effect — every grant is checked before the first durable write

Steps 2–5 (parse, authorize-all, mint, resolve, validate-all) perform **no durable effect**; the only
durable effect is step 6's single `backend.transaction`. Every `require` runs in step 2, strictly
before step 6. So a denial happens with **zero** records written and zero history appended.

One precision, not a soundness gap: validation (step 5) needs to **read** each member's instance Shape
record (the existing lane reads it via `images.getShape` *after* the `object/create` require, and
today `putObject` *re*-validates against the shape **inside** its transaction). A shape read is not a
side effect, so require-before-effect is untouched — and it stays **post-authorization** (the
`object/create` require precedes the shape fetch). The batch does, however, **relocate** the
shape-conformance validation from inside the transaction (where `putObject` does it today) to *before*
it (step 5). That is a deliberate, safe reordering — fail-fast before commit is strictly better than
fail-mid-transaction — and the batch widens the existing lane's "authorize before its one write" to
"authorize before its one atomic multi-write" while moving validation ahead of the commit point. The
record construction (slots/edges) still happens in step 4 exactly as ADR 0062/0064 build them.

### 4. Identity — all durable ids are server-minted; local names never become identity or Values

Step 3 mints ids via the lane's `newObjectId` (ADR 0046 §6), exactly as ADR 0062; a `local:` name is
resolved to a minted id and then discarded. Local names never appear in any record, history event, or
returned Value; they are not parseable as `ObjectRef`s. The durable identity contract (server-minted,
lost-ack-preserving via explicit candidate + `expectedVersion: 0` CAS retry) is unchanged — the batch
only mints *N* candidates instead of one.

### 5. Atomicity / failure — denial or failure produces no records and no history

- **Authorization denial** (any `require` throws): before step 6 → nothing written (per §3).
- **Validation failure** (any record malformed): step 5 is before step 6 → nothing written.
- **Collision exhaustion**: an id collision surfaces as `VersionConflictError` inside step 6's
  transaction, which **aborts the whole transaction** (ADR 0032: a failed optimistic version check
  aborts earlier operations in the same transaction); the lane retries with fresh ids, and after
  `maxIdentityAttempts` throws `ObjectCreationConflictError` having committed nothing.
- **Backend failure** mid-transaction: `backend.transaction` commits all callback operations or none
  (ADR 0032), so a crash leaves **no** partial member set and **no** partial history — the
  orphan-children failure mode of the 1+N composition is eliminated.

### The negative test (the falsification that the rule didn't leak)

```text
batch creates A
batch constructs an edge from A to EXISTING secret S
caller LACKS object/edge-write(S)
=> entire batch DENIED
=> A does not exist
=> no history event for A
```

This proves the fresh-target rule has **not** accidentally become "anything inside a batch may point
anywhere." The edge to `S` is an *existing-target* edge, so step 2b requires
`object/edge-write(objectResource(imageId, S))`; its absence throws in step 2, before any write, and
the atomicity property (§5) guarantees `A` and its history never appear. If an implementation instead
treated intra-batch edges as exempt from `require` *regardless of target freshness*, this test goes
red — which is precisely the leak it exists to catch. (Falsification: temporarily make the lane exempt
intra-batch edges from the per-target `require` **regardless of whether the target is fresh or
existing** — i.e. drop the fresh/existing distinction — and confirm this test goes red. Note that
*only* skipping the require for genuinely-fresh targets would not turn it red, because this test's
edge is to an existing object; the leak being probed is the exemption wrongly extending to existing
targets, not the fresh-target rule itself.)

## Why this is cleaner than the created-object capability (ADR 0066)

ADR 0066 kept staged authority because every *capability* variant violated the root model or the grant
algebra. This scheme violates neither: the local handle is **identity/provenance inside one
operation**, not reusable authority. It also removes the *atomicity* cost that a capability never
addressed — a capability authorizes follow-on operations but does not make N writes atomic; the batch
makes them atomic *and* removes the re-issuance, by construction. It is the composition ADR 0066
revisit condition 3 anticipated, in its narrowest form.

## Decision

**Adopt the authorized atomic creation batch as a lane to implement.** The fresh-target provenance
rule holds: it justifies intra-batch edges without touching the grant algebra, conferring no
post-commit authority, and requiring no capability, wildcard, or executor widening. Implement exactly
the narrow contract above.

**Stop conditions** (if any is hit during implementation, revert to staged workflow and reopen):

- the fresh-target rule turns out to require a persistent/reusable capability, authority widening, or
  a generic transaction language to express;
- require-before-effect cannot be maintained (e.g. some grant can only be checked after a write);
- the boundary-local name cannot be kept from leaking into a durable Value, history event, or returned
  token.

## Consequences

- The 1+N Perspective save becomes one atomic commit: **no orphan children**, and **no authority
  re-issuance** between child creation and Perspective creation — both demonstrated costs of ADR 0064
  §6 / ADR 0066 are removed at the substrate.
- ADR 0037's root model and ADR 0062/0064's lanes are **unchanged**; this is an additional lane, not a
  revision. Exact-match grants, check-only `require`, attenuate-only-narrows, server-minted ids all
  stand.
- The backend needs **no new capability**: `backend.transaction` already composes N
  `put`+`append` pairs atomically (ADR 0032). The substrate seam is a create-many executor that
  authorizes-all-then-commits-all in one transaction, where today's lane commits one-per-object.
- The broader questions stay deferred, each with its own ADR trigger: multi-object **mutation**
  transactions, **edge removal**, **deletes**, cross-image/distributed transactions, and any
  transaction-scoped grant form. This ADR resolves none of them.
- ADR 0066's conclusion is reaffirmed, not contradicted: no capability was adopted; the batch is the
  *atomicity* answer condition-3 pointed at, and it needs no capability.

## Guardrails

```text
authorized atomic creation batch: ADOPTED (image-local, create-only)
NOT a general multi-object transaction system; the name excludes mutation/deletes/cross-image/
  distributed/nested/effects/caller-ids and any transaction/execute broad grant
fresh-target rule: an edge to an object created in THIS batch is justified by that creation's
  object/create grant (provenance), needing no object/edge-write on its unknowable id
edge to an EXISTING object T still requires object/edge-write(T) — unchanged, exact-match
the batch confers NO grant and NO post-commit authority; local names are request-syntax only,
  never ObjectRefs / canonical Values / authority, and never leak past the call
authorize the WHOLE batch (every create + every existing-target edge) before the first durable write
server-mints all durable ids (ADR 0046 §6); insert-only via expectedVersion:0; CAS retry bounded by
  maxIdentityAttempts; collision/failure/validation/denial all abort the one backend.transaction,
  leaving no records and no history (ADR 0032 all-or-none)
negative test: an in-batch edge to an existing secret S without edge-write(S) denies the WHOLE batch
  and A never exists — proving the fresh-target rule did not become "point anywhere"
stop conditions: requires a capability / widening / generic transaction language, or breaks
  require-before-effect, or leaks a local name -> revert to staged workflow
```
