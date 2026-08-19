import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  booleanValue,
  createRuntime,
  defineClass,
  defineMethods,
  findSmalltalkBlockProtocol,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {defineMethodsFromSource} from '../src/language/smalltalk-instance-variables.js';
import {installWasmBlockTree} from '../src/wasm/tree-installer.js';
import {BLOCK_PROTOCOL_SLOTS} from '../src/language/smalltalk-block-protocol.js';
import {SYMMETRIC_SMALLTALK_ID} from '../src/language/symmetric-smalltalk.js';

// ADR 0051. What is under test is not `whileTrue:` the feature so much as the claim underneath it:
// that iteration can be added as two more operations on the classless Block personality, driven by
// ordinary sends, without the compiler, the IR, the activation or the frame rules learning anything.
//
// So the assertions that matter most are the negative and structural ones — constant depth, no
// selector recognition, no borrowed frames, and a routing authority that is verified rather than
// trusted.

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

async function seed(runtime, imageId, {lane = 'neutral', blockProtocol = true} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkControlFlow(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  const protocol = blockProtocol
    ? await installSmalltalkBlockProtocol({images: runtime.images, imageId})
    : null;
  return {kernel, protocol, options};
}

// A read record carries backend bookkeeping (`kind`, `_version`, timestamps) that `putObject`
// rejects, so a mutation test must write back only the authored fields.
const AUTHORED = ['id', 'shape', 'behavior', 'slots', 'indexed', 'metadata'];

async function rewriteObject(runtime, imageId, objectId, mutate) {
  const record = await runtime.images.getObject(imageId, objectId);
  const authored = Object.fromEntries(
    AUTHORED.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]),
  );
  await runtime.images.putObject(imageId, mutate(authored), {expectedVersion: record._version});
  return record;
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// --- semantics -----------------------------------------------------------------------------------

test('whileTrue: and whileFalse: loop with the expected sense', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'wf', '[ | i sum | i := 0. sum := 0. [ i = 5 ] whileFalse: [ i := i + 1. sum := sum + i ]. sum ]'),
      integerValue(15),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'wt', '[ | i | i := 0. [ i = 0 ] whileTrue: [ i := i + 1 ]. i ]'),
      integerValue(1),
    );
  });
});

test('a condition that stops at once runs the body zero times', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'never', '[ | i runs | i := 0. runs := 0. [ i = 0 ] whileFalse: [ runs := runs + 1 ]. runs ]'),
      integerValue(0),
    );
  });
});

// The body's own result is discarded, and the loop answers nil rather than the last value it saw.
test('the loop answers nil and ignores the body result', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const answer = await evaluate(
      runtime, 'app', 'answer',
      '[ | i | i := 0. [ i = 2 ] whileFalse: [ i := i + 1. 99 ] ]',
    );
    assert.deepEqual(answer, kernel.nil);
  });
});

// ADR 0051's corrected counting: N body executions means N+1 condition evaluations, because the
// final test is what stops the loop. The property being proven is that neither is duplicated.
test('N body executions produce N+1 condition evaluations', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const counts = await evaluate(
      runtime, 'app', 'counts',
      `[ | i conditions bodies |
         i := 0. conditions := 0. bodies := 0.
         [ conditions := conditions + 1. i = 4 ] whileFalse: [ bodies := bodies + 1. i := i + 1 ].
         conditions + (bodies + 100) ]`,
    );
    // 5 conditions, 4 bodies: 5 + 104.
    assert.deepEqual(counts, integerValue(109));
  });
});

test('a mutable temporary written by the body is visible to the next condition', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'cells', '[ | i | i := 0. [ i = 3 ] whileFalse: [ i := i + 1 ]. i ]'),
      integerValue(3),
    );
  });
});

// --- constant stack ------------------------------------------------------------------------------

// The activation depth limit is 256, so completing ten thousand iterations is itself the proof: a
// loop that consumed depth per iteration could not reach a hundred.
test('ten thousand iterations complete, where recursion fails far sooner', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'many', '[ | i | i := 0. [ i = 10000 ] whileFalse: [ i := i + 1 ]. i ]'),
      integerValue(10000),
    );

    // The recursive equivalent of the same count, so the difference is demonstrated rather than
    // asserted. `countTo:` is exactly the idiom the library was forced into before this ADR.
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      lane: 'neutral',
      classRef: kernel.integerClass,
      methods: [{selector: 'countTo:', source: '[ :limit | (self = limit) ifFalse: [ (self + 1) countTo: limit ] ]'}],
    });
    await assert.rejects(
      evaluate(runtime, 'app', 'recursive', '[ 0 countTo: 10000 ]'),
      /activation depth limit exceeded/,
    );
  });
});

// Stronger than "it completed": if the loop leaked depth, the headroom available *inside* an
// iteration would shrink as iterations accumulated. A body that makes its own nested sends
// therefore behaves identically on the first iteration and the fiftieth.
test('iterating does not consume the depth available inside the body', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      lane: 'neutral',
      classRef: kernel.integerClass,
      methods: [{selector: 'countTo:', source: '[ :limit | (self = limit) ifFalse: [ (self + 1) countTo: limit ] ]'}],
    });
    const deep = (iterations) => evaluate(
      runtime, 'app', `deep-${iterations}`,
      `[ | i | i := 0. [ i = ${iterations} ] whileFalse: [ 0 countTo: 12. i := i + 1 ]. i ]`,
    );
    assert.deepEqual(await deep(1), integerValue(1));
    assert.deepEqual(await deep(50), integerValue(50));
  });
});

// The scope ADR 0051 is careful not to overclaim: only iterations are constant-stack.
test('nested loops consume nesting depth normally', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(
        runtime, 'app', 'nested',
        `[ | i total |
           i := 0. total := 0.
           [ i = 3 ] whileFalse: [
             | j | j := 0.
             [ j = 4 ] whileFalse: [ j := j + 1. total := total + 1 ].
             i := i + 1 ].
           total ]`,
      ),
      integerValue(12),
    );
  });
});

// --- refusals ------------------------------------------------------------------------------------

test('a non-boolean condition result is refused, and names the problem', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'bad-cond', '[ [ 7 ] whileTrue: [ 1 ] ]'),
      /condition answered a integer Value; a Boolean is required/,
    );
  });
});

test('an image without the Block protocol answers neither selector', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'plain', {blockProtocol: false});
    for (const selector of ['whileTrue:', 'whileFalse:']) {
      await assert.rejects(
        evaluate(runtime, 'plain', `dnu-${selector}`, `[ [ 1 = 2 ] ${selector} [ 1 ] ]`),
        new RegExp(`Block does not understand: ${selector}`),
      );
    }
  });
});

test('a loop primitive refuses self-application and primitive operands', async () => {
  await withRuntime(async (runtime) => {
    const {protocol} = await seed(runtime, 'app');
    const ordinary = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'ordinary', source: '[ 1 = 2 ]',
    });
    const ordinaryRef = objectRef('app', ordinary.block.id);

    // `aLoopPrimitive value: aBlock` — the route the replaced receiver guard used to close.
    const send = async (receiver, selector, args) => {
      const activation = await runtime.invocations.prepareDispatch({
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver,
        message: textValue(selector),
        arguments: args,
      }, {dispatchImage: 'app'});
      return await runtime.executor.execute(activation.activation, {invocationFrame: activation.frame});
    };
    await assert.rejects(
      send(protocol.whileTrue, 'value:', [ordinaryRef]),
      /kernel-primitive Block as the condition/,
    );
    // A primitive smuggled in as the body, dispatched the intended way.
    await assert.rejects(
      send(ordinaryRef, 'whileTrue:', [protocol.whileFalse]),
      /kernel-primitive Block as the body/,
    );
    // A non-Block argument.
    await assert.rejects(send(ordinaryRef, 'whileTrue:', [integerValue(3)]), /as the body/);
  });
});

test('a loop primitive cannot be invoked directly', async () => {
  await withRuntime(async (runtime) => {
    const {protocol} = await seed(runtime, 'app');
    const ordinary = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'ordinary', source: '[ 1 = 2 ]',
    });
    const activation = await runtime.invocations.invokeBlock(protocol.whileTrue, [
      objectRef('app', ordinary.block.id),
    ]);
    await assert.rejects(
      runtime.executor.execute(activation),
      /reachable only by dispatching whileTrue: or whileFalse:/,
    );
  });
});

// --- the protocol object as a routing authority --------------------------------------------------

test('the protocol object is discoverable, exactly shaped, and idempotent', async () => {
  await withRuntime(async (runtime) => {
    const {protocol} = await seed(runtime, 'app');
    const found = await findSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'});
    assert.deepEqual(found.whileTrue, protocol.whileTrue);
    assert.deepEqual(found.whileFalse, protocol.whileFalse);
    assert.deepEqual(
      found.record.slots,
      {
        'block-protocol-while-true': protocol.whileTrue,
        'block-protocol-while-false': protocol.whileFalse,
      },
    );

    const before = (await runtime.images.listRecords('app')).length;
    await installSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'});
    assert.equal((await runtime.images.listRecords('app')).length, before);
  });
});

test('an image with no protocol object reports absent, not corrupt', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'plain', {blockProtocol: false});
    assert.equal(await findSmalltalkBlockProtocol({images: runtime.images, imageId: 'plain'}), null);
  });
});

test('installing the Block protocol requires a kernel', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'bare'});
    await assert.rejects(
      installSmalltalkBlockProtocol({images: runtime.images, imageId: 'bare'}),
      /has no Smalltalk kernel/,
    );
    // Nothing was published on the way to that refusal.
    assert.equal(await runtime.images.getBlock('bare', 'smalltalk/primitive/block-while-true'), null);
  });
});

// A structurally perfect protocol object whose slots point elsewhere is the attack the ADR added
// target validation for: every check on the object itself still passes.
test('a repointed protocol slot is refused rather than routed', async () => {
  const corruptions = [
    {
      label: 'a non-Block object',
      target: async (runtime, kernel) => kernel.nil,
    },
    {
      label: 'an ordinary Block',
      target: async (runtime) => objectRef('app', (await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app', id: 'plain-block', source: '[ 1 ]',
      })).block.id),
    },
    {
      label: 'a different kernel primitive',
      target: async () => objectRef('app', 'smalltalk/primitive/basic-new'),
    },
    {
      label: 'the other loop primitive',
      target: async (runtime, kernel, protocol) => protocol.whileFalse,
    },
  ];

  for (const {label, target} of corruptions) {
    await withRuntime(async (runtime) => {
      const {kernel, protocol} = await seed(runtime, 'app');
      const replacement = await target(runtime, kernel, protocol);
      await rewriteObject(runtime, 'app', 'smalltalk-block-protocol/v1', (record) => ({
        ...record,
        slots: {...record.slots, 'block-protocol-while-true': replacement},
      }));

      await assert.rejects(
        findSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'}),
        /Block protocol in app is corrupt: slot whileTrue/,
        `expected ${label} to be refused`,
      );
      // And the refusal reaches a send, rather than being a discovery-only nicety.
      await assert.rejects(
        evaluate(runtime, 'app', 'send', '[ [ 1 = 2 ] whileTrue: [ 1 ] ]'),
        /is corrupt/,
      );
    });
  }
});

test('a structurally damaged protocol object is corrupt, never absent', async () => {
  const damage = [
    {label: 'missing protocol tag', mutate: (record) => ({...record, metadata: {}}), match: /does not declare/},
    {
      // A decoy carrying the same two slots, so the object stays internally valid and only its
      // shape identity is wrong. That is the case a laxer "has two ref slots" check would admit.
      label: 'a decoy shape with the same slots',
      setUp: async (runtime) => {
        await runtime.images.putShape('app', {
          id: 'decoy-shape',
          slots: BLOCK_PROTOCOL_SLOTS.map(({id, name}) => ({id, name})),
        });
      },
      mutate: (record) => ({...record, shape: objectRef('app', 'decoy-shape')}),
      match: /does not have shape/,
    },
    {
      label: 'non-ref slot',
      mutate: (record) => ({...record, slots: {...record.slots, 'block-protocol-while-false': integerValue(1)}}),
      match: /slot whileFalse must be an unpinned local ref/,
    },
    {
      label: 'foreign-image slot',
      mutate: (record) => ({
        ...record,
        slots: {...record.slots, 'block-protocol-while-false': objectRef('elsewhere', 'x')},
      }),
      match: /slot whileFalse must be an unpinned local ref/,
    },
  ];

  for (const {label, mutate, match, setUp} of damage) {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app');
      if (setUp) await setUp(runtime);
      await rewriteObject(runtime, 'app', 'smalltalk-block-protocol/v1', mutate);
      await assert.rejects(
        findSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'}),
        match,
        `expected ${label} to be corrupt`,
      );
    });
  }
});

// The store refuses an object whose slots disagree with its declared shape, so a *missing* slot
// cannot coexist with the correct shape id and is unreachable through `putObject`. The check still
// exists because discovery must not depend on that guarantee holding for records it did not write,
// so it is exercised against a stub that can produce the record the store will not.
test('a protocol object with a missing slot is refused', async () => {
  const stub = {
    getObject: async () => ({
      id: 'smalltalk-block-protocol/v1',
      shape: objectRef('app', 'smalltalk/block-protocol-shape/v1'),
      slots: {'block-protocol-while-true': objectRef('app', 'smalltalk/primitive/block-while-true')},
      metadata: {protocol: 'smalltalk-block-protocol/v1'},
    }),
    // whileTrue is validated first, so it must be a genuine primitive for the missing whileFalse to
    // be what the assertion is actually about.
    getBlock: async (imageId, objectId) => ({id: objectId, code: objectRef('app', `${objectId}:code`)}),
    getCodeArtifact: async () => ({
      representation: 'smalltalk-kernel-primitive/v1',
      content: textValue(JSON.stringify({primitive: 'block-while-true'})),
    }),
  };
  await assert.rejects(
    findSmalltalkBlockProtocol({images: stub, imageId: 'app'}),
    /slot whileFalse must be an unpinned local ref/,
  );
});

test('a conflicting protocol object is refused rather than overwritten', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await rewriteObject(runtime, 'app', 'smalltalk-block-protocol/v1', (record) => ({
      ...record, metadata: {protocol: 'something-else'},
    }));
    await assert.rejects(
      installSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'}),
      /already exists and differs|does not declare/,
    );
  });
});

// --- kernel dependency ---------------------------------------------------------------------------

// The loop answers a nil it looks up, not one baked into the primitive. Proving that by repointing
// `kernel-nil` is not available: nil is also the method dictionary's empty-bucket marker, so moving
// it corrupts every dictionary in the image. The claim is therefore proven from both ends — the
// installed records capture nothing that could go stale, and the answer tracks whichever image's
// kernel is consulted (see the cross-image test below).
test('the loop captures no nil at install time and answers the kernel nil it looks up', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, protocol} = await seed(runtime, 'app');

    for (const slot of BLOCK_PROTOCOL_SLOTS) {
      const block = await runtime.images.getBlock('app', slot.blockId);
      const code = await runtime.images.getCodeArtifact('app', `${slot.blockId}:code`);
      // Nothing durable in the primitive refers to nil, the kernel, or any other object: a captured
      // nil would keep answering after the image's kernel changed underneath it.
      assert.equal(block.environment, null);
      assert.deepEqual(JSON.parse(code.content.value), {primitive: slot.primitive});
      assert.deepEqual(code.dependencies ?? [], []);
    }
    // And the protocol object points only at the two primitives — it holds no nil either.
    const record = await runtime.images.getObject('app', 'smalltalk-block-protocol/v1');
    assert.deepEqual(
      Object.values(record.slots).map((ref) => ref.objectId).sort(),
      BLOCK_PROTOCOL_SLOTS.map((slot) => slot.blockId).sort(),
    );

    assert.deepEqual(await evaluate(runtime, 'app', 'nil-now', '[ [ 1 = 2 ] whileTrue: [ 1 ] ]'), kernel.nil);
    assert.deepEqual(protocol.whileTrue.imageId, 'app');
  });
});

test('a present protocol with a broken kernel is a kernel failure, not a does-not-understand', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await rewriteObject(runtime, 'app', 'smalltalk-kernel/v1', (record) => ({...record, metadata: {}}));
    await assert.rejects(
      evaluate(runtime, 'app', 'broken', '[ [ 1 = 2 ] whileTrue: [ 1 ] ]'),
      (error) => {
        assert.ok(!/does not understand/.test(error.message), `kernel damage reported as DNU: ${error.message}`);
        assert.match(error.message, /does not declare smalltalk-kernel/);
        return true;
      },
    );
  });
});

// --- frames (ADR 0050) ---------------------------------------------------------------------------

async function counterClass(runtime, imageId, options) {
  const shape = objectRef(imageId, (await runtime.images.putShape(imageId, {
    id: 'loop-counter-shape', slots: [{id: 'n-slot', name: 'n'}],
  })).id);
  const counter = await defineClass({images: runtime.images, imageId, name: 'Counter', instanceShapeRef: shape});
  await defineMethodsFromSource({
    ...options,
    classRef: counter.classRef,
    methods: [
      {selector: 'init', source: '[ n := 0 ]'},
      {selector: 'n', source: '[ n ]'},
      // A loop *inside* a method, whose condition and body both touch an instance variable.
      {selector: 'countTo:', source: '[ :limit | [ n = limit ] whileFalse: [ n := n + 1 ]. n ]'},
      // A closure over `self` handed out for someone else to drive.
      {selector: 'bumper', source: '[ [ n := n + 1 ] ]'},
    ],
  });
  return counter;
}

test('a loop inside a method reaches that method instance variables', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app', options);
    const instance = await evaluate(runtime, 'app', 'make', '[ :c | c new init; yourself ]', [counter.classRef])
      .catch(async () => await evaluate(runtime, 'app', 'make2', '[ :c | | o | o := c new. o init. o ]', [counter.classRef]));
    assert.deepEqual(
      await evaluate(runtime, 'app', 'count', '[ :o | o countTo: 6 ]', [instance]),
      integerValue(6),
    );
  });
});

test('a closure created in a method still uses its creator self when driven by a loop', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app', options);
    const instance = await evaluate(runtime, 'app', 'make', '[ :c | | o | o := c new. o init. o ]', [counter.classRef]);
    // The loop drives a Block that belongs to `instance`, from an execution whose receiver is not
    // `instance` at all. ADR 0050 decision 5a rule 3 restores the creator's frame, and the loop adds
    // nothing to that: the body is reached by an ordinary `value` send.
    const result = await evaluate(
      runtime, 'app', 'drive',
      '[ :o | | b i | b := o bumper. i := 0. [ i = 4 ] whileFalse: [ b value. i := i + 1 ]. o n ]',
      [instance],
    );
    assert.deepEqual(result, integerValue(4));
  });
});

// The frame is transient by ADR 0050, so a closure that escaped its creating execution must fail
// closed — inside a loop exactly as outside one.
test('an escaped ivar-dependent closure still fails closed inside a loop', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app', options);
    const instance = await evaluate(runtime, 'app', 'make', '[ :c | | o | o := c new. o init. o ]', [counter.classRef]);
    const escaped = await evaluate(runtime, 'app', 'escape', '[ :o | o bumper ]', [instance]);
    await assert.rejects(
      evaluate(runtime, 'app', 'later', '[ :b | | i | i := 0. [ i = 2 ] whileFalse: [ b value. i := i + 1 ] ]', [escaped]),
      /frame/i,
    );
  });
});

// --- images --------------------------------------------------------------------------------------

// The protocol is found in the condition Block's image, and the body still executes in its own — both
// by the existing nested-send rule rather than by anything the loop does.
test('the condition image owns the loop, and a foreign body runs in its own image', async () => {
  await withRuntime(async (runtime) => {
    const {kernel: homeKernel} = await seed(runtime, 'home');
    await seed(runtime, 'away');
    // `tag` exists only in the away image. A body that runs under home's dispatch image could not
    // find it, so completing proves the body dispatched in its own image.
    const awayKernel = await findSmalltalkKernel({images: runtime.images, imageId: 'away'});
    await defineMethods({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'away',
      lane: 'neutral',
      classRef: awayKernel.integerClass,
      methods: [{selector: 'tag', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(7)}}}],
    });
    const body = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'away', id: 'foreign-body', source: '[ 0 tag ]',
    });

    // Home has no `tag`, which is what makes the previous assertion meaningful.
    await assert.rejects(evaluate(runtime, 'home', 'no-tag', '[ 0 tag ]'), /message not understood: tag/);

    const condition = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'home', id: 'home-condition', source: '[ :c | 1 = 2 ]',
    });
    void condition;

    // Driven from home: condition in home, body in away.
    const answer = await evaluate(
      runtime, 'home', 'cross',
      '[ :b | | i | i := 0. [ i = 3 ] whileFalse: [ b value. i := i + 1 ] ]',
      [objectRef('away', body.block.id)],
    );
    // And the answer is the *condition* image's nil, not the body image's.
    assert.deepEqual(answer, homeKernel.nil);
  });
});

// --- what must not have changed ------------------------------------------------------------------

test('the compiler recognizes no loop selector', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'shape', source: '[ [ 1 = 2 ] whileTrue: [ 3 ] ]',
    });
    const code = await runtime.images.getCodeArtifact('app', installed.semanticArtifact.id);
    const program = JSON.parse(code.content.value);
    const body = program.body?.op === 'sequence' ? program.body.expressions.at(-1) : program.body;
    assert.equal(body.op, 'send', 'whileTrue: must compile to an ordinary send');
    assert.equal(body.message.value, 'whileTrue:');
    assert.equal(body.receiver.op, 'block');
    assert.equal(body.arguments.length, 1);
    assert.equal(body.arguments[0].op, 'block');
    // No loop op anywhere in the program.
    assert.ok(!/"op"\s*:\s*"(while|loop|repeat)/.test(JSON.stringify(program)));
  });
});

test('no compiler source names a loop selector, and the dispatcher names no primitive id', async () => {
  const compilerSources = [
    'src/language/symmetric-smalltalk-compiler.js',
    'src/language/symmetric-smalltalk-semantic.js',
    'src/language/symmetric-smalltalk-parser.js',
    'src/language/symmetric-smalltalk-tokenizer.js',
  ];
  for (const path of compilerSources) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.ok(!/whileTrue|whileFalse/.test(source), `${path} must not recognize a loop selector`);
  }

  // ADR 0044 decision 9: the dispatcher learns rules, never object ids.
  const dispatcher = readFileSync(new URL('../src/language/symmetric-smalltalk-dispatcher.js', import.meta.url), 'utf8');
  assert.ok(!/smalltalk\/primitive\//.test(dispatcher), 'the dispatcher must name no primitive object id');
  for (const slot of BLOCK_PROTOCOL_SLOTS) {
    assert.ok(!dispatcher.includes(slot.blockId), `the dispatcher must not name ${slot.blockId}`);
  }
});

test('no new executable representation or Value kind is introduced', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {SMALLTALK_KERNEL_PRIMITIVE_V1} = await import('../src/language/smalltalk-primitives.js');
    for (const slot of BLOCK_PROTOCOL_SLOTS) {
      const block = await runtime.images.getBlock('app', slot.blockId);
      const code = await runtime.images.getCodeArtifact('app', `${slot.blockId}:code`);
      assert.equal(code.representation, SMALLTALK_KERNEL_PRIMITIVE_V1);
      assert.equal(JSON.parse(code.content.value).primitive, slot.primitive);
      assert.equal(block.environment, null);
    }
    // Blocks are still classless: no BlockClosure arrived with the loop.
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/BlockClosure'), null);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'still-value', '[ [ 5 ] value ]'),
      integerValue(5),
    );
  });
});

test('a Block still answers nothing else', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'other', '[ [ 1 ] printString ]'),
      /Block does not understand: printString/,
    );
    // Right selector, wrong arity: still not a loop.
    await assert.rejects(
      evaluate(runtime, 'app', 'arity', '[ [ 1 = 2 ] whileTrue ]'),
      /Block does not understand: whileTrue/,
    );
  });
});

test('booleans still dispatch as booleans inside a loop condition', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(
        runtime, 'app', 'bridge',
        '[ | i | i := 0. [ (i = 3) ifTrue: [ 1 = 2 ] ifFalse: [ 1 = 1 ] ] whileTrue: [ i := i + 1 ]. i ]',
      ),
      integerValue(3),
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'bool', '[ 1 = 1 ]'), booleanValue(true));
  });
});

// --- how the loop reaches the Blocks -------------------------------------------------------------

// Decision 5's mechanism, observed rather than inferred: the loop must reach both Blocks by ordinary
// `value` sends through the execution context. Counting the dispatches proves the shape *and* the
// N+1 relationship at the same time, and would catch an implementation that executed a Block's code
// directly (no dispatch would be recorded at all).
test('the loop reaches condition and body only by ordinary value sends', async () => {
  await withRuntime(async (runtime) => {
    const {protocol} = await seed(runtime, 'app');
    const seen = [];
    const prepareDispatch = runtime.invocations.prepareDispatch.bind(runtime.invocations);
    runtime.invocations.prepareDispatch = async (request, options) => {
      seen.push({
        selector: request.message?.value,
        receiver: request.receiver?.objectId ?? request.receiver?.kind,
      });
      return await prepareDispatch(request, options);
    };

    await evaluate(runtime, 'app', 'observed', '[ | i | i := 0. [ i = 3 ] whileFalse: [ i := i + 1 ] ]');

    const loopSends = seen.filter((entry) => entry.selector === 'whileFalse:');
    assert.equal(loopSends.length, 1, 'the loop is entered by exactly one dispatched send');

    const valueSends = seen.filter((entry) => entry.selector === 'value');
    // Four condition evaluations for three body runs, and every one of them is a dispatched send.
    assert.equal(valueSends.length, 7, `expected 4 condition + 3 body value sends, saw ${valueSends.length}`);
    const byReceiver = new Map();
    for (const entry of valueSends) byReceiver.set(entry.receiver, (byReceiver.get(entry.receiver) ?? 0) + 1);
    assert.deepEqual([...byReceiver.values()].sort(), [3, 4]);
    // The loop primitive is never itself sent `value`: it is dispatched, not applied.
    assert.ok(!valueSends.some((entry) => entry.receiver === protocol.whileFalse.objectId));
  });
});

// --- the WASM lane -------------------------------------------------------------------------------

test('a loop runs the same in the WASM lane', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app', {lane: 'wasm'});
    const source = '[ | i sum | i := 0. sum := 0. [ i = 5 ] whileFalse: [ i := i + 1. sum := sum + i ]. sum ]';

    const neutral = await evaluate(runtime, 'app', 'neutral-loop', source);
    assert.deepEqual(neutral, integerValue(15));

    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'wasm-loop', source,
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'wasm-loop-tree',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), []);
    // Both lanes agree on the same program.
    assert.deepEqual(await runtime.executor.execute(activation), neutral);
  });
});

// The loop's own result feeding a further send cannot be compiled as a tail call, so this is the
// case the resumable ABI has to carry across suspension and resumption.
test('a loop result feeding another send resumes correctly in WASM', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app', {lane: 'wasm'});
    // `answer` is defined on UndefinedObject, so sending it to the loop's nil result is a genuine
    // non-tail continuation: the loop must return before the send can be dispatched.
    await defineMethods({
      ...options,
      classRef: (await runtime.images.getObject('app', 'smalltalk/class/UndefinedObject'))
        ? objectRef('app', 'smalltalk/class/UndefinedObject')
        : kernel.objectClass,
      methods: [{
        selector: 'loopAnswer',
        program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(42)}},
      }],
    });

    const source = '[ | i | i := 0. ([ i = 3 ] whileFalse: [ i := i + 1 ]) loopAnswer ]';
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'wasm-nontail', source,
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'wasm-nontail-tree',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), []);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(42));
  });
});

// --- publication recovery ------------------------------------------------------------------------

const WRITE_METHODS = ['putCodeArtifact', 'putBlock', 'putShape', 'putObject'];

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

// Every write publishing the protocol is swept twice: interrupted before the commit, and committed
// with the acknowledgement lost. Both must leave an image a retry can complete, because a
// half-installed routing authority is the one thing discovery must never find.
test('every write publishing the Block protocol is recoverable', async () => {
  const total = await withRuntime(async (runtime) => {
    await seed(runtime, 'blank', {blockProtocol: false});
    const {images, writeCount} = faultingImages(runtime.images);
    await installSmalltalkBlockProtocol({images, imageId: 'blank'});
    return writeCount();
  });
  assert.ok(total >= 5, `expected several writes, saw ${total}`);

  for (let failAt = 1; failAt <= total; failAt += 1) {
    for (const commitThenThrow of [false, true]) {
      await withRuntime(async (runtime) => {
        await seed(runtime, 'app', {blockProtocol: false});
        const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});
        await assert.rejects(
          installSmalltalkBlockProtocol({images, imageId: 'app'}),
          /injected/,
          `write ${failAt} (${commitThenThrow ? 'lost ack' : 'pre-commit'}) should have failed`,
        );

        // A partial install must never be discoverable as a usable protocol: either the object is
        // not there yet, or it is complete and valid.
        const found = await findSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'});
        assert.ok(found === null || found.whileTrue.objectId.endsWith('block-while-true'));

        // And the retry converges rather than conflicting.
        await installSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'});
        assert.deepEqual(
          await evaluate(runtime, 'app', `recovered-${failAt}-${commitThenThrow}`,
            '[ | i | i := 0. [ i = 2 ] whileFalse: [ i := i + 1 ]. i ]'),
          integerValue(2),
        );
      });
    }
  }
});

// --- what the loop exposed -----------------------------------------------------------------------

// A characterization test, not an endorsement. ADR 0051 delivers constant *stack*, and it does — but
// removing the depth ceiling revealed that evaluating a Block that creates a closure publishes a new
// durable Block record every time. Recursion capped that at a couple of hundred before the
// activation limit stopped the program; a loop does not, so image growth is now unbounded in
// iteration count.
//
// This is pre-existing closure-identity behaviour rather than anything the loop introduced, and
// fixing it is a real design decision (deterministic per-creation-site ids? transient closures?
// collection?) rather than something to slip into this change. It is pinned here so the cost is
// measured and cannot regress unnoticed, and recorded in `docs/roadmap.md`.
test('closure-creating iterations still allocate a durable Block each time', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const source = (n) =>
      `[ | i | i := 0. [ i = ${n} ] whileFalse: [ (i = 999) ifTrue: [ 1 ] ifFalse: [ 2 ]. i := i + 1 ]. i ]`;
    const growth = async (id, n) => {
      const before = (await runtime.images.listRecords('app')).length;
      await evaluate(runtime, 'app', id, source(n));
      return (await runtime.images.listRecords('app')).length - before;
    };

    const fifty = await growth('grow-50', 50);
    const hundred = await growth('grow-100', 100);
    // Strictly linear in iteration count, and it does not converge on a re-run: these are fresh
    // records each time, not ensure-exact-or-create hits.
    assert.ok(fifty > 50, `expected per-iteration allocation, saw ${fifty} records for 50 iterations`);
    assert.ok(
      hundred > fifty * 1.8,
      `expected growth to scale with iterations, saw ${fifty} then ${hundred}`,
    );

    // The contrast that makes the cause specific: a body creating no closure allocates nothing
    // per iteration, so this is closure identity rather than looping.
    const before = (await runtime.images.listRecords('app')).length;
    await evaluate(runtime, 'app', 'flat-grow', '[ | i | i := 0. [ i = 200 ] whileFalse: [ i := i + 1 ]. i ]');
    const flat = (await runtime.images.listRecords('app')).length - before;
    assert.ok(flat < 20, `a closure-free body should allocate nothing per iteration, saw ${flat}`);
  });
});
