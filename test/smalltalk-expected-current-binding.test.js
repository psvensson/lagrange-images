import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  methodBlockRef,
  objectRef,
  readBehavior,
  reconcileMethods,
  reconcileMethodsFromSource,
} from '../src/runtime.js';
import {
  SmalltalkMethodDictionaryContentionError,
  SmalltalkStaleMethodPositionError,
} from '../src/language/smalltalk-class-builder.js';

// C1 of bead lagrange-images-qax: the class builder can be told "replace `guarded`, but ONLY if it
// still binds exactly the Block I observed". Every proof here makes the competing bindings
// OBSERVABLY different — each answers a distinct integer — and asserts behaviour through a real
// send, because several of the wrong implementations these tests exist to kill reach the same
// final REF and differ only in whether they should have.

const GUARDED = 'guardedAnswer';
const UNRELATED = 'unrelatedAnswer';

const method = (selector, answer) => ({
  selector,
  program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(answer)}},
});

const guarded = (answer, expectedCurrent) => ({...method(GUARDED, answer), expectedCurrent});

async function withFixture(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const options = {
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: kernel.integerClass,
      lane: 'wasm',
    };
    // A -> 1 at the guarded position, X -> 10 beside it. Different answers, so "which binding is
    // current" is a question a send can answer.
    await defineMethods({...options, methods: [method(GUARDED, 1), method(UNRELATED, 10)]});
    return await body(runtime, kernel, options);
  } finally {
    await runtime.close();
  }
}

let sends = 0;
async function answerOf(runtime, selector) {
  sends += 1;
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId: 'app', id: `send-${sends}`, source: `[ :receiver | receiver ${selector} ]`,
  });
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(
    objectRef('app', installed.block.id), [integerValue(0)],
  ));
}

const answers = async (runtime, selector, expected, message) =>
  assert.deepEqual(await answerOf(runtime, selector), integerValue(expected), message);

async function dictionaryRecord(runtime, classRef) {
  const behavior = await readBehavior(runtime.images, classRef);
  return await runtime.images.getObject(behavior.methods.imageId, behavior.methods.objectId);
}

// ADR 0086 derives a revision id from normalized semantics + lane + captures under the class's own
// method position, so the SAME definition on the same class has the same durable id in any image.
// That is what lets a contention proof name the material a losing attempt published without
// reaching into the builder's private id helpers.
async function revisionRefFor(answer) {
  return await withFixture(async (_runtime, _kernel, options) => {
    await reconcileMethods({...options, methods: [method(GUARDED, answer)]});
    return await methodBlockRef({...options, selector: GUARDED});
  });
}

// Run `actions[n]` immediately before this operation's (n+1)th MethodDictionary CAS, with the real
// backend restored so the interleaved actor writes normally. The dictionary write is then attempted
// against the version it read, and loses.
function interleaveAtDictionaryCas(runtime, classObjectId, actions) {
  const putObject = runtime.images.putObject.bind(runtime.images);
  let attempts = 0;
  const hook = async (imageId, input, options) => {
    if (input.id === `${classObjectId}/methods` && options?.expectedVersion !== undefined) {
      const action = actions[attempts];
      attempts += 1;
      if (action) {
        runtime.images.putObject = putObject;
        await action();
        runtime.images.putObject = hook;
      }
    }
    return await putObject(imageId, input, options);
  };
  runtime.images.putObject = hook;
  return {
    restore: () => { runtime.images.putObject = putObject; },
    attempts: () => attempts,
  };
}

const versionConflict = () => Object.assign(new Error('simulated backend conflict'), {
  name: 'VersionConflictError',
});

// ---------------------------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: an expectation that is accepted but never satisfiable,
// so no guarded replacement can ever land (a precondition compared against the wrong thing, or one
// that treats a matching binding as a mismatch).
test('a guarded replacement whose observed binding is still current advances exactly that position', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const before = await dictionaryRecord(runtime, options.classRef);

    await reconcileMethods({...options, methods: [guarded(3, observed)]});

    await answers(runtime, GUARDED, 3, 'the guarded position advanced to C');
    await answers(runtime, UNRELATED, 10, 'the unrelated position did not move');
    const after = await dictionaryRecord(runtime, options.classRef);
    assert.equal(after._version, before._version + 1, 'exactly one authoritative dictionary version');
    assert.notDeepEqual(await methodBlockRef({...options, selector: GUARDED}), observed);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: making the expectation a REPLACEMENT of ADR 0086's
// exact-replay rule rather than a precondition on it — a guarded caller replaying the definition
// that is already current must still be a write-free success, because that is a true replay against
// the very state it observed.
test('a guarded exact replay against the observed binding is a write-free success', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    await reconcileMethods({...options, methods: [method(GUARDED, 3)]});
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const before = await dictionaryRecord(runtime, options.classRef);
    const history = await runtime.images.history('app');

    await reconcileMethods({...options, methods: [guarded(3, observed)]});

    assert.equal((await runtime.images.history('app')).length, history.length, 'no write at all');
    assert.equal((await dictionaryRecord(runtime, options.classRef))._version, before._version);
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), observed);
    await answers(runtime, GUARDED, 3);
  });
});

// ---------------------------------------------------------------------------------------------
// Case 1 — an UNRELATED selector moved
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: two of them at once, distinguished by two different
// assertions.
//   (a) treating ANY lost dictionary CAS as staleness — the replacement would be refused although
//       nothing ever touched the guarded position. Killed by the call succeeding at all.
//   (b) retrying by REPLAYING the stale planning snapshot — the write would succeed and silently
//       carry the unrelated selector back to its pre-race binding. Killed by the unrelated send
//       still answering the WINNER's value, which is why the two positions answer differently.
test('an unrelated selector moving under the guarded write rebases and preserves the winner', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const race = interleaveAtDictionaryCas(runtime, options.classRef.objectId, [
      () => reconcileMethods({...options, methods: [method(UNRELATED, 20)]}),
    ]);

    await reconcileMethods({...options, methods: [guarded(3, observed)]});
    race.restore();

    assert.equal(race.attempts(), 2, 'the storage CAS lost once and the owner rebased and retried');
    await answers(runtime, GUARDED, 3, 'the guarded position reached C despite the unrelated race');
    await answers(runtime, UNRELATED, 20, 'the unrelated winner survived the rebase');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a single rebase, or rebasing onto the FIRST observed
// winner rather than the latest state. Two unrelated writes race in sequence; only an implementation
// that re-reads at every boundary ends with the latest unrelated binding.
test('repeated unrelated races rebase onto the LATEST state, keeping the original expectation', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const race = interleaveAtDictionaryCas(runtime, options.classRef.objectId, [
      () => reconcileMethods({...options, methods: [method(UNRELATED, 20)]}),
      () => reconcileMethods({...options, methods: [method(UNRELATED, 30)]}),
    ]);

    await reconcileMethods({...options, methods: [guarded(3, observed)]});
    race.restore();

    assert.equal(race.attempts(), 3, 'two lost CASes, two rebases, one winning write');
    await answers(runtime, GUARDED, 3);
    await answers(runtime, UNRELATED, 30, 'the LATEST unrelated winner survived, not the first');
  });
});

// ---------------------------------------------------------------------------------------------
// Case 2 — the GUARDED selector moved
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: ignoring the expected binding altogether — the
// replacement would simply overwrite the external winner, which is the entire failure the
// precondition exists to prevent.
test('a guarded position already moved is stale at plan time, and publishes nothing', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    await reconcileMethods({...options, methods: [method(GUARDED, 2)]});
    const winner = await methodBlockRef({...options, selector: GUARDED});
    const recordsBefore = (await runtime.images.listRecords('app')).length;
    const history = await runtime.images.history('app');

    const error = await reconcileMethods({...options, methods: [guarded(3, observed)]})
      .then(() => null, (cause) => cause);

    // Counted BEFORE any send: resolving a send installs its own Block and would mask the point.
    assert.equal((await runtime.images.listRecords('app')).length, recordsBefore,
      'a plan-time stale replacement publishes no new immutable material at all');
    assert.equal((await runtime.images.history('app')).length, history.length);
    assert.ok(error instanceof SmalltalkStaleMethodPositionError, `unexpected: ${error}`);
    assert.equal(error.selector, GUARDED);
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), winner, 'B was not overwritten');
    await answers(runtime, GUARDED, 2, 'the external winner is still what a send resolves to');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: silently REFRESHING the expectation from the state
// observed at the rebase boundary. Such an implementation rebases onto B, overwrites it with C and
// reports success — and it is invisible to any assertion that only checks the final value, because
// C is what the caller asked for. The kill is that the operation must REJECT and B must remain.
//
// It also states the compilation-before-CAS truth honestly rather than claiming a stale write
// writes nothing: by this point C's immutable revision material HAS been published, and it stays in
// the image, addressable and non-current. No rollback is added to hide it.
test('the guarded position moving mid-flight is stale at the rebase boundary; C is published but never current', async () => {
  const orphan = await revisionRefFor(3);
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const race = interleaveAtDictionaryCas(runtime, options.classRef.objectId, [
      () => reconcileMethods({...options, methods: [method(GUARDED, 2)]}),
    ]);

    const error = await reconcileMethods({...options, methods: [guarded(3, observed)]})
      .then(() => null, (cause) => cause);
    race.restore();

    assert.ok(error instanceof SmalltalkStaleMethodPositionError, `unexpected: ${error}`);
    await answers(runtime, GUARDED, 2, 'the mid-flight winner B is current and was never overwritten');
    const current = await methodBlockRef({...options, selector: GUARDED});
    assert.notDeepEqual(current, orphan, 'C never became the current binding');
    assert.ok(await runtime.images.getBlock('app', orphan.objectId),
      'honest: C\'s immutable Block was published before the final CAS and remains in the image');
    assert.ok(await runtime.images.getCodeArtifact('app', `${orphan.objectId}:semantic`),
      'honest: so did its immutable semantic artifact');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: checking ADR 0086 convergence BEFORE the expectation.
// Here the external actor installs exactly the definition this caller wanted, so a convergence-first
// implementation answers "already installed, write-free success" and the caller never learns that
// its observation was overtaken. Final-state equality cannot separate the two implementations —
// only the verdict can — which is why this is the sharpest test in the file.
test('an external winner semantically EQUAL to the desired replacement is still stale', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    await reconcileMethods({...options, methods: [method(GUARDED, 3)]});
    const winner = await methodBlockRef({...options, selector: GUARDED});
    assert.notDeepEqual(winner, observed, 'the external actor really did move the position');

    const error = await reconcileMethods({...options, methods: [guarded(3, observed)]})
      .then(() => null, (cause) => cause);

    assert.ok(error instanceof SmalltalkStaleMethodPositionError,
      `an external replacement after the observation is stale even when it means what the caller wanted: ${error}`);
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), winner);
    await answers(runtime, GUARDED, 3);
  });
});

// ---------------------------------------------------------------------------------------------
// Error boundary and input
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: letting the backend's VersionConflictError escape the
// owner once the guarded path stops classifying and starts retrying — either raw, or smuggled out
// as a `cause`.
test('sustained contention on the dictionary never leaks a backend conflict', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const putObject = runtime.images.putObject.bind(runtime.images);
    let attempts = 0;
    runtime.images.putObject = async (imageId, input, writeOptions) => {
      if (input.id === `${options.classRef.objectId}/methods` && writeOptions?.expectedVersion !== undefined) {
        attempts += 1;
        throw versionConflict();
      }
      return await putObject(imageId, input, writeOptions);
    };

    const error = await reconcileMethods({...options, methods: [guarded(3, observed)]})
      .then(() => null, (cause) => cause);
    runtime.images.putObject = putObject;

    assert.ok(attempts > 1, 'the owner did retry rather than give up on the first loss');
    assert.ok(attempts < 20, 'the retry is bounded');
    assert.notEqual(error?.name, 'VersionConflictError', 'no raw backend conflict escaped');
    assert.equal(error?.cause, undefined, 'and none was smuggled out as a cause');
    assert.ok(error instanceof SmalltalkMethodDictionaryContentionError, `unexpected: ${error}`);
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), observed,
      'the guarded position never moved');
    await answers(runtime, GUARDED, 1);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a stale refusal that hands back the current binding, a
// replacement token or a storage version, letting a caller "recover" by adopting state it never
// read. Current truth must come only from a fresh read.
test('a stale refusal discloses no winning ref, version or backend cause', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    await reconcileMethods({...options, methods: [method(GUARDED, 2)]});
    const winner = await methodBlockRef({...options, selector: GUARDED});
    const dictionary = await dictionaryRecord(runtime, options.classRef);

    const error = await reconcileMethods({...options, methods: [guarded(3, observed)]})
      .then(() => null, (cause) => cause);

    assert.ok(error instanceof SmalltalkStaleMethodPositionError);
    assert.equal(error.cause, undefined);
    const disclosed = JSON.stringify({message: error.message, ...error});
    assert.ok(!disclosed.includes(winner.objectId), 'the winning Block ref is not disclosed');
    assert.ok(!disclosed.includes(String(dictionary._version)), 'no storage version is disclosed');
    assert.ok(!disclosed.includes('_version'));
    assert.deepEqual(Object.keys(error), ['name', 'selector'], 'only the caller\'s own position');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: publishing part of a multi-position guarded call before
// every guarded position has been checked — the unrelated-looking sibling would advance while the
// caller's operation failed, which is wrong-selector damage under a different name.
test('one stale position in a guarded call moves no position at all', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const staleObservation = await methodBlockRef({...options, selector: GUARDED});
    const unrelatedObservation = await methodBlockRef({...options, selector: UNRELATED});
    await reconcileMethods({...options, methods: [method(GUARDED, 2)]});

    for (const order of [[GUARDED, UNRELATED], [UNRELATED, GUARDED]]) {
      const byselector = {
        [GUARDED]: {...method(GUARDED, 3), expectedCurrent: staleObservation},
        [UNRELATED]: {...method(UNRELATED, 20), expectedCurrent: unrelatedObservation},
      };
      const error = await reconcileMethods({...options, methods: order.map((s) => byselector[s])})
        .then(() => null, (cause) => cause);
      assert.ok(error instanceof SmalltalkStaleMethodPositionError, `${order}: ${error}`);
      assert.equal(error.selector, GUARDED, `${order}: the stale position is named`);
      await answers(runtime, GUARDED, 2, `${order}: the guarded winner survived`);
      await answers(runtime, UNRELATED, 10, `${order}: the sibling position did not advance either`);
    }
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: interpreting caller input instead of refusing it —
// an expectation on the add-only definition path, a foreign-image ref accepted as an observation
// (which would compare only the object id), or a partly guarded call whose lost-CAS meaning the
// owner would have to invent.
test('malformed expectations are refused as input, before any semantic verdict', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const before = (await runtime.images.history('app')).length;
    const refuses = async (label, call) => {
      const error = await call().then(() => null, (cause) => cause);
      assert.ok(error instanceof TypeError, `${label}: ${error}`);
      assert.ok(!(error instanceof SmalltalkStaleMethodPositionError), `${label} is malformed input, not staleness`);
    };

    await refuses('defineMethods is add-only', () =>
      defineMethods({...options, methods: [{...method('freshSelector', 5), expectedCurrent: observed}]}));
    await refuses('a foreign-image observation', () =>
      reconcileMethods({...options, methods: [guarded(3, objectRef('elsewhere', observed.objectId))]}));
    await refuses('a partly guarded call', () =>
      reconcileMethods({...options, methods: [guarded(3, observed), method(UNRELATED, 20)]}));

    assert.equal((await runtime.images.history('app')).length, before, 'no refusal wrote anything');
    await answers(runtime, GUARDED, 1);
    await answers(runtime, UNRELATED, 10);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a guarded path that publishes or moves the binding when
// the replacement source cannot be compiled at all. Compilation happens before the final CAS, so
// "compiled material may be orphaned" must not become "a rejected source can still move the
// position".
test('a source that does not compile leaves the guarded binding exactly where it was', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const before = (await runtime.images.listRecords('app')).map(({id, _version}) => [id, _version]).sort();

    const error = await reconcileMethodsFromSource({
      ...options,
      methods: [{selector: GUARDED, source: '[ 3 + ]', expectedCurrent: observed}],
    }).then(() => null, (cause) => cause);

    // Counted before any send, again: a send installs a Block of its own.
    assert.deepEqual(
      (await runtime.images.listRecords('app')).map(({id, _version}) => [id, _version]).sort(),
      before, 'a rejected source published nothing and moved no version',
    );
    assert.ok(error instanceof Error, 'the malformed source was rejected');
    assert.ok(!(error instanceof SmalltalkStaleMethodPositionError));
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), observed);
    await answers(runtime, GUARDED, 1, 'the current binding is untouched by a compile failure');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: threading the expectation only through the program-level
// entry point and dropping it where methods are compiled from source — which would silently turn
// every guarded replacement made from source into an unguarded overwrite.
test('the from-source path carries the expectation rather than dropping it', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    await reconcileMethods({...options, methods: [method(GUARDED, 2)]});
    const winner = await methodBlockRef({...options, selector: GUARDED});

    const error = await reconcileMethodsFromSource({
      ...options,
      methods: [{selector: GUARDED, source: '[ 3 ]', expectedCurrent: observed}],
    }).then(() => null, (cause) => cause);

    assert.ok(error instanceof SmalltalkStaleMethodPositionError, `unexpected: ${error}`);
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), winner);
    await answers(runtime, GUARDED, 2, 'a guarded from-source replacement did not overwrite the winner');
  });
});
