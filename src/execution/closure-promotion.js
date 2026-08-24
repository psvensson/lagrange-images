import {ensureBlock, ensureLexicalEnvironment, ensureObject} from '../graph/ensure-records.js';
import {objectRef} from '../value/index.js';
import {TRANSIENT_ID_PREFIX, isTransientRef} from '../value/transient-ref.js';
import {ExpiredClosureInstanceError} from './lexical-cells.js';

// ADR 0052 decision 7a: promotion is ONE operation, not a habit.
//
// Every escape boundary — root return, slot and indexed writes, Dictionary writes, the foreign
// boundary — calls this and nothing else. Four implementations of a rule this subtle would disagree,
// and the disagreement would surface as a closure that is sometimes shared and sometimes duplicated.
//
// The ordering below is the whole design, so it is worth reading as a sequence:
//
//   discover a transient instance
//     -> compute its durable id
//     -> memoize transient -> durable *immediately*, before recursing
//     -> recursively promote snapshot-captured transient refs
//     -> write the environment (exact-or-create)
//     -> write the Block (exact-or-create)
//
// The early memo is what makes sharing and cycles terminate: a closure reached twice is answered
// from the memo the second time, and a cycle meets its own entry rather than recursing forever. The
// preassigned durable ref is what lets another environment name this closure before its Block record
// exists — which is legal because `putLexicalEnvironment` validates the parent edge only and does
// not require binding refs to resolve, so no atomic write of a cycle is needed.
//
// But "identity reserved" and "records published" are different facts, and conflating them turns the
// very mechanism that breaks cycles into a way of reporting a failed promotion as a success: a retry
// would meet the leftover entry and answer a durable ref whose Block was never written. The memo
// therefore has three effective states:
//
//   absent        begin promotion
//   in-progress   answer the preassigned ref, so recursion and cycles terminate
//   complete      answer the promoted ref; the records exist
//
// A failure clears the in-progress entry, so a later call re-runs publication rather than trusting
// a reservation nobody honoured. Exact-or-create is what makes that safe after a commit-then-lost-
// ack: the retry rediscovers its own committed records and converges on them.

// Deterministic, and derived from the transient id — which already carries a per-arena nonce, so two
// executions cannot collide and a retry within one execution recomputes the same id. That is what
// makes a lost acknowledgement converge instead of promoting one closure under two identities.
//
// The transient id embeds the arena's mint kind as its first segment (`block`, `environment`,
// `object`). Closures keep the historical `closure/` prefix so a pre-ADR-0060 promoted closure's
// derived id is unchanged; objects derive under `object/`. The kind segment is consumed, not
// carried into the durable id.
function durableIdFor(transientObjectId) {
  const suffix = transientObjectId.slice(TRANSIENT_ID_PREFIX.length);
  if (suffix.startsWith('object/')) return `object/${suffix.slice('object/'.length)}`;
  return `closure/${suffix}`;
}

// Snapshot bindings only. A `{cell: true}` binding carries no value by construction, so there is
// nothing here to read — and that is deliberate rather than incidental: ADR 0043 keeps cell contents
// out of the durable record, and letting promotion see them would make transient state decide what
// persists. What is traversed is what is written.
function promotedBinding(binding) {
  if (binding?.cell === true) return {name: binding.name, cell: true};
  return {name: binding.name, unbound: true};
}

class ClosurePromoter {
  #images;
  #arena;
  #memo;

  constructor(images, arena) {
    this.#images = images;
    this.#arena = arena;
    // Per arena, so promotion is idempotent for the whole execution: a closure written into two
    // slots is one closure, in the second slot as much as the first.
    this.#memo = arena.promotionMemo();
  }

  // Rewrites a Value that may itself be, or contain, a transient reference. Returns a plain Value
  // when there is nothing transient about it, which is the overwhelmingly common case.
  async promoteValue(value) {
    if (!isTransientRef(value)) return value;
    return await this.promote(value);
  }

  async promote(ref) {
    const key = [ref.imageId, ref.objectId];
    // Both `in-progress` and `complete` answer the same ref: the first is what closes a cycle, the
    // second is what makes promotion idempotent. Only `absent` starts work.
    const existing = this.#memo.get(key);
    if (existing) return existing.ref;

    const record = this.#arena.transientRecord(ref.imageId, ref.objectId);
    if (!record) throw new ExpiredClosureInstanceError(ref.imageId, ref.objectId);

    const durable = objectRef(ref.imageId, durableIdFor(ref.objectId));
    // Reserved before any recursion. Everything below may reach this same instance again.
    this.#memo.set(key, {ref: durable, status: 'in-progress'});
    try {
      if (record.kind === 'block') {
        const environment = await this.#promoteEnvironment(ref.imageId, record.environment);
        await ensureBlock(this.#images, ref.imageId, {
          id: durable.objectId,
          code: record.code,
          environment,
          metadata: {...record.metadata},
        });
      } else if (record.kind === 'object') {
        await this.#promoteObjectRecord(ref, durable.objectId);
      } else {
        throw new TypeError(`only a closure instance or an object can be promoted: ${ref.imageId}/${ref.objectId}`);
      }
      this.#memo.set(key, {ref: durable, status: 'complete'});
      return durable;
    } catch (error) {
      // A reservation nobody honoured must not survive as an answer. Dropping it costs only the
      // work of re-running an exact-or-create publication, which converges whether the failed
      // attempt wrote nothing or wrote everything and lost the acknowledgement.
      this.#memo.delete(key);
      throw error;
    }
  }

  // ADR 0060 decision 5. The durable projection is the object's slots and indexed part, recursively
  // through transient refs only: what is traversed is what is written. A durable ref reachable from
  // the object is an edge to an existing durable record and is written as an edge, not re-published.
  // The preassigned durable ref (reserved in `promote` before this runs) is what lets a cycle name
  // this object before its record exists, so the traversal terminates on shared structure and on
  // cycles through the memo.
  //
  // The record is re-read from the arena *at write time*, not carried from the caller. Promotion of
  // a cyclic graph suspends inside a nested `promoteValue`, and Smalltalk code runs while a cycle is
  // still in-progress (`initialize`, slot writes) — so the object can be mutated between reservation
  // and publication. Writing the stale snapshot would silently drop the mutation that closed the
  // cycle (a link written *after* its target was reserved). The arena holds the live state; the
  // write publishes it as it stands when the holder's own promotion completes.
  async #promoteObjectRecord(ref, durableObjectId) {
    const record = this.#arena.transientRecord(ref.imageId, ref.objectId);
    if (!record) throw new ExpiredClosureInstanceError(ref.imageId, ref.objectId);
    const slots = {};
    for (const [slotId, value] of Object.entries(record.slots)) {
      slots[slotId] = await this.promoteValue(value);
    }
    const desired = {
      id: durableObjectId,
      shape: record.shape,
      behavior: record.behavior,
      slots,
      ...(Object.hasOwn(record, 'indexed')
        ? {indexed: await Promise.all(record.indexed.map((value) => this.promoteValue(value)))}
        : {}),
      metadata: {...record.metadata},
    };
    await ensureObject(this.#images, ref.imageId, desired);
  }

  async #promoteEnvironment(imageId, environmentRef) {
    if (!environmentRef) return null;
    // An instance may close over an environment that is already durable — a prototype's, say — in
    // which case there is nothing to promote and the edge stands as it is.
    if (!isTransientRef(environmentRef)) return environmentRef;

    const record = this.#arena.transientRecord(environmentRef.imageId, environmentRef.objectId);
    if (!record) throw new ExpiredClosureInstanceError(environmentRef.imageId, environmentRef.objectId);

    const bindings = {};
    for (const [bindingId, binding] of Object.entries(record.bindings)) {
      bindings[bindingId] = binding?.cell === true || binding?.unbound === true
        ? promotedBinding(binding)
        : {name: binding.name, value: await this.promoteValue(binding.value)};
    }

    const parent = await this.#promoteEnvironment(imageId, record.parent);
    const id = durableIdFor(environmentRef.objectId);
    await ensureLexicalEnvironment(this.#images, environmentRef.imageId, {
      id,
      ...(parent ? {parent} : {}),
      bindings,
    });
    return objectRef(environmentRef.imageId, id);
  }
}

// The single entry point every boundary uses.
async function promoteClosure(images, arena, value) {
  if (!arena || !isTransientRef(value)) return value;
  return await new ClosurePromoter(images, arena).promoteValue(value);
}

export {ClosurePromoter, durableIdFor, promoteClosure};
