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

    await reconcileMethodsFromSource({
      ...options, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: a}],
    });

    const b = await methodBlockRef({...options, selector});
    assert.notDeepEqual(b, a, 'the position advanced to a fresh immutable revision');
    assert.deepEqual(await laneOf(runtime, b), WASM, 'and the replacement kept the observed lane');
    await answers(runtime, selector, 7, 'native execution answers the replacement');
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

    await reconcileMethodsFromSource({
      ...options, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: a}],
    });

    const b = await methodBlockRef({...options, selector});
    assert.notDeepEqual(b, a);
    assert.deepEqual(await laneOf(runtime, b), NEUTRAL, 'and the replacement kept the observed lane');
    await answers(runtime, selector, 7, 'native execution answers the replacement');
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

    const wasmRejected = intercepting(runtime.compilation, {
      compileArtifact: async (source, request) => {
        if (String(request?.targetRepresentation ?? '').startsWith('wasm')) {
          throw new TypeError('this lane refuses the replacement');
        }
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
    assert.deepEqual(await methodBlockRef({...options, selector}), a, 'the observed revision is still current');
    assert.deepEqual(await laneOf(runtime, a), WASM, 'still in its own lane');
    await answers(runtime, selector, 1, 'and still answering what it always did');

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

// WRONG IMPLEMENTATION THIS TEST MUST KILL: "default to neutral when the lane cannot be read". That
// is the shipped behaviour wearing a preservation shape, and it would apply to exactly the records
// whose provenance is least trustworthy. Every method binding this owner writes carries its lane, so
// a binding without one came from a generic graph write — the same threat model
// `assertUniqueSelectorShape` and bead lagrange-images-jtz.2 already exist for.
test('a binding whose revision records no lane is refused rather than defaulted', async () => {
  await withKernel(async (runtime, options) => {
    const selector = 'laneless';
    await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector, source: '[ ^ 1 ]'}]});

    // A perfectly ordinary standalone Block — a real, dispatchable Block that simply is not a method
    // revision this owner installed, so it records no lane. Unary arity, so dispatch really does
    // reach it and the fixture proves the position is LIVE rather than merely occupied.
    const planted = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'planted-lane-less', source: '[ 5 ]',
    });
    const plantedRef = objectRef('app', planted.block.id);
    assert.equal((await runtime.images.getBlock('app', planted.block.id)).metadata?.lane, undefined);

    // A generic graph write binds it at the position, keeping the dictionary itself well-formed:
    // only the method cell of the selector's triple changes, so hash, key and tally still agree.
    const behavior = await runtime.images.getObject('app', options.classRef.objectId);
    const dictionaryRef = behavior.slots['behavior-methods'];
    const record = await runtime.images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
    const indexed = [...record.indexed];
    let bound = 0;
    for (let index = 0; index < indexed.length; index += 3) {
      if (indexed[index + 1]?.value === selector) {
        indexed[index + 2] = plantedRef;
        bound += 1;
      }
    }
    assert.equal(bound, 1, 'the fixture needs exactly one occupied bucket for this selector');
    await runtime.images.putObject('app', {
      id: record.id, shape: record.shape, slots: record.slots, indexed, metadata: record.metadata,
    }, {expectedVersion: record._version});

    assert.deepEqual(await methodBlockRef({...options, selector}), plantedRef, 'it really is the current binding');
    await answers(runtime, selector, 5, 'and it really does dispatch');

    const frontier = await runtime.images.frontier('app');
    const error = await reconcileMethodsFromSource({
      ...options, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: plantedRef}],
    }).then(() => null, (cause) => cause);

    assert.ok(error instanceof SmalltalkMethodLaneError, `unexpected: ${error?.name}: ${error?.message}`);
    assert.equal(error.name, 'SmalltalkMethodLaneError');
    assert.equal(error.cause, undefined, 'a semantic refusal, carrying no backend cause');
    assert.match(error.message, new RegExp(selector), 'it names the position the caller supplied');
    assert.ok(!error.message.includes(record.id), 'and not the class\'s method dictionary record');
    assert.equal(await runtime.images.frontier('app'), frontier, 'the refusal published nothing');
    assert.deepEqual(await methodBlockRef({...options, selector}), plantedRef, 'and moved nothing');
    await answers(runtime, selector, 5);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: honouring a caller-named lane over the observed one,
// which is a lane MIGRATION dressed as a replacement. Changing the execution representation of an
// existing method is a separate operation with its own policy, and there is none; a caller that
// names a lane at all must name the one it observed.
test('a replacement may not be steered into a lane the observed revision is not in', async () => {
  await withKernel(async (runtime, options) => {
    for (const [selector, lane, other] of [['steerWasm', 'wasm', 'neutral'], ['steerNeutral', 'neutral', 'wasm']]) {
      await defineMethodsFromSource({...options, lane, methods: [{selector, source: '[ ^ 1 ]'}]});
      const a = await methodBlockRef({...options, selector});

      const frontier = await runtime.images.frontier('app');
      const error = await reconcileMethodsFromSource({
        ...options, lane: other, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: a}],
      }).then(() => null, (cause) => cause);

      assert.ok(error instanceof SmalltalkMethodLaneError, `${lane}: unexpected ${error?.name}: ${error?.message}`);
      assert.equal(await runtime.images.frontier('app'), frontier, `${lane}: the refusal published nothing`);
      assert.deepEqual(await methodBlockRef({...options, selector}), a, `${lane}: and moved nothing`);

      // Naming the lane it actually observed is not a migration and is accepted.
      await reconcileMethodsFromSource({
        ...options, lane, methods: [{selector, source: '[ ^ 7 ]', expectedCurrent: a}],
      });
      await answers(runtime, selector, 7, `${lane}: the honest form of the same call succeeds`);
    }
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

// WRONG IMPLEMENTATION THIS TEST MUST KILL: making lane preservation a property of the from-source
// path rather than of a GUARDED call, so that the importer's own unguarded reconciliation — the one
// that installs every Cuis method in the WASM lane — started answering something else.
test('an unguarded call keeps the lane it named, and the neutral default when it names none', async () => {
  await withKernel(async (runtime, options) => {
    await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector: 'unguarded', source: '[ ^ 1 ]'}]});
    await reconcileMethodsFromSource({...options, lane: 'wasm', methods: [{selector: 'unguarded', source: '[ ^ 2 ]'}]});
    assert.deepEqual(await laneOf(runtime, await methodBlockRef({...options, selector: 'unguarded'})), WASM);

    await reconcileMethodsFromSource({...options, methods: [{selector: 'undeclared', source: '[ ^ 3 ]'}]});
    assert.deepEqual(await laneOf(runtime, await methodBlockRef({...options, selector: 'undeclared'})), NEUTRAL,
      'no expectation and no lane is still the from-source default it always was');
    await answers(runtime, 'unguarded', 2);
    await answers(runtime, 'undeclared', 3);
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
