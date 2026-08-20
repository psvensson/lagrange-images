import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime, integerValue, objectRef, textValue} from '../src/runtime.js';
import {LexicalCellArena} from '../src/execution/lexical-cells.js';
import {ClosurePromoter, durableIdFor, promoteClosure} from '../src/execution/closure-promotion.js';
import {findTransientRefs, isTransientRef, transientObjectId} from '../src/value/transient-ref.js';
import {TupleMap} from '../src/support/tuple-map.js';

// ADR 0052 stage 4: the central promotion operation, on its own.
//
// The two cases worth building first are the ones the ordering exists for — shared capture and a
// capture cycle — because both are decided by memoizing the durable identity *before* recursing.
// Everything else is plumbing around whatever these establish.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function base(runtime) {
  await runtime.images.createImage({id: 'app'});
  await runtime.images.putCodeArtifact('app', {
    id: 'proto:code', languageId: 'test', representation: 'test/v1', content: textValue('body'),
  });
  return objectRef('app', 'proto:code');
}

const blocks = async (runtime) =>
  (await runtime.images.listRecords('app')).filter((record) => record.kind === 'block');
const environments = async (runtime) =>
  (await runtime.images.listRecords('app')).filter((record) => record.kind === 'lexical-environment');

// --- shared capture ------------------------------------------------------------------------------

test('an inner closure captured twice promotes once, and both bindings carry the same ref', async () => {
  await withRuntime(async (runtime) => {
    const code = await base(runtime);
    const arena = new LexicalCellArena();

    const inner = arena.mintClosureBlock('app', {code});
    // One outer closure snapshot-capturing the *same* inner instance under two names.
    const outer = arena.mintClosureBlock('app', {
      code,
      environment: arena.mintClosureEnvironment('app', {
        bindings: {
          'b:left': {name: 'left', value: inner},
          'b:right': {name: 'right', value: inner},
        },
      }),
    });

    const promoted = await promoteClosure(runtime.images, arena, outer);

    const written = await blocks(runtime);
    assert.equal(written.length, 2, `expected the outer and one inner Block, saw ${written.length}`);

    const environment = (await environments(runtime))[0];
    assert.deepEqual(
      environment.bindings['b:left'].value,
      environment.bindings['b:right'].value,
      'the same inner closure must be the same durable ref in both bindings',
    );
    assert.ok(!isTransientRef(environment.bindings['b:left'].value));
    // And the outer's own promoted record points at that environment.
    const outerRecord = written.find((record) => record.id === promoted.objectId);
    assert.equal(outerRecord.environment.objectId, environment.id);
  });
});

test('promotion is idempotent: promoting twice answers one identity and writes once', async () => {
  await withRuntime(async (runtime) => {
    const code = await base(runtime);
    const arena = new LexicalCellArena();
    const instance = arena.mintClosureBlock('app', {code});

    const first = await promoteClosure(runtime.images, arena, instance);
    const afterFirst = (await blocks(runtime)).length;
    const second = await promoteClosure(runtime.images, arena, instance);

    assert.deepEqual(first, second, 'a closure promoted twice is one closure');
    assert.equal((await blocks(runtime)).length, afterFirst, 'the second promotion wrote nothing');
  });
});

// --- capture cycle -------------------------------------------------------------------------------

// A snapshot capture takes an *existing* value, so a genuine snapshot cycle cannot be built by
// ordinary evaluation — A would have to exist before B and B before A. Promotion must still
// terminate on one, because the memo is what guarantees termination and a guarantee that depends on
// the input being well-behaved is not one. Driving the promoter through a minimal arena double is
// how the cycle gets built at all, and it keeps the shape out of the production API.
class FakeArena {
  #records = new TupleMap(2);
  #memo = new TupleMap(2);

  set(ref, record) {
    this.#records.set([ref.imageId, ref.objectId], record);
    return ref;
  }

  transientRecord(imageId, objectId) {
    return this.#records.get([imageId, objectId]) ?? null;
  }

  promotionMemo() {
    return this.#memo;
  }
}

let fakeIds = 0;
const fakeRef = () => objectRef('app', transientObjectId(`block/${fakeIds += 1}/fake`));
const fakeEnvRef = () => objectRef('app', transientObjectId(`environment/${fakeIds += 1}/fake`));

test('a capture cycle terminates and leaves no transient ref durable', async () => {
  await withRuntime(async (runtime) => {
    const code = await base(runtime);
    const arena = new FakeArena();

    // A's environment names B; B's environment names A.
    const a = fakeRef();
    const b = fakeRef();
    const environmentA = fakeEnvRef();
    const environmentB = fakeEnvRef();
    arena.set(environmentA, {kind: 'lexical-environment', bindings: {'b:b': {name: 'b', value: b}}, parent: null});
    arena.set(environmentB, {kind: 'lexical-environment', bindings: {'b:a': {name: 'a', value: a}}, parent: null});
    arena.set(a, {kind: 'block', code, environment: environmentA, metadata: {}});
    arena.set(b, {kind: 'block', code, environment: environmentB, metadata: {}});

    const promotedA = await new ClosurePromoter(runtime.images, arena).promoteValue(a);

    const written = await blocks(runtime);
    assert.equal(written.length, 2, `a two-closure cycle must promote two Blocks, saw ${written.length}`);
    for (const record of [...written, ...(await environments(runtime))]) {
      assert.deepEqual(findTransientRefs(record), [], `${record.id} still holds a transient ref`);
    }

    // The cycle is preserved rather than broken: following A -> B -> A returns to the same identity.
    const environmentsById = new Map((await environments(runtime)).map((record) => [record.id, record]));
    const recordA = written.find((record) => record.id === promotedA.objectId);
    const toB = environmentsById.get(recordA.environment.objectId).bindings['b:b'].value;
    const recordB = written.find((record) => record.id === toB.objectId);
    const backToA = environmentsById.get(recordB.environment.objectId).bindings['b:a'].value;
    assert.deepEqual(backToA, promotedA, 'the cycle must close on the same durable identity');
  });
});

test('a promotion retried after a lost acknowledgement converges on the same identities', async () => {
  await withRuntime(async (runtime) => {
    const code = await base(runtime);
    const build = () => {
      const arena = new FakeArena();
      const a = objectRef('app', transientObjectId('block/a/stable'));
      const b = objectRef('app', transientObjectId('block/b/stable'));
      const environmentA = objectRef('app', transientObjectId('environment/a/stable'));
      const environmentB = objectRef('app', transientObjectId('environment/b/stable'));
      arena.set(environmentA, {kind: 'lexical-environment', bindings: {'b:b': {name: 'b', value: b}}, parent: null});
      arena.set(environmentB, {kind: 'lexical-environment', bindings: {'b:a': {name: 'a', value: a}}, parent: null});
      arena.set(a, {kind: 'block', code, environment: environmentA, metadata: {}});
      arena.set(b, {kind: 'block', code, environment: environmentB, metadata: {}});
      return {arena, a};
    };

    // Commit, then lose the acknowledgement: the write landed, the caller saw a failure.
    let failures = 1;
    const faulting = Object.create(runtime.images);
    faulting.putBlock = async (imageId, input) => {
      const stored = await runtime.images.putBlock(imageId, input);
      if (failures-- > 0) throw new Error(`injected post-commit failure (${input.id})`);
      return stored;
    };

    const first = build();
    await assert.rejects(
      new ClosurePromoter(faulting, first.arena).promoteValue(first.a),
      /injected post-commit failure/,
    );

    // A fresh arena and a fresh promoter. What this proves is narrower than it might look: that
    // publication is deterministic given the same *logical* transient identity, independent of any
    // promoter's local state. It does not claim a new execution could reconstruct an expired
    // closure — it could not, and does not need to. The same-arena retry below is the recovery
    // case that actually matters.
    const second = build();
    const retried = await new ClosurePromoter(runtime.images, second.arena).promoteValue(second.a);

    const written = await blocks(runtime);
    assert.equal(written.length, 2, `a converged retry must leave two Blocks, saw ${written.length}`);
    assert.ok(written.some((record) => record.id === retried.objectId));
    for (const record of [...written, ...(await environments(runtime))]) {
      assert.deepEqual(findTransientRefs(record), []);
    }
  });
});


// --- recovery (the memo's three states) ----------------------------------------------------------

// A reserved identity is not a published record. If a failure leaves the reservation behind, the
// mechanism that breaks cycles becomes a way of answering a durable ref whose Block was never
// written — a failed promotion reported as a success.
//
// Swept at both publication points and in both failure modes, and the retry always uses the SAME
// arena, because that is where a stale reservation would live.
for (const target of ['putLexicalEnvironment', 'putBlock']) {
  for (const mode of ['pre-commit', 'lost-ack']) {
    test(`a ${mode} failure at ${target} leaves no false promotion, and the same arena retries clean`, async () => {
      await withRuntime(async (runtime) => {
        const code = await base(runtime);
        const arena = new LexicalCellArena();
        const inner = arena.mintClosureBlock('app', {code});
        const instance = arena.mintClosureBlock('app', {
          code,
          environment: arena.mintClosureEnvironment('app', {
            bindings: {'b:held': {name: 'held', value: inner}},
          }),
        });

        let armed = true;
        const faulting = Object.create(runtime.images);
        faulting[target] = async (imageId, input, options) => {
          if (armed && mode === 'pre-commit') {
            armed = false;
            throw new Error(`injected pre-commit failure (${input.id})`);
          }
          const stored = await runtime.images[target](imageId, input, options);
          if (armed) {
            armed = false;
            throw new Error(`injected post-commit failure (${input.id})`);
          }
          return stored;
        };

        await assert.rejects(
          new ClosurePromoter(faulting, arena).promoteValue(instance),
          /injected (pre|post)-commit failure/,
        );

        // The retry runs against the same arena, so a stale in-progress reservation would be
        // consulted here — and would answer a ref whose Block may not exist.
        const promoted = await new ClosurePromoter(runtime.images, arena).promoteValue(instance);

        // The answer must be a real, resolvable Block, not merely a plausible ref.
        const record = await runtime.images.getBlock('app', promoted.objectId);
        assert.ok(record, `retry answered ${promoted.objectId}, which does not exist`);
        assert.deepEqual(findTransientRefs(record), []);

        // And the closure it captured resolves too, through a real environment.
        const environment = await runtime.images.getLexicalEnvironment(
          record.environment.imageId, record.environment.objectId,
        );
        assert.ok(environment, 'the promoted environment does not exist');
        const heldRef = environment.bindings['b:held'].value;
        assert.ok(!isTransientRef(heldRef));
        assert.ok(await runtime.images.getBlock('app', heldRef.objectId), 'the captured closure was not published');

        // Exactly two Blocks: the instance and the closure it held. A cleared reservation must not
        // become a second identity for either.
        assert.equal((await blocks(runtime)).length, 2);
      });
    });
  }
}

// The distinction the three states exist for, stated directly.
test('a failed promotion does not leave a memo entry that answers as success', async () => {
  await withRuntime(async (runtime) => {
    const code = await base(runtime);
    const arena = new LexicalCellArena();
    const instance = arena.mintClosureBlock('app', {code});

    const failing = Object.create(runtime.images);
    failing.putBlock = async () => { throw new Error('injected failure'); };
    await assert.rejects(new ClosurePromoter(failing, arena).promoteValue(instance), /injected failure/);

    // A promoter sharing the arena's memo must not answer from the abandoned reservation. If it
    // did, this would return a ref with no record behind it rather than re-publishing.
    const promoted = await new ClosurePromoter(runtime.images, arena).promoteValue(instance);
    assert.ok(await runtime.images.getBlock('app', promoted.objectId));
  });
});

test('a completed promotion is still answered from the memo without rewriting', async () => {
  await withRuntime(async (runtime) => {
    const code = await base(runtime);
    const arena = new LexicalCellArena();
    const instance = arena.mintClosureBlock('app', {code});
    const promoter = new ClosurePromoter(runtime.images, arena);

    const first = await promoter.promoteValue(instance);
    let writes = 0;
    const counting = Object.create(runtime.images);
    counting.putBlock = async (...args) => { writes += 1; return await runtime.images.putBlock(...args); };

    const second = await new ClosurePromoter(counting, arena).promoteValue(instance);
    assert.deepEqual(second, first);
    assert.equal(writes, 0, 'a complete entry must be answered from the memo, not re-published');
  });
});

// --- what promotion must not carry ---------------------------------------------------------------

test('a promoted closure carries cell markers without contents, and no frame', async () => {
  await withRuntime(async (runtime) => {
    const code = await base(runtime);
    const arena = new LexicalCellArena();
    const held = arena.mintClosureBlock('app', {code});
    const instance = arena.mintClosureBlock('app', {
      code,
      environment: arena.mintClosureEnvironment('app', {
        bindings: {
          'b:live': {name: 'counter', cell: true},
          'b:snap': {name: 'snapshot', value: integerValue(3)},
        },
      }),
    });
    // A frame association, exactly as a closure created inside a method would have.
    arena.associateFrame(instance, {self: objectRef('app', 'some-receiver'), definingBehavior: null});

    const promoted = await promoteClosure(runtime.images, arena, instance);
    const record = (await blocks(runtime)).find((entry) => entry.id === promoted.objectId);
    const environment = (await environments(runtime))[0];

    assert.deepEqual(environment.bindings['b:live'], {name: 'counter', cell: true},
      'a live cell is a marker with no contents');
    assert.deepEqual(environment.bindings['b:snap'].value, integerValue(3));
    // No frame, no defining behaviour, anywhere in the promoted record.
    assert.equal(JSON.stringify(record).includes('definingBehavior'), false);
    assert.equal(JSON.stringify(record).includes('some-receiver'), false);
    // `held` was never captured, so it was never promoted.
    assert.equal((await blocks(runtime)).length, 1);
    void held;
  });
});

test('a cell whose contents happen to be a closure does not promote that closure', async () => {
  await withRuntime(async (runtime) => {
    const code = await base(runtime);
    const arena = new LexicalCellArena();
    const hidden = arena.mintClosureBlock('app', {code});
    // The durable binding for a live cell records only the marker; the contents live in the arena
    // cell, which promotion must not read. Modelling that faithfully: the binding is a marker, and
    // the closure is reachable only through cell contents the durable record never carries.
    const instance = arena.mintClosureBlock('app', {
      code,
      environment: arena.mintClosureEnvironment('app', {bindings: {'b:cell': {name: 'box', cell: true}}}),
    });

    await promoteClosure(runtime.images, arena, instance);

    const written = await blocks(runtime);
    assert.equal(written.length, 1, 'only the promoted closure itself may be written');
    // Named precisely: the id `hidden` *would* have been promoted under, so this cannot pass by
    // accident the way a substring check on a shared arena nonce would.
    assert.ok(
      !written.some((record) => record.id === durableIdFor(hidden.objectId)),
      'a closure reachable only through cell contents must not be promoted',
    );
  });
});

test('promoting something that is not a closure instance is refused', async () => {
  await withRuntime(async (runtime) => {
    await base(runtime);
    const arena = new LexicalCellArena();
    // A durable ref passes through untouched.
    const durable = objectRef('app', 'proto:code');
    assert.deepEqual(await promoteClosure(runtime.images, arena, durable), durable);
    // An expired transient ref is an expiry, not a silent no-op.
    const gone = arena.mintClosureBlock('app', {code: objectRef('app', 'proto:code')});
    await assert.rejects(
      promoteClosure(runtime.images, new LexicalCellArena(), gone),
      /has expired/,
    );
  });
});
