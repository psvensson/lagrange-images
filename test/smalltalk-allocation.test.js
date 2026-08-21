import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  CompilationService,
  booleanValue,
  createDefaultCodeCompilerRegistry,
  createRuntime,
  defineClass,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  objectRef,
  pinnedRef,
  textValue,
} from '../src/runtime.js';
import {SMALLTALK_KERNEL_PRIMITIVE_V1} from '../src/language/smalltalk-primitives.js';
import {SYMMETRIC_SMALLTALK_ID} from '../src/language/symmetric-smalltalk.js';
import {methodBlockRef} from '../src/language/smalltalk-class-builder.js';

// ADR 0046: `basicNew`, `new` and `class` as ordinary messages over two language-owned primitive
// Blocks. What the tests below are really separating:
//
//   instanceShape nil vs empty Shape   not instantiable vs a valid zero-slot layout
//   fresh opaque identity              an instance is not a named declaration
//   image locality                     one rule, both primitives, or a foreign kernel answers
//   composition                        execution never learns the language

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function withRuntime(body, options = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, ...options});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seed(runtime, imageId, {lane = 'neutral', protocol = true} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  if (protocol) {
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId, lane,
    });
  }
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

async function evaluateThroughWasm(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const tree = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef(imageId, installed.semanticArtifact.id),
    id: `${id}:wasm-tree`,
  });
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, tree.block.id), args);
  return await runtime.executor.execute(activation);
}

async function shapeFor(runtime, imageId, id, slots) {
  return objectRef(imageId, (await runtime.images.putShape(imageId, {id, slots})).id);
}

const emptyShape = (runtime, imageId, id = 'empty-instance-shape') => shapeFor(runtime, imageId, id, []);

const pointShape = (runtime, imageId, id = 'point-shape') =>
  shapeFor(runtime, imageId, id, [{id: 'point-x', name: 'x'}, {id: 'point-y', name: 'y'}]);

// --- allocation -----------------------------------------------------------------------------

for (const lane of ['neutral', 'wasm']) {
  test(`basicNew allocates an instance of a zero-slot class through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      const shape = await emptyShape(runtime, 'app');
      const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});

      const first = await evaluate(runtime, 'app', `alloc-${lane}-1`, '[ :c | c basicNew ]', [point.classRef]);
      const second = await evaluate(runtime, 'app', `alloc-${lane}-2`, '[ :c | c basicNew ]', [point.classRef]);
      assert.equal(first.kind, 'ref');
      assert.notEqual(first.objectId, second.objectId, 'two sends must produce two identities');

      const record = await runtime.images.getObject('app', first.objectId);
      assert.deepEqual(record.behavior, point.classRef);
      assert.deepEqual(record.shape, shape);
      assert.deepEqual(record.slots, {}, 'an empty Shape is a valid zero-slot layout');
    });
  });
}

test('every slot of an allocated instance starts at that image nil', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const shape = await pointShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});

    const instance = await evaluate(runtime, 'app', 'alloc-slots', '[ :c | c basicNew ]', [point.classRef]);
    const record = await runtime.images.getObject('app', instance.objectId);
    assert.deepEqual(record.slots, {'point-x': kernel.nil, 'point-y': kernel.nil});

    // Not a policy choice this ADR could have made differently: assertObjectMatchesShape rejects an
    // object whose slot set differs from its Shape in either direction, so a partially populated
    // instance is not a representable record.
    const stored = await runtime.images.getShape('app', shape.objectId);
    assert.deepEqual(Object.keys(record.slots).sort(), stored.slots.map(({id}) => id).sort());
  });
});

// Decision 3, and the reason nil is not the empty shape: reinterpreting it would change the meaning
// of every Behavior ADR 0044 already stored, without rewriting a record.
test('a class whose instanceShape is nil refuses to allocate, and writes nothing', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const before = (await runtime.images.listObjects('app')).length;
    await assert.rejects(
      evaluate(runtime, 'app', 'not-instantiable', '[ :c | c basicNew ]', [kernel.objectClass]),
      (error) => error.name === 'SmalltalkNotInstantiableError',
    );
    assert.equal((await runtime.images.listObjects('app')).length, before, 'a refusal must allocate nothing');
  });
});

test('defineClass still leaves instanceShape nil when none is supplied', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const plain = await defineClass({images: runtime.images, imageId: 'app', name: 'Plain'});
    const record = await runtime.images.getObject('app', plain.classRef.objectId);
    assert.deepEqual(record.slots['behavior-instance-shape'], kernel.nil);
    await assert.rejects(
      evaluate(runtime, 'app', 'plain-new', '[ :c | c basicNew ]', [plain.classRef]),
      (error) => error.name === 'SmalltalkNotInstantiableError',
    );
  });
});

// The three graph failures mean different things to whoever has to fix them, so they stay apart.
test('a dangling instanceShape and a malformed Behavior fail differently from non-instantiable', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const shape = await pointShape(runtime, 'app');
    const ghost = await defineClass({images: runtime.images, imageId: 'app', name: 'Ghost', instanceShapeRef: shape});
    // Repoint the class at a Shape id that does not resolve.
    const record = await runtime.images.getObject('app', ghost.classRef.objectId);
    await runtime.images.putObject('app', {
      id: record.id,
      shape: record.shape,
      behavior: record.behavior,
      slots: {...record.slots, 'behavior-instance-shape': objectRef('app', 'no-such-shape')},
      metadata: record.metadata,
    }, {expectedVersion: record._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'dangling', '[ :c | c basicNew ]', [ghost.classRef]),
      (error) => error.name === 'SmalltalkDanglingEdgeError' && error.edge === 'instanceShape',
    );

    // A record that is not a well-formed Behavior at all. Reached by calling the primitive directly,
    // because ordinary `basicNew` dispatch on such a receiver fails as message-not-understood long
    // before the primitive would see it — which is also why the primitive validates independently.
    await runtime.images.putObject('app', {
      id: 'not-a-class',
      shape: objectRef('app', 'smalltalk/empty-shape/v1'),
      behavior: kernel.objectClass,
      slots: {},
      metadata: {},
    });
    await assert.rejects(
      runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: objectRef('app', 'smalltalk/primitive/basic-new'),
        message: textValue('value:'),
        arguments: [objectRef('app', 'not-a-class')],
      })),
      (error) => error.name === 'SmalltalkMalformedBehaviorError',
    );
  });
});

// --- new and initialize ---------------------------------------------------------------------

for (const lane of ['neutral', 'wasm']) {
  test(`new is basicNew followed by initialize through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      const shape = await emptyShape(runtime, 'app');
      const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});

      const instance = await evaluate(runtime, 'app', `new-${lane}`, '[ :c | c new ]', [point.classRef]);
      const record = await runtime.images.getObject('app', instance.objectId);
      assert.deepEqual(record.behavior, point.classRef, 'the default initialize answers self');
    });
  });
}

// `new` returns whatever `initialize` returns, because that is what the composition says. The
// runtime does not secretly substitute the allocated object afterwards.
test('initialize may be overridden, and new answers what it returns', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: point.classRef,
      methods: [{selector: 'initialize', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('initialized')}}}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'override-initialize', '[ :c | c new ]', [point.classRef]),
      textValue('initialized'),
    );
  });
});

// Decision 8: allocation and initialization are not one transaction. Hiding a rollback inside `new`
// would require a transaction across arbitrary user code.
test('a failing initialize does not roll the allocated object back', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: point.classRef,
      methods: [{
        selector: 'initialize',
        // A send of a selector nothing implements, so initialize fails after basicNew committed.
        program: {
          parameters: [],
          captures: [],
          body: {
            op: 'send',
            languageId: SYMMETRIC_SMALLTALK_ID,
            receiver: {op: 'receiver'},
            message: textValue('noSuchSelector'),
            arguments: [],
          },
        },
      }],
    });

    const before = new Set((await runtime.images.listObjects('app')).map(({id}) => id));
    await assert.rejects(
      evaluate(runtime, 'app', 'failing-initialize', '[ :c | c new ]', [point.classRef]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError',
    );
    const after = (await runtime.images.listObjects('app')).filter(({id}) => !before.has(id));
    assert.equal(after.length, 1, 'the allocated object survives a failed initialize');
    assert.deepEqual(after[0].behavior, point.classRef);
  });
});

// Decision 7: resumption continues after a completed effect; it never replays it. If the WASM lane
// re-executed the basicNew send on resume, this would allocate twice.
test('a WASM new allocates exactly once across suspension and resumption', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app', {lane: 'wasm'});
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});

    const before = new Set((await runtime.images.listObjects('app')).map(({id}) => id));
    const instance = await evaluateThroughWasm(runtime, 'app', 'wasm-new-once', '[ :c | c new ]', [point.classRef]);
    const created = (await runtime.images.listObjects('app')).filter(({id}) => !before.has(id));
    assert.equal(created.length, 1, 'a non-tail basicNew must not be replayed on resumption');
    assert.equal(created[0].id, instance.objectId);
  });
});

// --- class ----------------------------------------------------------------------------------

test('class answers the graph behavior for refs and the kernel class for immediates', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});
    const classOf = (id, source, args) => evaluate(runtime, 'app', id, source, args);

    assert.deepEqual(await classOf('c1', '[ :c | c basicNew class ]', [point.classRef]), point.classRef);
    assert.deepEqual(await classOf('c2', '[ :c | c class ]', [point.classRef]), point.metaclassRef);
    assert.deepEqual(await classOf('c3', '[ :c | c class class ]', [point.classRef]), kernel.metaclassClass);
    assert.deepEqual(await classOf('c4', '[ :n | n class ]', [integerValue(3)]), kernel.integerClass);
    assert.deepEqual(await classOf('c5', '[ :n | n class ]', [textValue('hi')]), kernel.textClass);
  });
});

// ADR 0045 stays load-bearing: the singleton is the effective receiver, so inherited Object >> class
// sees the object and answers True or False — without boxing the boolean Value.
test('true class is True and false class is False', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'true-class', '[ :b | b class ]', [booleanValue(true)]),
      objectRef('app', 'smalltalk/class/True'),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'false-class', '[ :b | b class ]', [booleanValue(false)]),
      objectRef('app', 'smalltalk/class/False'),
    );
  });
});

test('the compiler recognizes none of new, basicNew or class', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'shape-check', source: '[ :c | c new class ]',
    });
    const semantic = await runtime.images.getCodeArtifact('app', installed.semanticArtifact.id);
    const program = JSON.parse(semantic.content.value);
    assert.equal(program.body.op, 'send');
    assert.equal(program.body.message.value, 'class');
    assert.equal(program.body.receiver.op, 'send');
    assert.equal(program.body.receiver.message.value, 'new');
  });
});

test('a kernel without the allocation protocol answers none of these selectors', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app', {protocol: false});
    await assert.rejects(
      evaluate(runtime, 'app', 'no-protocol', '[ :c | c basicNew ]', [kernel.objectClass]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError',
    );
  });
});

// --- primitive boundary ---------------------------------------------------------------------

// Decision 11: one rule, both primitives, measured against the primitive Block's own image. A
// foreign class-of answering the foreign image's Integer would be silent rather than a failure,
// which is exactly the cross-image identity bug class this substrate rejects elsewhere.
test('a foreign primitive Block fails for class-of as well as for basic-new', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await seed(runtime, 'other');
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});

    // `other`'s primitives, sent local `app` values.
    const foreignClassOf = objectRef('other', 'smalltalk/primitive/class-of');
    const foreignBasicNew = objectRef('other', 'smalltalk/primitive/basic-new');

    await assert.rejects(
      runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: foreignBasicNew,
        message: textValue('value:'),
        arguments: [point.classRef],
      })),
      (error) => error.name === 'SmalltalkPrimitiveLocalityError',
    );

    await assert.rejects(
      runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: foreignClassOf,
        message: textValue('value:'),
        arguments: [point.classRef],
      })),
      (error) => error.name === 'SmalltalkPrimitiveLocalityError',
      'a foreign class-of must fail, not answer the foreign image class',
    );
  });
});

// An immediate Value carries no image, so a foreign class-of cannot be caught by a locality check on
// the argument. It must answer from its own image's kernel — which is a different class object than
// the local one, and that difference is the whole risk.
test('a foreign class-of answers its own image kernel, never the sender image', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await seed(runtime, 'other');
    const result = await runtime.executor.execute(await runtime.invocations.sendMessage({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: objectRef('other', 'smalltalk/primitive/class-of'),
      message: textValue('value:'),
      arguments: [integerValue(3)],
    }, {dispatchImage: 'app'}));
    assert.equal(result.imageId, 'other', 'the primitive image decides, not the dispatch image');
    assert.deepEqual(result, objectRef('other', 'smalltalk/class/Integer'));
  });
});

test('the primitives reject a pinned ref', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});
    const record = await runtime.images.getObject('app', point.classRef.objectId);

    for (const primitive of ['class-of', 'basic-new']) {
      await assert.rejects(
        runtime.executor.execute(await runtime.invocations.sendMessage({
          languageId: SYMMETRIC_SMALLTALK_ID,
          receiver: objectRef('app', `smalltalk/primitive/${primitive}`),
          message: textValue('value:'),
          arguments: [pinnedRef('app', record.id, record._version)],
        })),
        (error) => error.name === 'SmalltalkPrimitiveReceiverError',
        `${primitive} must refuse a pinned ref`,
      );
    }
  });
});

// --- identity -------------------------------------------------------------------------------

// Decision 6. A known collision means another candidate, never adopting the existing object as an
// idempotent retry — an instance is not a named declaration.
test('a colliding candidate identity is retried with a fresh one, never adopted', async () => {
  const identities = ['collides', 'collides', 'fresh-instance'];
  let index = 0;
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});
    // Somebody else already owns that id.
    await runtime.images.putObject('app', {
      id: 'collides',
      shape,
      slots: {},
      metadata: {owner: 'somebody else'},
    });

    const instance = await evaluate(runtime, 'app', 'collision', '[ :c | c basicNew ]', [point.classRef]);
    assert.equal(instance.objectId, 'fresh-instance');
    const squatter = await runtime.images.getObject('app', 'collides');
    assert.deepEqual(squatter.metadata, {owner: 'somebody else'}, 'the existing object must be untouched');
  }, {smalltalkObjectIds: () => identities[Math.min(index++, identities.length - 1)]});
});

// --- class definition -------------------------------------------------------------------------

// Decision 4: an instance shape is the complete layout, so a subclass must carry its superclass's
// slot ids. Compared by stable id, never by source name.
test('a subclass instance shape must preserve inherited slot ids', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const base = await pointShape(runtime, 'app', 'base-shape');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: base});

    const dropped = await shapeFor(runtime, 'app', 'dropped-shape', [{id: 'point-z', name: 'z'}]);
    await assert.rejects(
      defineClass({
        images: runtime.images, imageId: 'app', name: 'Point3D',
        superclassRef: point.classRef, instanceShapeRef: dropped,
      }),
      /drops inherited slot ids: point-x, point-y/,
    );

    const complete = await shapeFor(runtime, 'app', 'complete-shape', [
      {id: 'point-x', name: 'x'}, {id: 'point-y', name: 'y'}, {id: 'point-z', name: 'z'},
    ]);
    const solid = await defineClass({
      images: runtime.images, imageId: 'app', name: 'Point3D',
      superclassRef: point.classRef, instanceShapeRef: complete,
    });
    const instance = await evaluate(runtime, 'app', 'subclass-alloc', '[ :c | c basicNew ]', [solid.classRef]);
    const record = await runtime.images.getObject('app', instance.objectId);
    assert.deepEqual(Object.keys(record.slots).sort(), ['point-x', 'point-y', 'point-z']);
  });
});

// A non-instantiable class in the middle of a chain declares no layout of its own, but it does not
// cancel the one above it: C still inherits every method A defines, so C's instances still need A's
// slots. Stopping the check at the direct superclass let one `nil` link erase the invariant silently.
test('an inherited slot survives a non-instantiable class in the middle of the chain', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const aShape = await shapeFor(runtime, 'app', 'a-shape', [{id: 'slot-a', name: 'a'}]);
    const a = await defineClass({images: runtime.images, imageId: 'app', name: 'A', instanceShapeRef: aShape});
    // B declares no layout at all, which is the whole point of the case.
    const b = await defineClass({images: runtime.images, imageId: 'app', name: 'B', superclassRef: a.classRef});

    const partial = await shapeFor(runtime, 'app', 'c-partial', [{id: 'slot-c', name: 'c'}]);
    await assert.rejects(
      defineClass({
        images: runtime.images, imageId: 'app', name: 'C',
        superclassRef: b.classRef, instanceShapeRef: partial,
      }),
      /drops inherited slot ids: slot-a/,
      'a nil link must not cancel the layout above it',
    );

    const complete = await shapeFor(runtime, 'app', 'c-complete', [
      {id: 'slot-a', name: 'a'}, {id: 'slot-c', name: 'c'},
    ]);
    const c = await defineClass({
      images: runtime.images, imageId: 'app', name: 'C',
      superclassRef: b.classRef, instanceShapeRef: complete,
    });
    const instance = await evaluate(runtime, 'app', 'deep-alloc', '[ :k | k basicNew ]', [c.classRef]);
    assert.deepEqual(
      Object.keys((await runtime.images.getObject('app', instance.objectId)).slots).sort(),
      ['slot-a', 'slot-c'],
    );
  });
});

// Slot ids are identity; slot names are how instance variables will be read. Generic Shapes
// deliberately permit duplicate names, so this is an instance-shape invariant checked at definition
// — the same shape of rule as MethodDictionary selector uniqueness.
// "No inherited layout" and "the chain is corrupt" are indistinguishable to a caller if both answer
// the same way, so only the first may. A subclass must not publish on the strength of an invariant
// the builder never managed to check. Only the *direct* superclass is validated by the caller, so
// each of these corrupts the chain one link above it.
test('a corrupt superclass chain refuses the class rather than reporting no inherited layout', async () => {
  const cases = {
    'dangling ancestor': (record, kernel) => ({...record.slots, 'behavior-superclass': objectRef('app', 'gone')}),
    'malformed ancestor': (record, kernel) => ({...record.slots, 'behavior-superclass': objectRef('app', 'not-a-behavior')}),
  };
  for (const [label, corrupt] of Object.entries(cases)) {
    await withRuntime(async (runtime) => {
      const kernel = await seed(runtime, 'app');
      const aShape = await shapeFor(runtime, 'app', 'a-shape', [{id: 'slot-a', name: 'a'}]);
      const a = await defineClass({images: runtime.images, imageId: 'app', name: 'A', instanceShapeRef: aShape});
      const b = await defineClass({images: runtime.images, imageId: 'app', name: 'B', superclassRef: a.classRef});
      await runtime.images.putObject('app', {
        id: 'not-a-behavior',
        shape: objectRef('app', 'smalltalk/empty-shape/v1'),
        slots: {},
        metadata: {},
      });

      // B stays a well-formed Behavior; what it points at does not.
      const record = await runtime.images.getObject('app', b.classRef.objectId);
      await runtime.images.putObject('app', {
        id: record.id,
        shape: record.shape,
        behavior: record.behavior,
        slots: corrupt(record, kernel),
        metadata: record.metadata,
      }, {expectedVersion: record._version});

      const shape = await shapeFor(runtime, 'app', 'c-shape', [{id: 'slot-c', name: 'c'}]);
      await assert.rejects(
        defineClass({
          images: runtime.images, imageId: 'app', name: 'C',
          superclassRef: b.classRef, instanceShapeRef: shape,
        }),
        /superclass chain/,
        `${label} must refuse the class`,
      );
      assert.equal(await runtime.images.getObject('app', 'smalltalk/class/C'), null, 'nothing may be published');
    });
  }
});

test('a superclass chain cycle refuses the class rather than reporting no inherited layout', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const aShape = await shapeFor(runtime, 'app', 'a-shape', [{id: 'slot-a', name: 'a'}]);
    const a = await defineClass({images: runtime.images, imageId: 'app', name: 'A', instanceShapeRef: aShape});
    const b = await defineClass({images: runtime.images, imageId: 'app', name: 'B', superclassRef: a.classRef});

    // Close the loop above the direct superclass: A's superclass becomes B.
    const record = await runtime.images.getObject('app', a.classRef.objectId);
    await runtime.images.putObject('app', {
      id: record.id,
      shape: record.shape,
      behavior: record.behavior,
      // A also loses its own layout, so the walk must keep going and meet itself.
      slots: {...record.slots, 'behavior-superclass': b.classRef, 'behavior-instance-shape': (await findSmalltalkKernel({images: runtime.images, imageId: 'app'})).nil},
      metadata: record.metadata,
    }, {expectedVersion: record._version});

    const shape = await shapeFor(runtime, 'app', 'c-shape', [{id: 'slot-c', name: 'c'}]);
    await assert.rejects(
      defineClass({
        images: runtime.images, imageId: 'app', name: 'C',
        superclassRef: b.classRef, instanceShapeRef: shape,
      }),
      /superclass chain has a cycle/,
    );
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/C'), null);
  });
});

test('an instance shape with two slots of one name is refused', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const duplicate = await shapeFor(runtime, 'app', 'dup-shape', [
      {id: 'point-x', name: 'x'}, {id: 'other-x', name: 'x'},
    ]);
    await assert.rejects(
      defineClass({images: runtime.images, imageId: 'app', name: 'Dup', instanceShapeRef: duplicate}),
      /duplicate slot name: x/,
    );
  });
});

// A ref to a record that is not there is not a structural defect in a record — the three graph
// failures stay apart, exactly as they do during method lookup.
test('basic-new reports an absent class as a dangling edge, not a malformed Behavior', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await assert.rejects(
      runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: objectRef('app', 'smalltalk/primitive/basic-new'),
        message: textValue('value:'),
        arguments: [objectRef('app', 'no-such-class')],
      })),
      (error) => error.name === 'SmalltalkDanglingEdgeError' && error.edge === 'class',
    );
  });
});

// A primitive Block ref written into a method-dictionary slot by a raw graph write would otherwise
// run as a method: allocating from its first *argument* while `self` is silently discarded.
test('a primitive Block invoked as a method is refused, not run with self discarded', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});

    // Forge a dictionary entry on Integer pointing straight at the allocation primitive.
    const slotId = 'selector:c25lYWt5Og';
    const dictionaryShape = await runtime.images.putShape('app', {
      id: 'sneaky-shape', slots: [{id: slotId, name: 'sneaky:'}],
    });
    const dictionary = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);
    await runtime.images.putObject('app', {
      id: dictionary.id,
      shape: objectRef('app', dictionaryShape.id),
      slots: {[slotId]: objectRef('app', 'smalltalk/primitive/basic-new')},
      metadata: dictionary.metadata,
    }, {expectedVersion: dictionary._version});

    const before = (await runtime.images.listObjects('app')).length;
    await assert.rejects(
      evaluate(runtime, 'app', 'sneaky', '[ :n :c | n sneaky: c ]', [integerValue(1), point.classRef]),
      /accepts only direct Block invocation/,
    );
    assert.equal((await runtime.images.listObjects('app')).length, before, 'nothing may be allocated');
  });
});

test('an unknown lane is refused before any primitive record is written', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    await assert.rejects(
      installSmalltalkAllocationProtocol({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm2',
      }),
      /unknown method lane: wasm2/,
    );
    assert.equal(await runtime.images.getBlock('app', 'smalltalk/primitive/basic-new'), null);
  });
});

// The dispatcher registration uses the same guard, so an explicit override is a supported choice
// rather than a hard ExecutorRegistrationError out of createRuntime itself.
test('an embedder-supplied primitive executor wins over the default', async () => {
  const stub = {async execute() { return textValue('stubbed'); }};
  await withRuntime(async (runtime) => {
    assert.equal(runtime.codeExecutors.get(SMALLTALK_KERNEL_PRIMITIVE_V1), stub);
  }, {codeExecutors: {[SMALLTALK_KERNEL_PRIMITIVE_V1]: stub}});
});

// A conflict is matched by name, not by class. `createBackend` accepts an embedder-supplied backend
// through `lagrangeFactory`, which need not throw this module's error class; matching by identity
// would let an ordinary id collision escape the retry loop and fail the whole send. This drives the
// executor directly so the foreign error class is the only variable.
test('a conflict from a foreign backend error class still retries with a fresh candidate', async () => {
  const {createSmalltalkKernelPrimitiveV1Executor} = await import('../src/language/smalltalk-primitives.js');
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});

    // Same `name`, deliberately not the same class as src/backend/backend-contract.js exports.
    class ForeignVersionConflictError extends Error {
      constructor() {
        super('version conflict');
        this.name = 'VersionConflictError';
      }
    }
    let firstWrite = true;
    const images = Object.create(runtime.images);
    images.putObject = async (...args) => {
      if (firstWrite) {
        firstWrite = false;
        throw new ForeignVersionConflictError();
      }
      return await runtime.images.putObject(...args);
    };

    const identities = ['taken', 'free-instance'];
    let index = 0;
    const executor = createSmalltalkKernelPrimitiveV1Executor({newObjectId: () => identities[index++]});
    const primitiveBlock = objectRef('app', 'smalltalk/primitive/basic-new');
    const block = await runtime.images.getBlock('app', primitiveBlock.objectId);
    const result = await executor.execute({
      activation: {
        kind: 'activation-request',
        block: primitiveBlock,
        code: block.code,
        environment: null,
        receiver: primitiveBlock,
        arguments: [point.classRef],
        dispatch: null,
      },
      code: await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId),
    }, {images});

    assert.deepEqual(result, objectRef('app', 'free-instance'), 'the retry must use the next candidate');
    assert.equal((await runtime.images.getObject('app', 'free-instance')).behavior.objectId, point.classRef.objectId);
    assert.equal(kernel.nil.imageId, 'app');
  });
});

test('an instance shape must be a local ref that resolves', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await seed(runtime, 'other');
    const foreign = await emptyShape(runtime, 'other', 'foreign-shape');
    await assert.rejects(
      defineClass({images: runtime.images, imageId: 'app', name: 'Foreign', instanceShapeRef: foreign}),
      /must be an unpinned ref in app/,
    );
    await assert.rejects(
      defineClass({images: runtime.images, imageId: 'app', name: 'Missing', instanceShapeRef: objectRef('app', 'nope')}),
      /instanceShape not found/,
    );
  });
});

// --- composition and authority ------------------------------------------------------------------

// Decision 2a. The point is not merely that it works, but that execution never learns the language:
// src/language already imports src/execution, so the reverse edge would close a cycle that the
// export * barrel turns into an import-time failure naming neither file.
test('the primitive executor is registered by the composition root, not the execution layer', async () => {
  const {createDefaultCodeExecutorRegistry} = await import('../src/execution/executor.js');
  assert.equal(
    createDefaultCodeExecutorRegistry().has(SMALLTALK_KERNEL_PRIMITIVE_V1),
    false,
    'the default execution registry must not know a language-owned representation',
  );
  await withRuntime(async (runtime) => {
    assert.equal(runtime.codeExecutors.has(SMALLTALK_KERNEL_PRIMITIVE_V1), true);
  });
});

test('src/execution imports nothing from src/language', async () => {
  const directory = join(ROOT, 'src', 'execution');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = await readFile(join(directory, file), 'utf8');
    assert.doesNotMatch(
      source,
      /from '\.\.\/language\//,
      `src/execution/${file} imports src/language, which closes a dependency cycle`,
    );
  }
});

// Decision 10. Image-native allocation is language semantics, not a capability-gated host effect:
// a program that can materialize closures without a grant must be able to construct its own objects.
test('image-native new succeeds with no authority context at all', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = await emptyShape(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'no-authority', source: '[ :c | c new ]',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), [point.classRef]);
    // No authority argument: `execute` defaults it to null, and nothing here calls `require`.
    const instance = await runtime.executor.execute(activation);
    assert.equal((await runtime.images.getObject('app', instance.objectId)).kind, 'object');
  });
});

// --- installation ---------------------------------------------------------------------------

test('installing the allocation protocol twice changes nothing', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const before = await runtime.images.getObject('app', 'smalltalk/class/Object/methods');
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
    });
    const after = await runtime.images.getObject('app', 'smalltalk/class/Object/methods');
    assert.equal(after._version, before._version);
  });
});

test('the primitive Blocks carry the kernel-primitive representation and no environment', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    for (const primitive of ['class-of', 'basic-new']) {
      const block = await runtime.images.getBlock('app', `smalltalk/primitive/${primitive}`);
      assert.equal(block.environment, null);
      const code = await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId);
      assert.equal(code.representation, SMALLTALK_KERNEL_PRIMITIVE_V1);
      assert.deepEqual(JSON.parse(code.content.value), {primitive});
    }
    // The methods reach them through explicit captured refs in the ordinary environment graph,
    // never through hidden metadata.
    const ref = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.objectClass, selector: 'class',
    });
    const method = await runtime.images.getBlock('app', ref.objectId);
    const environment = await runtime.images.getLexicalEnvironment(
      method.environment.imageId, method.environment.objectId,
    );
    assert.deepEqual(environment.bindings['smalltalk/primitive/class-of'], {
      name: 'primitiveClassOf',
      value: objectRef('app', 'smalltalk/primitive/class-of'),
    });
  });
});

// A publication sequence is proven recoverable by enumerating its writes, not by probing a few. The
// allocation protocol adds primitive code artifacts and Blocks ahead of the method installs, so the
// sweep covers those too — including a commit-then-throw that models a lost acknowledgement, after
// which an identical install must be idempotent rather than a redefinition error.
const INSTALL_WRITE_METHODS = ['putCodeArtifact', 'putBlock', 'putShape', 'putObject', 'putLexicalEnvironment'];

function faultingImages(images, {failAt = null, commitThenThrow = false} = {}) {
  let writes = 0;
  const wrapped = Object.create(Object.getPrototypeOf(images));
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(images))) {
    if (typeof images[key] !== 'function' || key === 'constructor') continue;
    wrapped[key] = (...args) => images[key](...args);
  }
  for (const [key, value] of Object.entries(images)) {
    if (typeof value === 'function') wrapped[key] = (...args) => images[key](...args);
    else wrapped[key] = value;
  }
  for (const method of INSTALL_WRITE_METHODS) {
    wrapped[method] = async (imageId, input, options) => {
      writes += 1;
      const index = writes;
      if (index === failAt && !commitThenThrow) {
        throw new Error(`injected failure at write ${index} (${method} ${input?.id})`);
      }
      const result = await images[method](imageId, input, options);
      if (index === failAt && commitThenThrow) {
        throw new Error(`injected post-commit failure at write ${index} (${method} ${input?.id})`);
      }
      return result;
    };
  }
  return {images: wrapped, writeCount: () => writes};
}

function servicesFor(images) {
  return new CompilationService({images, compilers: createDefaultCodeCompilerRegistry()});
}

async function installWriteCount(lane) {
  return await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'count'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'count'});
    const {images, writeCount} = faultingImages(runtime.images);
    await installSmalltalkAllocationProtocol({
      images, compilation: servicesFor(images), imageId: 'count', lane,
    });
    return writeCount();
  });
}

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write installing the ${lane} allocation protocol`, async () => {
    const total = await installWriteCount(lane);
    assert.ok(total > 5, `expected several writes in the ${lane} lane, saw ${total}`);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      for (const commitThenThrow of [false, true]) {
        await withRuntime(async (runtime) => {
          await runtime.images.createImage({id: 'app'});
          await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
          const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});

          await assert.rejects(
            installSmalltalkAllocationProtocol({
              images, compilation: servicesFor(images), imageId: 'app', lane,
            }),
            /injected/,
            `${lane}: write ${failAt} (commitThenThrow=${commitThenThrow}) should have failed`,
          );

          // The identical operation, retried against a clean service, must complete and work.
          await installSmalltalkAllocationProtocol({
            images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane,
          });
          const shape = await emptyShape(runtime, 'app');
          const point = await defineClass({
            images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape,
          });
          const instance = await evaluate(
            runtime, 'app', `retry-${lane}-${failAt}-${commitThenThrow}`, '[ :c | c new ]', [point.classRef],
          );
          assert.equal((await runtime.images.getObject('app', instance.objectId)).kind, 'object');
        });
      }
    }
  });
}
