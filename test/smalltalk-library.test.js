import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkIndexedProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSmalltalkLibrary,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {METHOD_DICTIONARY_SHAPE_ID} from '../src/language/smalltalk-method-dictionary.js';

// The first image-resident library. What is under test is not really `add:` — it is that a class
// written in ordinary Smalltalk, over the facilities ADRs 0043-0050 built, behaves like a class.
//
// So the assertions that matter most are the structural ones: every method is a durable Smalltalk
// method with a semantic artifact, and no host primitive was added for either class.

async function withRuntime(body, options = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, ...options});
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

async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkControlFlow(options);
  await installSmalltalkIndexedProtocol(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  const library = await installSmalltalkLibrary(options);
  return {kernel, library};
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// --- Association ---------------------------------------------------------------------------------

test('an Association holds a key and a value', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const pair = await evaluate(runtime, 'app', 'pair', "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);

    assert.deepEqual(await evaluate(runtime, 'app', 'key', '[ :a | a key ]', [pair]), textValue('k'));
    assert.deepEqual(await evaluate(runtime, 'app', 'value', '[ :a | a value ]', [pair]), integerValue(1));
    await evaluate(runtime, 'app', 'set', '[ :a | a value: 2 ]', [pair]);
    assert.deepEqual(await evaluate(runtime, 'app', 'value2', '[ :a | a value ]', [pair]), integerValue(2));
  });
});

test('Association equality compares key and value, and guards its argument', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const make = (id, key, value) =>
      evaluate(runtime, 'app', id, `[ :c | (c new) key: ${key} value: ${value} ]`, [library.association]);
    const a = await make('a', '1', '2');
    const same = await make('b', '1', '2');
    const otherValue = await make('c', '1', '3');
    const otherKey = await make('d', '9', '2');

    assert.deepEqual(await evaluate(runtime, 'app', 'eq', '[ :x :y | x = y ]', [a, same]), booleanValue(true));
    assert.deepEqual(await evaluate(runtime, 'app', 'ne-v', '[ :x :y | x = y ]', [a, otherValue]), booleanValue(false));
    assert.deepEqual(await evaluate(runtime, 'app', 'ne-k', '[ :x :y | x = y ]', [a, otherKey]), booleanValue(false));
    // The same-class guard: comparing against a non-Association must answer false, not fail with
    // message-not-understood on `key`.
    assert.deepEqual(await evaluate(runtime, 'app', 'ne-int', '[ :x | x = 7 ]', [a]), booleanValue(false));
    assert.deepEqual(await evaluate(runtime, 'app', 'ne-text', "[ :x | x = 'nope' ]", [a]), booleanValue(false));
  });
});

// ADR 0048 decision 4's obligation, discharged by an ordinary Smalltalk class rather than by a helper.
test('equal Associations hash alike, and a Dictionary uses those methods', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const {installSmalltalkDictionaryProtocol} = await import('../src/runtime.js');
    await installSmalltalkDictionaryProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
    });
    const make = (id) => evaluate(runtime, 'app', id, "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);
    const first = await make('h1');
    const second = await make('h2');

    assert.deepEqual(
      await evaluate(runtime, 'app', 'hash-eq', '[ :x :y | x hash = y hash ]', [first, second]),
      booleanValue(true),
    );
    // Two distinct objects that the class says are equal are therefore one Dictionary key.
    const dictionary = await evaluate(runtime, 'app', 'dict', '[ :c | c new ]',
      [objectRef('app', 'smalltalk/class/Dictionary')]);
    await evaluate(runtime, 'app', 'put1', '[ :d :k | d at: k put: 1 ]', [dictionary, first]);
    await evaluate(runtime, 'app', 'put2', '[ :d :k | d at: k put: 2 ]', [dictionary, second]);
    assert.deepEqual(await evaluate(runtime, 'app', 'dsize', '[ :d | d size ]', [dictionary]), integerValue(1));
    assert.deepEqual(await evaluate(runtime, 'app', 'dget', '[ :d :k | d at: k ]', [dictionary, first]), integerValue(2));
  });
});

// --- OrderedCollection ---------------------------------------------------------------------------

const fill = (count) => Array.from({length: count}, (unused, index) => `x add: ${(index + 1) * 10}.`).join(' ');

for (const lane of ['neutral', 'wasm']) {
  test(`an OrderedCollection grows and reads back through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      const {library} = await seed(runtime, 'app', {lane});
      const collection = await evaluate(runtime, 'app', `oc-${lane}`, '[ :c | c new ]', [library.orderedCollection]);

      assert.deepEqual(await evaluate(runtime, 'app', `empty-${lane}`, '[ :x | x isEmpty ]', [collection]), booleanValue(true));
      assert.deepEqual(await evaluate(runtime, 'app', `size0-${lane}`, '[ :x | x size ]', [collection]), integerValue(0));

      // Nine additions past an initial capacity of four: growth happens twice.
      assert.deepEqual(
        await evaluate(runtime, 'app', `add-${lane}`, `[ :x | ${fill(9)} x size ]`, [collection]),
        integerValue(9),
      );
      assert.deepEqual(await evaluate(runtime, 'app', `empty2-${lane}`, '[ :x | x isEmpty ]', [collection]), booleanValue(false));
      assert.deepEqual(
        await evaluate(runtime, 'app', `arr-${lane}`, '[ :x | x asArray at: 9 ]', [collection]),
        integerValue(90),
        'every element survives the two growths',
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `arrsize-${lane}`, '[ :x | x asArray size ]', [collection]),
        integerValue(9),
        'asArray is exactly the collection size, not the backing capacity',
      );
    });
  });
}

test('includes: finds an element and reports absence', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const collection = await evaluate(runtime, 'app', 'oc', '[ :c | c new ]', [library.orderedCollection]);
    await evaluate(runtime, 'app', 'fill', `[ :x | ${fill(6)} x size ]`, [collection]);

    assert.deepEqual(await evaluate(runtime, 'app', 'has', '[ :x | x includes: 50 ]', [collection]), booleanValue(true));
    assert.deepEqual(await evaluate(runtime, 'app', 'hasnt', '[ :x | x includes: 99 ]', [collection]), booleanValue(false));
    // Emptiness is the boundary case for a recursive scan.
    const empty = await evaluate(runtime, 'app', 'empty-oc', '[ :c | c new ]', [library.orderedCollection]);
    assert.deepEqual(await evaluate(runtime, 'app', 'empty-has', '[ :x | x includes: 1 ]', [empty]), booleanValue(false));
  });
});

// `do:` takes a Block and calls it — the whole point of having Blocks, exercised through a library
// class rather than through kernel protocol.
test('do: evaluates its Block once per element, in order', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const collection = await evaluate(runtime, 'app', 'oc', '[ :c | c new ]', [library.orderedCollection]);
    await evaluate(runtime, 'app', 'fill', `[ :x | ${fill(6)} x size ]`, [collection]);

    assert.deepEqual(
      await evaluate(runtime, 'app', 'sum', '[ :x | | t | t := 0. x do: [ :e | t := t + e ]. t ]', [collection]),
      integerValue(210),
      'the Block mutates a temporary of the calling activation',
    );
    // Order, not just the total: each element lands one position later than the last.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'first-seen',
        '[ :x | | seen | seen := 0. x do: [ :e | (seen = 0) ifTrue: [ seen := e ] ]. seen ]', [collection]),
      integerValue(10),
    );
  });
});

test('an OrderedCollection holds ordinary objects, including Associations', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const collection = await evaluate(runtime, 'app', 'oc', '[ :c | c new ]', [library.orderedCollection]);
    const pair = await evaluate(runtime, 'app', 'pair', "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);
    const equal = await evaluate(runtime, 'app', 'equal', "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);

    await evaluate(runtime, 'app', 'add-pair', '[ :x :p | x add: p ]', [collection, pair]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'find-equal', '[ :x :p | x includes: p ]', [collection, equal]),
      booleanValue(true),
      'includes: uses the element class own = , so an equal Association is found',
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'read-back', '[ :x | (x asArray at: 1) value ]', [collection]),
      integerValue(1),
    );
  });
});

test('each collection instance has its own state', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const first = await evaluate(runtime, 'app', 'oc1', '[ :c | c new ]', [library.orderedCollection]);
    const second = await evaluate(runtime, 'app', 'oc2', '[ :c | c new ]', [library.orderedCollection]);
    await evaluate(runtime, 'app', 'fill1', '[ :x | x add: 1. x add: 2 ]', [first]);

    assert.deepEqual(await evaluate(runtime, 'app', 's1', '[ :x | x size ]', [first]), integerValue(2));
    assert.deepEqual(await evaluate(runtime, 'app', 's2', '[ :x | x size ]', [second]), integerValue(0));
  });
});

// Iteration is recursion, because a Block cannot answer `whileTrue:`. That works, and it has a
// ceiling: `do:` over 50 elements is fine while 100 exceeds the activation depth limit. The exact
// ceiling is not asserted — it moves the moment a loop construct arrives — but the limitation is
// real and is recorded in the roadmap.
test('do: handles a collection well past its initial capacity', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const collection = await evaluate(runtime, 'app', 'big', '[ :c | c new ]', [library.orderedCollection]);
    const adds = Array.from({length: 50}, (unused, index) => `x add: ${index + 1}.`).join(' ');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'big-sum', `[ :x | | t | t := 0. ${adds} x do: [ :e | t := t + e ]. t ]`, [collection]),
      integerValue(1275),
      'four growths and fifty Block evaluations',
    );
  });
});

// --- the structural claim -------------------------------------------------------------------------

// The point of the exercise: these are ordinary durable Smalltalk methods, not host operations.
test('every library method is an ordinary Smalltalk method with a semantic artifact', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');

    for (const [classRef, selectors] of [
      [library.association, ['key', 'value', 'key:value:', 'value:', '=', 'hash']],
      [library.orderedCollection, ['initialize', 'size', 'isEmpty', 'add:', 'do:', 'includes:', 'asArray']],
    ]) {
      const behavior = await runtime.images.getObject('app', classRef.objectId);
      const dictionary = await runtime.images.getObject(
        'app', behavior.slots['behavior-methods'].objectId,
      );
      assert.equal(dictionary.shape.objectId, METHOD_DICTIONARY_SHAPE_ID);

      for (const selector of selectors) {
        const methodId = `${classRef.objectId}/method/${Buffer.from(selector, 'utf8').toString('base64url')}`;
        const semantic = await runtime.images.getCodeArtifact('app', `${methodId}:semantic`);
        assert.ok(semantic, `${selector} must have a durable semantic artifact`);
        assert.match(semantic.representation, /^lagrange-code\/v[01]$/);
        assert.equal(semantic.languageId, 'symmetric-smalltalk');
      }
    }
  });
});

// No collection-specific host operation was added. The primitive family is exactly what ADRs
// 0046-0051 installed, and the library reaches storage only through Array's ordinary protocol.
// ADR 0051's two loop primitives are language operations on the Block personality, not collection
// operations: no method in this library names them, and they are reached only by dispatching
// `whileTrue:`/`whileFalse:`.
test('the library adds no new kernel primitive', async () => {
  const {SMALLTALK_PRIMITIVE_NAMES} = await import('../src/language/smalltalk-primitives.js');
  assert.deepEqual([...SMALLTALK_PRIMITIVE_NAMES].sort(), [
    'basic-new',
    'basic-new-sized',
    'block-while-false',
    'block-while-true',
    'built-in-equals',
    'built-in-hash',
    'class-of',
    'dictionary-at',
    'dictionary-at-put',
    'dictionary-includes-key',
    'dictionary-initialize',
    'dictionary-size',
    'indexed-at',
    'indexed-at-put',
    'indexed-size',
    'instance-slot-read',
    'instance-slot-write',
  ]);
});

test('installing the library twice changes nothing', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const before = (await runtime.images.listRecords('app')).length;
    await installSmalltalkLibrary({images: runtime.images, compilation: runtime.compilation, imageId: 'app'});
    assert.equal((await runtime.images.listRecords('app')).length, before);
  });
});

// --- deterministic-id exactness -------------------------------------------------------------------

// A record at a derived id is reused only when it *is* what the installer would have written.
// Accepting any object there would adopt an unrelated one as this class or its layout.
test('a squatter at a library class or shape id is refused, not adopted', async () => {
  for (const [label, plant] of Object.entries({
    'class id': async (runtime) => {
      const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
      const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'wrong-shape', slots: []})).id);
      // A real, well-formed class at Association's id — but a different class.
      const {defineClass} = await import('../src/runtime.js');
      await defineClass({
        images: runtime.images, imageId: 'app', name: 'Association',
        superclassRef: kernel.integerClass, instanceShapeRef: shape,
      });
    },
    'shape id': async (runtime) => {
      await runtime.images.putShape('app', {
        id: 'smalltalk/association-instance-shape/v1',
        slots: [{id: 'not-key', name: 'other'}],
      });
    },
  })) {
    await withRuntime(async (runtime) => {
      // Seed the kernel protocols the library needs, but not the library itself.
      await runtime.images.createImage({id: 'app'});
      await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
      const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app'};
      await installSmalltalkAllocationProtocol(options);
      await installSmalltalkEqualityProtocol(options);
      await installSmalltalkControlFlow(options);
      await installSmalltalkIndexedProtocol(options);
      await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
      const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
      await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});

      await plant(runtime);
      await assert.rejects(
        installSmalltalkLibrary(options),
        (error) => error.name === 'SmalltalkKernelConflictError',
        `${label}: a differing record must be refused`,
      );
    });
  }
});

// Metadata is written deterministically by `defineClass`, so it is part of what "the same class"
// means. The method dictionary is excluded from rediscovery because it has a lifecycle; metadata
// does not.
test('altered Behavior metadata makes rediscovery a conflict', async () => {
  for (const target of ['smalltalk/class/Association', 'smalltalk/metaclass/Association']) {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app');
      const record = await runtime.images.getObject('app', target);
      await runtime.images.putObject('app', {
        id: record.id,
        shape: record.shape,
        behavior: record.behavior,
        slots: record.slots,
        metadata: {...record.metadata, tampered: true},
      }, {expectedVersion: record._version});

      await assert.rejects(
        installSmalltalkLibrary({images: runtime.images, compilation: runtime.compilation, imageId: 'app'}),
        (error) => error.name === 'SmalltalkKernelConflictError',
        `${target}: altered metadata must be refused`,
      );
    });
  }
});

// --- capture declarations -----------------------------------------------------------------------

// Compilation takes declarations; installation binds values. Every declaration becomes a binding in
// the installed method, so a declaration without a value is an installation error that says so.
test('a capture declared without a value fails at installation, naming the capture', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const {defineMethodsFromSource} = await import('../src/runtime.js');
    await assert.rejects(
      defineMethodsFromSource({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: library.association,
        methods: [{selector: 'needsIt', source: '[ Thing ]', captures: {Thing: 'lib/thing'}}],
      }),
      /declares capture Thing without a value/,
    );
  });
});

// The rule is uniform, which is the point: a declaration is a binding, so an unused one needs a
// value too. Uniform beats a special case that would depend on whether the compiler happened to keep
// the reference.
test('an unused declaration needs a value as well, and works when given one', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const {defineMethodsFromSource} = await import('../src/runtime.js');
    const captures = [{name: 'Thing', id: 'lib/unused-thing', value: integerValue(1)}];
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: library.association,
      methods: [{selector: 'ignoresIt', source: '[ key ]', captures}],
    });
    const pair = await evaluate(runtime, 'app', 'p', "[ :c | (c new) key: 5 value: 1 ]", [library.association]);
    assert.deepEqual(await evaluate(runtime, 'app', 'ig', '[ :a | a ignoresIt ]', [pair]), integerValue(5));
  });
});

// The binder injects its own captures for instance-variable access, and spreads them *after* the
// caller's — so without this a colliding declaration would be silently replaced, value included.
test('a capture declaration cannot collide with the binder own namespace', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const {defineMethodsFromSource} = await import('../src/runtime.js');
    const attempt = (captures) => defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: library.association,
      methods: [{selector: 'clash', source: '[ key ]', captures}],
    });
    await assert.rejects(
      attempt([{name: '$instanceSlotRead', id: 'lib/mine', value: integerValue(1)}]),
      /capture name \$instanceSlotRead is reserved/,
    );
    await assert.rejects(
      attempt([{name: 'Mine', id: 'smalltalk/primitive/instance-slot-write', value: integerValue(1)}]),
      /capture id smalltalk\/primitive\/instance-slot-write is reserved/,
    );
  });
});

test('duplicate capture declarations are refused rather than resolved by position', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const {defineMethodsFromSource} = await import('../src/runtime.js');
    const attempt = (captures) => defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: library.association,
      methods: [{selector: 'dup', source: '[ key ]', captures}],
    });
    await assert.rejects(
      attempt([{name: 'A', id: 'lib/one', value: integerValue(1)}, {name: 'A', id: 'lib/two', value: integerValue(2)}]),
      /declares capture name A twice/,
    );
    await assert.rejects(
      attempt([{name: 'A', id: 'lib/same', value: integerValue(1)}, {name: 'B', id: 'lib/same', value: integerValue(2)}]),
      /declares capture id lib\/same twice/,
    );
  });
});

// --- the compiler gap this exercise exposed ---------------------------------------------------------

// Found by writing `includes:index:`, whose instance-variable reference sits inside a Block inside a
// Block. Resolution asked an intermediate scope to *provide* the name; that scope resolved it to an
// instance-slot expression, which adds no capture, and the caller then read a capture that was not
// there. One Block deep had always worked, which is why the nested-Block landing missed it.
test('an instance variable resolves from a Block nested two levels deep', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const collection = await evaluate(runtime, 'app', 'deep', '[ :c | c new ]', [library.orderedCollection]);
    await evaluate(runtime, 'app', 'deep-fill', '[ :x | x add: 5 ]', [collection]);
    // `includes:index:` is exactly that shape, and it reads `contents` from the inner arm.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'deep-has', '[ :x | x includes: 5 ]', [collection]),
      booleanValue(true),
    );
  });
});

// ADR 0051's reason for existing, discharged. Before it, `do:` recursed once per element and every
// traversal sat under the 256-activation limit: 50 elements worked and 100 raised "activation depth
// limit exceeded". The methods were correct the whole time; they were simply unreachable at any
// useful size.
test('a large OrderedCollection traverses, where recursion used to exceed the depth limit', async () => {
  await withRuntime(async (runtime) => {
    const {library} = await seed(runtime, 'app');
    const collection = await evaluate(runtime, 'app', 'big', `[ :c | | oc i |
      oc := c new.
      i := 0.
      [ i = 110 ] whileFalse: [ i := i + 1. oc add: i ].
      oc ]`, [library.orderedCollection]);

    assert.deepEqual(await evaluate(runtime, 'app', 'big-size', '[ :oc | oc size ]', [collection]), integerValue(110));
    // `do:` over 110 elements. Before ADR 0051 this collection could be built but not traversed:
    // 50 elements answered 1275 and 100 raised "activation depth limit exceeded".
    assert.deepEqual(
      await evaluate(runtime, 'app', 'big-sum', `[ :oc | | sum |
        sum := 0.
        oc do: [ :each | sum := sum + each ].
        sum ]`, [collection]),
      integerValue(6105),
    );
    // And `includes:`, which also had to scan by recursion.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'big-inc', '[ :oc | oc includes: 109 ]', [collection]),
      booleanValue(true),
    );
  });
});
