import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
  createRuntime,
  defineClass,
  defineMethods,
  defineMethodsFromSource,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {nestedIds} from '../src/language/smalltalk-nested-blocks.js';
import {SYMMETRIC_SMALLTALK_ID} from '../src/language/symmetric-smalltalk.js';

// Nested Blocks inside methods, and the frame semantics that make them mean what Smalltalk says.
//
// The property under test throughout: a Block's `self` is the receiver of the method that *created*
// it, established at creation and restored at activation — never the receiver of whoever happens to
// invoke it, and never recoverable once the execution that created it has ended.

const READ_PRIMITIVE = 'smalltalk/primitive/instance-slot-read';

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
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  return kernel;
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

async function counterClass(runtime, imageId, {lane = 'neutral', extra = []} = {}) {
  const shape = objectRef(imageId, (await runtime.images.putShape(imageId, {
    id: 'counter-shape', slots: [{id: 'n-slot', name: 'n'}],
  })).id);
  const counter = await defineClass({images: runtime.images, imageId, name: 'Counter', instanceShapeRef: shape});
  await defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId, lane, classRef: counter.classRef,
    methods: [
      {selector: 'init', source: '[ n := 0 ]'},
      {selector: 'n', source: '[ n ]'},
      // v0: a nested Block that touches no instance state at all.
      {selector: 'constantBlock', source: '[ [ 42 ] ]'},
      // v1: the case the whole feature exists for.
      {selector: 'incrementer', source: '[ [ n := n + 1 ] ]'},
      ...extra,
    ],
  });
  return counter;
}

const newCounter = async (runtime, imageId, id, classRef) => {
  const instance = await evaluate(runtime, imageId, id, '[ :c | c basicNew ]', [classRef]);
  await evaluate(runtime, imageId, `${id}-init`, '[ :o | o init ]', [instance]);
  return instance;
};

// --- both representations, both lanes ----------------------------------------------------------

for (const lane of ['neutral', 'wasm']) {
  test(`a v0 method with a nested Block installs and runs through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      const counter = await counterClass(runtime, 'app', {lane});
      const instance = await newCounter(runtime, 'app', `c0-${lane}`, counter.classRef);
      assert.deepEqual(
        await evaluate(runtime, 'app', `const-${lane}`, '[ :o | o constantBlock value ]', [instance]),
        integerValue(42),
      );
    });
  });

  test(`a v1 method returns an ivar-mutating closure through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      const counter = await counterClass(runtime, 'app', {lane});
      const instance = await newCounter(runtime, 'app', `c1-${lane}`, counter.classRef);

      // Invoked twice within one execution: it must mutate the original receiver both times.
      assert.deepEqual(
        await evaluate(runtime, 'app', `twice-${lane}`,
          '[ :o | o incrementer value. o incrementer value. o n ]', [instance]),
        integerValue(2),
      );
      // And the durable record agrees — it is the receiver's slot, not a copy.
      const record = await runtime.images.getObject('app', instance.objectId);
      assert.deepEqual(record.slots['n-slot'], integerValue(2));
    });
  });
}

// One closure value, invoked repeatedly, rather than a fresh closure per send.
test('a single closure value mutates the same receiver on each invocation', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app');
    const instance = await newCounter(runtime, 'app', 'single', counter.classRef);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'one-closure',
        '[ :o | | b | b := o incrementer. b value. b value. b value. o n ]', [instance]),
      integerValue(3),
    );
  });
});

// A closure result feeding a further send cannot be compiled as a tail call.
test('a nested-Block result feeding another send resumes correctly in WASM', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app', {lane: 'wasm'});
    const counter = await counterClass(runtime, 'app', {lane: 'wasm'});
    const instance = await newCounter(runtime, 'app', 'nontail', counter.classRef);

    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'nontail-caller',
      source: '[ :o | (o incrementer value) + 10 ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'nontail-caller-tree',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), [instance]);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(11));
    assert.deepEqual(
      await evaluate(runtime, 'app', 'nontail-read', '[ :o | o n ]', [instance]),
      integerValue(1),
      'and the mutation happened exactly once across suspension and resumption',
    );
  });
});

// --- the cross-execution boundary ----------------------------------------------------------------

// ADR 0050 decision 10a, unchanged: the frame lives in the execution arena, so a closure that
// outlived its execution has none. Repairing that by persisting a defining Behavior would make the
// one fact the self-only check depends on into forgeable durable data.
test('an ivar-using closure fails closed when invoked in a later execution', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app');
    const instance = await newCounter(runtime, 'app', 'escaped', counter.classRef);

    const closure = await evaluate(runtime, 'app', 'make-closure', '[ :o | o incrementer ]', [instance]);
    assert.equal(closure.kind, 'ref', 'the closure is an ordinary durable Block');

    await assert.rejects(
      evaluate(runtime, 'app', 'later', '[ :b | b value ]', [closure]),
      (error) => error.name === 'SmalltalkSlotFrameMissingError',
    );
    // Nothing was mutated by the refused call.
    assert.deepEqual(await evaluate(runtime, 'app', 'unchanged', '[ :o | o n ]', [instance]), integerValue(0));
  });
});

// The restriction must be about trusted private-state provenance, not about Blocks. An ordinary
// durable closure that depends on neither instance state nor a live cell keeps working.
test('an ordinary durable closure still works across executions', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app');
    const instance = await newCounter(runtime, 'app', 'plain', counter.classRef);

    const closure = await evaluate(runtime, 'app', 'make-plain', '[ :o | o constantBlock ]', [instance]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'later-plain', '[ :b | b value ]', [closure]),
      integerValue(42),
      'a closure with no private-state dependency is unaffected',
    );

    // And a snapshot-capturing standalone closure keeps its ADR 0043 behaviour.
    const snapshot = await evaluate(runtime, 'app', 'make-snapshot', '[ :v | [ v ] ]', [integerValue(7)]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'later-snapshot', '[ :b | b value ]', [snapshot]),
      integerValue(7),
    );
  });
});

// --- adversarial frame proofs ---------------------------------------------------------------------

// The sharpest case: A's closure invoked from inside B's method must still be A's self.
test('a closure invoked from another method does not inherit that method frame', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app', {
      extra: [{selector: 'runInMe:', source: '[ :b | b value. n ]'}],
    });
    const first = await newCounter(runtime, 'app', 'first', counter.classRef);
    const second = await newCounter(runtime, 'app', 'second', counter.classRef);

    // `second runInMe: (first incrementer)` — the closure belongs to `first`.
    const result = await evaluate(runtime, 'app', 'cross',
      '[ :a :b | b runInMe: a incrementer ]', [first, second]);

    assert.deepEqual(result, integerValue(0), 'the invoking receiver was not the one mutated');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'cross-first', '[ :o | o n ]', [first]),
      integerValue(1),
      'the creating receiver was',
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'cross-second', '[ :o | o n ]', [second]), integerValue(0));
  });
});

// Decision 5a rule 4 from the other direction: a Block created outside any method borrows nothing.
test('an unrelated Block passed into a method does not borrow the method frame', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app', {
      extra: [{selector: 'runInMe:', source: '[ :b | b value. n ]'}],
    });
    const instance = await newCounter(runtime, 'app', 'unrelated', counter.classRef);

    // A standalone Block that calls the slot primitive directly, handed to a method and invoked
    // there. It was created with no frame, so it must still have none.
    const outsider = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'outsider',
      source: '[ [ 1 ] value ]',
    });
    void outsider;
    const prim = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'prim-caller',
      source: '[ :p :t | p value: t value: 1 ]',
    });
    await assert.rejects(
      evaluate(runtime, 'app', 'borrow',
        '[ :o :b :p :t | o runInMe: [ b value: p value: t ] ]',
        [instance, objectRef('app', prim.block.id), objectRef('app', READ_PRIMITIVE), instance]),
      (error) => error.name === 'SmalltalkSlotFrameMissingError' || error.name === 'SmalltalkSlotAccessError',
    );
  });
});

// Trusted identity comes from the creation/dispatch event, never from the artifact. This forgery is
// faithful: the closure genuinely receives the slot primitive and the right `self`, and is created
// by a real `make-block`. What it cannot forge is the frame, which comes from the dispatch that is
// running — a method on Object, which declares no layout at all.
test('a closure created in a forged method gets that method defining Behavior, not a chosen one', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app');
    const instance = await newCounter(runtime, 'app', 'forge', counter.classRef);

    const nestedProgram = {
      parameters: [],
      captures: [{id: 'forged/prim', name: 'prim'}, {id: 'forged/self', name: 'me'}],
      body: {
        op: 'send',
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: {op: 'binding', id: 'forged/prim'},
        message: textValue('value:value:'),
        arguments: [{op: 'binding', id: 'forged/self'}, {op: 'literal', value: textValue('n-slot')}],
      },
    };
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.objectClass,
      methods: [{
        selector: 'stolen',
        program: {
          parameters: [],
          captures: [{id: 'stolen/prim', name: 'prim'}],
          body: {
            op: 'block',
            blockId: 'root/block:0',
            program: nestedProgram,
            captures: [
              {id: 'forged/prim', name: 'prim', value: {op: 'binding', id: 'stolen/prim'}},
              {id: 'forged/self', name: 'me', value: {op: 'receiver'}},
            ],
          },
        },
        captures: [{id: 'stolen/prim', name: 'prim', value: objectRef('app', READ_PRIMITIVE)}],
      }],
    });

    // The closure is well-formed and holds the real receiver; only permission is missing.
    await assert.rejects(
      evaluate(runtime, 'app', 'stolen-call', '[ :o | o stolen value ]', [instance]),
      (error) => error.name === 'SmalltalkSlotAccessError' && /not declared by/.test(error.message),
      'the frame comes from the dispatch that created the closure, not from what the code names',
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'forge-n', '[ :o | o n ]', [instance]), integerValue(0));
  });
});

// Reusing a published prototype directly confers nothing either: a raw prototype Block has no
// environment of its own, so it is not even a runnable closure outside the creation that makes one.
test('sending value to a published prototype Block does not run it as a closure', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app');
    const instance = await newCounter(runtime, 'app', 'proto', counter.classRef);
    const methodId = `${counter.classRef.objectId}/method/${Buffer.from('incrementer', 'utf8').toString('base64url')}`;
    const prototypeId = nestedIds(methodId, 'root/block:0').prototypeId;
    assert.ok(await runtime.images.getBlock('app', prototypeId), 'the fixture needs the real prototype');

    await assert.rejects(
      evaluate(runtime, 'app', 'raw-proto', '[ :b | b value ]', [objectRef('app', prototypeId)]),
      /lexical binding not found/,
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'proto-n', '[ :o | o n ]', [instance]), integerValue(0));
  });
});

// --- captures ---------------------------------------------------------------------------------------

// ADR 0043's capture modes, exercised inside a method Block alongside lexical self and an ivar.
test('a nested method Block combines a snapshot capture, lexical self and an instance variable', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app', {
      extra: [
        // `delta` is a parameter, captured by snapshot; `n` is an instance variable; `self` is
        // lexical inside the Block.
        {selector: 'addBlock:', source: '[ :delta | [ n := n + delta ] ]'},
        {selector: 'selfInBlock', source: '[ [ self ] value ]'},
      ],
    });
    const instance = await newCounter(runtime, 'app', 'captures', counter.classRef);

    assert.deepEqual(
      await evaluate(runtime, 'app', 'add-block', '[ :o | (o addBlock: 5) value. o n ]', [instance]),
      integerValue(5),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'self-in-block', '[ :o | o selfInBlock ]', [instance]),
      instance,
      'lexical self inside a method Block is the method receiver',
    );
  });
});

// A mutable temporary shared with a nested Block, within one execution — ADR 0043's cell path,
// unchanged by any of this.
test('a nested method Block shares a mutable temporary within one execution', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app', {
      extra: [{selector: 'localBump', source: '[ | t b | t := 1. b := [ t := t + 1 ]. b value. b value. t ]'}],
    });
    const instance = await newCounter(runtime, 'app', 'cells', counter.classRef);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'local-bump', '[ :o | o localBump ]', [instance]),
      integerValue(3),
    );
  });
});

// --- shared publication -------------------------------------------------------------------------------

test('nested identities derive from the method identity and the semantic block id', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app');
    const methodId = `${counter.classRef.objectId}/method/${Buffer.from('incrementer', 'utf8').toString('base64url')}`;
    const ids = nestedIds(methodId, 'root/block:0');

    for (const [label, record] of [
      ['semantic', await runtime.images.getCodeArtifact('app', ids.semanticId)],
      ['code', await runtime.images.getCodeArtifact('app', ids.codeId)],
      ['prototype', await runtime.images.getBlock('app', ids.prototypeId)],
    ]) {
      assert.ok(record, `the ${label} record must exist at its derived id`);
    }
    assert.equal((await runtime.images.getBlock('app', ids.prototypeId)).metadata.prototype, true);
  });
});

test('installing the same method twice is idempotent, nested tree included', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app');
    const before = (await runtime.images.listRecords('app')).length;
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: counter.classRef,
      methods: [{selector: 'incrementer', source: '[ [ n := n + 1 ] ]'}],
    });
    assert.equal((await runtime.images.listRecords('app')).length, before, 'no record is rewritten or added');
  });
});

// --- publication recovery ----------------------------------------------------------------------------

const WRITE_METHODS = ['putCodeArtifact', 'putBlock', 'putShape', 'putObject', 'putLexicalEnvironment'];

function faultingImages(images, {failAt = null, commitThenThrow = false, failIdMatching = null} = {}) {
  let writes = 0;
  let targeted = false;
  const wrapped = Object.create(Object.getPrototypeOf(images));
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(images))) {
    if (typeof images[key] !== 'function' || key === 'constructor') continue;
    wrapped[key] = (...args) => images[key](...args);
  }
  for (const [key, value] of Object.entries(images)) {
    if (typeof value === 'function') wrapped[key] = (...args) => images[key](...args);
    else wrapped[key] = value;
  }
  for (const method of WRITE_METHODS) {
    wrapped[method] = async (imageId, input, options) => {
      writes += 1;
      const index = writes;
      // Either the Nth write, or the first write whose record id matches — the latter lets a test
      // name the artifact whose lost acknowledgement it is actually about.
      const hit = failIdMatching
        ? !targeted && typeof input?.id === 'string' && failIdMatching.test(input.id)
        : index === failAt;
      if (hit) targeted = true;
      if (hit && !commitThenThrow) throw new Error(`injected failure at write ${index} (${input?.id})`);
      const result = await images[method](imageId, input, options);
      if (hit && commitThenThrow) throw new Error(`injected post-commit failure at write ${index} (${input?.id})`);
      return result;
    };
  }
  return {images: wrapped, writeCount: () => writes};
}

// Group compilers included: the WASM lane plans a nested tree as a shared-module compilation group,
// so a service without them cannot publish one.
const servicesFor = (images) => new CompilationService({
  images,
  compilers: createDefaultCodeCompilerRegistry(),
  groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
});

// Two shapes, because they take different publication paths. The v1 method is the widest — its
// nested Block mutates an instance variable — while the v0 method is the one that reaches the v0
// WASM function assembler, which the v1 path never touches.
const RECOVERY_SHAPES = [
  {
    label: 'v1 ivar-mutating',
    methods: [{selector: 'incrementer', source: '[ [ n := n + 1 ] ]'}],
    exercise: '[ :o | o incrementer value. o n ]',
    expected: 1,
  },
  {
    label: 'v0 constant',
    methods: [{selector: 'constantBlock', source: '[ [ 42 ] ]'}],
    exercise: '[ :o | o constantBlock value ]',
    expected: 42,
  },
];

async function baseForRecovery(runtime, imageId, lane) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  const shape = objectRef(imageId, (await runtime.images.putShape(imageId, {
    id: 'rec-counter-shape', slots: [{id: 'n-slot', name: 'n'}],
  })).id);
  const counter = await defineClass({images: runtime.images, imageId, name: 'Counter', instanceShapeRef: shape});
  await defineMethodsFromSource({
    ...options, classRef: counter.classRef,
    methods: [{selector: 'init', source: '[ n := 0 ]'}, {selector: 'n', source: '[ n ]'}],
  });
  return counter;
}

for (const lane of ['neutral', 'wasm']) {
  for (const shape of RECOVERY_SHAPES) {
    test(`every write publishing a ${lane} ${shape.label} nested-Block method is recoverable`, async () => {
      const total = await withRuntime(async (runtime) => {
        const counter = await baseForRecovery(runtime, 'count', lane);
        const {images, writeCount} = faultingImages(runtime.images);
        await defineMethodsFromSource({
          images, compilation: servicesFor(images), imageId: 'count', lane,
          classRef: counter.classRef, methods: shape.methods,
        });
        return writeCount();
      });
      assert.ok(total > 3, `expected several writes in the ${lane} lane, saw ${total}`);

      for (let failAt = 1; failAt <= total; failAt += 1) {
        for (const commitThenThrow of [false, true]) {
          await withRuntime(async (runtime) => {
            const counter = await baseForRecovery(runtime, 'app', lane);
            const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});

            await assert.rejects(
              defineMethodsFromSource({
                images, compilation: servicesFor(images), imageId: 'app', lane,
                classRef: counter.classRef, methods: shape.methods,
              }),
              /injected/,
              `${lane} ${shape.label}: write ${failAt} (commitThenThrow=${commitThenThrow}) should have failed`,
            );

            // A failed install must never leave a published selector pointing at an incomplete tree:
            // the identical retry converges and the method works.
            await defineMethodsFromSource({
              images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane,
              classRef: counter.classRef, methods: shape.methods,
            });

            const suffix = `${lane}-${shape.label.replace(/\W/g, '')}-${failAt}-${commitThenThrow}`;
            const instance = await evaluate(runtime, 'app', `rec-new-${suffix}`, '[ :c | c basicNew ]', [counter.classRef]);
            await evaluate(runtime, 'app', `rec-init-${suffix}`, '[ :o | o init ]', [instance]);
            assert.deepEqual(
              await evaluate(runtime, 'app', `rec-run-${suffix}`, shape.exercise, [instance]),
              integerValue(shape.expected),
              `${lane} ${shape.label}: not usable after retrying past write ${failAt}`,
            );
          });
        }
      }
    });
  }
}

// The specific write the v0 WASM assembler owns. Naming it rather than relying on an ordinal keeps
// the proof pointed at the artifact whose lost acknowledgement is the actual hazard.
test('a lost acknowledgement on the v0 WASM function artifact converges on retry', async () => {
  await withRuntime(async (runtime) => {
    const counter = await baseForRecovery(runtime, 'app', 'wasm');
    const methods = [{selector: 'constantBlock', source: '[ [ 42 ] ]'}];
    const {images} = faultingImages(runtime.images, {
      commitThenThrow: true,
      failIdMatching: /:function$|:wasm:function$/,
    });

    await assert.rejects(
      defineMethodsFromSource({
        images, compilation: servicesFor(images), imageId: 'app', lane: 'wasm',
        classRef: counter.classRef, methods,
      }),
      /injected post-commit failure.*function/,
      'the fixture must actually hit a WASM function artifact write',
    );

    // The artifact is committed and the caller believes it failed. An identical retry must reuse it.
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm',
      classRef: counter.classRef, methods,
    });
    const instance = await evaluate(runtime, 'app', 'lostack-new', '[ :c | c basicNew ]', [counter.classRef]);
    await evaluate(runtime, 'app', 'lostack-init', '[ :o | o init ]', [instance]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'lostack-run', '[ :o | o constantBlock value ]', [instance]),
      integerValue(42),
    );
  });
});
