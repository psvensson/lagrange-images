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
import {SmalltalkMethodRedefinitionError, methodBlockRef} from '../src/language/smalltalk-class-builder.js';

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

// ADR 0044 decision 6 in full: ONE semantic method, derived independently into a neutral Block and
// a WASM Block, with both executed. A single Block reached from two callers would not show this.
test('the same semantic + method runs through both execution lanes', async () => {
  for (const lane of ['neutral', 'wasm']) {
    await withRuntime(async (runtime) => {
      const kernel = await seed(runtime, 'app');
      await defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [plusMethod()], lane,
      });

      const ref = await methodBlockRef({
        images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '+',
      });
      const methodBlock = await runtime.images.getBlock('app', ref.objectId);
      const code = await runtime.images.getCodeArtifact(methodBlock.code.imageId, methodBlock.code.objectId);
      assert.equal(
        code.representation,
        lane === 'wasm' ? 'wasm-function/v1' : 'neutral-expression/v0',
        `the ${lane} lane must derive its own executable representation`,
      );
      // The semantic artifact is lagrange-code/v0 in both cases — the method itself is lane-neutral.
      const semantic = await runtime.images.getCodeArtifact(
        'app', `${kernel.integerClass.objectId}/method/Kw:semantic`,
      );
      assert.equal(semantic.representation, 'lagrange-code/v0');

      assert.deepEqual(
        await evaluate(runtime, 'app', `adder-${lane}`, '[ :a :b | a + b ]',
          [integerValue(3), integerValue(4)]),
        integerValue(7),
        `3 + 4 must be 7 through the ${lane} lane`,
      );
    });
  }
});

// Deterministic ids plus a plain putObject would let defineClass silently replace an existing class
// — the same defect the kernel installer had before review.
test('defineClass refuses to overwrite an existing class', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await defineClass({images: runtime.images, imageId: 'app', name: 'Point'});
    const before = await runtime.images.getObject('app', 'smalltalk/class/Point');

    // An identical definition is a no-op, so a retry after a partial failure works.
    await defineClass({images: runtime.images, imageId: 'app', name: 'Point'});
    const after = await runtime.images.getObject('app', 'smalltalk/class/Point');
    assert.equal(after._version, before._version);

    // A different definition at the same id is refused rather than applied.
    const other = await defineClass({images: runtime.images, imageId: 'app', name: 'Other'});
    await assert.rejects(
      defineClass({images: runtime.images, imageId: 'app', name: 'Point', superclassRef: other.classRef}),
      (error) => error.name === 'SmalltalkKernelConflictError',
    );
  });
});

test('defineClass validates its superclass before writing anything', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await seed(runtime, 'other');
    const foreign = await findSmalltalkKernel({images: runtime.images, imageId: 'other'});

    await assert.rejects(
      defineClass({images: runtime.images, imageId: 'app', name: 'Foreign', superclassRef: foreign.objectClass}),
      /superclass must be an unpinned ref in app/,
    );
    // Nothing was written, so a class dispatch would later reject does not exist.
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/Foreign'), null);

    const legacyShape = await runtime.images.putShape('app', {id: 'not-a-behavior', slots: []});
    await runtime.images.putObject('app', {id: 'NotABehavior', shape: objectRef('app', legacyShape.id), slots: {}});
    await assert.rejects(
      defineClass({
        images: runtime.images, imageId: 'app', name: 'Bad',
        superclassRef: objectRef('app', 'NotABehavior'),
      }),
      /is not a well-formed smalltalk\/behavior-shape\/v1 Behavior/,
    );
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/Bad'), null);
  });
});

// Add-only, with one deliberate exception: an *identical* definition is idempotent, because a lost
// acknowledgement can leave the dictionary updated while the caller believes the call failed. A
// different program or lane for an existing selector is replacement, and replacement needs
// versioned method identity it does not have yet.
test('an identical definition is idempotent and a different one is refused', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const define = (methods) => defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods,
    });
    await define([plusMethod()]);
    const dictionary = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);

    await define([plusMethod()]);
    const unchanged = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);
    assert.equal(unchanged._version, dictionary._version, 'an identical definition must write nothing');

    await assert.rejects(
      define([plusMethod(99)]),
      (error) => error instanceof SmalltalkMethodRedefinitionError,
    );
    const afterRefusal = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);
    assert.equal(afterRefusal._version, dictionary._version, 'a refused redefinition must not touch the dictionary');
  });
});

test('defineMethods requires a local fixed-shape Behavior', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await seed(runtime, 'other');
    const foreign = await findSmalltalkKernel({images: runtime.images, imageId: 'other'});
    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: foreign.integerClass, methods: [plusMethod()],
      }),
      /class must be an unpinned ref in app/,
    );
  });
});

// The builder enforces selector uniqueness, but generic graph writes can produce a dictionary shape
// with duplicate names. A find over that would resurrect first-wins lookup.
test('a duplicate selector in stored data is rejected rather than resolved by position', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass,
      methods: [{selector: 'label', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('first')}}}],
    });
    const dictionary = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);
    const original = await runtime.images.getShape(dictionary.shape.imageId, dictionary.shape.objectId);
    const method = dictionary.slots[original.slots[0].id];

    const corrupt = await runtime.images.putShape('app', {
      id: 'corrupt-dictionary-shape',
      slots: [{id: 'a', name: 'label'}, {id: 'b', name: 'label'}],
    });
    await runtime.images.putObject('app', {
      id: dictionary.id,
      shape: objectRef('app', corrupt.id),
      slots: {a: method, b: method},
      metadata: dictionary.metadata,
    }, {expectedVersion: dictionary._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'dup-selector', '[ :x | x label ]', [integerValue(1)]),
      (error) => error.name === 'SmalltalkMalformedBehaviorError' && /duplicate selector: label/.test(error.message),
    );
  });
});

test('a method Block that does not load is a dangling edge', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass,
      methods: [{selector: 'label', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('x')}}}],
    });
    // Repoint the installed method at a Block that does not exist, in whichever representation the
    // dictionary uses.
    const dictionary = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);
    const indexed = [...dictionary.indexed];
    for (let index = 0; index < indexed.length; index += 3) {
      if (indexed[index].kind === 'integer') indexed[index + 2] = objectRef('app', 'no-such-block');
    }
    await runtime.images.putObject('app', {
      id: dictionary.id,
      shape: dictionary.shape,
      slots: dictionary.slots,
      indexed,
      metadata: dictionary.metadata,
    }, {expectedVersion: dictionary._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'dangling-method', '[ :x | x label ]', [integerValue(1)]),
      (error) => error.name === 'SmalltalkDanglingEdgeError'
        && error.edge === 'method'
        // The formatter must render refs, not `app/undefined`.
        && !/undefined/.test(error.message),
    );
  });
});

// Decision 10 preserves what a stored object *means*, and a failure is part of that meaning.
test('a legacy selector miss keeps its pre-0044 failure identity', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const legacyShape = await runtime.images.putShape('app', {
      id: 'legacy-miss-shape', slots: [{id: 'method-other', name: 'other'}],
    });
    await runtime.images.putObject('app', {
      id: 'LegacyMissBehavior', shape: objectRef('app', legacyShape.id),
      slots: {'method-other': objectRef('app', 'anything')},
    });
    const receiverShape = await runtime.images.putShape('app', {id: 'legacy-miss-receiver', slots: []});
    await runtime.images.putObject('app', {
      id: 'legacy-miss-receiver-object', shape: objectRef('app', receiverShape.id),
      behavior: objectRef('app', 'LegacyMissBehavior'), slots: {},
    });

    await assert.rejects(
      evaluate(runtime, 'app', 'legacy-miss', '[ :t | t nope ]',
        [objectRef('app', 'legacy-miss-receiver-object')]),
      (error) => error.name === 'TypeError'
        && error.message === 'Symmetric Smalltalk message not understood: nope',
    );
  });
});

// compileWasmFunctionArtifact writes its deterministic function artifact unconditionally, so a
// failure between that write and the dictionary swap used to make an exact retry collide with its
// own output.
test('the WASM lane survives a failure after its function artifact is written', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const methodObjectId = `${kernel.integerClass.objectId}/method/Kw`;

    // Fail once the wasm function exists but before the Block is published.
    const failing = {
      ...runtime.images,
      getCodeArtifact: (...args) => runtime.images.getCodeArtifact(...args),
      getObject: (...args) => runtime.images.getObject(...args),
      getShape: (...args) => runtime.images.getShape(...args),
      getBlock: (...args) => runtime.images.getBlock(...args),
      putShape: (...args) => runtime.images.putShape(...args),
      putObject: (...args) => runtime.images.putObject(...args),
      putCodeArtifact: (...args) => runtime.images.putCodeArtifact(...args),
      putBlock: async () => { throw new Error('interrupted before the Block'); },
    };
    await assert.rejects(
      defineMethods({
        images: failing, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [plusMethod()], lane: 'wasm',
      }),
      /interrupted before the Block/,
    );
    assert.notEqual(await runtime.images.getCodeArtifact('app', `${methodObjectId}:wasm:function`), null);
    assert.equal(await runtime.images.getBlock('app', methodObjectId), null);

    // The exact retry must reuse that function artifact rather than collide with it.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [plusMethod()], lane: 'wasm',
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'retried-wasm', '[ :a :b | a + b ]', [integerValue(3), integerValue(4)]),
      integerValue(7),
    );
  });
});

// Shape identity from the selector set, not its cardinality: a failed `foo` leaving a one-selector
// shape must not conflict with a later, unrelated `bar`.
test('an abandoned dictionary shape does not block a different selector of the same size', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const literal = (text) => ({parameters: [], captures: [], body: {op: 'literal', value: textValue(text)}});

    const failing = {
      ...runtime.images,
      getCodeArtifact: (...a) => runtime.images.getCodeArtifact(...a),
      getObject: (...a) => runtime.images.getObject(...a),
      getShape: (...a) => runtime.images.getShape(...a),
      getBlock: (...a) => runtime.images.getBlock(...a),
      putCodeArtifact: (...a) => runtime.images.putCodeArtifact(...a),
      putBlock: (...a) => runtime.images.putBlock(...a),
      putShape: (...a) => runtime.images.putShape(...a),
      putObject: async (imageId, input, options) => {
        if (input.id.endsWith('/methods')) throw new Error('interrupted before the dictionary');
        return await runtime.images.putObject(imageId, input, options);
      },
    };
    await assert.rejects(
      defineMethods({
        images: failing, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [{selector: 'foo', program: literal('foo')}],
      }),
      /interrupted before the dictionary/,
    );

    // A different single selector wants a different shape id, so this must simply work.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [{selector: 'bar', program: literal('bar')}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'bar-send', '[ :x | x bar ]', [integerValue(1)]),
      textValue('bar'),
    );
  });
});

test('defineMethods rejects the same selector twice in one call, before writing', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const dictionary = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);
    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass,
        methods: [
          {selector: 'dup', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('a')}}},
          {selector: 'dup', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('b')}}},
        ],
      }),
      /declares dup twice in one call/,
    );
    const after = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);
    assert.equal(after._version, dictionary._version);
  });
});

test('defineMethods refuses to extend a dictionary that already violates uniqueness', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const dictionary = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);
    const corrupt = await runtime.images.putShape('app', {
      id: 'corrupt-extend-shape',
      slots: [{id: 'a', name: 'x'}, {id: 'b', name: 'x'}],
    });
    await runtime.images.putObject('app', {
      id: dictionary.id,
      shape: objectRef('app', corrupt.id),
      slots: {a: objectRef('app', 'anything'), b: objectRef('app', 'anything')},
      metadata: dictionary.metadata,
    }, {expectedVersion: dictionary._version});

    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass,
        methods: [{selector: 'fresh', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('f')}}}],
      }),
      /duplicate selector: x/,
    );
  });
});

test('the builder rejects a Behavior the dispatcher would refuse', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const behavior = await runtime.images.getObject('app', kernel.integerClass.objectId);
    // Carries the fixed shape, but its name slot holds a ref where text is promised.
    await runtime.images.putObject('app', {
      id: behavior.id, shape: behavior.shape, behavior: behavior.behavior,
      slots: {...behavior.slots, 'behavior-name': objectRef('app', 'smalltalk/nil')},
      metadata: behavior.metadata,
    }, {expectedVersion: behavior._version});

    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [plusMethod()],
      }),
      /is not a well-formed/,
    );
  });
});

test('a code artifact differing only in provenance is not treated as exact', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const methodObjectId = `${kernel.integerClass.objectId}/method/bGFiZWw`;
    const program = {parameters: [], captures: [], body: {op: 'literal', value: textValue('x')}};
    // Same representation and content, different derivedFrom.
    const decoy = await runtime.images.putCodeArtifact('app', {
      id: 'decoy',
      representation: 'lagrange-code/v0',
      content: textValue(JSON.stringify(program)),
    });
    await runtime.images.putCodeArtifact('app', {
      id: `${methodObjectId}:semantic`,
      languageId: 'symmetric-smalltalk',
      representation: 'lagrange-code/v0',
      content: textValue(JSON.stringify(program)),
      derivedFrom: [objectRef('app', decoy.id)],
      metadata: {smalltalk: 'method', selector: 'label'},
    });

    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [{selector: 'label', program}],
      }),
      (error) => error.name === 'SmalltalkKernelConflictError',
    );
  });
});

// Reuse must be exact to the same standard as ensureCodeArtifact. Correct provenance with the wrong
// compiled output is stale, not reusable.
test('a wasm function with right provenance but the wrong module is a conflict', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const methodObjectId = `${kernel.integerClass.objectId}/method/Kw`;
    const program = plusMethod().program;

    const semantic = await runtime.images.putCodeArtifact('app', {
      id: `${methodObjectId}:semantic`,
      languageId: 'symmetric-smalltalk',
      representation: 'lagrange-code/v0',
      content: textValue(JSON.stringify(program)),
      metadata: {smalltalk: 'method', selector: '+'},
    });
    // A decoy module, so the planted function's content points somewhere a fresh compile would not.
    const decoyModule = await runtime.images.putCodeArtifact('app', {
      id: 'decoy-module',
      representation: 'wasm-module/v1',
      content: {kind: 'bytes', base64: ''},
      metadata: {abi: 'lagrange-value-handle/v0', entry: 'run', parameters: 1, captures: []},
    });
    await runtime.images.putCodeArtifact('app', {
      id: `${methodObjectId}:wasm:function`,
      representation: 'wasm-function/v1',
      content: objectRef('app', decoyModule.id),
      derivedFrom: [objectRef('app', semantic.id), objectRef('app', decoyModule.id)],
      metadata: {abi: 'lagrange-value-handle/v0', entry: 'run', parameters: 1, captures: [], closurePrototypes: []},
    });

    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [plusMethod()], lane: 'wasm',
      }),
      (error) => error.name === 'SmalltalkKernelConflictError' && /wasm function artifact/.test(error.message),
    );
  });
});

// The shape id names a canonical selector *set*, so two orderings of that set must describe the
// same persisted shape — including its slot array — or recovery conflicts with itself.
test('a partial install recovers when the same selectors arrive in a different order', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const literal = (text) => ({parameters: [], captures: [], body: {op: 'literal', value: textValue(text)}});
    const foo = {selector: 'foo', program: literal('foo')};
    const bar = {selector: 'bar', program: literal('bar')};

    const failing = {
      ...runtime.images,
      getCodeArtifact: (...a) => runtime.images.getCodeArtifact(...a),
      getObject: (...a) => runtime.images.getObject(...a),
      getShape: (...a) => runtime.images.getShape(...a),
      getBlock: (...a) => runtime.images.getBlock(...a),
      putCodeArtifact: (...a) => runtime.images.putCodeArtifact(...a),
      putBlock: (...a) => runtime.images.putBlock(...a),
      putShape: (...a) => runtime.images.putShape(...a),
      putObject: async (imageId, input, options) => {
        if (input.id.endsWith('/methods')) throw new Error('interrupted after the shape');
        return await runtime.images.putObject(imageId, input, options);
      },
    };
    await assert.rejects(
      defineMethods({
        images: failing, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [foo, bar],
      }),
      /interrupted after the shape/,
    );

    // Same set, opposite order. It must reuse the shape the failed attempt left behind.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [bar, foo],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'foo-after', '[ :x | x foo ]', [integerValue(1)]),
      textValue('foo'),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'bar-after', '[ :x | x bar ]', [integerValue(1)]),
      textValue('bar'),
    );
  });
});
