import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineClass,
  defineMethods,
  ensureSmalltalkShape,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkConditionProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkIndexedProtocol,
  installSmalltalkGlobalNamespace,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkIntegerProtocol,
  installSmalltalkKernel,
  installSmalltalkLibrary,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  publishSmalltalkClassGlobals,
  textValue,
} from '../src/runtime.js';
import {defineMethodsFromSource} from '../src/language/smalltalk-instance-variables.js';
import {TRANSIENT_ID_PREFIX, transientObjectId} from '../src/value/transient-ref.js';

// ADR 0060. What is under test is the claim the ADR makes: an object allocated inside an execution
// begins transient in the arena and becomes durable only when a reference crosses a durability
// boundary — so the common case (a handled condition, a built-and-discarded collection, any object
// that never escapes) costs no durable record, while identity, aliasing and cycles survive
// promotion. The assertions that matter most are the record-count ones: not writing is the point.

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

async function seed(runtime, imageId, {lane = 'neutral', library = false} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkControlFlow(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  let lib = null;
  if (library) {
    await installSmalltalkIndexedProtocol(options);
    await installSmalltalkIntegerProtocol(options);
    await installSmalltalkConditionProtocol(options);
    await installSmalltalkGlobalNamespace(options);
    await publishSmalltalkClassGlobals({
      images: runtime.images, imageId, names: ['Array', 'IndexOutOfRange', 'EmptyCollection'],
    });
    lib = await installSmalltalkLibrary(options);
  }
  return {kernel, library: lib, options};
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// Install the Block first and measure only around its *execution*: installation itself writes
// source/syntax/semantic/code artifacts plus the Block, and those are durable by design (ADR 0007).
// What ADR 0060 controls is what an *evaluation* publishes — so the baseline is after install.
async function evaluateAndCountNew(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const before = await recordCount(runtime, imageId);
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  const answer = await runtime.executor.execute(activation);
  const written = (await recordCount(runtime, imageId)) - before;
  return {answer, written};
}

const recordCount = async (runtime, imageId) => (await runtime.images.listRecords(imageId)).length;

// A boxed accumulator whose `add:` answers the added amount, so a slot write is observable. Slots
// start nil, so initialize must run (ADR 0046).
async function defineCounter({options, lane = 'neutral', name = 'ResidencyCounter', shapeId = 'residency/counter-shape'}) {
  const shapeRef = await ensureSmalltalkShape(
    options.images, options.imageId, {id: shapeId, slots: [{id: `${shapeId}-total`, name: 'total'}]},
  );
  const {classRef} = await defineClass({
    images: options.images, imageId: options.imageId, name, instanceShapeRef: shapeRef,
  });
  await defineMethodsFromSource({
    images: options.images, compilation: options.compilation, imageId: options.imageId, lane,
    classRef,
    methods: [
      {selector: 'initialize', source: '[ total := 0. self ]'},
      {selector: 'total', source: '[ total ]'},
      {selector: 'add:', source: '[ :n | total := total + n. n ]'},
      {selector: 'setTo:', source: '[ :n | total := n. self ]'},
    ],
  });
  return classRef;
}

// --- the operational claim -----------------------------------------------------------------------

test('an object that never escapes leaves no durable trace', async () => {
  await withRuntime(async (runtime) => {
    const {options, kernel} = await seed(runtime, 'app');
    const counter = await defineCounter({options});

    // Allocate, initialize, mutate and read — all inside one evaluation, answering an Integer.
    // The object never crosses a durability boundary.
    const {answer, written} = await evaluateAndCountNew(
      runtime, 'app', 'noescape', '[ :c | | x | x := c new. x add: 3. x add: 4. x total ]', [counter],
    );
    assert.deepEqual(answer, integerValue(7));
    assert.equal(written, 0, 'a built-and-discarded object must publish no durable record');
  });
});

test('the constant is a constant: N non-escaping allocations write nothing', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const counter = await defineCounter({options});
    // Several separate evaluations, each allocating and discarding. If any one promoted, the count
    // would grow with N; it must not.
    for (const n of [1, 2, 3]) {
      const {written} = await evaluateAndCountNew(
        runtime, 'app', `noescape-${n}`, '[ :c | | x | x := c new. x add: 1. x total ]', [counter],
      );
      assert.equal(written, 0, `evaluation ${n} wrote a durable record for a non-escaping object`);
    }
  });
});

test('a handled condition allocated, signalled and discarded writes no durable record', async () => {
  await withRuntime(async (runtime) => {
    const {options, library} = await seed(runtime, 'app', {library: true});
    // `at:` signals IndexOutOfRange; `at:ifAbsent:` handles it inside the same execution. The
    // condition object never escapes, so ADR 0054's durable-garbage case is now free.
    const {answer, written} = await evaluateAndCountNew(
      runtime, 'app', 'handled',
      '[ :oc | | c | c := oc new. c at: 5 ifAbsent: [ 42 ] ]', [library.orderedCollection],
    );
    assert.deepEqual(answer, integerValue(42));
    assert.equal(written, 0, 'a handled condition must not leave a durable object per occurrence');
  });
});

// --- escape and identity --------------------------------------------------------------------------

test('an object returned from a root execution is promoted and usable later', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const counter = await defineCounter({options});

    // The object crosses the root boundary, so it is promoted. The durable id derives from the
    // transient one by the ADR 0060 rule (object/...).
    const made = await evaluate(runtime, 'app', 'make', '[ :c | | x | x := c new. x add: 5. x ]', [counter]);
    assert.ok(made.objectId.startsWith('object/'), `promoted id should derive under object/, got ${made.objectId}`);
    assert.ok(!made.objectId.startsWith(TRANSIENT_ID_PREFIX), 'a promoted object is not transient');

    // And it works in a later, independent execution — reading the state promotion carried.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'read', '[ :x | x total ]', [made]),
      integerValue(5),
    );
    // A durable record now exists for it.
    assert.ok(await runtime.images.getObject('app', made.objectId), 'the promoted object must be durable');
  });
});

test('two slots written with one transient object hold one durable object after promotion', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const counter = await defineCounter({options});

    // Build one counter, write it into two slots of a holder, return both reads. Promotion is
    // memoized, so both promote to the SAME durable object — and a mutation through one is visible
    // through the other because there is only one.
    const pair = await evaluate(runtime, 'app', 'pair', `[ :c | | shared a b |
      shared := c new.
      shared add: 7.
      a := shared.
      b := shared.
      a setTo: (a total + 1).
      b total ]`, [counter]);
    // a and b are one object: a's setTo: is visible to b.
    assert.deepEqual(pair, integerValue(8), 'two references to one transient object must promote as one object');

    // The object itself, returned once: one durable identity.
    const one = await evaluate(runtime, 'app', 'one', '[ :c | | x | x := c new. x add: 1. x ]', [counter]);
    assert.ok(one.objectId.startsWith('object/'));
  });
});

test('basicNew answered twice at one site gives two objects that never alias', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const counter = await defineCounter({options});
    // Two allocations from the same `c new` site must be two objects: mutating one leaves the
    // other. Read them back as (a.total, b.total) mapped to a two-digit sum with plain `+`.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'two', `[ :c | | a b |
        a := c new.
        b := c new.
        a add: 10.
        b add: 1.
        (a total + a total) + b total ]`, [counter]),
      integerValue(21),
      'two instances of one site must stay independent: a=10 counted twice + b=1',
    );
  });
});

// --- cycles and sharing ----------------------------------------------------------------------------

test('a cyclic structure promotes to a cyclic durable graph and terminates', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    // Two counters that can hold each other via a slot. A -> B -> A is a cycle; promotion must
    // terminate through the memo (preassigned ids reserved before recursion) and stay shared.
    const shapeRef = await ensureSmalltalkShape(options.images, 'app', {
      id: 'residency/node-shape', slots: [{id: 'residency/node-link', name: 'link'}, {id: 'residency/node-val', name: 'val'}],
    });
    const {classRef: nodeRef} = await defineClass({
      images: options.images, imageId: 'app', name: 'ResidencyNode', instanceShapeRef: shapeRef,
    });
    await defineMethodsFromSource({
      images: options.images, compilation: options.compilation, imageId: 'app',
      classRef: nodeRef,
      methods: [
        {selector: 'initialize', source: '[ val := 0. link := nil. self ]'},
        {selector: 'link:', source: '[ :x | link := x. self ]'},
        {selector: 'link', source: '[ link ]'},
        {selector: 'val:', source: '[ :n | val := n. self ]'},
        {selector: 'val', source: '[ val ]'},
      ],
    });

    // Build A and B, link A->B and B->A, return A. The cycle promotes; reading A.link.link.val
    // reaches back to A, proving both the cycle survived and the two stayed distinct objects.
    const a = await evaluate(runtime, 'app', 'cycle', `[ :n | | a b |
      a := n new.
      b := n new.
      a val: 1.
      b val: 2.
      a link: b.
      b link: a.
      a ]`, [nodeRef]);
    assert.ok(a.objectId.startsWith('object/'));
    // a.link is b, b.link is a; a.link.link.val is a's own val = 1.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'cycle-read', '[ :x | x link link val ]', [a]),
      integerValue(1),
      'the cycle must promote as a cycle, terminating back at the same object',
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'cycle-read2', '[ :x | x link val ]', [a]),
      integerValue(2),
    );
  });
});

// --- the boundary guard ----------------------------------------------------------------------------

test('an unpromoted transient object ref cannot be written into a durable record directly', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // The write-seam guard is the proof a boundary was not forgotten: a durable record embedding a
    // reserved ref is refused. Objects join closures under the same guard.
    const id = transientObjectId('obj-squatter');
    const shape = await runtime.images.putShape('app', {id: 'guard-shape', slots: [{id: 's', name: 's'}]});
    await assert.rejects(
      runtime.images.putObject('app', {
        id: 'guard-target',
        shape: objectRef('app', shape.id),
        slots: {s: objectRef('app', id)},
        metadata: {},
      }, {expectedVersion: 0}),
      /unpromoted transient reference/,
    );
  });
});

// --- lanes -----------------------------------------------------------------------------------------

for (const lane of ['neutral', 'wasm']) {
  test(`an escaping object promotes and a non-escaping one does not, through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      const {options} = await seed(runtime, 'app', {lane});
      const counter = await defineCounter({options, lane, name: `ResidencyCounter-${lane}`, shapeId: `residency/counter-${lane}`});

      // Non-escaping: discarded inside the evaluation.
      const {written} = await evaluateAndCountNew(
        runtime, 'app', `lane-noescape-${lane}`, '[ :c | | x | x := c new. x add: 9. x total ]', [counter],
      );
      assert.equal(written, 0, `non-escaping object wrote a durable record in the ${lane} lane`);

      // Escaping: returned, so it promotes.
      const made = await evaluate(runtime, 'app', `lane-escape-${lane}`, '[ :c | | x | x := c new. x add: 9. x ]', [counter]);
      assert.ok(made.objectId.startsWith('object/'));
      assert.deepEqual(await evaluate(runtime, 'app', `lane-read-${lane}`, '[ :x | x total ]', [made]), integerValue(9));
    });
  });
}
