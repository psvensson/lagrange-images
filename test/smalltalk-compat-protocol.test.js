import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  booleanValue,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

// Workstream 3 (MessagePack pressure). The source-only compatibility seam: ordinary Smalltalk
// methods, no new primitive, no compiler knowledge. Each is proven here by *behaviour*, not by the
// presence of a method — the red that motivated each was an upstream MessagePack send that current
// main could not resolve.
//
// These run against the composed standard image so the install ordering (allocation → integer →
// dictionary → exception accessors) is exercised exactly as a real image assembles it.

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
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    lane,
  });
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// --- Object >> yourself / isNil -----------------------------------------------------------------

test('Object>>yourself answers the receiver, and isNil separates nil from everything else', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // `yourself` is identity: the same object comes back, so a cascade can keep its target.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'ys-nil', '[ nil yourself isNil ]'),
      booleanValue(true),
    );
    // Both halves of isNil must be installed: nil is the UndefinedObject singleton (^true), and
    // every other receiver inherits Object>>isNil (^false). One without the other is the bug.
    assert.deepEqual(await evaluate(runtime, 'app', 'nil-isnil', '[ nil isNil ]'), booleanValue(true));
    assert.deepEqual(await evaluate(runtime, 'app', 'int-isnil', '[ 5 isNil ]'), booleanValue(false));
    assert.deepEqual(await evaluate(runtime, 'app', 'text-isnil', "[ 'x' isNil ]"), booleanValue(false));
    assert.deepEqual(
      await evaluate(runtime, 'app', 'obj-isnil', '[ Dictionary new isNil ]'),
      booleanValue(false),
    );
  });
});

// --- Integer convenience / control --------------------------------------------------------------

test('Integer>>between:and: is inclusive on both bounds', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const cases = [
      ['5 between: 0 and: 10', true],
      ['0 between: 0 and: 10', true],
      ['10 between: 0 and: 10', true],
      ['11 between: 0 and: 10', false],
      ['(0 - 1) between: 0 and: 10', false],
    ];
    for (const [expression, expected] of cases) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `between-${expression}`, `[ ${expression} ]`),
        booleanValue(expected),
        expression,
      );
    }
  });
});

test('Integer>>negated flips sign across zero', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(await evaluate(runtime, 'app', 'neg-pos', '[ 5 negated ]'), integerValue(-5));
    assert.deepEqual(await evaluate(runtime, 'app', 'neg-neg', '[ (0 - 5) negated ]'), integerValue(5));
    assert.deepEqual(await evaluate(runtime, 'app', 'neg-zero', '[ 0 negated ]'), integerValue(0));
  });
});

test('Integer>>to:do: iterates inclusively and timesRepeat: repeats', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // 1 to: 5 sums 1+2+3+4+5 = 15, accumulated into an OrderedCollection then reduced.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'todo', `[ | sum |
        sum := 0.
        1 to: 5 do: [ :i | sum := sum + i ].
        sum ]`),
      integerValue(15),
    );
    // An empty range runs the body zero times.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'todo-empty', `[ | sum |
        sum := 0.
        5 to: 1 do: [ :i | sum := sum + i ].
        sum ]`),
      integerValue(0),
    );
    // timesRepeat: runs the block exactly n times.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'timesrepeat', `[ | count |
        count := 0.
        4 timesRepeat: [ count := count + 1 ].
        count ]`),
      integerValue(4),
    );
  });
});

// --- Dictionary lookup conveniences + class-side new: -------------------------------------------

test('Dictionary>>at:ifAbsent: and at:ifAbsentPut: honour present and missing keys', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // Present key answers the stored value; the absent block does not run.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'present', `[ | d |
        d := Dictionary new.
        d at: 'k' put: 7.
        d at: 'k' ifAbsent: [ 99 ] ]`),
      integerValue(7),
    );
    // Missing key runs the absent block.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'absent', `[ | d |
        d := Dictionary new.
        d at: 'missing' ifAbsent: [ 99 ] ]`),
      integerValue(99),
    );
    // at:ifAbsentPut: stores on miss and answers the stored value...
    assert.deepEqual(
      await evaluate(runtime, 'app', 'put-miss', `[ | d |
        d := Dictionary new.
        d at: 'k' ifAbsentPut: [ 42 ].
        d at: 'k' ]`),
      integerValue(42),
    );
    // ...and on a hit neither stores nor runs the block, so a single store is observable via size.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'put-hit', `[ | d |
        d := Dictionary new.
        d at: 'k' put: 1.
        d at: 'k' ifAbsentPut: [ 999 ].
        (d at: 'k') + d size ]`),
      integerValue(2), // value still 1, size still 1 -> 1 + 1
    );
  });
});

test('Dictionary class>>new: accepts a capacity hint and answers an empty usable Dictionary', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // The hint is ignored (grow-on-demand), but the result must be a real, empty, writable
    // Dictionary — this is the metaclass dispatch path upstream `createDictionary:` relies on.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'new-hint', `[ | d |
        d := Dictionary new: 3.
        d at: 'a' put: 1.
        d at: 'b' put: 2.
        d size ]`),
      integerValue(2),
    );
  });
});

// --- Exception >> messageText -------------------------------------------------------------------

test('Exception>>messageText reads the text a host-generated condition actually carried', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // `1 // 0` signals a host ZeroDivide whose messageText slot is populated with the host message.
    // Catching it and reading messageText proves the accessor reaches the real slot, not a literal.
    const answer = await evaluate(runtime, 'app', 'messagetext', `[ | text |
      text := 'none'.
      [ 1 // 0 ] on: ZeroDivide do: [ :ex | text := ex messageText ].
      text ]`);
    assert.equal(answer.kind, 'text');
    assert.notEqual(answer.value, 'none', 'the handler must have run and replaced the sentinel');
    assert.notEqual(answer.value, '', 'a host-generated condition carries non-empty text');
  });
});
