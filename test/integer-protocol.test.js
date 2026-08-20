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
  installSmalltalkIntegerProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  float64Value,
} from '../src/runtime.js';

// ADR 0053. The load-bearing part is not that `3 < 5` — it is that ordering is protocol rather than
// an instruction, and that division means floor rather than whatever the host does.

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
  await installSmalltalkControlFlow(options);
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  await installSmalltalkIntegerProtocol(options);
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  // `+` is not kernel protocol — it is installed on top, through the `integer-add` IR op. ADR 0053
  // deliberately leaves it alone, so it is installed here the way every other suite does in order to
  // assert that it still works unchanged.
  await defineMethods({
    ...options,
    classRef: kernel.integerClass,
    methods: [{
      selector: '+',
      program: {
        parameters: [{id: 'plus:arg', name: 'n'}],
        captures: [],
        body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}},
      },
    }],
  });
  return kernel;
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// --- ordering ------------------------------------------------------------------------------------

test('the four comparisons agree, including at the boundary', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const cases = [
      ['3 < 5', true], ['5 < 3', false], ['4 < 4', false],
      ['5 > 3', true], ['3 > 5', false], ['4 > 4', false],
      ['3 <= 5', true], ['5 <= 3', false], ['4 <= 4', true],
      ['5 >= 3', true], ['3 >= 5', false], ['4 >= 4', true],
      // Negatives on both sides, and across zero. Parenthesised because binary sends are strictly
      // left to right with no precedence, so `0 - 5 < 0 - 3` would parse as `((0 - 5) < 0) - 3`.
      ['(0 - 5) < (0 - 3)', true], ['(0 - 3) < (0 - 5)', false],
      ['(0 - 1) < 1', true], ['1 < (0 - 1)', false],
      ['(0 - 4) <= (0 - 4)', true], ['(0 - 4) >= (0 - 4)', true],
    ];
    for (const [expression, expected] of cases) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `cmp-${expression}`, `[ ${expression} ]`),
        booleanValue(expected),
        expression,
      );
    }
  });
});

// Trichotomy: exactly one of a < b, a = b, b < a. A `>=` that parts company with `<` at one
// boundary is the bug one primitive plus three derived methods exists to prevent.
test('exactly one of less, equal and greater holds for every pair', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const values = ['0 - 7', '0 - 1', '0', '1', '7'];
    for (const left of values) {
      for (const right of values) {
        const answers = await Promise.all([
          evaluate(runtime, 'app', `t1-${left}-${right}`, `[ (${left}) < (${right}) ]`),
          evaluate(runtime, 'app', `t2-${left}-${right}`, `[ (${left}) = (${right}) ]`),
          evaluate(runtime, 'app', `t3-${left}-${right}`, `[ (${right}) < (${left}) ]`),
        ]);
        assert.equal(
          answers.filter((answer) => answer.value === true).length, 1,
          `exactly one of <, =, > must hold for ${left} and ${right}`,
        );
        // And the derived forms agree with the primitive rather than being independently wrong.
        assert.deepEqual(
          await evaluate(runtime, 'app', `t4-${left}-${right}`, `[ (${left}) <= (${right}) ]`),
          booleanValue(answers[0].value || answers[1].value),
        );
        assert.deepEqual(
          await evaluate(runtime, 'app', `t5-${left}-${right}`, `[ (${left}) >= (${right}) ]`),
          booleanValue(answers[2].value || answers[1].value),
        );
      }
    }
  });
});

test('comparison is exact beyond the safe-integer range', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // Two values differing only in their last digit, far past 2^53. A host-number round trip would
    // make these compare equal.
    const low = '9007199254740993000000000000001';
    const high = '9007199254740993000000000000002';
    assert.deepEqual(await evaluate(runtime, 'app', 'big-lt', `[ ${low} < ${high} ]`), booleanValue(true));
    assert.deepEqual(await evaluate(runtime, 'app', 'big-gt', `[ ${low} > ${high} ]`), booleanValue(false));
    assert.deepEqual(await evaluate(runtime, 'app', 'big-eq', `[ ${low} = ${low} ]`), booleanValue(true));
  });
});

// --- arithmetic ----------------------------------------------------------------------------------

test('subtraction and multiplication are exact and arbitrary precision', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(await evaluate(runtime, 'app', 'sub', '[ 10 - 3 ]'), integerValue(7));
    assert.deepEqual(await evaluate(runtime, 'app', 'sub-neg', '[ 3 - 10 ]'), integerValue(-7));
    assert.deepEqual(await evaluate(runtime, 'app', 'mul', '[ 6 * 7 ]'), integerValue(42));
    assert.deepEqual(await evaluate(runtime, 'app', 'mul-neg', '[ 6 * (0 - 7) ]'), integerValue(-42));
    // Past 2^53: exact, not rounded.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'mul-big', '[ 9007199254740993 * 9007199254740993 ]'),
      integerValue(9007199254740993n * 9007199254740993n),
    );
  });
});

// The distinction ADR 0053 decision 4 exists for. Host BigInt division truncates toward zero, so
// every one of these four quadrants is a place a raw `/` would answer differently.
test('floor division and modulo are correct in all four sign quadrants', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const quadrants = [
      {a: 7n, b: 2n, quotient: 3n, remainder: 1n},
      {a: -7n, b: 2n, quotient: -4n, remainder: 1n},
      {a: 7n, b: -2n, quotient: -4n, remainder: -1n},
      {a: -7n, b: -2n, quotient: 3n, remainder: -1n},
    ];
    const literal = (value) => (value < 0n ? `(0 - ${-value})` : `${value}`);

    for (const {a, b, quotient, remainder} of quadrants) {
      const q = await evaluate(runtime, 'app', `fd-${a}-${b}`, `[ ${literal(a)} // ${literal(b)} ]`);
      const r = await evaluate(runtime, 'app', `md-${a}-${b}`, `[ ${literal(a)} \\\\ ${literal(b)} ]`);
      assert.deepEqual(q, integerValue(quotient), `${a} // ${b}`);
      assert.deepEqual(r, integerValue(remainder), `${a} \\\\ ${b}`);

      // The invariant that actually distinguishes floor from truncation: the remainder's range.
      // The reconstruction identity below holds for truncation too, so it is checked as a
      // consistency condition rather than as the specification.
      const rv = BigInt(r.value);
      if (b > 0n) assert.ok(0n <= rv && rv < b, `for a positive divisor 0 <= r < b, got ${rv}`);
      else assert.ok(b < rv && rv <= 0n, `for a negative divisor b < r <= 0, got ${rv}`);
      assert.equal(BigInt(q.value) * b + rv, a, 'reconstruction identity');
    }
  });
});

test('division and modulo by zero fail explicitly and name the operation', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'div0', '[ 7 // 0 ]'),
      /integer-floor-divide primitive cannot divide by zero/,
    );
    await assert.rejects(
      evaluate(runtime, 'app', 'mod0', '[ 7 \\\\ 0 ]'),
      /integer-modulo primitive cannot divide by zero/,
    );
  });
});

// --- refusals and scope --------------------------------------------------------------------------

test('a non-Integer operand is refused by name', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'mixed', '[ :f | 1 < f ]', [float64Value(1.5)]),
      /integer-less-than primitive requires two Integers; the argument is a float64 Value/,
    );
    await assert.rejects(
      evaluate(runtime, 'app', 'mixed-text', "[ 1 - 'two' ]"),
      /integer-subtract primitive requires two Integers; the argument is a text Value/,
    );
  });
});

test('a Float receiver answers message-not-understood rather than a coerced comparison', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'float-recv', '[ :f | f < 2 ]', [float64Value(1.5)]),
      /message not understood: </,
    );
  });
});

// ADR 0048's contract is untouched: mixed *equality* was already decided, and only mixed ordering
// and arithmetic are deferred.
test('mixed Integer and Float equality still holds', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'mixed-eq', '[ :f | 1 = f ]', [float64Value(1.0)]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'mixed-ne', '[ :f | 1 = f ]', [float64Value(1.5)]),
      booleanValue(false),
    );
  });
});

// --- what must not have changed -------------------------------------------------------------------

test('the compiler learns no comparison or arithmetic selector', async () => {
  const {readFileSync} = await import('node:fs');
  for (const path of [
    'src/language/symmetric-smalltalk-compiler.js',
    'src/language/symmetric-smalltalk-semantic.js',
    'src/language/symmetric-smalltalk-parser.js',
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.ok(!/integer-less-than|integer-floor-divide|integer-modulo/.test(source), path);
  }
  // And no comparison op reached the neutral IR.
  const ir = readFileSync(new URL('../src/execution/neutral-expression-v0.js', import.meta.url), 'utf8');
  assert.ok(!/'integer-less-than'|'less-than'|'integer-subtract'/.test(ir),
    'lagrange-code/v0 must gain no comparison or arithmetic op');
});

test('each method is an ordinary method capturing the primitive Block', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const {methodBlockRef} = await import('../src/language/smalltalk-class-builder.js');
    for (const selector of ['<', '>', '<=', '>=', '-', '*', '//', '\\\\']) {
      const ref = await methodBlockRef({images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector});
      assert.ok(ref, `Integer >> ${selector} must be an installed method`);
      const block = await runtime.images.getBlock(ref.imageId, ref.objectId);
      const code = await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId);
      // An ordinary semantic program, not a primitive artifact: the method sends to a captured
      // primitive Block rather than being one.
      assert.notEqual(code.representation, 'smalltalk-kernel-primitive/v1',
        `Integer >> ${selector} must not itself be a primitive`);
      assert.ok(block.environment, `Integer >> ${selector} must capture the primitive Block`);
    }
    // `+` is deliberately untouched and still runs through the IR op.
    assert.deepEqual(await evaluate(runtime, 'app', 'plus-unchanged', '[ 2 + 3 ]'), integerValue(5));
  });
});

test('installing the Integer protocol twice changes nothing', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const before = (await runtime.images.listRecords('app')).length;
    await installSmalltalkIntegerProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'neutral',
    });
    assert.equal((await runtime.images.listRecords('app')).length, before);
  });
});

test('both lanes agree on ordering and arithmetic', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'neutral-image');
    await seed(runtime, 'wasm-image', {lane: 'wasm'});
    for (const expression of ['5 - 8', '3 * 4', '0 - 7 // 2', '0 - 7 \\\\ 2']) {
      const neutral = await evaluate(runtime, 'neutral-image', `n-${expression}`, `[ ${expression} ]`);
      const wasm = await evaluate(runtime, 'wasm-image', `w-${expression}`, `[ ${expression} ]`);
      assert.deepEqual(wasm, neutral, expression);
    }
    for (const expression of ['3 < 5', '4 <= 4', '5 >= 9']) {
      const neutral = await evaluate(runtime, 'neutral-image', `nb-${expression}`, `[ ${expression} ]`);
      const wasm = await evaluate(runtime, 'wasm-image', `wb-${expression}`, `[ ${expression} ]`);
      assert.deepEqual(wasm, neutral, expression);
    }
  });
});

// --- publication recovery --------------------------------------------------------------------------

// `defineMethods` recovery is proven elsewhere, but not for *this* composed installer: five
// primitive CodeArtifact/Block pairs published before eight methods that capture them. The
// interesting failures are in the composition — a method whose captured Block was never written, or
// a retry that meets a half-finished protocol.
const WRITE_METHODS = ['putCodeArtifact', 'putBlock', 'putShape', 'putObject', 'putLexicalEnvironment'];

function faultingImages(images, {failAt = null, commitThenThrow = false} = {}) {
  let writes = 0;
  const wrapped = Object.create(Object.getPrototypeOf(images));
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(images))) {
    if (typeof images[key] !== 'function' || key === 'constructor') continue;
    wrapped[key] = (...args) => images[key](...args);
  }
  for (const [key, value] of Object.entries(images)) {
    wrapped[key] = typeof value === 'function' ? (...args) => images[key](...args) : value;
  }
  for (const method of WRITE_METHODS) {
    wrapped[method] = async (imageId, input, options) => {
      writes += 1;
      const hit = writes === failAt;
      if (hit && !commitThenThrow) throw new Error(`injected failure at write ${writes} (${input?.id})`);
      const result = await images[method](imageId, input, options);
      if (hit && commitThenThrow) throw new Error(`injected post-commit failure at write ${writes} (${input?.id})`);
      return result;
    };
  }
  return {images: wrapped, writeCount: () => writes};
}

async function baseImage(runtime, imageId) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane: 'neutral'};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkControlFlow(options);
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  return options;
}

test('every write publishing the Integer protocol is recoverable', async () => {
  const total = await withRuntime(async (runtime) => {
    const options = await baseImage(runtime, 'count');
    const {images, writeCount} = faultingImages(runtime.images);
    await installSmalltalkIntegerProtocol({...options, images});
    return writeCount();
  });
  assert.ok(total > 10, `expected many writes across five primitives and eight methods, saw ${total}`);

  for (let failAt = 1; failAt <= total; failAt += 1) {
    for (const commitThenThrow of [false, true]) {
      await withRuntime(async (runtime) => {
        const options = await baseImage(runtime, 'app');
        const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});

        await assert.rejects(
          installSmalltalkIntegerProtocol({...options, images}),
          /injected/,
          `write ${failAt} (${commitThenThrow ? 'lost ack' : 'pre-commit'}) should have failed`,
        );

        // The retry converges rather than conflicting, and the protocol works afterwards.
        await installSmalltalkIntegerProtocol(options);
        assert.deepEqual(
          await evaluate(runtime, 'app', `recovered-${failAt}-${commitThenThrow}`, '[ 3 <= 4 ]'),
          booleanValue(true),
        );
        assert.deepEqual(
          await evaluate(runtime, 'app', `recovered-div-${failAt}-${commitThenThrow}`, '[ (0 - 7) // 2 ]'),
          integerValue(-4),
        );
      });
    }
  }
});

// The partial-install hazard the library's prerequisite check exists for: primitives are published
// before methods, so a Block-existence check would pass while `<` is still missing.
test('a half-installed Integer protocol is not mistaken for a complete one', async () => {
  await withRuntime(async (runtime) => {
    const options = await baseImage(runtime, 'app');
    // The library checks for its Array class before it checks Integer, so that prerequisite has to
    // be satisfied for this test to reach the check it is actually about.
    const {installSmalltalkIndexedProtocol} = await import('../src/runtime.js');
    await installSmalltalkIndexedProtocol(options);
    // Fail at the first *method* write, leaving all five primitive Blocks published.
    let seenPrimitiveBlocks = 0;
    const faulting = Object.create(runtime.images);
    faulting.putBlock = async (imageId, input) => {
      const stored = await runtime.images.putBlock(imageId, input);
      if (input.id?.startsWith('smalltalk/primitive/integer-')) seenPrimitiveBlocks += 1;
      if (seenPrimitiveBlocks === 5 && !input.id?.startsWith('smalltalk/primitive/')) {
        throw new Error('injected failure before the methods');
      }
      return stored;
    };
    faulting.putCodeArtifact = async (imageId, input) => {
      if (seenPrimitiveBlocks === 5 && !input.id?.startsWith('smalltalk/primitive/')) {
        throw new Error('injected failure before the methods');
      }
      return await runtime.images.putCodeArtifact(imageId, input);
    };

    await assert.rejects(installSmalltalkIntegerProtocol({...options, images: faulting}), /injected/);

    // The primitive Block exists...
    assert.ok(await runtime.images.getBlock('app', 'smalltalk/primitive/integer-less-than'));
    // ...but the method does not, which is precisely what the library must not be fooled by.
    const {methodBlockRef} = await import('../src/language/smalltalk-class-builder.js');
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    assert.equal(
      await methodBlockRef({images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '<'}),
      null,
      'the fixture must leave < absent for this test to mean anything',
    );

    const {installSmalltalkLibrary} = await import('../src/runtime.js');
    await assert.rejects(
      installSmalltalkLibrary(options),
      /has no Integer < method/,
      'the library must check for the method, not for the primitive Block',
    );
  });
});
