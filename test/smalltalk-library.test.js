import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installSmalltalkGlobalNamespace,
  publishSmalltalkClassGlobals,
  booleanValue,
  createRuntime,
  defineClass,
  defineMethods,
  ensureSmalltalkShape,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkConditionProtocol,
  installSmalltalkIntegerProtocol,
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
import {sharedFixture} from './support/shared-fixture.js';

// The first image-resident library. What is under test is not really `add:` — it is that a class
// written in ordinary Smalltalk, over the facilities ADRs 0043-0050 built, behaves like a class.
//
// So the assertions that matter most are the structural ones: every method is a durable Smalltalk
// method with a semantic artifact, and no host primitive was added for either class.

// Most tests here only ADD their own uniquely-named classes/blocks and never mutate shared durable
// state, so they share one installed image per lane (the expensive kernel+library install runs
// once). Tests that count records, corrupt a class, or tamper with metadata keep their own runtime
// via `withRuntime` below. `evaluate` mints each block id through `unique` so two tests never
// collide on a shared image.
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
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkControlFlow(options);
  await installSmalltalkIndexedProtocol(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  await installSmalltalkIntegerProtocol(options);
  await installSmalltalkConditionProtocol(options);
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  await installSmalltalkGlobalNamespace(options);
  await publishSmalltalkClassGlobals({
    images: runtime.images, imageId, names: ['Array', 'IndexOutOfRange', 'EmptyCollection'],
  });
  const library = await installSmalltalkLibrary(options);
  // The library's own classes, so library tests may name them in source — Collection for
  // hierarchy work, OrderedCollection for species overrides that derive to it.
  await publishSmalltalkClassGlobals({
    images: runtime.images, imageId, names: ['Collection', 'OrderedCollection'],
  });
  return {kernel, library};
}

// The shared fixture: one installed image per lane, seeded once via `seed` above. `shared(lane)`
// answers `{runtime, imageId, kernel, library, unique}`.
const shared = async (lane = 'neutral') => await sharedFixture('library', lane, seed);

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// --- Association ---------------------------------------------------------------------------------

test('an Association holds a key and a value', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const pair = await evaluate(runtime, imageId, unique('pair'), "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);

  assert.deepEqual(await evaluate(runtime, imageId, unique('key'), '[ :a | a key ]', [pair]), textValue('k'));
  assert.deepEqual(await evaluate(runtime, imageId, unique('value'), '[ :a | a value ]', [pair]), integerValue(1));
  await evaluate(runtime, imageId, unique('set'), '[ :a | a value: 2 ]', [pair]);
  assert.deepEqual(await evaluate(runtime, imageId, unique('value2'), '[ :a | a value ]', [pair]), integerValue(2));
});

test('Association equality compares key and value, and guards its argument', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const make = (id, key, value) =>
    evaluate(runtime, imageId, unique(id), `[ :c | (c new) key: ${key} value: ${value} ]`, [library.association]);
  const a = await make('a', '1', '2');
  const same = await make('b', '1', '2');
  const otherValue = await make('c', '1', '3');
  const otherKey = await make('d', '9', '2');

  assert.deepEqual(await evaluate(runtime, imageId, unique('eq'), '[ :x :y | x = y ]', [a, same]), booleanValue(true));
  assert.deepEqual(await evaluate(runtime, imageId, unique('ne-v'), '[ :x :y | x = y ]', [a, otherValue]), booleanValue(false));
  assert.deepEqual(await evaluate(runtime, imageId, unique('ne-k'), '[ :x :y | x = y ]', [a, otherKey]), booleanValue(false));
  // The same-class guard: comparing against a non-Association must answer false, not fail with
  // message-not-understood on `key`.
  assert.deepEqual(await evaluate(runtime, imageId, unique('ne-int'), '[ :x | x = 7 ]', [a]), booleanValue(false));
  assert.deepEqual(await evaluate(runtime, imageId, unique('ne-text'), "[ :x | x = 'nope' ]", [a]), booleanValue(false));
});

// ADR 0048 decision 4's obligation, discharged by an ordinary Smalltalk class rather than by a helper.
test('equal Associations hash alike, and a Dictionary uses those methods', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const {installSmalltalkDictionaryProtocol} = await import('../src/runtime.js');
  await installSmalltalkDictionaryProtocol({
    images: runtime.images, compilation: runtime.compilation, imageId,
  });
  const make = (id) => evaluate(runtime, imageId, unique(id), "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);
  const first = await make('h1');
  const second = await make('h2');

  assert.deepEqual(
    await evaluate(runtime, imageId, unique('hash-eq'), '[ :x :y | x hash = y hash ]', [first, second]),
    booleanValue(true),
  );
  // Two distinct objects that the class says are equal are therefore one Dictionary key.
  const dictionary = await evaluate(runtime, imageId, unique('dict'), '[ :c | c new ]',
    [objectRef(imageId, 'smalltalk/class/Dictionary')]);
  await evaluate(runtime, imageId, unique('put1'), '[ :d :k | d at: k put: 1 ]', [dictionary, first]);
  await evaluate(runtime, imageId, unique('put2'), '[ :d :k | d at: k put: 2 ]', [dictionary, second]);
  assert.deepEqual(await evaluate(runtime, imageId, unique('dsize'), '[ :d | d size ]', [dictionary]), integerValue(1));
  assert.deepEqual(await evaluate(runtime, imageId, unique('dget'), '[ :d :k | d at: k ]', [dictionary, first]), integerValue(2));
});

// --- OrderedCollection ---------------------------------------------------------------------------

const fill = (count) => Array.from({length: count}, (unused, index) => `x add: ${(index + 1) * 10}.`).join(' ');

for (const lane of ['neutral', 'wasm']) {
  test(`an OrderedCollection grows and reads back through the ${lane} lane`, async () => {
    const {runtime, imageId, library, unique} = await shared(lane);
    const collection = await evaluate(runtime, imageId, unique(`oc-${lane}`), '[ :c | c new ]', [library.orderedCollection]);

    assert.deepEqual(await evaluate(runtime, imageId, unique(`empty-${lane}`), '[ :x | x isEmpty ]', [collection]), booleanValue(true));
    assert.deepEqual(await evaluate(runtime, imageId, unique(`size0-${lane}`), '[ :x | x size ]', [collection]), integerValue(0));

    // Nine additions past an initial capacity of four: growth happens twice.
    assert.deepEqual(
      await evaluate(runtime, imageId, unique(`add-${lane}`), `[ :x | ${fill(9)} x size ]`, [collection]),
      integerValue(9),
    );
    assert.deepEqual(await evaluate(runtime, imageId, unique(`empty2-${lane}`), '[ :x | x isEmpty ]', [collection]), booleanValue(false));
    assert.deepEqual(
      await evaluate(runtime, imageId, unique(`arr-${lane}`), '[ :x | x asArray at: 9 ]', [collection]),
      integerValue(90),
      'every element survives the two growths',
    );
    assert.deepEqual(
      await evaluate(runtime, imageId, unique(`arrsize-${lane}`), '[ :x | x asArray size ]', [collection]),
      integerValue(9),
      'asArray is exactly the collection size, not the backing capacity',
    );
  });
}

test('includes: finds an element and reports absence', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('oc'), '[ :c | c new ]', [library.orderedCollection]);
  await evaluate(runtime, imageId, unique('fill'), `[ :x | ${fill(6)} x size ]`, [collection]);

  assert.deepEqual(await evaluate(runtime, imageId, unique('has'), '[ :x | x includes: 50 ]', [collection]), booleanValue(true));
  assert.deepEqual(await evaluate(runtime, imageId, unique('hasnt'), '[ :x | x includes: 99 ]', [collection]), booleanValue(false));
  // Emptiness is the boundary case for a recursive scan.
  const empty = await evaluate(runtime, imageId, unique('empty-oc'), '[ :c | c new ]', [library.orderedCollection]);
  assert.deepEqual(await evaluate(runtime, imageId, unique('empty-has'), '[ :x | x includes: 1 ]', [empty]), booleanValue(false));
});

// `do:` takes a Block and calls it — the whole point of having Blocks, exercised through a library
// class rather than through kernel protocol.
test('do: evaluates its Block once per element, in order', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('oc'), '[ :c | c new ]', [library.orderedCollection]);
  await evaluate(runtime, imageId, unique('fill'), `[ :x | ${fill(6)} x size ]`, [collection]);

  assert.deepEqual(
    await evaluate(runtime, imageId, unique('sum'), '[ :x | | t | t := 0. x do: [ :e | t := t + e ]. t ]', [collection]),
    integerValue(210),
    'the Block mutates a temporary of the calling activation',
  );
  // Order, not just the total: each element lands one position later than the last.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('first-seen'),
      '[ :x | | seen | seen := 0. x do: [ :e | (seen = 0) ifTrue: [ seen := e ] ]. seen ]', [collection]),
    integerValue(10),
  );
});

test('an OrderedCollection holds ordinary objects, including Associations', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('oc'), '[ :c | c new ]', [library.orderedCollection]);
  const pair = await evaluate(runtime, imageId, unique('pair'), "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);
  const equal = await evaluate(runtime, imageId, unique('equal'), "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);

  await evaluate(runtime, imageId, unique('add-pair'), '[ :x :p | x add: p ]', [collection, pair]);
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('find-equal'), '[ :x :p | x includes: p ]', [collection, equal]),
    booleanValue(true),
    'includes: uses the element class own = , so an equal Association is found',
  );
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('read-back'), '[ :x | (x asArray at: 1) value ]', [collection]),
    integerValue(1),
  );
});

test('each collection instance has its own state', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const first = await evaluate(runtime, imageId, unique('oc1'), '[ :c | c new ]', [library.orderedCollection]);
  const second = await evaluate(runtime, imageId, unique('oc2'), '[ :c | c new ]', [library.orderedCollection]);
  await evaluate(runtime, imageId, unique('fill1'), '[ :x | x add: 1. x add: 2 ]', [first]);

  assert.deepEqual(await evaluate(runtime, imageId, unique('s1'), '[ :x | x size ]', [first]), integerValue(2));
  assert.deepEqual(await evaluate(runtime, imageId, unique('s2'), '[ :x | x size ]', [second]), integerValue(0));
});

// Iteration is recursion, because a Block cannot answer `whileTrue:`. That works, and it has a
// ceiling: `do:` over 50 elements is fine while 100 exceeds the activation depth limit. The exact
// ceiling is not asserted — it moves the moment a loop construct arrives — but the limitation is
// real and is recorded in the roadmap.
test('do: handles a collection well past its initial capacity', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('big'), '[ :c | c new ]', [library.orderedCollection]);
  const adds = Array.from({length: 50}, (unused, index) => `x add: ${index + 1}.`).join(' ');
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('big-sum'), `[ :x | | t | t := 0. ${adds} x do: [ :e | t := t + e ]. t ]`, [collection]),
    integerValue(1275),
    'four growths and fifty Block evaluations',
  );
});

// --- the structural claim -------------------------------------------------------------------------

// The point of the exercise: these are ordinary durable Smalltalk methods, not host operations.
test('every library method is an ordinary Smalltalk method with a semantic artifact', async () => {
  const {runtime, imageId, library} = await shared();

  for (const [classRef, selectors] of [
    [library.association, ['key', 'value', 'key:value:', 'value:', '=', 'hash']],
    [library.collection, [
      // The shared protocol: species plus the enumeration written against `do:` and it.
      'species', 'collect:', 'select:', 'detect:ifNone:', 'inject:into:',
    ]],
    [library.orderedCollection, [
      'initialize', 'size', 'isEmpty', 'add:', 'do:', 'includes:', 'asArray',
    ]],
  ]) {
    const behavior = await runtime.images.getObject(imageId, classRef.objectId);
    const dictionary = await runtime.images.getObject(
      imageId, behavior.slots['behavior-methods'].objectId,
    );
    assert.equal(dictionary.shape.objectId, METHOD_DICTIONARY_SHAPE_ID);

    for (const selector of selectors) {
      const methodId = `${classRef.objectId}/method/${Buffer.from(selector, 'utf8').toString('base64url')}`;
      const semantic = await runtime.images.getCodeArtifact(imageId, `${methodId}:semantic`);
      assert.ok(semantic, `${selector} must have a durable semantic artifact`);
      assert.match(semantic.representation, /^lagrange-code\/v[01]$/);
      assert.equal(semantic.languageId, 'symmetric-smalltalk');
    }
  }
});

// No collection-specific host operation was added. The primitive family is exactly what ADRs
// 0046-0051 installed, and the library reaches storage only through Array's ordinary protocol.
// The loop (ADR 0051), Integer (ADR 0053), condition (ADR 0054) and non-local-return (ADR 0055)
// primitives are language operations, not collection operations. `non-local-return` is reached only
// by the compiler's `^` lowering and is never named in source. They are reached by
// dispatching `whileTrue:`/`whileFalse:` and `<`/`<=`/`-` like any other message.
test('the library adds no new kernel primitive', async () => {
  const {SMALLTALK_PRIMITIVE_NAMES} = await import('../src/language/smalltalk-primitives.js');
  assert.deepEqual([...SMALLTALK_PRIMITIVE_NAMES].sort(), [
    'basic-new',
    'basic-new-sized',
    'block-ensure',
    'block-if-curtailed',
    'block-on-do',
    'block-while-false',
    'block-while-true',
    'built-in-equals',
    'built-in-hash',
    'class-of',
    'condition-resume',
    'condition-return',
    'condition-signal',
    'dictionary-at',
    'dictionary-at-put',
    'dictionary-includes-key',
    'dictionary-initialize',
    // Workstream 3: Dictionary-owned enumeration, installed by `installSmalltalkDictionaryProtocol`
    // like the five ADR 0048 Dictionary primitives above and below it.
    'dictionary-keys-and-values-do',
    'dictionary-size',
    'indexed-at',
    'indexed-at-put',
    'indexed-size',
    'instance-slot-read',
    'instance-slot-write',
    // The four workstream-3 bitwise primitives belong to the *Integer* protocol (ADR 0053 family),
    // not to the library — they are registered by `installSmalltalkIntegerProtocol`, which this
    // image also runs. Their presence here is the protocol's, and the assertion still proves the
    // *library* itself adds nothing beyond the kernel's frozen set plus these named primitives.
    'integer-bit-and',
    'integer-bit-or',
    'integer-bit-shift',
    'integer-bit-xor',
    'integer-floor-divide',
    'integer-less-than',
    'integer-modulo',
    'integer-multiply',
    'integer-subtract',
    'non-local-return',
    // Symbol protocol: interning and dynamic send, installed by
    // `installSmalltalkSymbolProtocol` which the standard image runs.
    'perform-send',
    'perform-send-with',
    // Class-hierarchy introspection: `subclasses-of` is installed by
    // `installSmalltalkSubclassProtocol`, not by the library — the library still adds nothing.
    'subclasses-of',
    'symbol-intern',
  ]);
});

test('installing the library twice changes nothing', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
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
      await runtime.images.createImage({id: 'app'});
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
  const {runtime, imageId, library} = await shared();
  const {defineMethodsFromSource} = await import('../src/runtime.js');
  await assert.rejects(
    defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId,
      classRef: library.association,
      methods: [{selector: 'needsIt', source: '[ Thing ]', captures: {Thing: 'lib/thing'}}],
    }),
    /declares capture Thing without a value/,
  );
});

// The rule is uniform, which is the point: a declaration is a binding, so an unused one needs a
// value too. Uniform beats a special case that would depend on whether the compiler happened to keep
// the reference.
test('an unused declaration needs a value as well, and works when given one', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const {defineMethodsFromSource} = await import('../src/runtime.js');
  const captures = [{name: 'Thing', id: 'lib/unused-thing', value: integerValue(1)}];
  await defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId,
    classRef: library.association,
    methods: [{selector: 'ignoresIt', source: '[ key ]', captures}],
  });
  const pair = await evaluate(runtime, imageId, unique('p'), "[ :c | (c new) key: 5 value: 1 ]", [library.association]);
  assert.deepEqual(await evaluate(runtime, imageId, unique('ig'), '[ :a | a ignoresIt ]', [pair]), integerValue(5));
});

// The binder injects its own captures for instance-variable access, and spreads them *after* the
// caller's — so without this a colliding declaration would be silently replaced, value included.
test('a capture declaration cannot collide with the binder own namespace', async () => {
  const {runtime, imageId, library} = await shared();
  const {defineMethodsFromSource} = await import('../src/runtime.js');
  const attempt = (captures) => defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId,
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

test('duplicate capture declarations are refused rather than resolved by position', async () => {
  const {runtime, imageId, library} = await shared();
  const {defineMethodsFromSource} = await import('../src/runtime.js');
  const attempt = (captures) => defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId,
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

// --- the compiler gap this exercise exposed ---------------------------------------------------------

// Found by writing `includes:index:`, whose instance-variable reference sits inside a Block inside a
// Block. Resolution asked an intermediate scope to *provide* the name; that scope resolved it to an
// instance-slot expression, which adds no capture, and the caller then read a capture that was not
// there. One Block deep had always worked, which is why the nested-Block landing missed it.
test('an instance variable resolves from a Block nested two levels deep', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('deep'), '[ :c | c new ]', [library.orderedCollection]);
  await evaluate(runtime, imageId, unique('deep-fill'), '[ :x | x add: 5 ]', [collection]);
  // `includes:index:` is exactly that shape, and it reads `contents` from the inner arm.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('deep-has'), '[ :x | x includes: 5 ]', [collection]),
    booleanValue(true),
  );
});

// ADR 0051's reason for existing, discharged. Before it, `do:` recursed once per element and every
// traversal sat under the 256-activation limit: 50 elements worked and 100 raised "activation depth
// limit exceeded". The methods were correct the whole time; they were simply unreachable at any
// useful size.
test('a large OrderedCollection traverses, where recursion used to exceed the depth limit', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('big'), `[ :c | | oc i |
    oc := c new.
    i := 0.
    [ i = 110 ] whileFalse: [ i := i + 1. oc add: i ].
    oc ]`, [library.orderedCollection]);

  assert.deepEqual(await evaluate(runtime, imageId, unique('big-size'), '[ :oc | oc size ]', [collection]), integerValue(110));
  // `do:` over 110 elements. Before ADR 0051 this collection could be built but not traversed:
  // 50 elements answered 1275 and 100 raised "activation depth limit exceeded".
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('big-sum'), `[ :oc | | sum |
      sum := 0.
      oc do: [ :each | sum := sum + each ].
      sum ]`, [collection]),
    integerValue(6105),
  );
  // And `includes:`, which also had to scan by recursion.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('big-inc'), '[ :oc | oc includes: 109 ]', [collection]),
    booleanValue(true),
  );
});

// --- ADR 0053: bounds-checked access --------------------------------------------------------------

// `at:` is the first integration test for ordering, and the interesting edge is not the arithmetic —
// it is that the collection's logical size must bound the access, never the backing Array's
// capacity. `contents at:` succeeds for any index up to capacity, so a collection that deferred to
// it would answer whatever slack the growth policy left behind.
test('at: bounds by tally, not by the backing Array capacity', async () => {
  const {runtime, imageId, library, unique} = await shared();
  // One element in a collection whose backing Array holds four: indices 2..4 are readable from the
  // Array and must still be refused by the collection.
  const collection = await evaluate(runtime, imageId, unique('one'),
    '[ :c | | oc | oc := c new. oc add: 11. oc ]', [library.orderedCollection]);

  assert.deepEqual(await evaluate(runtime, imageId, unique('size-one'), '[ :oc | oc size ]', [collection]), integerValue(1));
  assert.deepEqual(await evaluate(runtime, imageId, unique('at-one'), '[ :oc | oc at: 1 ]', [collection]), integerValue(11));

  // The capacity leak, if the bound were wrong: index 2 is inside the Array and outside the
  // collection. It must be refused rather than answering the Array's unused slot.
  for (const index of [2, 3, 4]) {
    await assert.rejects(
      evaluate(runtime, imageId, unique(`at-slack-${index}`), `[ :oc | oc at: ${index} ]`, [collection]),
      /unhandled Smalltalk condition/,
      `index ${index} is within the backing Array but outside the collection`,
    );
  }
  // The private backing Array really does hold that slack, so the refusals above are not vacuous.
  // Read from the durable record rather than through `asArray`, which answers a tally-sized copy
  // and so says nothing about capacity.
  const record = await runtime.images.getObject(imageId, collection.objectId);
  const contents = await runtime.images.getObject(imageId, record.slots['ordered-collection-contents'].objectId);
  assert.equal(contents.indexed.length, 4,
    'the growth policy starts at four, so indices 2..4 exist in the Array and are refused above');
});

test('at: refuses an index below one and past the end', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('three'), `[ :c | | oc |
    oc := c new. oc add: 1. oc add: 2. oc add: 3. oc ]`, [library.orderedCollection]);

  assert.deepEqual(await evaluate(runtime, imageId, unique('at-1'), '[ :oc | oc at: 1 ]', [collection]), integerValue(1));
  assert.deepEqual(await evaluate(runtime, imageId, unique('at-3'), '[ :oc | oc at: 3 ]', [collection]), integerValue(3));
  for (const index of ['0', '(0 - 1)', '4']) {
    await assert.rejects(
      evaluate(runtime, imageId, unique(`at-bad-${index}`), `[ :oc | oc at: ${index} ]`, [collection]),
      /unhandled Smalltalk condition/,
      `index ${index}`,
    );
  }
});

test('first, last and removeLast work, and refuse on an empty collection', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('flr'), `[ :c | | oc |
    oc := c new. oc add: 7. oc add: 8. oc add: 9. oc ]`, [library.orderedCollection]);

  assert.deepEqual(await evaluate(runtime, imageId, unique('first'), '[ :oc | oc first ]', [collection]), integerValue(7));
  assert.deepEqual(await evaluate(runtime, imageId, unique('last'), '[ :oc | oc last ]', [collection]), integerValue(9));
  assert.deepEqual(await evaluate(runtime, imageId, unique('rm'), '[ :oc | oc removeLast ]', [collection]), integerValue(9));
  assert.deepEqual(await evaluate(runtime, imageId, unique('after-rm'), '[ :oc | oc size ]', [collection]), integerValue(2));
  assert.deepEqual(await evaluate(runtime, imageId, unique('last-2'), '[ :oc | oc last ]', [collection]), integerValue(8));
  // Removing does not make the removed element reachable again through at:.
  await assert.rejects(
    evaluate(runtime, imageId, unique('at-removed'), '[ :oc | oc at: 3 ]', [collection]),
    /unhandled Smalltalk condition/,
  );

  // Empty: every accessor refuses rather than answering the backing Array's nil.
  const empty = await evaluate(runtime, imageId, unique('empty'), '[ :c | c new ]', [library.orderedCollection]);
  await assert.rejects(evaluate(runtime, imageId, unique('e-first'), '[ :oc | oc first ]', [empty]), /unhandled Smalltalk condition/);
  await assert.rejects(evaluate(runtime, imageId, unique('e-last'), '[ :oc | oc last ]', [empty]), /unhandled Smalltalk condition/);
  await assert.rejects(
    evaluate(runtime, imageId, unique('e-rm'), '[ :oc | oc removeLast ]', [empty]),
    /unhandled Smalltalk condition/,
  );
});

// `at:` refusing to answer a removed element is not the same as the element being gone. The backing
// Array is a durable object, so a ref left behind keeps the removed element reachable in the graph —
// and a large collection drained to empty would retain everything it ever held.
test('removeLast clears the slot it vacates, so the element is not retained', async () => {
  const {runtime, imageId, kernel, library, unique} = await shared();
  const held = await evaluate(runtime, imageId, unique('held'), "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);
  const collection = await evaluate(runtime, imageId, unique('holder'),
    '[ :c :item | | oc | oc := c new. oc add: item. oc ]', [library.orderedCollection, held]);

  const backingArray = async () => {
    const record = await runtime.images.getObject(imageId, collection.objectId);
    return await runtime.images.getObject(imageId, record.slots['ordered-collection-contents'].objectId);
  };
  assert.deepEqual((await backingArray()).indexed[0], held, 'the element is in the Array before removal');

  await evaluate(runtime, imageId, unique('drop'), '[ :oc | oc removeLast ]', [collection]);

  const after = await backingArray();
  assert.deepEqual(after.indexed[0], kernel.nil, 'the vacated slot must be cleared, not merely hidden');
  // Nothing anywhere in the collection still points at the removed element.
  assert.ok(
    !JSON.stringify(after.indexed).includes(held.objectId),
    'the removed element is still reachable through the backing Array',
  );
});

test('removeLast down to empty, then refuses', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('drain'), `[ :c | | oc |
    oc := c new. oc add: 1. oc add: 2. oc ]`, [library.orderedCollection]);
  assert.deepEqual(await evaluate(runtime, imageId, unique('d1'), '[ :oc | oc removeLast ]', [collection]), integerValue(2));
  assert.deepEqual(await evaluate(runtime, imageId, unique('d2'), '[ :oc | oc removeLast ]', [collection]), integerValue(1));
  assert.deepEqual(await evaluate(runtime, imageId, unique('d-size'), '[ :oc | oc size ]', [collection]), integerValue(0));
  assert.deepEqual(await evaluate(runtime, imageId, unique('d-empty'), '[ :oc | oc isEmpty ]', [collection]), booleanValue(true));
  await assert.rejects(
    evaluate(runtime, imageId, unique('d3'), '[ :oc | oc removeLast ]', [collection]),
    /unhandled Smalltalk condition/,
  );
});

// ADR 0054's payoff for the library: a refusal is catchable, so the alternative-value idiom is
// ordinary Smalltalk rather than a second primitive.
test('at:ifAbsent: handles the collection own signal', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const collection = await evaluate(runtime, imageId, unique('ifabs'),
    '[ :c | | oc | oc := c new. oc add: 5. oc ]', [library.orderedCollection]);

  assert.deepEqual(
    await evaluate(runtime, imageId, unique('present'), '[ :oc | oc at: 1 ifAbsent: [ 99 ] ]', [collection]),
    integerValue(5),
  );
  for (const index of ['0', '2', '(0 - 1)']) {
    assert.deepEqual(
      await evaluate(runtime, imageId, unique(`absent-${index}`), `[ :oc | oc at: ${index} ifAbsent: [ 99 ] ]`, [collection]),
      integerValue(99),
      `index ${index} must take the absent branch rather than failing`,
    );
  }
  // The signal is still a signal: unhandled, it fails.
  await assert.rejects(
    evaluate(runtime, imageId, unique('still-fails'), '[ :oc | oc at: 2 ]', [collection]),
    /unhandled Smalltalk condition/,
  );
});

// The gap signal ADR 0047 recorded is retired with the gap: no library method counts up to
// `tally + 1` and compares with `=` any more.
test('the count-up-and-compare-with-= idiom is gone from the library', async () => {
  const {ORDERED_COLLECTION_METHODS} = await import('../src/language/smalltalk-library.js');
  for (const {selector, source} of ORDERED_COLLECTION_METHODS) {
    // The idiom is *comparing* against `tally + 1`, not the increment in `add:`, which is ordinary
    // arithmetic and stays.
    assert.ok(
      !/=\s*\(tally \+ 1\)/.test(source),
      `${selector} still counts up to tally + 1 instead of bounding with <=`,
    );
  }
  // And `includes:` answers from its loop rather than carrying a flag out (ADR 0055).
  const includes = ORDERED_COLLECTION_METHODS.find(({selector}) => selector === 'includes:');
  assert.ok(!/found/.test(includes.source), 'the found temporary must be gone, not merely unused');
  assert.match(includes.source, /\^/, 'includes: must answer with a non-local return');

  // And the traversals do state their bound.
  const traversals = ORDERED_COLLECTION_METHODS.filter(({selector}) => ['do:', 'copyInto:'].includes(selector));
  assert.equal(traversals.length, 2);
  for (const {selector, source} of traversals) {
    assert.match(source, /index <= tally/, `${selector} must bound with <=`);
  }
});

// --- higher-order enumeration ----------------------------------------------------------------------

// Built on `do:` rather than on four more indexed loops, so what these tests are really about is
// whether library protocol can now compose library protocol: a Block passed through a method, a
// loop inside that method, a `^` crossing back out, and mutable capture along the way.

const collectionOf = (runtime, imageId, id, library, items) => evaluate(
  runtime, imageId, id,
  `[ :c | | x | x := c new. ${items.map((item) => `x add: ${item}. `).join('')}x ]`,
  [library.orderedCollection],
);

for (const lane of ['neutral', 'wasm']) {
  test(`collect: transforms every element in order through the ${lane} lane`, async () => {
    const {runtime, imageId, library, unique} = await shared(lane);
    const source = await collectionOf(runtime, imageId, unique(`c-src-${lane}`), library, [1, 2, 3]);
    const mapped = await evaluate(runtime, imageId, unique(`c-map-${lane}`),
      '[ :x | x collect: [ :e | e + 10 ] ]', [source]);

    assert.deepEqual(await evaluate(runtime, imageId, unique(`c-size-${lane}`), '[ :m | m size ]', [mapped]), integerValue(3));
    // Order preserved, every element transformed.
    for (const [index, expected] of [[1, 11], [2, 12], [3, 13]]) {
      assert.deepEqual(
        await evaluate(runtime, imageId, unique(`c-at-${lane}-${index}`), `[ :m | m at: ${index} ]`, [mapped]),
        integerValue(expected),
      );
    }
    // A distinct collection, and the receiver is untouched.
    assert.notEqual(mapped.objectId, source.objectId);
    assert.deepEqual(await evaluate(runtime, imageId, unique(`c-src-size-${lane}`), '[ :x | x size ]', [source]), integerValue(3));
    assert.deepEqual(await evaluate(runtime, imageId, unique(`c-src-at-${lane}`), '[ :x | x at: 1 ]', [source]), integerValue(1));
  });

  test(`select: keeps matching elements in order through the ${lane} lane`, async () => {
    const {runtime, imageId, library, unique} = await shared(lane);
    const source = await collectionOf(runtime, imageId, unique(`s-src-${lane}`), library, [1, 2, 3, 4]);

    // None, some and all.
    assert.deepEqual(
      await evaluate(runtime, imageId, unique(`s-none-${lane}`), '[ :x | (x select: [ :e | e = 9 ]) size ]', [source]),
      integerValue(0),
    );
    assert.deepEqual(
      await evaluate(runtime, imageId, unique(`s-all-${lane}`), '[ :x | (x select: [ :e | e <= 4 ]) size ]', [source]),
      integerValue(4),
    );
    const some = await evaluate(runtime, imageId, unique(`s-some-${lane}`),
      '[ :x | x select: [ :e | e >= 3 ] ]', [source]);
    assert.deepEqual(await evaluate(runtime, imageId, unique(`s-some-size-${lane}`), '[ :m | m size ]', [some]), integerValue(2));
    assert.deepEqual(await evaluate(runtime, imageId, unique(`s-some-1-${lane}`), '[ :m | m at: 1 ]', [some]), integerValue(3));
    assert.deepEqual(await evaluate(runtime, imageId, unique(`s-some-2-${lane}`), '[ :m | m at: 2 ]', [some]), integerValue(4));

    assert.deepEqual(await evaluate(runtime, imageId, unique(`s-src-size-${lane}`), '[ :x | x size ]', [source]), integerValue(4));
  });

  // The ADR 0055 pressure test, in ordinary library clothing: the `^` originates in a predicate
  // Block that `do:` invokes, and must leave the enclosing `detect:ifNone:` activation through
  // `do:`, its loop, and the intervening Block machinery.
  //
  // The counter is what makes a local Block return fail rather than accidentally pass: a local
  // return would let `do:` run to the end (count 4) and `detect:ifNone:` fall through to its
  // `noneBlock`, answering 0 instead of the element.
  test(`detect:ifNone: answers the first match and stops, through the ${lane} lane`, async () => {
    const {runtime, imageId, library, unique} = await shared(lane);
    const source = await collectionOf(runtime, imageId, unique(`d-src-${lane}`), library, [5, 6, 7, 8]);

    // `count` is a mutable temporary of the *caller*, captured by the predicate — so it also
    // exercises lexical capture across the whole composition.
    const found = await evaluate(runtime, imageId, unique(`d-found-${lane}`), `[ :x | | count answer |
      count := 0.
      answer := x detect: [ :e | count := count + 1. e = 6 ] ifNone: [ 0 ].
      (answer * 100) + count ]`, [source]);
    assert.deepEqual(
      found, integerValue(602),
      'expected element 6 after 2 predicate evaluations; a local Block return would answer 4 (0 * 100 + 4)',
    );

    // The ifNone: Block runs exactly when nothing matches, and not otherwise.
    const missing = await evaluate(runtime, imageId, unique(`d-none-${lane}`), `[ :x | | count answer noneRan |
      count := 0. noneRan := 0.
      answer := x detect: [ :e | count := count + 1. e = 99 ] ifNone: [ noneRan := 1. 42 ].
      (answer * 100) + ((count * 10) + noneRan) ]`, [source]);
    assert.deepEqual(
      missing, integerValue(4241),
      'expected 42 after all 4 elements with the none Block run once',
    );

    const present = await evaluate(runtime, imageId, unique(`d-none-not-run-${lane}`), `[ :x | | noneRan |
      noneRan := 0.
      x detect: [ :e | e = 5 ] ifNone: [ noneRan := 1. 0 ].
      noneRan ]`, [source]);
    assert.deepEqual(present, integerValue(0), 'the none Block must not run when an element matches');
  });

  // Decimal accumulation rather than a sum: reversing the Block's arguments would still answer
  // correctly for a commutative fold, and would not here.
  test(`inject:into: folds left with the arguments in order, through the ${lane} lane`, async () => {
    const {runtime, imageId, library, unique} = await shared(lane);
    const source = await collectionOf(runtime, imageId, unique(`i-src-${lane}`), library, [1, 2, 3]);

    assert.deepEqual(
      await evaluate(runtime, imageId, unique(`i-fold-${lane}`),
        '[ :x | x inject: 0 into: [ :acc :e | (acc * 10) + e ] ]', [source]),
      integerValue(123),
      'reversed Block arguments would answer 3 * 10 + accumulator instead',
    );
    // The initial value is used, and used first.
    assert.deepEqual(
      await evaluate(runtime, imageId, unique(`i-seed-${lane}`),
        '[ :x | x inject: 9 into: [ :acc :e | (acc * 10) + e ] ]', [source]),
      integerValue(9123),
    );
  });
}

test('all four enumeration protocols handle an empty collection', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const empty = await evaluate(runtime, imageId, unique('empty-coll'), '[ :c | c new ]', [library.orderedCollection]);

  assert.deepEqual(
    await evaluate(runtime, imageId, unique('e-collect'), '[ :x | (x collect: [ :e | e + 1 ]) size ]', [empty]),
    integerValue(0),
  );
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('e-select'), '[ :x | (x select: [ :e | e = 1 ]) size ]', [empty]),
    integerValue(0),
  );
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('e-detect'), '[ :x | x detect: [ :e | e = 1 ] ifNone: [ 77 ] ]', [empty]),
    integerValue(77),
    'an empty collection must reach the none Block',
  );
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('e-inject'), '[ :x | x inject: 5 into: [ :acc :e | acc + e ] ]', [empty]),
    integerValue(5),
    'an empty fold answers its initial value',
  );
});

test('select: preserves element identity rather than copying', async () => {
  const {runtime, imageId, library, unique} = await shared();
  // Associations, so identity is observable as a ref rather than as an equal Integer.
  const pair = await evaluate(runtime, imageId, unique('ident-pair'),
    "[ :c | (c new) key: 'k' value: 1 ]", [library.association]);
  const collection = await evaluate(runtime, imageId, unique('ident-coll'),
    '[ :c :p | | x | x := c new. x add: p. x ]', [library.orderedCollection, pair]);

  const selected = await evaluate(runtime, imageId, unique('ident-select'),
    '[ :x | x select: [ :e | 1 = 1 ] ]', [collection]);
  const element = await evaluate(runtime, imageId, unique('ident-at'), '[ :m | m at: 1 ]', [selected]);
  assert.deepEqual(element, pair, 'select: must keep the element itself, not a copy');
});

test('enumeration composes with mutable lexical capture', async () => {
  const {runtime, imageId, library, unique} = await shared();
  const source = await collectionOf(runtime, imageId, unique('cap-src'), library, [1, 2, 3, 4]);
  // A running total in a caller temporary, written from inside a Block that `collect:` passes to
  // `do:` — the cell has to survive the whole composition.
  assert.deepEqual(
    await evaluate(runtime, imageId, unique('cap-run'), `[ :x | | total mapped |
      total := 0.
      mapped := x collect: [ :e | total := total + e. e * 2 ].
      (total * 1000) + ((mapped at: 4) + (mapped size)) ]`, [source]),
    integerValue(10012),
    'total 10, last element 8, size 4',
  );
});

// --- species and the hierarchy ----------------------------------------------------------------

// The point of the slice: enumeration lives on Collection once, written against `do:` and
// `species`, and a derived collection's class is the receiver's `species` — not a hard-coded
// `self class` and not a new primitive. A subclass that wants a different answer overrides
// `species`, not the enumeration methods.
for (const lane of ['neutral', 'wasm']) {
  test(`a derived collection is the receiver's own class by default, through the ${lane} lane`, async () => {
    const {runtime, imageId, library, unique} = await shared(lane);
    const source = await collectionOf(runtime, imageId, unique(`sp-src-${lane}`), library, [1, 2]);

    // `species` is the receiver's class, and both derived collections are that class — read
    // back through `class`, which ADR 0046 made an ordinary message.
    for (const [id, expression] of [
      [`sp-species-${lane}`, '[ :x | x species ]'],
      [`sp-collect-${lane}`, '[ :x | (x collect: [ :e | e ]) class ]'],
      [`sp-select-${lane}`, '[ :x | (x select: [ :e | 1 = 1 ]) class ]'],
    ]) {
      assert.deepEqual(
        await evaluate(runtime, imageId, unique(id), expression, [source]),
        library.orderedCollection,
        `${expression} must answer OrderedCollection`,
      );
    }
  });

  test(`a subclass overriding species redirects its derived collections, through the ${lane} lane`, async () => {
    const {runtime, imageId, library, unique} = await shared(lane);
    const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
    // A subclass of OrderedCollection whose derived collections are OrderedCollections, by
    // overriding species — the Smalltalk pattern this slice exists to make expressible.
    const shapeRef = await ensureSmalltalkShape(runtime.images, imageId, {
      id: unique('species-test/sub-shape'),
      slots: [
        {id: 'ordered-collection-contents', name: 'contents'},
        {id: 'ordered-collection-tally', name: 'tally'},
      ],
    });
    const {classRef: subRef} = await defineClass({
      images: runtime.images, imageId, name: unique('SpeciesOverrideCollection'),
      superclassRef: library.orderedCollection, instanceShapeRef: shapeRef,
    });
    const {defineMethodsFromSource} = await import('../src/language/smalltalk-instance-variables.js');
    await defineMethodsFromSource({
      ...options,
      classRef: subRef,
      methods: [{selector: 'species', source: '[ OrderedCollection ]'}],
    });

    const source = await evaluate(runtime, imageId, unique(`sub-src-${lane}`),
      '[ :c | | x | x := c new. x add: 1. x add: 2. x ]', [subRef]);

    // The receiver is the subclass...
    assert.equal(
      (await evaluate(runtime, imageId, unique(`sub-class-${lane}`), '[ :x | x class ]', [source])).objectId,
      subRef.objectId,
    );
    // ...but both derived collections are its species, not its class.
    for (const [id, expression] of [
      [`sub-collect-${lane}`, '[ :x | (x collect: [ :e | e + 10 ]) class ]'],
      [`sub-select-${lane}`, '[ :x | (x select: [ :e | e > 1 ]) class ]'],
    ]) {
      assert.equal(
        (await evaluate(runtime, imageId, unique(id), expression, [source])).objectId,
        library.orderedCollection.objectId,
        `${expression} must be the species, OrderedCollection — not the receiver's class`,
      );
    }
    // And the derived collection holds what the enumeration put there, so this is a real
    // OrderedCollection, not a relabelled subclass.
    assert.deepEqual(
      await evaluate(runtime, imageId, unique(`sub-first-${lane}`), '[ :x | (x collect: [ :e | e + 10 ]) at: 1 ]', [source]),
      integerValue(11),
    );
  });

  test(`enumeration is inherited from Collection, not defined on OrderedCollection, through the ${lane} lane`, async () => {
    const {runtime, imageId, kernel, library} = await shared(lane);
    // collect: lives on Collection's dictionary; OrderedCollection's dictionary does not carry
    // it, so the send resolves by the superclass walk — which is what makes it shared protocol.
    const methodId = (classRef, selector) =>
      `${classRef.objectId}/method/${Buffer.from(selector, 'utf8').toString('base64url')}`;
    for (const selector of ['species', 'collect:', 'select:']) {
      assert.ok(
        await runtime.images.getCodeArtifact(imageId, `${methodId(library.collection, selector)}:semantic`),
        `${selector} must be defined on Collection`,
      );
      assert.equal(
        await runtime.images.getCodeArtifact(imageId, `${methodId(library.orderedCollection, selector)}:semantic`),
        null,
        `${selector} must not be re-defined on OrderedCollection`,
      );
    }
    // And the subclass relationship is the one declared: OrderedCollection's superclass is
    // Collection, whose own superclass is Object.
    const oc = await runtime.images.getObject(imageId, library.orderedCollection.objectId);
    assert.deepEqual(oc.slots['behavior-superclass'], library.collection);
    const collection = await runtime.images.getObject(imageId, library.collection.objectId);
    assert.deepEqual(collection.slots['behavior-superclass'], kernel.objectClass);
  });
}
