import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {LexicalCellArena, arenaImagesView} from '../src/execution/lexical-cells.js';
import {TRANSIENT_ID_PREFIX, findTransientRefs, transientObjectId} from '../src/value/transient-ref.js';

// ADR 0052, built substrate-first. What is under test here is the *seam*, before promotion exists:
// a closure instance that lives only in the arena must be an ordinary Value to everything above it,
// and reaching it must cost no durable write.
//
// Proving that now, rather than after `createClosure` switches over, is the point. If these pass
// while every closure is still eagerly persisted, the arena-first path is genuinely being used
// rather than being hidden by eager promotion making every lookup succeed durably.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

const PLUS = {
  selector: '+',
  program: {
    parameters: [{id: 'plus:arg', name: 'n'}],
    captures: [],
    body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}},
  },
};

async function seed(runtime, imageId) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane: 'neutral'};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkControlFlow(options);
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  return kernel;
}

const recordCount = async (runtime, imageId) => (await runtime.images.listRecords(imageId)).length;

// --- the write seam owns the namespace (decision 5b) ----------------------------------------------

test('no durable record may be written at a reserved transient id', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const id = transientObjectId('squatter');
    await assert.rejects(
      runtime.images.putShape('app', {id, slots: []}),
      /runtime-reserved transient id/,
    );
    await assert.rejects(
      runtime.images.putCodeArtifact('app', {id, languageId: 'x', representation: 'y', content: textValue('x')}),
      /runtime-reserved transient id/,
    );
    await assert.rejects(
      runtime.images.putLexicalEnvironment('app', {id, bindings: {}}),
      /runtime-reserved transient id/,
    );
    assert.ok(!await runtime.images.getRecord('app', id), 'nothing was written at the reserved id');
  });
});

// ADR 0052 reserves the namespace for REF object ids, not for every storage key. An image id is not
// an object id and never appears as one in a REF, so an image may be named anything — including
// something that looks like a reserved object id. Scoping the check wrongly would make a legal image
// name unusable for a rule that was never about image names.
test('a reserved-looking image name stays legal, while a record inside it does not', async () => {
  await withRuntime(async (runtime) => {
    const imageId = `${TRANSIENT_ID_PREFIX}perfectly-valid-image`;
    await runtime.images.createImage({id: imageId});
    assert.equal((await runtime.images.getImage(imageId)).id, imageId);

    // Ordinary records inside that image are unaffected.
    const shape = await runtime.images.putShape(imageId, {id: 'ordinary-shape', slots: []});
    assert.equal(shape.id, 'ordinary-shape');
    // Setting a root still works, so the second image-collection writer is unaffected too.
    await runtime.images.putObject(imageId, {
      id: 'root', shape: objectRef(imageId, 'ordinary-shape'), slots: {}, metadata: {},
    }, {expectedVersion: 0});
    await runtime.images.setRoot(imageId, 'root');
    assert.equal((await runtime.images.getImage(imageId)).rootObjectId, 'root');

    // But a *record* at a reserved object id is refused, in this image like any other.
    await assert.rejects(
      runtime.images.putShape(imageId, {id: transientObjectId('inside'), slots: []}),
      /runtime-reserved transient id/,
    );
  });
});

test('no durable record may embed an unpromoted transient reference', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const transient = objectRef('app', transientObjectId('instance'));

    // A slot, an indexed part, a binding and a Block edge: four different record kinds, one guard.
    await runtime.images.putShape('app', {id: 'holder-shape', slots: [{id: 's', name: 's'}]});
    await assert.rejects(
      runtime.images.putObject('app', {
        id: 'holder', shape: objectRef('app', 'holder-shape'), slots: {s: transient}, metadata: {},
      }, {expectedVersion: 0}),
      /unpromoted transient reference/,
    );
    await assert.rejects(
      runtime.images.putLexicalEnvironment('app', {
        id: 'holder-env', bindings: {b: {name: 'b', value: transient}},
      }),
      /unpromoted transient reference/,
    );
    // A transient ref in `code` is refused by the pre-existing referential check, which is a
    // different guard reaching the same outcome; a transient ref in a field with no such check is
    // refused by this one. Both are asserted, because the new guard's job is the second case.
    await assert.rejects(
      runtime.images.putBlock('app', {id: 'holder-block', code: transient, environment: null}),
      /must reference a code-artifact|unpromoted transient reference/,
    );
    // An indexed part is the surface with no pre-existing referential check of its own, so it is
    // the one where this guard is the only thing standing between a transient instance and a
    // dangling durable edge.
    await runtime.images.putShape('app', {id: 'values-shape', slots: [], indexed: 'values'});
    await assert.rejects(
      runtime.images.putObject('app', {
        id: 'indexed-holder',
        shape: objectRef('app', 'values-shape'),
        slots: {},
        indexed: [transient],
        metadata: {},
      }, {expectedVersion: 0}),
      /unpromoted transient reference/,
    );
    // Metadata already refuses refs of any kind, so a transient one is refused there too — by the
    // older rule rather than this one. Asserted so the coverage claim stays honest about which
    // guard is doing the work.
    await assert.rejects(
      runtime.images.putCodeArtifact('app', {
        id: 'holder-code', languageId: 'x', representation: 'y', content: textValue('x'),
        metadata: {nested: {deep: transient}},
      }),
      /must not contain object references/,
    );
  });
});

// The embedded-ref half of the guard is not scoped: a transient ref dangles wherever it is stored,
// image records included.
test('an image record may not embed an unpromoted transient reference either', async () => {
  await withRuntime(async (runtime) => {
    await assert.rejects(
      runtime.images.createImage({
        id: 'holder-image', metadata: {held: objectRef('holder-image', transientObjectId('x'))},
      }),
      /unpromoted transient reference|must not contain object references/,
    );
  });
});

test('the transient-ref walk finds refs wherever a record carries them', () => {
  const transient = objectRef('img', transientObjectId('x'));
  const durable = objectRef('img', 'ordinary');
  assert.equal(findTransientRefs({slots: {a: durable}}).length, 0);
  assert.equal(findTransientRefs({slots: {a: transient}}).length, 1);
  assert.equal(findTransientRefs({indexed: [durable, transient]}).length, 1);
  assert.equal(findTransientRefs({bindings: {b: {name: 'b', value: transient}}}).length, 1);
  assert.equal(findTransientRefs({metadata: {deep: {deeper: [transient]}}}).length, 1);
  assert.ok(transientObjectId('x').startsWith(TRANSIENT_ID_PREFIX));
});

// --- arena-first resolution (decision 5a) ---------------------------------------------------------

test('the arena view resolves transient records and falls through to durable ones', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const arena = new LexicalCellArena();
    const view = arenaImagesView(runtime.images, arena);

    const environment = arena.mintClosureEnvironment('app', {
      bindings: {'b:1': {name: 'captured', value: integerValue(7)}},
    });
    const block = arena.mintClosureBlock('app', {code: objectRef('app', 'whatever:code'), environment});

    assert.equal((await view.getBlock('app', block.objectId)).kind, 'block');
    assert.equal((await view.getLexicalEnvironment('app', environment.objectId)).kind, 'lexical-environment');
    // Durable resolution is unchanged.
    assert.ok(await view.getBlock('app', 'smalltalk/primitive/block-while-true'));
    // And no durable record was created for either.
    assert.ok(!await runtime.images.getRecord('app', block.objectId));
    assert.ok(!await runtime.images.getRecord('app', environment.objectId));
  });
});

test('a transient ref outliving its arena is an expired instance, not a missing Block', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // A fresh arena: the instance below belongs to a different, finished one.
    const view = arenaImagesView(runtime.images, new LexicalCellArena());
    await assert.rejects(
      view.getBlock('app', transientObjectId('block/1/some-other-arena')),
      (error) => {
        assert.equal(error.name, 'ExpiredClosureInstanceError');
        assert.match(error.message, /has expired; its execution has ended/);
        assert.ok(!/not found/.test(error.message), 'expiry must not read as a missing record');
        return true;
      },
    );
    // Without an arena there is nothing to resolve against, so behaviour is plain durable lookup.
    assert.equal(arenaImagesView(runtime.images, null), runtime.images);
  });
});

// --- the invariant that proves the seam is real ---------------------------------------------------

// The early check: an ordinary send carrying a transient Block must perform no durable write. If
// this passes while `createClosure` still persists eagerly, the arena-first path is doing the work.
test('sending to a transient Block performs zero durable writes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // A durable prototype, exactly as a compiled Block literal produces.
    const prototype = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'proto', source: '[ 6 + 1 ]',
    });

    const arena = new LexicalCellArena();
    const view = arenaImagesView(runtime.images, arena);
    const instance = arena.mintClosureBlock('app', {
      code: objectRef('app', prototype.codeArtifact.id),
      environment: null,
      metadata: {prototypeBlockId: 'proto'},
    });

    const before = await recordCount(runtime, 'app');

    // Dispatched as an ordinary Value: the dispatcher must recognize it as a Block and answer
    // `value`, having consulted the arena rather than the graph.
    const dispatched = await runtime.invocations.prepareDispatch({
      languageId: 'symmetric-smalltalk',
      receiver: instance,
      message: textValue('value'),
      arguments: [],
    }, {dispatchImage: 'app', images: view});
    const answer = await runtime.executor.execute(dispatched.activation, {
      dispatchImage: 'app', cellArena: arena, invocationFrame: dispatched.frame,
    });

    assert.deepEqual(answer, integerValue(7));
    assert.equal(await recordCount(runtime, 'app'), before, 'invoking a transient closure wrote a record');
  });
});

test('a transient Block passed as an argument performs zero durable writes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const prototype = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'arg-proto', source: '[ 41 + 1 ]',
    });
    const arena = new LexicalCellArena();
    const view = arenaImagesView(runtime.images, arena);
    const instance = arena.mintClosureBlock('app', {
      code: objectRef('app', prototype.codeArtifact.id), environment: null,
    });

    // A driver that receives the transient closure as an argument and sends `value` to it — an
    // ordinary nested send, which is the shape the invariant is really about.
    const driver = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'driver', source: '[ :b | b value ]',
    });

    const before = await recordCount(runtime, 'app');
    const activation = await runtime.invocations.prepareActivation({
      block: objectRef('app', driver.block.id), arguments: [instance], images: view,
    });
    const answer = await runtime.executor.execute(activation, {dispatchImage: 'app', cellArena: arena});

    assert.deepEqual(answer, integerValue(42));
    assert.equal(await recordCount(runtime, 'app'), before, 'a nested send with a transient argument wrote a record');
  });
});

test('a transient closure resolves its captures without a durable environment', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const prototype = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'cap-proto', source: '[ captured + 1 ]',
      captures: {captured: 'cap:binding'},
      environment: objectRef('app', (await runtime.images.putLexicalEnvironment('app', {
        id: 'cap-env-durable', bindings: {'cap:binding': {name: 'captured', value: integerValue(0)}},
      })).id),
    });

    const arena = new LexicalCellArena();
    const view = arenaImagesView(runtime.images, arena);
    // The instance's own bindings differ from the prototype's, which is what makes two instances of
    // one site distinguishable at all.
    const environment = arena.mintClosureEnvironment('app', {
      bindings: {'cap:binding': {name: 'captured', value: integerValue(10)}},
    });
    const instance = arena.mintClosureBlock('app', {
      code: objectRef('app', prototype.codeArtifact.id), environment,
    });

    const before = await recordCount(runtime, 'app');
    const activation = await runtime.invocations.prepareActivation({block: instance, images: view});
    assert.deepEqual(
      await runtime.executor.execute(activation, {dispatchImage: 'app', cellArena: arena}),
      integerValue(11),
      'the transient environment supplied the capture',
    );
    assert.equal(await recordCount(runtime, 'app'), before);
  });
});

// Two instances of one prototype with different captures, both live, both correct — the invariant
// per-site deterministic ids would have broken (ADR 0052 decision 3).
test('two live transient instances of one prototype stay independent', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const prototype = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'twin-proto', source: '[ captured + 0 ]',
      captures: {captured: 'twin:binding'},
      environment: objectRef('app', (await runtime.images.putLexicalEnvironment('app', {
        id: 'twin-env', bindings: {'twin:binding': {name: 'captured', value: integerValue(0)}},
      })).id),
    });
    const arena = new LexicalCellArena();
    const view = arenaImagesView(runtime.images, arena);
    const instanceFor = (value) => arena.mintClosureBlock('app', {
      code: objectRef('app', prototype.codeArtifact.id),
      environment: arena.mintClosureEnvironment('app', {
        bindings: {'twin:binding': {name: 'captured', value: integerValue(value)}},
      }),
    });

    const left = instanceFor(10);
    const right = instanceFor(20);
    assert.notEqual(left.objectId, right.objectId, 'two instances are two identities');

    const run = async (instance) => await runtime.executor.execute(
      await runtime.invocations.prepareActivation({block: instance, images: view}),
      {dispatchImage: 'app', cellArena: arena},
    );
    assert.deepEqual(await run(left), integerValue(10));
    assert.deepEqual(await run(right), integerValue(20));
    // Still independent after both have run, so neither displaced the other.
    assert.deepEqual(await run(left), integerValue(10));
  });
});
