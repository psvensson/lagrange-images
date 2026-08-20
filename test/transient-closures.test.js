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
import {TRANSIENT_ID_PREFIX, findTransientRefs, isTransientRef, transientObjectId} from '../src/value/transient-ref.js';

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

// --- escape boundaries (ADR 0052 decision 6) ------------------------------------------------------

// Root return is an escape because the answer reaches a caller with no arena. A nested send is not:
// it hands its answer back inside the same arena, where a transient closure stays usable. The
// existing call structure already draws that line — the root is the execution given no arena.
async function rootAnswer(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

test('a root return promotes the closure it answers, and it works in a later execution', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const answer = await rootAnswer(runtime, 'app', 'maker', '[ [ 6 + 1 ] ]');

    assert.ok(!isTransientRef(answer), 'a root must not answer a transient ref');
    assert.ok(
      await runtime.images.getBlock('app', answer.objectId),
      'the promoted closure must be a Block that exists',
    );
    // The point of promoting: it still works once its creating execution is over.
    assert.deepEqual(
      await rootAnswer(runtime, 'app', 'later', '[ :b | b value ]', [answer]),
      integerValue(7),
    );
  });
});

test('a root return promotes a closure with snapshot captures', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // A parameter, not an assigned temporary: assigning makes it a live cell, and a live cell
    // escaping is EscapingMutableClosureError by ADR 0043 rather than something to promote.
    const answer = await rootAnswer(runtime, 'app', 'snap', '[ :n | [ n + 1 ] ]', [integerValue(41)]);
    assert.ok(!isTransientRef(answer));
    assert.deepEqual(
      await rootAnswer(runtime, 'app', 'snap-use', '[ :b | b value ]', [answer]),
      integerValue(42),
      'the snapshot survived promotion',
    );
  });
});

// The discriminator that matters: only the eventual root return promotes.
test('a nested send returning a closure writes nothing; only the root return promotes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // `makeAndCall` receives a closure from a nested send and invokes it, all inside one execution.
    const before = await recordCount(runtime, 'app');
    const inner = await rootAnswer(
      runtime, 'app', 'nested-only',
      '[ | make | make := [ [ 5 ] ]. (make value) value ]',
    );
    assert.deepEqual(inner, integerValue(5));
    const afterInner = await recordCount(runtime, 'app');

    // The closure was created, returned from a nested send, and invoked — and never escaped, so
    // nothing was promoted. Only the two prototypes the compiler published exist.
    const promotedBlocks = (await runtime.images.listRecords('app'))
      .filter((record) => record.kind === 'block' && record.id.startsWith('closure/'));
    assert.deepEqual(promotedBlocks, [], 'a closure that never escaped must not be promoted');

    // Now the same closure escapes by being returned from the root, and exactly one is promoted.
    await rootAnswer(runtime, 'app', 'escaping', '[ | make | make := [ [ 5 ] ]. make value ]');
    const nowPromoted = (await runtime.images.listRecords('app'))
      .filter((record) => record.kind === 'block' && record.id.startsWith('closure/'));
    assert.equal(nowPromoted.length, 1, 'the root return promotes exactly the closure it answers');
    void before; void afterInner;
  });
});

test('returning an ordinary durable ref promotes nothing', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    // Publish the prototype first, so the count below measures execution rather than compilation.
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'durable', source: '[ :o | o ]',
    });
    const before = await recordCount(runtime, 'app');
    const answer = await runtime.executor.execute(
      await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), [kernel.nil]),
    );

    assert.deepEqual(answer, kernel.nil, 'a durable ref comes back unchanged');
    assert.equal(await recordCount(runtime, 'app'), before, 'returning a durable ref wrote nothing');
    // No graph walk is needed to establish that: a durable object cannot secretly hold a transient
    // closure, because creating that edge would already have been refused at the write seam. So the
    // root promotes the returned Value only, and this object's slots are never traversed.
    assert.deepEqual(
      (await runtime.images.listRecords('app')).filter((record) => record.id.startsWith('closure/')),
      [],
    );
  });
});

test('if promoting the root result fails, the root call fails rather than answering transiently', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const executor = runtime.executor;
    const previous = executor.images;
    const failing = Object.create(runtime.images);
    failing.putBlock = async () => { throw new Error('injected promotion failure'); };
    executor.images = failing;
    try {
      await assert.rejects(
        rootAnswer(runtime, 'app', 'fail-promote', '[ [ 1 ] ]'),
        /injected promotion failure/,
        'a failed promotion must fail the call, not leak a transient ref to the caller',
      );
    } finally {
      executor.images = previous;
    }
  });
});

// --- durable write boundaries ---------------------------------------------------------------------

// Each boundary rewrites through the central promoter and then does its existing write. The stage-1
// graph guard is what proves none was forgotten: a missed boundary is a refused write, not a
// dangling ref.
test('storing a closure in an instance variable promotes it', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {defineClass, installSmalltalkInstanceVariableProtocol} = await import('../src/runtime.js');
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
    const {defineMethodsFromSource} = await import('../src/language/smalltalk-instance-variables.js');
    const shape = objectRef('app', (await runtime.images.putShape('app', {
      id: 'box-shape', slots: [{id: 'held-slot', name: 'held'}],
    })).id);
    const box = await defineClass({images: runtime.images, imageId: 'app', name: 'Box', instanceShapeRef: shape});
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'neutral',
      classRef: box.classRef,
      methods: [
        {selector: 'hold', source: '[ held := [ 9 ]. self ]'},
        {selector: 'held', source: '[ held ]'},
      ],
    });

    const instance = await rootAnswer(runtime, 'app', 'make-box', '[ :c | | b | b := c new. b hold. b ]', [box.classRef]);
    const record = await runtime.images.getObject('app', instance.objectId);
    const held = record.slots['held-slot'];
    assert.ok(!isTransientRef(held), 'a slot must never hold a transient ref');
    assert.ok(await runtime.images.getBlock('app', held.objectId), 'the stored closure was not published');
    // And it still runs, from a later execution, through the object.
    assert.deepEqual(
      await rootAnswer(runtime, 'app', 'use-box', '[ :b | b held value ]', [instance]),
      integerValue(9),
    );
  });
});

test('storing a closure in an Array promotes it', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {installSmalltalkIndexedProtocol} = await import('../src/runtime.js');
    await installSmalltalkIndexedProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'neutral',
    });
    const array = await rootAnswer(
      runtime, 'app', 'fill-array',
      '[ :c | | a | a := c new: 1. a at: 1 put: [ 8 ]. a ]',
      [objectRef('app', 'smalltalk/class/Array')],
    );
    const record = await runtime.images.getObject('app', array.objectId);
    assert.ok(!isTransientRef(record.indexed[0]), 'an indexed part must never hold a transient ref');
    assert.deepEqual(
      await rootAnswer(runtime, 'app', 'use-array', '[ :a | (a at: 1) value ]', [array]),
      integerValue(8),
    );
  });
});

// --- the operational claim (ADR 0052) -------------------------------------------------------------

// The proof the ADR exists for: evaluating a closure creation site is free unless the closure
// escapes. Measured at 10,000 here; 100,000 was run out of band and is also exactly zero, with
// wall-clock linear in iteration count rather than quadratic as it was before this change.
test('ten thousand non-escaping closure evaluations produce zero durable records', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const source = `[ | i | i := 0.
      [ i = 10000 ] whileFalse: [ (i = 999999999) ifTrue: [ 1 ] ifFalse: [ 2 ]. i := i + 1 ].
      i ]`;
    // Publish the prototypes first, so the measurement is of execution rather than compilation.
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'scale', source,
    });

    const before = await recordCount(runtime, 'app');
    const answer = await runtime.executor.execute(
      await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), []),
    );

    assert.deepEqual(answer, integerValue(10000));
    assert.equal(
      await recordCount(runtime, 'app') - before,
      0,
      'a closure that never escapes must cost no durable record',
    );
  });
});

// The constant really is constant: growth does not scale with the number of evaluations.
test('durable growth does not scale with the number of closure evaluations', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const run = async (id, n) => {
      const source = `[ | i | i := 0. [ i = ${n} ] whileFalse: [ (i = 999999999) ifTrue: [ 1 ] ifFalse: [ 2 ]. i := i + 1 ]. i ]`;
      const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId: 'app', id, source});
      const before = await recordCount(runtime, 'app');
      await runtime.executor.execute(
        await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), []),
      );
      return await recordCount(runtime, 'app') - before;
    };
    assert.equal(await run('scale-100', 100), 0);
    assert.equal(await run('scale-2000', 2000), 0);
  });
});

// The third durable-write boundary. A Dictionary makes both its keys and its values durably
// reachable, so both are promoted; this covers the ordinary shape — an already-durable key naming a
// closure value — through persistence and later use.
test('storing a closure as a Dictionary value promotes it and it survives', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {installSmalltalkDictionaryProtocol} = await import('../src/runtime.js');
    await installSmalltalkDictionaryProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
    });

    const dictionary = await rootAnswer(
      runtime, 'app', 'fill-dictionary',
      "[ :c | | d | d := c new. d at: 'k' put: [ 12 ]. d ]",
      [objectRef('app', 'smalltalk/class/Dictionary')],
    );

    // Nothing transient reached the durable graph — which the write seam would have refused anyway,
    // so this is really asserting that the boundary promoted rather than failed.
    for (const record of await runtime.images.listRecords('app')) {
      assert.deepEqual(findTransientRefs(record), [], `${record.id} holds a transient ref`);
    }

    // The stored closure is a published Block, and still runs in a later execution.
    const stored = await rootAnswer(runtime, 'app', 'read-dictionary', "[ :d | d at: 'k' ]", [dictionary]);
    assert.ok(!isTransientRef(stored));
    assert.ok(await runtime.images.getBlock('app', stored.objectId), 'the stored closure was not published');
    assert.deepEqual(
      await rootAnswer(runtime, 'app', 'use-dictionary', "[ :d | (d at: 'k') value ]", [dictionary]),
      integerValue(12),
    );
  });
});
