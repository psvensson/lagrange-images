import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_OBSERVATION_BINDING_V1,
  OBJECT_READ_OPERATION,
  createAuthorityService,
  createRuntime,
  installCallableInterfaceV2,
  installImageObservationBinding,
  installSmalltalkKernel,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  textValue,
  unpackCompositeValue,
} from '../src/runtime.js';

// ADR 0070. The authorized image-observation lane: a substrate-side FILTERED, METADATA-ONLY
// invalidation feed. The lane scans the image's private history internally and emits, for each
// object.put the caller may object/read, ONLY {objectId, kind, cursor} — never the record
// payload, never the raw global revision. The cursor is an opaque, integrity-protected token:
// tamper throws, and a valid older cursor is an idempotent resume. State disclosure stays in
// readObject (ADR 0068); an unreadable object's changes are indistinguishable from no-change.

const TYPES = normalizeTypeDeclarations({
  'obs-event': {
    kind: 'record',
    fields: [
      {name: 'object-id', type: 'string'},
      {name: 'kind', type: 'string'},
      {name: 'cursor', type: 'string'},
    ],
  },
  'obs-result': {
    kind: 'record',
    fields: [
      {name: 'events', type: {kind: 'list', element: 'obs-event'}},
      {name: 'cursor', type: 'string'},
    ],
  },
});

const readGrant = (id) => ({operation: OBJECT_READ_OPERATION, resource: objectResource('demo', id)});

async function seed({grants = null, objects = []} = {}) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority});
  await runtime.images.createImage({id: 'demo'});
  await installSmalltalkKernel({images: runtime.images, imageId: 'demo'});

  const shape = await runtime.images.putShape('demo', {
    id: 'item-shape',
    slots: [{id: 'slot-name', name: 'name'}],
  });

  for (const id of objects) {
    await runtime.images.putObject('demo', {
      id, shape: objectRef('demo', shape.id),
      slots: {'slot-name': textValue(`${id}-name`)},
    });
  }

  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'observe',
    functionName: 'observe', parameters: ['string'], result: 'obs-result', types: TYPES,
  });
  const binding = await installImageObservationBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', callableInterface.id),
    bindingId: 'observation', blockId: 'observation-block',
  });

  const context = grants === null ? null : authority.issue({principal: 'alice', grants});
  const options = () => (context === null ? {} : {authority: context});
  const observe = async (afterCursor = '') => {
    const activation = await runtime.invocations.invokeBlock(
      objectRef('demo', 'observation-block'), [textValue(afterCursor)],
    );
    const packed = await runtime.executor.execute(activation, options());
    return unpackCompositeValue(packed, 'obs-result', TYPES);
  };
  const mutate = async (id, count) => {
    const existing = await runtime.images.getObject('demo', id);
    await runtime.images.putObject('demo', {
      id, shape: objectRef('demo', shape.id),
      slots: {'slot-name': textValue(`${id}-v${count}`)},
      metadata: {count: integerValue(count)},
    }, {expectedVersion: existing._version});
  };
  return {runtime, authority, context, binding, observe, mutate, shape};
}

// Live-follow gives a caller a cursor at the current end without replaying the backlog, so a
// test that wants to observe subsequent writes first takes a live cursor and resumes from it.

// Case 1 — PETER'S CORE PROOF: caller has object/read(A) only. Mutate B then mutate A. The
// feed contains ONLY A: B's objectId never appears, B's state is nowhere in the result, and no
// raw revision number is exposed.
test("an unauthorized object's changes never appear: visible events only, no payload, no raw revision", async () => {
  const {runtime, observe, mutate} = await seed({grants: [readGrant('a')], objects: ['a', 'b']});
  try {
    const start = await observe('');
    await mutate('b', 1);
    await mutate('a', 1);

    const result = await observe(start.cursor);
    assert.equal(result.events.length, 1, 'exactly one visible event');
    assert.equal(result.events[0]['object-id'], 'a');
    assert.equal(result.events[0].kind, 'object.put');

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('"b"'), `B's objectId must not appear: ${serialized}`);
    assert.ok(!serialized.includes('b-v1'), `B's state must not appear: ${serialized}`);
    assert.ok(!serialized.includes('b-name'), `B's earlier state must not appear: ${serialized}`);
    assert.ok(!/\brevision\b/.test(serialized), `no revision field leaks: ${serialized}`);
    for (const token of [result.cursor, ...result.events.map(({cursor}) => cursor)]) {
      assert.ok(Number.isNaN(Number(token)), 'the cursor is not a bare number');
    }
  } finally {
    await runtime.close();
  }
});

// Case 2 — metadata-only: an emitted event carries objectId+kind+cursor and nothing else.
test('an emitted event is exactly {object-id, kind, cursor} — no slots/indexed/record/state', async () => {
  const {runtime, observe, mutate} = await seed({grants: [readGrant('a')], objects: ['a']});
  try {
    const start = await observe('');
    await mutate('a', 1);
    const result = await observe(start.cursor);
    assert.equal(result.events.length, 1);
    assert.deepEqual(Object.keys(result.events[0]).sort(), ['cursor', 'kind', 'object-id']);
    assert.deepEqual(Object.keys(result).sort(), ['cursor', 'events']);
    // Payload names must not appear as FIELD NAMES; `object-id`/`object.put` are identity+kind.
    for (const forbidden of ['"slots"', '"indexed"', '"record"', '"state"', '"object"', '"revision"', '"version"', '"objectVersion"']) {
      assert.ok(!JSON.stringify(result).includes(forbidden), `result must not carry field ${forbidden}`);
    }
  } finally {
    await runtime.close();
  }
});

// Case 3 — no gap leak: the cursor is opaque. It is not parseable as a number, does not equal
// String(revision), and its visible text carries no decimal the consumer could compare.
test('the cursor is opaque: not a number, not the raw revision, no gap analysis', async () => {
  const {runtime, observe, mutate} = await seed({grants: [readGrant('a')], objects: ['a', 'b']});
  try {
    const start = await observe('');
    await mutate('b', 1); // invisible write advances the global revision
    await mutate('a', 1);
    const history = await runtime.images.history('demo');
    const lastRevision = history[history.length - 1].revision;

    const result = await observe(start.cursor);
    assert.equal(result.events.length, 1);
    for (const token of [result.cursor, result.events[0].cursor]) {
      assert.match(token, /^obs-cursor\/v1:/);
      assert.ok(Number.isNaN(Number(token)), 'the cursor is not parseable as a number');
      assert.notEqual(token, String(lastRevision), 'the cursor is not the raw revision');
      // No plain readable decimal the consumer could compare: the token body is base64url, and
      // no maximal digit run in it decodes back to the raw revision it encodes.
      const body = token.slice('obs-cursor/v1:'.length);
      for (const run of body.match(/\d+/g) ?? []) {
        assert.notEqual(run, String(lastRevision), `token carries a readable revision: ${token}`);
      }
    }
    // The invisible B write sits between the start cursor and the visible A write in the global
    // sequence, yet NOTHING in the result marks it: the per-event cursor and the result cursor
    // are both the position after the A write (the last scanned event), and the tokens expose
    // no count and no gap. Invisible writes are indistinguishable from no-change.
    const historyAfter = await runtime.images.history('demo');
    assert.ok(historyAfter.some(({type, objectId}) => type === 'object.put' && objectId === 'b'),
      'sanity: the invisible write really is in the private stream');
  } finally {
    await runtime.close();
  }
});

// Case 4 — resume: observe(after-cursor=C1) returns only events after C1, and a valid older
// cursor resumes idempotently, re-emitting earlier visible events.
test('a cursor resumes after its point; a valid older cursor re-emits earlier visible events', async () => {
  const {runtime, observe, mutate} = await seed({grants: [readGrant('a')], objects: ['a']});
  try {
    const start = await observe('');
    await mutate('a', 1);
    const first = await observe(start.cursor);
    assert.equal(first.events.length, 1);

    await mutate('a', 2);
    const resumed = await observe(first.cursor);
    assert.equal(resumed.events.length, 1, 'only events after the cursor');
    assert.equal(resumed.events[0]['object-id'], 'a');
    assert.notEqual(resumed.cursor, first.cursor, 'the high-water mark advanced');

    const replayed = await observe(resumed.cursor);
    assert.equal(replayed.events.length, 0, 'no backlog replays at the high-water mark');
    // The cursor is FUNCTIONALLY stable when nothing changed: it decodes to the same position (no
    // events after it), even though the encrypted token is not byte-identical (a fresh IV per token
    // is what makes it opaque/non-comparable — byte-stability is not required, only resume-stability).
    assert.equal((await observe(replayed.cursor)).events.length, 0, 'the cursor resumes at the same position');

    // Rollback-safe: a valid older cursor is an idempotent resume, not an error.
    const older = await observe(first.cursor);
    assert.equal(older.events.length, 1);
    assert.equal(older.events[0]['object-id'], 'a');
  } finally {
    await runtime.close();
  }
});

// Case 5 — tamper: a cursor with a forged/changed revision component or a bad MAC throws a
// TypeError, never a silent accept.
test('a tampered or forged cursor throws', async () => {
  const {runtime, observe, mutate} = await seed({grants: [readGrant('a')], objects: ['a']});
  try {
    const start = await observe('');
    await mutate('a', 1);
    const first = await observe(start.cursor);
    const body = first.cursor.slice('obs-cursor/v1:'.length);

    // Flip a byte in the encrypted payload: the GCM auth tag no longer verifies, so it throws.
    const payload = Buffer.from(body, 'base64url');
    payload[payload.length - 1] ^= 0xff;
    const forged = `obs-cursor/v1:${payload.toString('base64url')}`;
    await assert.rejects(observe(forged), (error) => error instanceof TypeError && /integrity check/.test(error.message));

    // Truncated, garbage, wrong version tag, raw number: all rejected.
    await assert.rejects(observe(`obs-cursor/v1:${body.slice(0, -2)}`), TypeError);
    await assert.rejects(observe('obs-cursor/v1:not-a-cursor'), TypeError);
    await assert.rejects(observe('obs-cursor/v0:AAAA.BBBB'), TypeError);
    await assert.rejects(observe('3'), TypeError);
  } finally {
    await runtime.close();
  }
});

// Case 6 — empty result when nothing visible changed; live-follow (empty after-cursor) starts
// at the current end with no backlog replay.
test('nothing visible yields an empty feed; live-follow starts at the current end', async () => {
  const {runtime, observe, mutate} = await seed({grants: [readGrant('a')], objects: ['a', 'b']});
  try {
    // Live-follow: the backlog (including readable A's creation) is NOT replayed.
    const live = await observe('');
    assert.equal(live.events.length, 0, 'an empty after-cursor starts from the current end');

    // Only the invisible B changed: empty feed, but the high-water mark still advances.
    await mutate('b', 1);
    const skipped = await observe(live.cursor);
    assert.equal(skipped.events.length, 0, 'an invisible write is indistinguishable from no-change');
    assert.notEqual(skipped.cursor, live.cursor, 'the cursor advances past the invisible write');

    const stillEmpty = await observe(skipped.cursor);
    assert.equal(stillEmpty.events.length, 0);
    // Functionally stable (resumes at the same position), though the opaque token is not byte-equal.
    assert.equal((await observe(stillEmpty.cursor)).events.length, 0, 'resumes at the same position');
  } finally {
    await runtime.close();
  }
});

// Case 7 — non-object record kinds (shape.put etc.) are dropped from the feed even when every
// object is readable.
test('non-object record kinds are dropped from the feed', async () => {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority});
  try {
    await runtime.images.createImage({id: 'demo'});
    // A temporary binding/block pair, only to mint a live cursor at the CURRENT end. Every
    // subsequent write — kernel, interface, shape, binding/block artifacts — lands after it.
    const anchorInterface = await installCallableInterfaceV2({
      images: runtime.images, imageId: 'demo', interfaceId: 'observe',
      functionName: 'observe', parameters: ['string'], result: 'obs-result', types: TYPES,
    });
    await installImageObservationBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', anchorInterface.id),
      bindingId: 'observation', blockId: 'observation-block',
    });
    const context = authority.issue({principal: 'alice', grants: [readGrant('a')]});
    const observe = async (afterCursor = '') => {
      const activation = await runtime.invocations.invokeBlock(
        objectRef('demo', 'observation-block'), [textValue(afterCursor)],
      );
      const packed = await runtime.executor.execute(activation, {authority: context});
      return unpackCompositeValue(packed, 'obs-result', TYPES);
    };
    const anchor = await observe('');

    // The kernel and one readable object write arrive after the anchor, among a stream of
    // shape/block/artifact writes.
    await installSmalltalkKernel({images: runtime.images, imageId: 'demo'});
    const shape = await runtime.images.putShape('demo', {id: 'item-shape', slots: [{id: 'slot-name', name: 'name'}]});
    await runtime.images.putObject('demo', {
      id: 'a', shape: objectRef('demo', shape.id), slots: {'slot-name': textValue('a-name')},
    });
    const beginning = await runtime.images.history('demo', {afterRevision: 0});

    // Resuming from the anchor yields the ONE object.put the caller may read; every non-object
    // kind (kernel objects excluded by authority, shape/block/artifact writes by kind) is dropped.
    const result = await observe(anchor.cursor);
    assert.deepEqual(result.events.map((event) => event['object-id']), ['a']);
    const kinds = new Set(beginning.map(({type}) => type));
    assert.ok([...kinds].some((kind) => kind !== 'object.put'), 'the seed wrote non-object records');
    assert.ok(kinds.has('object.put'), 'sanity: the seed wrote object records too');
  } finally {
    await runtime.close();
  }
});

// Case 8 — no authority context: the executor's check-only require throws TypeError on first
// use (mirror of the read lane's "no authority context was supplied"), which is NOT an
// AuthorityError, so the lane surfaces it rather than silently observing everything.
test('no authority context is a thrown TypeError, not silent full visibility', async () => {
  const {runtime, observe, mutate} = await seed({grants: null, objects: ['a']});
  try {
    // Live-follow emits nothing, so no per-event check runs. The throw must therefore come
    // from a resume scan over a pending write: the first per-event check-only require throws.
    const live = await observe('');
    await mutate('a', 1);
    await assert.rejects(observe(live.cursor), /no authority context was supplied/);
  } finally {
    await runtime.close();
  }
});
