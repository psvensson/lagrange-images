import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
  CUIS_SEMANTIC_EXPORT_V2,
  createRuntime,
  defineMethodsFromSource,
  findSmalltalkKernel,
  importCuisNativePackage,
  installSmalltalkAllocationProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  methodBlockRef,
  objectRef,
  reconcileMethodsFromSource,
} from '../src/runtime.js';
import {
  SmalltalkMethodLaneError,
  SmalltalkStaleMethodPositionError,
} from '../src/language/smalltalk-class-builder.js';

// Bead lagrange-images-it3: which EXECUTION LANE does a replacement of an existing native method
// compile in?
//
// The answer this file proves is the class builder's: a replacement guarded by an observed revision
// compiles in THAT REVISION'S lane. `{Class/Metaclass, selector}` is the logical position (ADR 0086
// decision 1) and the Block bound there is the immutable current revision; an E3 replacement says
// "make this position mean this source instead", and says nothing about moving it to a different
// executable representation. Since the authorized seam deliberately publishes no compiler and no
// lane knob, a lane change underneath it would be a SECOND mutation the caller neither asked for nor
// can observe through the public contract.
//
// WHY THIS OWNER AND NOT THE SEAM. `installMethods` publishes `metadata: {smalltalk: 'method',
// selector, lane}` on every method Block it installs, and already compares that field in
// `isSameInstalledMethod`. Reading it back here is the owner reading its own record. Nothing in this
// path opens a Block's CODE artifact, decodes an executable representation or consults the executor
// registry — which is exactly why the same question may not be answered in
// `smalltalk-authorized-method-replacement.js` (ADR 0087/0088 rejected a second CodeArtifact
// decoder), and `test/smalltalk-authorized-method-replacement.test.js` keeps that boundary honest.
//
// Every proof here makes the competing outcomes OBSERVABLE — a distinct integer through a real send,
// and the code artifact's own representation — because the wrong implementations these tests exist
// to kill mostly still answer correctly.

const CUIS_INTEGER_ANSWER = 1;

// A service wrapper that keeps the owner's own instance behind it: `runtime.images` and
// `runtime.compilation` are class instances, so a spread copy would silently drop every prototype
// method and the fixture would fail for a reason that has nothing to do with lanes.
function intercepting(service, overrides) {
  return new Proxy(service, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function withKernel(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const options = {
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: kernel.integerClass,
    };
    return await body(runtime, options, kernel);
  } finally {
    await runtime.close();
  }
}

let sends = 0;
async function answerOf(runtime, selector, receiver = integerValue(0)) {
  sends += 1;
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId: 'app', id: `lane-send-${sends}`, source: `[ :receiver | receiver ${selector} ]`,
  });
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(
    objectRef('app', installed.block.id), [receiver],
  ));
}

const answers = async (runtime, selector, expected, message) =>
  assert.deepEqual(await answerOf(runtime, selector), integerValue(expected), message);

// The two facts a lane claim rests on, read the way an outside observer would: the lane THIS OWNER
// recorded on the Block, and the representation of the code artifact that Block actually points at.
// Asserting only the metadata would pass for an implementation that labelled a neutral artifact
// `wasm`; asserting only the representation would pass for one that produced WASM but recorded
// nothing, which is the state the missing-metadata refusal below exists for.
async function laneOf(runtime, method) {
  const block = await runtime.images.getBlock(method.imageId, method.objectId);
  const code = await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId);
  return {lane: block.metadata?.lane ?? null, representation: code.representation};
}

const WASM = {lane: 'wasm', representation: 'wasm-function/v2'};
const NEUTRAL = {lane: 'neutral', representation: 'neutral-expression/v0'};

// ---------------------------------------------------------------------------------------------
// The rule itself, in both directions
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: the shipped one. `reconcileMethodsFromSource` defaulted
// its lane to `neutral`, so replacing a method installed in the WASM lane — which is EVERY
// Cuis-imported method — silently recompiled it into the neutral lane. It still dispatched and still
// answered, because the executor registry selects by the artifact's representation, so nothing but
// an assertion on the representation itself can see it.
test('a replacement of a WASM-lane revision is published in the WASM lane', async () => {
  await withKernel(async (runtime, options) => {
    const selector = 'wasmAnswer';
    await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector, source: '[ ^ 1 ]'}]});
    const a = await methodBlockRef({...options, selector});
    assert.deepEqual(await laneOf(runtime, a), WASM, 'the fixture really is WASM-lane');
    await answers(runtime, selector, 1, 'and A really executes through it');

    await reconcileMethodsFromSource({
      ...options, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: a}],
    });

    const b = await methodBlockRef({...options, selector});
    assert.notDeepEqual(b, a, 'the position advanced to a fresh immutable revision');
    assert.deepEqual(await laneOf(runtime, b), WASM, 'and the replacement kept the observed lane');
    // Both halves matter. Metadata alone would pass for an implementation that LABELLED a neutral
    // artifact `wasm`; a send alone would pass for one that migrated the representation, because
    // the executor registry selects by representation and both lanes answer correctly.
    await answers(runtime, selector, 7, 'and B executes correctly through that same lane');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: "compile every replacement in the WASM lane", which
// would satisfy the proof above on its own while migrating every neutral method in the image the
// first time anyone edited it. Preservation has to be preservation in both directions, or it is just
// a different hard-coded default.
test('a replacement of a neutral-lane revision is published in the neutral lane', async () => {
  await withKernel(async (runtime, options) => {
    const selector = 'neutralAnswer';
    await defineMethodsFromSource({...options, lane: 'neutral', methods: [{selector, source: '[ ^ 1 ]'}]});
    const a = await methodBlockRef({...options, selector});
    assert.deepEqual(await laneOf(runtime, a), NEUTRAL, 'the fixture really is neutral-lane');
    await answers(runtime, selector, 1, 'and A really executes through it');

    await reconcileMethodsFromSource({
      ...options, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: a}],
    });

    const b = await methodBlockRef({...options, selector});
    assert.notDeepEqual(b, a);
    assert.deepEqual(await laneOf(runtime, b), NEUTRAL, 'and the replacement kept the observed lane');
    await answers(runtime, selector, 7, 'and B executes correctly through that same lane');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: preservation machinery that manufactures a revision for
// a replacement that changes nothing. ADR 0086's exact replay is decided partly BY the lane —
// `isSameInstalledMethod` compares `block.metadata.lane`, and `methodRevisionId` encodes it — so a
// preservation step that computed the lane but failed to use it for identity would turn every
// identical redefinition of a WASM method into a write, which is precisely how the shipped defect
// behaved.
test('an exact guarded replay in the observed lane stays write-free', async () => {
  await withKernel(async (runtime, options) => {
    for (const [selector, lane, expected] of [['replayWasm', 'wasm', WASM], ['replayNeutral', 'neutral', NEUTRAL]]) {
      await defineMethodsFromSource({...options, lane, methods: [{selector, source: '[ ^ 3 ]'}]});
      const a = await methodBlockRef({...options, selector});
      assert.deepEqual(await laneOf(runtime, a), expected);

      const frontier = await runtime.images.frontier('app');
      await reconcileMethodsFromSource({
        ...options, methods: [{selector, source: '[ ^ 3 ]', expectedCurrent: a}],
      });

      assert.equal(await runtime.images.frontier('app'), frontier,
        `${lane}: an identical guarded replay published nothing`);
      assert.deepEqual(await methodBlockRef({...options, selector}), a, 'and the binding did not move');
      assert.deepEqual(await laneOf(runtime, a), expected);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// No fallback
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: "try the observed lane, and if it rejects the
// replacement, compile it in the other one". That is the migration E3 does not offer, performed
// silently and precisely when the caller has least reason to expect it. A replacement the observed
// lane cannot compile FAILS, and the observed revision stays current.
//
// THE FIXTURE IS A LANE-SCOPED COMPILE FAULT, NOT A SOURCE. There is no source in this repository
// that the WASM lane rejects and the neutral lane accepts: the two backends cover the same semantic
// ops, and the one bounded WASM restriction that exists (`isWasmTailEffectRestrictionError`, effects
// outside tail position) is not a rejection at all — the class builder and the compilation registry
// both answer it by falling through to the resumable backend, so it never surfaces. A fourteen-source
// probe over both lanes found no divergence. Rather than invent compiler functionality to
// manufacture one, this injects a failure at the ONE seam the lanes actually differ at: the
// compilation service request for a WASM target. The same source through the neutral lane still
// compiles under the very same faulted service, which is the "accepted by the other lane" half.
test('a replacement the observed lane cannot compile fails; it is never retried in the other lane', async () => {
  await withKernel(async (runtime, options) => {
    const selector = 'noFallback';
    await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector, source: '[ ^ 1 ]'}]});
    const a = await methodBlockRef({...options, selector});
    assert.deepEqual(await laneOf(runtime, a), WASM);

    const targets = [];
    const wasmRejected = intercepting(runtime.compilation, {
      compileArtifact: async (source, request) => {
        const target = String(request?.targetRepresentation ?? '');
        targets.push(target);
        if (target.startsWith('wasm')) throw new TypeError('this lane refuses the replacement');
        return await runtime.compilation.compileArtifact(source, request);
      },
    });

    const error = await reconcileMethodsFromSource({
      ...options,
      compilation: wasmRejected,
      methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: a}],
    }).then(() => null, (cause) => cause);

    assert.match(error?.message ?? '', /this lane refuses the replacement/,
      'the observed lane\'s rejection is the answer, not a diagnostic from a second attempt');
    // The retry itself, not only its outcome: a fallback implementation would ASK the compiler for a
    // neutral target after the WASM one refused, and this call asked for none.
    assert.ok(targets.length > 0, 'the guarded call really did reach the compiler');
    assert.deepEqual(targets.filter((target) => !target.startsWith('wasm')), [],
      'no compilation was requested in the other lane');
    assert.deepEqual(await methodBlockRef({...options, selector}), a, 'the observed revision is still current');
    assert.deepEqual(await laneOf(runtime, a), WASM, 'still in its own lane');
    await answers(runtime, selector, 1, 'and still answering what it always did');
    // NOT asserted: that nothing immutable was admitted. ADR 0086 publishes revision material before
    // the final CAS, and this owner does not promise an empty write. The load-bearing claim is the
    // narrow one above — the current binding did not move, and nothing in the other lane became it.

    // The other half of "no fallback": the identical source compiles perfectly well in the neutral
    // lane through the SAME faulted service, so the refusal above is a lane decision and not a
    // broken fixture.
    await defineMethodsFromSource({
      ...options, compilation: wasmRejected, lane: 'neutral',
      methods: [{selector: 'noFallbackSibling', source: '[ ^ 7 ]'}],
    });
    await answers(runtime, 'noFallbackSibling', 7, 'the other lane accepts exactly this source');
  });
});

// ---------------------------------------------------------------------------------------------
// The expectation is still the assumption
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: resolving the lane by re-reading the CURRENT position.
// That would refresh half of the caller's assumption — the half nothing guards — while continuing to
// enforce the other half, and on a moved position it would silently compile against a lane the
// caller never observed. The verdict alone cannot separate the two implementations (both refuse as
// stale), so this counts the Block records actually read: the OBSERVED revision must be read and the
// WINNER must not.
test('a stale position is refused on the observation, and the winner\'s lane is never consulted', async () => {
  await withKernel(async (runtime, options) => {
    const selector = 'staleBeatsLane';
    await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector, source: '[ ^ 1 ]'}]});
    const a = await methodBlockRef({...options, selector});
    assert.deepEqual(await laneOf(runtime, a), WASM);

    // An external, UNGUARDED writer moves the position, deliberately into the other lane so that a
    // fresh-read implementation would compile in a demonstrably different one.
    await reconcileMethodsFromSource({...options, lane: 'neutral', methods: [{selector, source: '[ ^ 2 ]'}]});
    const b = await methodBlockRef({...options, selector});
    assert.deepEqual(await laneOf(runtime, b), NEUTRAL);

    const read = [];
    const watched = {
      ...options,
      images: intercepting(runtime.images, {
        getBlock: async (imageId, blockId) => {
          read.push(blockId);
          return await runtime.images.getBlock(imageId, blockId);
        },
      }),
    };

    const error = await reconcileMethodsFromSource({
      ...watched, methods: [{selector, source: '[ ^ 3 ]', expectedCurrent: a}],
    }).then(() => null, (cause) => cause);

    assert.ok(error instanceof SmalltalkStaleMethodPositionError, `unexpected: ${error?.name}: ${error?.message}`);
    assert.ok(!(error instanceof SmalltalkMethodLaneError), 'staleness, not a lane verdict');
    assert.ok(read.includes(a.objectId), 'the lane came from the revision the caller observed');
    assert.ok(!read.includes(b.objectId), 'and never from a fresh read of the current winner');
    assert.deepEqual(await methodBlockRef({...options, selector}), b, 'the winner survives');
    await answers(runtime, selector, 2, 'and still answers');
  });
});

// ---------------------------------------------------------------------------------------------
// Refusal, never a default
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: two of them at once. "Default to neutral when the lane
// cannot be read" is the shipped behaviour wearing a preservation shape, and it would apply to
// exactly the records whose provenance is least trustworthy. And reading `metadata.lane` in
// ISOLATION would accept any Block that happens to carry the field, when what the observation has to
// be is a native method revision OF THIS POSITION.
//
// Every method binding this owner writes carries `{smalltalk: 'method', selector, lane}`, so a
// binding that does not arrived through a generic graph write — the same threat model
// `assertUniqueSelectorShape` and bead lagrange-images-jtz.2 already exist for. Each case below is
// bound at the position as the LIVE current binding, so nothing else refuses first.
//
// The ref's own shape (unpinned, local to this image) is NOT retested here: that rule belongs to
// `readExpectedCurrentBindings`, which already applied it, and a second copy is the duplication
// jtz.2 was closed to remove.
test('an observation that is not a native method revision of this position is refused, never defaulted', async () => {
  // Binds `ref` at `selector` through a generic graph write, keeping the dictionary itself
  // well-formed: only the method cell of that selector's triple changes, so hash, key and tally
  // still agree and the reader still sees an ordinary live binding.
  const plant = async (runtime, classRef, selector, ref) => {
    const behavior = await runtime.images.getObject('app', classRef.objectId);
    const dictionaryRef = behavior.slots['behavior-methods'];
    const record = await runtime.images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
    const indexed = [...record.indexed];
    let bound = 0;
    for (let index = 0; index < indexed.length; index += 3) {
      if (indexed[index + 1]?.value === selector) {
        indexed[index + 2] = ref;
        bound += 1;
      }
    }
    assert.equal(bound, 1, `the fixture needs exactly one occupied bucket for ${selector}`);
    await runtime.images.putObject('app', {
      id: record.id, shape: record.shape, slots: record.slots, indexed, metadata: record.metadata,
    }, {expectedVersion: record._version});
    return record.id;
  };

  const cases = [
    ['absent', async (runtime, options) => {
      // A well-formed local ref that names no record at all.
      const ref = objectRef('app', 'smalltalk/block/never-written');
      assert.equal(await runtime.images.getBlock('app', ref.objectId), null);
      return ref;
    }],
    ['not a method', async (runtime) => {
      // An ordinary standalone Block: real and dispatchable, but never installed as a method, so it
      // carries none of the method metadata. Unary, so the position really does answer through it.
      const planted = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app', id: 'planted-not-a-method', source: '[ 5 ]',
      });
      assert.equal((await runtime.images.getBlock('app', planted.block.id)).metadata?.smalltalk, undefined);
      return objectRef('app', planted.block.id);
    }],
    ['another selector', async (runtime, options) => {
      // A genuine native method revision — same class, same lane, correct metadata — of a DIFFERENT
      // selector. Only the selector check can refuse this one.
      await defineMethodsFromSource({
        ...options, lane: 'wasm', methods: [{selector: 'elsewhere', source: '[ ^ 6 ]'}],
      });
      const ref = await methodBlockRef({...options, selector: 'elsewhere'});
      const record = await runtime.images.getBlock(ref.imageId, ref.objectId);
      assert.deepEqual(
        [record.metadata.smalltalk, record.metadata.selector, record.metadata.lane],
        ['method', 'elsewhere', 'wasm'],
        'the fixture is a real method revision, and only its SELECTOR is wrong for this position',
      );
      return ref;
    }],
  ];

  for (const [label, build] of cases) {
    await withKernel(async (runtime, options) => {
      const selector = 'refused';
      await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector, source: '[ ^ 1 ]'}]});
      const observed = await build(runtime, options);
      const dictionaryId = await plant(runtime, options.classRef, selector, observed);
      assert.deepEqual(await methodBlockRef({...options, selector}), observed,
        `${label}: it really is the current binding`);

      const frontier = await runtime.images.frontier('app');
      const error = await reconcileMethodsFromSource({
        ...options, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: observed}],
      }).then(() => null, (cause) => cause);

      assert.ok(error instanceof SmalltalkMethodLaneError, `${label}: unexpected ${error?.name}: ${error?.message}`);
      assert.equal(error.name, 'SmalltalkMethodLaneError');
      assert.equal(error.cause, undefined, `${label}: a semantic refusal, carrying no backend cause`);
      assert.match(error.message, new RegExp(selector), `${label}: it names the caller's own position`);
      assert.ok(!error.message.includes(dictionaryId), `${label}: and not the method dictionary record`);
      assert.equal(await runtime.images.frontier('app'), frontier, `${label}: the refusal published nothing`);
      assert.deepEqual(await methodBlockRef({...options, selector}), observed, `${label}: and moved nothing`);
    });
  }
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: reading the lane back but ignoring an unknown value —
// the "default to neutral because we could not tell" branch, isolated from the shape checks above so
// that removing it reds exactly one proof.
test('a method revision recording an unknown execution lane is refused, never defaulted', async () => {
  await withKernel(async (runtime, options) => {
    const selector = 'unknownLane';
    await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector, source: '[ ^ 1 ]'}]});
    const a = await methodBlockRef({...options, selector});
    const record = await runtime.images.getBlock(a.imageId, a.objectId);
    // The same Block record in every respect except a lane nothing can compile in. Written at a
    // fresh id because revision Blocks are immutable, then bound at the position the way any other
    // generic graph write would bind one.
    const planted = await runtime.images.putBlock('app', {
      id: `${record.id}/unknown-lane`,
      code: record.code,
      environment: record.environment,
      metadata: {...record.metadata, lane: 'jvm'},
    });
    const plantedRef = objectRef('app', planted.id);
    const behavior = await runtime.images.getObject('app', options.classRef.objectId);
    const dictionaryRef = behavior.slots['behavior-methods'];
    const dictionary = await runtime.images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
    const indexed = [...dictionary.indexed];
    for (let index = 0; index < indexed.length; index += 3) {
      if (indexed[index + 1]?.value === selector) indexed[index + 2] = plantedRef;
    }
    await runtime.images.putObject('app', {
      id: dictionary.id, shape: dictionary.shape, slots: dictionary.slots, indexed, metadata: dictionary.metadata,
    }, {expectedVersion: dictionary._version});

    assert.deepEqual(await methodBlockRef({...options, selector}), plantedRef);
    await answers(runtime, selector, 1, 'it is a live binding that still executes');

    const frontier = await runtime.images.frontier('app');
    const error = await reconcileMethodsFromSource({
      ...options, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: plantedRef}],
    }).then(() => null, (cause) => cause);

    assert.ok(error instanceof SmalltalkMethodLaneError, `unexpected: ${error?.name}: ${error?.message}`);
    assert.equal(await runtime.images.frontier('app'), frontier, 'the refusal published nothing');
    assert.deepEqual(await methodBlockRef({...options, selector}), plantedRef, 'and moved nothing');
    await answers(runtime, selector, 1);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: widening the derivation until it overrules a lane an
// internal caller actually NAMED. The rule is scoped to the case that produced it — an existing
// revision replaced under an observation with no lane named — because that is the only case the
// public E3 seam can reach, and because silently changing what a naming caller gets would be a
// worse regression than the bug being fixed. `installMethods` gets its lane from exactly three
// places, and this pins the two that must not move.
test('a named lane is still honoured, and an unguarded call still gets the default it always had', async () => {
  await withKernel(async (runtime, options) => {
    for (const [selector, lane, other, otherShape] of [
      ['namedWasm', 'wasm', 'neutral', NEUTRAL],
      ['namedNeutral', 'neutral', 'wasm', WASM],
    ]) {
      await defineMethodsFromSource({...options, lane, methods: [{selector, source: '[ ^ 1 ]'}]});
      const a = await methodBlockRef({...options, selector});

      // A guarded replacement that NAMES the other lane gets the lane it named: an internal caller
      // has decided, and this owner does not overrule it. Only the public seam, which names none,
      // is guaranteed never to migrate.
      await reconcileMethodsFromSource({
        ...options, lane: other, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: a}],
      });
      const b = await methodBlockRef({...options, selector});
      assert.deepEqual(await laneOf(runtime, b), otherShape, `${lane}: the named lane is honoured`);
      await answers(runtime, selector, 7, `${lane}: and the result executes`);
    }

    // CREATION is untouched. `defineMethodsFromSource` cannot be guarded at all — the class builder
    // refuses `expectedCurrent` on the add-only path — so it keeps spelling its own neutral default.
    await defineMethodsFromSource({...options, methods: [{selector: 'createdDefault', source: '[ ^ 3 ]'}]});
    assert.deepEqual(await laneOf(runtime, await methodBlockRef({...options, selector: 'createdDefault'})), NEUTRAL);
    await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector: 'createdWasm', source: '[ ^ 4 ]'}]});
    assert.deepEqual(await laneOf(runtime, await methodBlockRef({...options, selector: 'createdWasm'})), WASM);
    await assert.rejects(defineMethodsFromSource({
      ...options,
      methods: [{
        selector: 'createdDefault',
        source: '[ ^ 5 ]',
        expectedCurrent: await methodBlockRef({...options, selector: 'createdDefault'}),
      }],
    }), /does not accept expectedCurrent/, 'which is why definition has no lane to preserve');

    // An UNGUARDED reconciliation is the creation-shaped half of the same entry point, and keeps
    // both of its answers: the lane it names, and neutral when it names none.
    await reconcileMethodsFromSource({...options, lane: 'wasm', methods: [{selector: 'unguardedWasm', source: '[ ^ 5 ]'}]});
    assert.deepEqual(await laneOf(runtime, await methodBlockRef({...options, selector: 'unguardedWasm'})), WASM);
    await reconcileMethodsFromSource({...options, methods: [{selector: 'unguardedDefault', source: '[ ^ 6 ]'}]});
    assert.deepEqual(await laneOf(runtime, await methodBlockRef({...options, selector: 'unguardedDefault'})), NEUTRAL);
    await answers(runtime, 'createdDefault', 3);
    await answers(runtime, 'createdWasm', 4);
    await answers(runtime, 'unguardedWasm', 5);
    await answers(runtime, 'unguardedDefault', 6);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: picking one lane for a batch whose observed revisions
// disagree, which preserves one position by migrating the other. One `installMethods` call derives
// revision identity, exact replay and code production from a single lane, so a batch that cannot be
// preserved whole is refused whole.
test('a guarded batch whose observed revisions are in different lanes is refused, not half-migrated', async () => {
  await withKernel(async (runtime, options) => {
    await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector: 'mixedWasm', source: '[ ^ 1 ]'}]});
    await defineMethodsFromSource({...options, lane: 'neutral', methods: [{selector: 'mixedNeutral', source: '[ ^ 2 ]'}]});
    const wasm = await methodBlockRef({...options, selector: 'mixedWasm'});
    const neutral = await methodBlockRef({...options, selector: 'mixedNeutral'});

    const frontier = await runtime.images.frontier('app');
    const error = await reconcileMethodsFromSource({
      ...options,
      methods: [
        {selector: 'mixedWasm', source: '[ ^ 7 ]', expectedCurrent: wasm},
        {selector: 'mixedNeutral', source: '[ ^ 8 ]', expectedCurrent: neutral},
      ],
    }).then(() => null, (cause) => cause);

    assert.ok(error instanceof SmalltalkMethodLaneError, `unexpected: ${error?.name}: ${error?.message}`);
    assert.equal(await runtime.images.frontier('app'), frontier, 'the refusal published nothing');
    assert.deepEqual(await methodBlockRef({...options, selector: 'mixedWasm'}), wasm);
    assert.deepEqual(await methodBlockRef({...options, selector: 'mixedNeutral'}), neutral);
    await answers(runtime, 'mixedWasm', 1);
    await answers(runtime, 'mixedNeutral', 2);
  });
});

// ---------------------------------------------------------------------------------------------
// Real imported Cuis pressure
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a preservation rule proven only on methods this test
// file installed itself. The consumer that produced this question is the Object Environment editing
// a CUIS-IMPORTED method (GitHub #218, slice D of bead lagrange-images-qax), and every Cuis-imported
// method is installed in the WASM lane by `importCuisNativePackage`. This drives the whole real
// adapter — canonical `smalltalk/cuis-semantic-export-v2` manifest, header translation, native class
// and method owners — with no Cuis runtime present, and then replaces one of its methods.
//
// It also pins the honest consequence: the imported method's revision after replacement is a native
// revision of a Cuis-ORIGIN method, still executing through the same WASM lane the import chose.
test('a Cuis-imported WASM method stays in the WASM lane when it is replaced', async () => {
  await withKernel(async (runtime, options) => {
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'neutral',
    });
    const manifest = {
      format: CUIS_SEMANTIC_EXPORT_V2,
      packages: [{name: 'Fixture', requires: ['Cuis-Base']}],
      classes: [{
        identity: 'cuis-class/Fixture/LaneUnit',
        package: 'Fixture',
        name: 'LaneUnit',
        superclassName: 'Object',
        superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
        instanceVariables: [],
      }],
      methods: [{
        identity: 'cuis-method/Fixture/LaneUnit/instance/answer',
        package: 'Fixture',
        class: 'cuis-class/Fixture/LaneUnit',
        side: 'instance',
        selector: 'answer',
        source: `answer\n\t^ ${CUIS_INTEGER_ANSWER}`,
      }],
    };

    const imported = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest,
    });
    const unit = imported.classes.find(({identity}) => identity === 'cuis-class/Fixture/LaneUnit');
    const classOptions = {...options, classRef: unit.classRef};

    const allocate = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'allocate-lane-unit', source: '[ :class | class basicNew ]',
    });
    const instance = await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('app', allocate.block.id), [unit.classRef],
    ));

    const a = await methodBlockRef({...classOptions, selector: 'answer'});
    assert.deepEqual(await laneOf(runtime, a), WASM, 'the importer installs Cuis methods in the WASM lane');
    assert.deepEqual(await answerOf(runtime, 'answer', instance), integerValue(CUIS_INTEGER_ANSWER));

    await reconcileMethodsFromSource({
      ...classOptions, methods: [{selector: 'answer', source: '[ ^ 42 ]', expectedCurrent: a}],
    });

    const b = await methodBlockRef({...classOptions, selector: 'answer'});
    assert.notDeepEqual(b, a, 'the imported position advanced');
    assert.deepEqual(await laneOf(runtime, b), WASM,
      'and an edited Cuis-imported method is still executed through the lane it was imported into');
    assert.deepEqual(await answerOf(runtime, 'answer', instance), integerValue(42));
  });
});

// A guard on the fixture above, not a second proof of the rule: if the adapter ever stopped
// installing in the WASM lane, the Cuis proof would keep passing for the wrong reason.
test('the Cuis adapter fixture really is WASM-lane material', async () => {
  await withKernel(async (runtime) => {
    const manifest = {
      format: CUIS_SEMANTIC_EXPORT_V2,
      packages: [{name: 'Fixture', requires: ['Cuis-Base']}],
      classes: [{
        identity: 'cuis-class/Fixture/LaneProbe',
        package: 'Fixture',
        name: 'LaneProbe',
        superclassName: 'Object',
        superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
        instanceVariables: [],
      }],
      methods: [{
        identity: 'cuis-method/Fixture/LaneProbe/instance/answer',
        package: 'Fixture',
        class: 'cuis-class/Fixture/LaneProbe',
        side: 'instance',
        selector: 'answer',
        source: 'answer\n\t^ 1',
      }],
    };
    await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest,
    });
    const blocks = (await runtime.images.listRecords('app')).filter((record) =>
      record.kind === 'block' && record.metadata?.smalltalk === 'method' && record.metadata.selector === 'answer');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].metadata.lane, 'wasm');
  });
});
