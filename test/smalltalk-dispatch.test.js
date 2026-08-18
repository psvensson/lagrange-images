import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineClass,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {BEHAVIOR_SHAPE_ID} from '../src/language/smalltalk-kernel.js';

// ADR 0044 dispatch: fixed-Behavior lookup with inheritance, immediate Values taking their class
// from their kind under a dispatch image, and `+` as an ordinary method.

const plusMethod = (literal = null) => ({
  selector: '+',
  program: {
    parameters: [{id: 'plus:arg', name: 'aNumber'}],
    captures: [],
    body: literal === null
      ? {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}}
      : {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'literal', value: integerValue(literal)}},
  },
});

async function seed(runtime, imageId) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

async function evaluate(runtime, imageId, id, source, args) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

// The wall ADR 0044 exists to knock down. `integer-add` was always in the neutral IR; what was
// missing was a class to hang it on.
test('3 + 4 is an ordinary message send', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [plusMethod()],
    });
    const result = await evaluate(runtime, 'app', 'adder', '[ :a :b | a + b ]',
      [integerValue(3), integerValue(4)]);
    assert.deepEqual(result, integerValue(7));
  });
});

test('adding a method leaves the Behavior object untouched', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const before = await runtime.images.getObject('app', kernel.integerClass.objectId);
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [plusMethod()],
    });
    const after = await runtime.images.getObject('app', kernel.integerClass.objectId);
    assert.equal(after._version, before._version, 'the Behavior record must not be rewritten');
    assert.equal(after.shape.objectId, BEHAVIOR_SHAPE_ID);
  });
});

test('a method is found on a superclass, and an override wins', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    // Integer inherits from Object, so a method on Object is reachable from an integer receiver.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.objectClass,
      methods: [{selector: 'label', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('from Object')}}}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'inherited', '[ :x | x label ]', [integerValue(1)]),
      textValue('from Object'),
    );

    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass,
      methods: [{selector: 'label', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('from Integer')}}}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'overridden', '[ :x | x label ]', [integerValue(1)]),
      textValue('from Integer'),
      'the subclass implementation must win',
    );
    // The superclass method is still reachable from a receiver whose class does not override it.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'still-inherited', '[ :x | x label ]', [textValue('hi')]),
      textValue('from Object'),
    );
  });
});

// Decision 4's class-side chain, proven with a harmless marker rather than `new`, which needs an
// allocation primitive that does not exist.
test('a class-side method is found through the metaclass, and inherits', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point'});
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: point.metaclassRef,
      methods: [{selector: 'classMarker', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('Point class')}}}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'class-side', '[ :c | c classMarker ]', [point.classRef]),
      textValue('Point class'),
    );

    // Inherited class-side: define on Object class, reach it from Point class.
    const objectMetaclass = (await runtime.images.getObject('app', kernel.objectClass.objectId)).behavior;
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: objectMetaclass,
      methods: [{selector: 'shared', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('from Object class')}}}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'class-side-inherited', '[ :c | c shared ]', [point.classRef]),
      textValue('from Object class'),
      'class-side inheritance requires C class superclass == S class',
    );
  });
});

// The three failure classes must stay distinct: a caller that cannot tell them apart cannot respond
// correctly to any of them.
test('a selector on no class in the chain is not understood', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'missing', '[ :x | x nope ]', [integerValue(1)]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError' && /nope/.test(error.message),
    );
  });
});

test('a dangling superclass edge is corrupt graph state, not a selector miss', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const behavior = await runtime.images.getObject('app', kernel.integerClass.objectId);
    await runtime.images.putObject('app', {
      id: behavior.id,
      shape: behavior.shape,
      behavior: behavior.behavior,
      slots: {...behavior.slots, 'behavior-superclass': objectRef('app', 'smalltalk/class/Vanished')},
      metadata: behavior.metadata,
    }, {expectedVersion: behavior._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'dangling', '[ :x | x nope ]', [integerValue(1)]),
      (error) => error.name === 'SmalltalkDanglingEdgeError' && error.edge === 'superclass',
    );
  });
});

test('a malformed Behavior is distinguished from both', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const behavior = await runtime.images.getObject('app', kernel.integerClass.objectId);
    await runtime.images.putObject('app', {
      id: behavior.id,
      shape: behavior.shape,
      behavior: behavior.behavior,
      // A ref where the fixed shape promises text.
      slots: {...behavior.slots, 'behavior-name': objectRef('app', 'smalltalk/nil')},
      metadata: behavior.metadata,
    }, {expectedVersion: behavior._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'malformed', '[ :x | x nope ]', [integerValue(1)]),
      (error) => error.name === 'SmalltalkMalformedBehaviorError',
    );
  });
});

test('a cyclic superclass chain fails as a cycle rather than looping', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const integer = await runtime.images.getObject('app', kernel.integerClass.objectId);
    const object = await runtime.images.getObject('app', kernel.objectClass.objectId);
    await runtime.images.putObject('app', {
      id: object.id, shape: object.shape, behavior: object.behavior,
      slots: {...object.slots, 'behavior-superclass': kernel.integerClass},
      metadata: object.metadata,
    }, {expectedVersion: object._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'cyclic', '[ :x | x nope ]', [integerValue(1)]),
      /superclass cycle/,
    );
    assert.equal(integer.id, kernel.integerClass.objectId);
  });
});

// Decision 5a. The same integer Value dispatches to a different Integer depending on which image
// the send happens in — and the receiver carries no image of its own.
test('an immediate Value takes its class from the dispatch image', async () => {
  await withRuntime(async (runtime) => {
    const alpha = await seed(runtime, 'alpha');
    const beta = await seed(runtime, 'beta');
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'alpha',
      classRef: alpha.integerClass, methods: [plusMethod(100)],
    });
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'beta',
      classRef: beta.integerClass, methods: [plusMethod(200)],
    });

    assert.deepEqual(
      await evaluate(runtime, 'alpha', 'alpha-send', '[ :x | x + 0 ]', [integerValue(1)]),
      integerValue(101),
    );
    assert.deepEqual(
      await evaluate(runtime, 'beta', 'beta-send', '[ :x | x + 0 ]', [integerValue(1)]),
      integerValue(201),
      'the same Value must dispatch through the sending image kernel',
    );
  });
});

test('an image with no kernel cannot dispatch an immediate Value', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'bare'});
    await assert.rejects(
      evaluate(runtime, 'bare', 'no-kernel', '[ :x | x + 0 ]', [integerValue(1)]),
      (error) => error.name === 'SmalltalkKernelMissingError',
    );
  });
});

// Lookup terminates by comparing the full ref against the kernel's own `nil`, never by object id.
// That comparison is currently defence in depth rather than an active discriminator: `readBehavior`
// requires a Behavior's superclass to be a *local* ref, so a foreign `smalltalk/nil` is rejected as
// a malformed Behavior before the chain can reach the termination check. Within one image the two
// comparisons coincide, because a local ref to `smalltalk/nil` is that image's nil.
//
// So this asserts the behaviour that actually exists — cross-image inheritance is unsupported —
// rather than a termination property the locality rule makes unreachable.
test('a foreign superclass ref is rejected rather than silently ending the chain', async () => {
  await withRuntime(async (runtime) => {
    const app = await seed(runtime, 'app');
    await seed(runtime, 'other');
    const object = await runtime.images.getObject('app', app.objectClass.objectId);
    await runtime.images.putObject('app', {
      id: object.id, shape: object.shape, behavior: object.behavior,
      // Same object id, different image.
      slots: {...object.slots, 'behavior-superclass': objectRef('other', 'smalltalk/nil')},
      metadata: object.metadata,
    }, {expectedVersion: object._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'foreign-nil', '[ :x | x nope ]', [integerValue(1)]),
      (error) => error.name === 'SmalltalkMalformedBehaviorError'
        && /superclass must be an unpinned ref in app/.test(error.message),
    );
  });
});

test('a legacy behavior object still dispatches after the kernel is installed', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'echo-method', source: '[ :value | value ]',
    });
    const legacyShape = await runtime.images.putShape('app', {
      id: 'legacy-shape', slots: [{id: 'method-echo', name: 'echo:'}],
    });
    await runtime.images.putObject('app', {
      id: 'LegacyBehavior', shape: objectRef('app', legacyShape.id),
      slots: {'method-echo': objectRef('app', 'echo-method')},
    });
    const receiverShape = await runtime.images.putShape('app', {id: 'legacy-receiver-shape', slots: []});
    await runtime.images.putObject('app', {
      id: 'legacy-receiver', shape: objectRef('app', receiverShape.id),
      behavior: objectRef('app', 'LegacyBehavior'), slots: {},
    });

    assert.deepEqual(
      await evaluate(runtime, 'app', 'legacy-caller', "[ :t | t echo: 'hello' ]",
        [objectRef('app', 'legacy-receiver')]),
      textValue('hello'),
    );
  });
});

test('Blocks still answer value and value: without a class', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'block-send', '[ :b | b value: 5 ]',
        [(await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'app', id: 'identity', source: '[ :v | v ]',
        })).block].map((block) => objectRef('app', block.id))),
      integerValue(5),
    );
  });
});
