import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  createRuntime,
  defineClass,
  defineMethods,
  findSmalltalkKernel,
  float64Value,
  installSmalltalkAllocationProtocol,
  installSmalltalkDictionaryProtocol,
  installSmalltalkEqualityProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

// Workstream 3 (MessagePack pressure). `Object>>==` is *identity*, and it must not be an alias for
// `=` — `=` is overridable (Association overrides it for value equality), so `^self = other` would
// be wrong. `==` reuses the SAME built-in primitive as `=`: ADR 0048 decision 2's relation is
// already exactly what identity means here (an ObjectRef has genuine (imageId, objectId) identity;
// an immediate Value carries no object identity apart from its value, so its identity collapses to
// value by construction). The upstream type-mapper dispatch (`self class == Dictionary`) compares
// class refs, which is genuine ref identity.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// Peter's discriminating proof: two Associations that are `=` (value equality, via the Association
// override) but not `==` (distinct refs), and an object that is `==` to itself. This is the one test
// that separates identity from equality — if `==` were `^self = other`, the middle assertion fails.
test('equal-but-distinct Associations are = but not ==, and an object is == to itself', async () => {
  await withRuntime(async (runtime) => {
    // Association is a library class, so this case uses the composed standard image; the rest of
    // the file proves `==` against a minimal seed.
    await runtime.images.createImage({id: 'app'});
    await installSymmetricSmalltalkStandardImage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
    });
    const associationClass = objectRef('app', 'smalltalk/class/Association');
    const a = await evaluate(runtime, 'app', 'a', "[ :c | c new key: 'k' value: 1 ]", [associationClass]);
    const b = await evaluate(runtime, 'app', 'b', "[ :c | c new key: 'k' value: 1 ]", [associationClass]);
    assert.notEqual(a.objectId, b.objectId, 'the two Associations must be distinct objects');

    assert.deepEqual(
      await evaluate(runtime, 'app', 'eq', '[ :x :y | x = y ]', [a, b]),
      booleanValue(true),
      'Association overrides = for value equality',
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'ident', '[ :x :y | x == y ]', [a, b]),
      booleanValue(false),
      'distinct refs are not identical, even when = ',
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'self-ident', '[ :x | x == x ]', [a]),
      booleanValue(true),
      'an object is identical to itself',
    );
  });
});

// The override-bypass proof: a class that answers `= true` for everything must still see `==` as
// identity. If `==` routed through `=`, these two distinct instances would be `==`.
test('== bypasses an = override and compares identity directly', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'tag-shape', slots: []})).id);
    const tag = await defineClass({images: runtime.images, imageId: 'app', name: 'Tag', instanceShapeRef: shape});
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: tag.classRef,
      methods: [
        {selector: '=', program: {parameters: [{id: 'eq:0', name: 'other'}], captures: [], body: {op: 'literal', value: booleanValue(true)}}},
      ],
    });
    const one = await evaluate(runtime, 'app', 't1', '[ :c | c basicNew ]', [tag.classRef]);
    const two = await evaluate(runtime, 'app', 't2', '[ :c | c basicNew ]', [tag.classRef]);
    assert.notEqual(one.objectId, two.objectId, 'two distinct objects');

    assert.deepEqual(await evaluate(runtime, 'app', 'oeq', '[ :x :y | x = y ]', [one, two]), booleanValue(true));
    assert.deepEqual(
      await evaluate(runtime, 'app', 'oident', '[ :x :y | x == y ]', [one, two]),
      booleanValue(false),
      '== must compare identity, not the overridden = ',
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'oself', '[ :x | x == x ]', [one]), booleanValue(true));
  });
});

// The actual upstream selector: the type-mapper dispatch compares a class ref to a class global.
// Both are refs, so `==` is genuine ref identity here.
test('self class == SomeClass compares class identity, as the MessagePack dispatch does', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await installSmalltalkDictionaryProtocol({images: runtime.images, compilation: runtime.compilation, imageId: 'app'});
    const dictionaryClass = objectRef('app', 'smalltalk/class/Dictionary');
    const instance = await evaluate(runtime, 'app', 'd', '[ :c | c new ]', [dictionaryClass]);
    // (d class) is the Dictionary class ref; compare it to the Dictionary and Array class refs.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'cls-eq', '[ :o :k | o class == k ]', [instance, dictionaryClass]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'cls-ne', '[ :o :k | o class == k ]', [instance, objectRef('app', 'smalltalk/class/Array')]),
      booleanValue(false),
    );
  });
});

// Immediates have no object identity apart from their value, so `==` collapses to value. `1000 ==
// 1000` is true because that is the only identity 1000 has — this is not a compromise but the only
// sound reading, and it is what the upstream symbol/integer/boolean `==` uses rely on.
test('== on immediates is value identity', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const cases = [
      ['integer same', integerValue(1000), integerValue(1000), true],
      ['integer different', integerValue(1), integerValue(2), false],
      ['text same', textValue('strict'), textValue('strict'), true],  // the mode == #strict shape
      ['text different', textValue('a'), textValue('b'), false],
      ['boolean true', booleanValue(true), booleanValue(true), true],
      ['boolean mixed', booleanValue(true), booleanValue(false), false],
      ['cross kind', integerValue(1), textValue('1'), false],
    ];
    for (const [label, left, right, expected] of cases) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `imm-${label}`, '[ :x :y | x == y ]', [left, right]),
        booleanValue(expected),
        label,
      );
    }
  });
});

// The falsifier for a hand-rolled identity primitive: `aBoolean == true` crosses the ADR 0045
// bridge, so one side may be the true-singleton ref while the other is the boolean Value. Reusing
// the built-in primitive inherits its boolean-singleton normalization; dropping it would make this
// answer false. This is the case a naive new `IDENTICAL` primitive would get wrong.
test('== normalizes the boolean singleton across the ADR 0045 bridge', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    // true == true and true == false through ordinary source.
    assert.deepEqual(await evaluate(runtime, 'app', 'tt', '[ true == true ]'), booleanValue(true));
    assert.deepEqual(await evaluate(runtime, 'app', 'tf', '[ true == false ]'), booleanValue(false));
    // Mixed arrival: the receiver arrives as a boolean Value, the argument as the kernel.true ref.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'bridge', '[ :a :b | a == b ]', [booleanValue(true), kernel.true]),
      booleanValue(true),
      'a boolean Value and the true singleton ref must be identical',
    );
  });
});

// `=` and `hash` are proven through both execution lanes (smalltalk-equality-hash.test.js); `==`
// gets the same treatment so the equality protocol's selectors do not drift between lanes.
for (const lane of ['neutral', 'wasm']) {
  test(`== is an ordinary send through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      // The class-identity case needs the Dictionary class to exist; install its protocol.
      await installSmalltalkDictionaryProtocol({images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane});
      const dictionaryClass = objectRef('app', 'smalltalk/class/Dictionary');
      const instance = await evaluate(runtime, 'app', `d-${lane}`, '[ :c | c new ]', [dictionaryClass]);
      // Immediate value identity and ref identity, through this lane's dispatch.
      assert.deepEqual(
        await evaluate(runtime, 'app', `imm-${lane}`, '[ :a :b | a == b ]', [integerValue(7), integerValue(7)]),
        booleanValue(true),
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `ref-${lane}`, '[ :o :k | o class == k ]', [instance, dictionaryClass]),
        booleanValue(true),
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `refne-${lane}`, '[ :o :k | o class == k ]', [instance, objectRef('app', 'smalltalk/class/Array')]),
        booleanValue(false),
      );
    });
  });
}

// NaN carries no stable value-identity, and an immediate's identity is its value, so NaN is
// identical to nothing — including itself (ADR 0048: NaN is unequal to everything). Pinned here so
// the answer is a decision, not an accident.
test('nan == nan is false', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const nan = float64Value(NaN);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'nan', '[ :x :y | x == y ]', [nan, nan]),
      booleanValue(false),
    );
  });
});
