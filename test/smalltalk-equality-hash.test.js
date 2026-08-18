import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  bytesValue,
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
  installWasmBlockTree,
  integerValue,
  objectRef,
  pinnedRef,
  textValue,
} from '../src/runtime.js';
import {
  SMALLTALK_HASH_BITS,
  builtInEquals,
  builtInHash,
  equalityNormalForm,
} from '../src/language/smalltalk-equality.js';

// ADR 0048 decisions 2-4. The obligation this file exists to hold is one line:
//
//     a = b  =>  a hash = b hash
//
// Everything below either exercises that, or exercises a case where the two must deliberately come
// apart (NaN), or checks that a user override really replaces both halves rather than being bypassed.

async function withRuntime(body, options = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, ...options});
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

const TWO_POW_60 = 2n ** 60n;

// Each pair is [label, left, right, equal]. The hash obligation is checked for every equal pair
// automatically, which is the point: a new case cannot be added without also asserting the contract.
const BUILT_IN_CASES = [
  ['integer identical', integerValue(3), integerValue(3), true],
  ['integer different', integerValue(3), integerValue(4), false],
  ['huge integers', integerValue(TWO_POW_60), integerValue(TWO_POW_60), true],
  // Neither side is a JavaScript safe integer, so a safe-integer shortcut would get this wrong in
  // both directions.
  ['2^60 integer/float', integerValue(TWO_POW_60), float64Value(Number(TWO_POW_60)), true],
  ['2^60+1 integer/float', integerValue(TWO_POW_60 + 1n), float64Value(Number(TWO_POW_60)), false],
  ['integer/integral float', integerValue(1), float64Value(1), true],
  ['integer/fractional float', integerValue(1), float64Value(1.5), false],
  ['fractional floats', float64Value(1.5), float64Value(1.5), true],
  ['signed zero', float64Value(0), float64Value(-0), true],
  ['infinities', float64Value(Infinity), float64Value(Infinity), true],
  ['opposite infinities', float64Value(Infinity), float64Value(-Infinity), false],
  ['text identical', textValue('hi'), textValue('hi'), true],
  ['text different', textValue('hi'), textValue('ho'), false],
  ['bytes identical', bytesValue(new Uint8Array([1, 2, 3])), bytesValue(new Uint8Array([1, 2, 3])), true],
  ['bytes different', bytesValue(new Uint8Array([1, 2])), bytesValue(new Uint8Array([2, 1])), false],
  ['booleans', booleanValue(true), booleanValue(true), true],
  ['boolean/integer', booleanValue(true), integerValue(1), false],
  ['text/bytes', textValue('a'), bytesValue(new Uint8Array([97])), false],
  ['same ref', objectRef('app', 'x'), objectRef('app', 'x'), true],
  ['ref other object', objectRef('app', 'x'), objectRef('app', 'y'), false],
  ['ref other image', objectRef('app', 'x'), objectRef('other', 'x'), false],
  ['pinned vs ref', pinnedRef('app', 'x', 1), objectRef('app', 'x'), false],
];

test('the built-in relation answers correctly and never breaks the hash obligation', () => {
  for (const [label, left, right, equal] of BUILT_IN_CASES) {
    assert.equal(builtInEquals(left, right), equal, `${label}: equality`);
    assert.equal(builtInEquals(right, left), equal, `${label}: equality is symmetric`);
    if (!equal) continue;
    assert.deepEqual(builtInHash(left), builtInHash(right), `${label}: equal values must hash alike`);
  }
});

// NaN is the one place where equality and the hash deliberately disagree, and it disagrees in the
// safe direction: a stable hash for an value that is not equal to itself.
test('NaN is unequal to itself while still hashing stably', () => {
  const nan = float64Value(NaN);
  assert.equal(builtInEquals(nan, nan), false);
  assert.deepEqual(builtInHash(nan), builtInHash(float64Value(NaN)));
  assert.equal(builtInEquals(nan, integerValue(0)), false);
});

// Bucket placement in a durable table depends on this. A host-randomized or address-derived hash
// would relocate every key on restart.
test('the hash is stable across independent runtimes and is a non-negative 63-bit Integer', async () => {
  const sample = [textValue('selector'), integerValue(-7), objectRef('app', 'thing'), booleanValue(false)];
  const first = sample.map((value) => builtInHash(value));
  await withRuntime(async () => {});
  await withRuntime(async () => {});
  const second = sample.map((value) => builtInHash(value));
  assert.deepEqual(second, first, 'the same value must hash identically in a fresh runtime');

  for (const hash of first) {
    const numeric = BigInt(hash.value);
    assert.ok(numeric >= 0n, 'hash must be non-negative');
    assert.ok(numeric < (1n << SMALLTALK_HASH_BITS), `hash must fit in ${SMALLTALK_HASH_BITS} bits`);
  }
});

// The exact contract is observable, so it is pinned to *fixed vectors*. A self-comparison would stay
// green if the digest, the domain string, the byte order or the truncation changed — and each of
// those relocates every key in every stored table, which is a migration decision rather than an
// optimization.
const PUBLISHED_HASHES = [
  ["text 'x'", textValue('x'), '4826396080780372441'],
  ['integer 0', integerValue(0), '1243595255675647355'],
  // Same vector as integer 0, which is what proves signed zero shares one normal form rather than
  // merely comparing equal.
  ['float64 +0', float64Value(0), '1243595255675647355'],
  ['float64 -0', float64Value(-0), '1243595255675647355'],
  ['boolean true', booleanValue(true), '8066000890264313310'],
  ['ref app/x', objectRef('app', 'x'), '1957266370730748260'],
  ['+Infinity', float64Value(Infinity), '4746807931473417378'],
  ['integer 2^60', integerValue(TWO_POW_60), '2642122963298743788'],
  ['float64 2^60', float64Value(Number(TWO_POW_60)), '2642122963298743788'],
  ['bytes 0x01', bytesValue(new Uint8Array([1])), '5404651657761466440'],
];

test('the hash algorithm is pinned to its exact published values', () => {
  for (const [label, value, expected] of PUBLISHED_HASHES) {
    assert.equal(builtInHash(value).value, expected, `${label} must hash to its published vector`);
  }
  assert.deepEqual(equalityNormalForm(float64Value(-0)), ['number/integer', '0']);
  assert.deepEqual(equalityNormalForm(float64Value(Number(TWO_POW_60))), ['number/integer', TWO_POW_60.toString(10)]);
  assert.deepEqual(equalityNormalForm(integerValue(TWO_POW_60)), ['number/integer', TWO_POW_60.toString(10)]);
  assert.deepEqual(equalityNormalForm(objectRef('app', 'x')), ['ref', 'app', 'x']);
  assert.deepEqual(equalityNormalForm(float64Value(Infinity)), ['number/infinity', '+']);
});

test('a pinned ref has no hash contract at all', () => {
  assert.throws(
    () => builtInHash(pinnedRef('app', 'x', 3)),
    (error) => error.name === 'SmalltalkUnhashableValueError',
  );
});

// The ref rule is identity, so a mutated object is still equal to itself and still hashes the same.
test('ref equality and hash ignore version, shape and contents', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const shape = objectRef('app', (await runtime.images.putShape('app', {
      id: 'point-shape', slots: [{id: 'point-x', name: 'x'}],
    })).id);
    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point', instanceShapeRef: shape});
    const instance = await evaluate(runtime, 'app', 'alloc', '[ :c | c basicNew ]', [point.classRef]);

    const before = await evaluate(runtime, 'app', 'hash-before', '[ :o | o hash ]', [instance]);
    const record = await runtime.images.getObject('app', instance.objectId);
    await runtime.images.putObject('app', {
      id: record.id,
      shape: record.shape,
      behavior: record.behavior,
      slots: {'point-x': integerValue(99)},
      metadata: record.metadata,
    }, {expectedVersion: record._version});

    assert.deepEqual(await evaluate(runtime, 'app', 'hash-after', '[ :o | o hash ]', [instance]), before);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'self-equal', '[ :o | o = o ]', [instance]),
      booleanValue(true),
    );
    assert.equal(kernel.nil.imageId, 'app');
  });
});

for (const lane of ['neutral', 'wasm']) {
  test(`= and hash are ordinary sends through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      assert.deepEqual(
        await evaluate(runtime, 'app', `eq-${lane}`, '[ :a :b | a = b ]', [integerValue(2), integerValue(2)]),
        booleanValue(true),
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `neq-${lane}`, '[ :a :b | a = b ]', [textValue('a'), textValue('b')]),
        booleanValue(false),
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `hash-${lane}`, '[ :a | a hash ]', [textValue('k')]),
        builtInHash(textValue('k')),
      );
    });
  });
}

// ADR 0045 makes the singleton the effective receiver of a boolean send, so without the bridge
// normalization one operand would be a ref and the other a boolean Value, and `true = true` would
// answer false.
test('the true/false bridge does not make a boolean unequal to itself', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'bool-eq', '[ :a :b | a = b ]', [booleanValue(true), booleanValue(true)]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'bool-neq', '[ :a :b | a = b ]', [booleanValue(true), booleanValue(false)]),
      booleanValue(false),
    );
    // Mixed arrival: the singleton ref on one side, the canonical boolean on the other.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'bool-mixed', '[ :a :b | a = b ]', [booleanValue(true), kernel.true]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'bool-hash', '[ :a | a hash ]', [booleanValue(true)]),
      await evaluate(runtime, 'app', 'singleton-hash', '[ :a | a hash ]', [kernel.true]),
    );
  });
});

// An Array is an object, so it inherits Object equality. Exposing its elements must not turn the
// structural `equals` IR op into deep object equality by the back door.
test('two Arrays with equal elements are not equal', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {installSmalltalkIndexedProtocol} = await import('../src/runtime.js');
    await installSmalltalkIndexedProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
    });
    const arrayClass = objectRef('app', 'smalltalk/class/Array');
    const first = await evaluate(runtime, 'app', 'arr1', '[ :c | c new: 2 ]', [arrayClass]);
    const second = await evaluate(runtime, 'app', 'arr2', '[ :c | c new: 2 ]', [arrayClass]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'arr-eq', '[ :a :b | a = b ]', [first, second]),
      booleanValue(false),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'arr-self', '[ :a | a = a ]', [first]),
      booleanValue(true),
    );
  });
});

// Decision 4: overriding is ordinary Smalltalk, and it is the program's job to keep the two halves
// consistent. What the runtime owes is that the override is actually used.
test('a class may override = and hash, and Dictionary uses the override', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await installSmalltalkDictionaryProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
    });
    const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'tag-shape', slots: []})).id);
    const tag = await defineClass({images: runtime.images, imageId: 'app', name: 'Tag', instanceShapeRef: shape});
    // Every Tag is equal to every other Tag, and they all hash alike — a deliberately coarse but
    // *consistent* key.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: tag.classRef,
      methods: [
        {selector: '=', program: {parameters: [{id: 'eq:0', name: 'other'}], captures: [], body: {op: 'literal', value: booleanValue(true)}}},
        {selector: 'hash', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(1234)}}},
      ],
    });

    const one = await evaluate(runtime, 'app', 'tag1', '[ :c | c basicNew ]', [tag.classRef]);
    const two = await evaluate(runtime, 'app', 'tag2', '[ :c | c basicNew ]', [tag.classRef]);
    assert.notEqual(one.objectId, two.objectId, 'two distinct objects');

    const dictionary = await evaluate(runtime, 'app', 'dict', '[ :c | c new ]',
      [objectRef('app', 'smalltalk/class/Dictionary')]);
    await evaluate(runtime, 'app', 'put-one', '[ :d :k | d at: k put: 1 ]', [dictionary, one]);
    // The override says these are the same key, so the second store replaces rather than adds.
    await evaluate(runtime, 'app', 'put-two', '[ :d :k | d at: k put: 2 ]', [dictionary, two]);

    assert.deepEqual(await evaluate(runtime, 'app', 'size', '[ :d | d size ]', [dictionary]), integerValue(1));
    assert.deepEqual(
      await evaluate(runtime, 'app', 'read', '[ :d :k | d at: k ]', [dictionary, one]),
      integerValue(2),
      'Dictionary must send the override, not fall back to the built-in helper',
    );
  });
});

// A broken override must fail the operation rather than corrupt a table.
test('a hash or = answering the wrong kind fails before anything is published', async () => {
  for (const [label, methods, expected] of [
    ['bad hash', [{selector: 'hash', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('nope')}}}], /hash must answer an Integer/],
    ['bad =', [
      {selector: 'hash', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(7)}}},
      {selector: '=', program: {parameters: [{id: 'eq:0', name: 'other'}], captures: [], body: {op: 'literal', value: textValue('nope')}}},
    ], /= must answer a Boolean/],
  ]) {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app');
      await installSmalltalkDictionaryProtocol({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      });
      const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'bad-shape', slots: []})).id);
      const bad = await defineClass({images: runtime.images, imageId: 'app', name: 'Bad', instanceShapeRef: shape});
      await defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: bad.classRef, methods,
      });

      const dictionary = await evaluate(runtime, 'app', 'dict', '[ :c | c new ]',
        [objectRef('app', 'smalltalk/class/Dictionary')]);
      const before = await runtime.images.getObject('app', dictionary.objectId);
      const key = await evaluate(runtime, 'app', 'bad-key', '[ :c | c basicNew ]', [bad.classRef]);
      // The `bad =` case needs an occupant with a matching stored hash before `=` is consulted.
      if (label === 'bad =') {
        await evaluate(runtime, 'app', 'seed-key', '[ :d :k | d at: k put: 1 ]', [dictionary, key]);
      }

      const other = await evaluate(runtime, 'app', 'bad-key-2', '[ :c | c basicNew ]', [bad.classRef]);
      await assert.rejects(
        evaluate(runtime, 'app', 'store', '[ :d :k | d at: k put: 2 ]', [dictionary, label === 'bad =' ? other : key]),
        expected,
      );
      const after = await runtime.images.getObject('app', dictionary.objectId);
      if (label === 'bad hash') {
        assert.deepEqual(after.slots, before.slots, 'a rejected hash must publish no table');
      }
    });
  }
});
