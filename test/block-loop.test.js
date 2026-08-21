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
  pinnedRef,
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

// Proven on its own terms rather than as an inversion of the whileTrue: fixture: its own counting,
// its own zero-iteration case, and its own answer.
test('whileFalse: is a loop in its own right', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    // Runs while the condition is false, and stops on the first true.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'wf-sense', `[ | i seen |
        i := 0. seen := 0.
        [ i = 3 ] whileFalse: [ i := i + 1. seen := seen + i ].
        seen ]`),
      integerValue(6),
    );
    // N bodies, N+1 conditions, counted independently of the whileTrue: case.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'wf-count', `[ | i conditions bodies |
        i := 0. conditions := 0. bodies := 0.
        [ conditions := conditions + 1. i = 5 ] whileFalse: [ bodies := bodies + 1. i := i + 1 ].
        (conditions + (bodies + 100)) ]`),
      integerValue(111),
    );
    // A condition already true runs the body zero times and still answers nil.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'wf-zero', `[ | runs |
        runs := 0.
        [ 1 = 1 ] whileFalse: [ runs := runs + 1 ] ]`),
      kernel.nil,
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'wf-zero-count', `[ | runs |
        runs := 0.
        [ 1 = 1 ] whileFalse: [ runs := runs + 1 ].
        runs ]`),
      integerValue(0),
    );
  });
});

test('whileTrue: runs the body zero times when its condition is false at once', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'wt-zero', `[ | runs |
        runs := 0.
        [ 1 = 2 ] whileTrue: [ runs := runs + 1 ].
        runs ]`),
      integerValue(0),
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
    // Completion alone would be satisfied by a loop that silently skipped work, so the same run
    // counts both evaluations: 10,000 bodies and the 10,001 conditions that bracket them.
    const counted = await evaluate(runtime, 'app', 'many', `[ | i conditions bodies |
      i := 0. conditions := 0. bodies := 0.
      [ conditions := conditions + 1. i = 10000 ] whileFalse: [ bodies := bodies + 1. i := i + 1 ].
      (conditions + bodies) ]`);
    assert.deepEqual(counted, integerValue(20001), '10001 conditions + 10000 bodies');

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
    // The third distinct shape: a primitive Block as the *dispatched* condition. This reaches the
    // guard by the intended route rather than by `value:`, so it is not the same case as the
    // self-application above.
    await assert.rejects(
      send(protocol.whileFalse, 'whileTrue:', [ordinaryRef]),
      /kernel-primitive Block as the condition/,
    );
    // Including a non-loop primitive, so the rule is "no kernel primitive", not "no loop primitive".
    await assert.rejects(
      send(objectRef('app', 'smalltalk/primitive/basic-new'), 'whileTrue:', [ordinaryRef]),
      /kernel-primitive Block as the condition/,
    );
    await assert.rejects(
      send(ordinaryRef, 'whileTrue:', [objectRef('app', 'smalltalk/primitive/basic-new')]),
      /kernel-primitive Block as the body/,
    );
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

// The corruption a "both slots hold loop primitives" check would wave through, and the one that
// would silently turn every whileTrue: in the image into a whileFalse:.
test('swapping the two loop primitives is refused', async () => {
  await withRuntime(async (runtime) => {
    const {protocol} = await seed(runtime, 'app');
    await rewriteObject(runtime, 'app', 'smalltalk-block-protocol/v1', (record) => ({
      ...record,
      slots: {
        'block-protocol-while-true': protocol.whileFalse,
        'block-protocol-while-false': protocol.whileTrue,
      },
    }));
    await assert.rejects(
      findSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'}),
      /slot whileTrue references the block-while-false primitive, not block-while-true/,
    );
    // The send fails rather than quietly looping with the opposite sense.
    await assert.rejects(
      evaluate(runtime, 'app', 'swapped', '[ | i | i := 0. [ i = 2 ] whileFalse: [ i := i + 1 ]. i ]'),
      /is corrupt/,
    );
  });
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
    {
      // A pinned ref is a different Value kind, not a ref with a flag: accepting one would let a
      // pinned handle stand in for the local Block the dispatcher is about to run.
      label: 'pinned slot',
      mutate: (record) => ({
        ...record,
        slots: {
          ...record.slots,
          'block-protocol-while-false': pinnedRef('app', 'smalltalk/primitive/block-while-false', 1),
        },
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
// Two states the store's own invariants make unreachable — it refuses a dangling `code` ref on
// `putBlock`, and refuses slots that disagree with the declared shape. Discovery still checks both,
// because it must not assume those invariants held for records it did not write, so they are
// exercised against a stub that can produce what the store will not.
test('a protocol slot pointing at a Block with no code artifact is refused', async () => {
  const stub = {
    getObject: async () => ({
      id: 'smalltalk-block-protocol/v1',
      shape: objectRef('app', 'smalltalk/block-protocol-shape/v1'),
      slots: {
        'block-protocol-while-true': objectRef('app', 'smalltalk/primitive/block-while-true'),
        'block-protocol-while-false': objectRef('app', 'smalltalk/primitive/block-while-false'),
      },
      metadata: {protocol: 'smalltalk-block-protocol/v1'},
    }),
    getBlock: async (imageId, objectId) => ({id: objectId, code: objectRef('app', `${objectId}:code`)}),
    getCodeArtifact: async () => null,
  };
  await assert.rejects(
    findSmalltalkBlockProtocol({images: stub, imageId: 'app'}),
    /slot whileTrue references a Block with no code artifact/,
  );
});

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

// Every deterministic identity the installer claims, squatted by a differing record. Each must be
// refused rather than overwritten: silently replacing a squatter is how a routing authority gets
// re-pointed by whoever wrote first.
test('a differing record at any installed identity is refused, never overwritten', async () => {
  const squatters = [
    {
      label: 'the protocol shape',
      plant: async (runtime) => {
        await runtime.images.putShape('app', {id: 'smalltalk/block-protocol-shape/v1', slots: [{id: 'x', name: 'x'}]});
      },
      survives: async (runtime) => {
        const shape = await runtime.images.getShape('app', 'smalltalk/block-protocol-shape/v1');
        assert.deepEqual(shape.slots, [{id: 'x', name: 'x'}], 'the squatting shape is untouched');
      },
    },
    {
      label: 'a primitive code artifact',
      plant: async (runtime) => {
        await runtime.images.putCodeArtifact('app', {
          id: 'smalltalk/primitive/block-while-true:code',
          languageId: SYMMETRIC_SMALLTALK_ID,
          representation: 'smalltalk-kernel-primitive/v1',
          content: textValue(JSON.stringify({primitive: 'basic-new'})),
          metadata: {},
        });
      },
      survives: async (runtime) => {
        const code = await runtime.images.getCodeArtifact('app', 'smalltalk/primitive/block-while-true:code');
        assert.equal(JSON.parse(code.content.value).primitive, 'basic-new', 'the squatting artifact is untouched');
      },
    },
    {
      label: 'a primitive Block',
      plant: async (runtime) => {
        const code = await runtime.images.putCodeArtifact('app', {
          id: 'squatter:code',
          languageId: SYMMETRIC_SMALLTALK_ID,
          representation: 'smalltalk-kernel-primitive/v1',
          content: textValue(JSON.stringify({primitive: 'class-of'})),
          metadata: {},
        });
        await runtime.images.putBlock('app', {
          id: 'smalltalk/primitive/block-while-false',
          code: objectRef('app', code.id),
          environment: null,
          metadata: {},
        });
      },
      survives: async (runtime) => {
        const block = await runtime.images.getBlock('app', 'smalltalk/primitive/block-while-false');
        assert.equal(block.code.objectId, 'squatter:code', 'the squatting Block is untouched');
      },
    },
  ];

  for (const {label, plant, survives} of squatters) {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {blockProtocol: false});
      await plant(runtime);
      await assert.rejects(
        installSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'}),
        /already exists and differs/,
        `expected a differing record at ${label} to be refused`,
      );
      await survives(runtime);
    });
  }
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

// The execution-time proof, not just the no-capture one: repoint `kernel-nil` *after* the protocol
// is installed and the loop must answer the new object.
//
// The fixture has to avoid every message send, because nil is also the method dictionary's
// empty-bucket marker — a loop whose condition sends `=` would fail on a corrupt dictionary before
// reaching the answer. A condition that is simply a captured argument sends nothing at all.
test('the answered nil is fetched from the kernel at execution time', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const loop = (id) => evaluate(runtime, 'app', id, '[ :keepGoing | [ keepGoing ] whileTrue: [ 1 ] ]', [
      booleanValue(false),
    ]);
    assert.deepEqual(await loop('nil-before'), kernel.nil);

    const replacement = objectRef('app', (await runtime.images.putObject('app', {
      id: 'smalltalk/other-nil',
      shape: objectRef('app', 'smalltalk/empty-shape/v1'),
      behavior: null,
      slots: {},
      metadata: {},
    }, {expectedVersion: 0})).id);
    await rewriteObject(runtime, 'app', 'smalltalk-kernel/v1', (record) => ({
      ...record, slots: {...record.slots, 'kernel-nil': replacement},
    }));

    // Same primitive, same installed records, different answer: the nil is looked up per execution.
    assert.deepEqual(await loop('nil-after'), replacement);
    assert.notDeepEqual(replacement, kernel.nil);
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

// ADR 0050 decision 5a rule 4, and the case the loop makes newly reachable: the loop primitive
// inherits the caller's frame, so if that frame leaked to the body an arbitrary Block would act on
// the calling method's `self`. The adversarial shape is a closure belonging to one instance driven
// by a loop inside a *different* instance's method: it must bump its creator, never its driver.
test('a body driven by a loop acts on its creator self, never the loop callers', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    const counter = await counterClass(runtime, 'app', options);
    await defineMethodsFromSource({
      ...options,
      classRef: counter.classRef,
      // A method whose own `self` is the driver, looping over someone else's Block.
      methods: [{
        selector: 'driveTwice:',
        source: '[ :body | | i | i := 0. [ i = 2 ] whileFalse: [ body value. i := i + 1 ]. n ]',
      }],
    });

    const result = await evaluate(runtime, 'app', 'cross-self', `[ :c | | owner driver drivenN |
      owner := c new. owner init.
      driver := c new. driver init.
      drivenN := driver driveTwice: (owner bumper).
      (owner n) + (drivenN + 100) ]`, [counter.classRef]);

    // owner n = 2 (bumped twice), driver n = 0 (never touched): 2 + 0 + 100.
    assert.deepEqual(result, integerValue(102),
      'the body bumped its creator, and the loop callers own n stayed untouched');
  });
});

// --- images --------------------------------------------------------------------------------------

// The protocol is found in the condition Block's image, and the body still executes in its own —
// both by the existing nested-send rule rather than by anything the loop does. Proven semantically:
// each image answers the same selector differently, so the outcome names which image ran the code.

const literalMethod = (selector, value) => ({
  selector,
  program: {parameters: [], captures: [], body: {op: 'literal', value}},
});

test('the condition Block image owns the loop, semantically', async () => {
  await withRuntime(async (runtime) => {
    const {kernel: homeKernel} = await seed(runtime, 'home');
    const {kernel: awayKernel} = await seed(runtime, 'away');

    // The same selector, opposite answers. A condition evaluated in the wrong image would not merely
    // give a different result — answering true in `home` would never terminate.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'away', lane: 'neutral',
      classRef: awayKernel.integerClass, methods: [literalMethod('keepGoing', booleanValue(false))],
    });
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'home', lane: 'neutral',
      classRef: homeKernel.integerClass, methods: [literalMethod('keepGoing', booleanValue(true))],
    });

    const condition = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'away', id: 'away-condition', source: '[ 0 keepGoing ]',
    });
    const body = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'home', id: 'home-body', source: '[ 1 ]',
    });

    // Dispatched with `home` as the ambient dispatch image, so only the receiver's own image can be
    // what selects the protocol and the condition's meaning.
    const dispatched = await runtime.invocations.prepareDispatch({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: objectRef('away', condition.block.id),
      message: textValue('whileTrue:'),
      arguments: [objectRef('home', body.block.id)],
    }, {dispatchImage: 'home'});
    const answer = await runtime.executor.execute(dispatched.activation, {
      dispatchImage: 'home', invocationFrame: dispatched.frame,
    });

    // Terminating at all proves the condition answered away's `false`; the answer proves the loop
    // took its nil from the condition image rather than the ambient one.
    assert.deepEqual(answer, awayKernel.nil);
    assert.notDeepEqual(awayKernel.nil, homeKernel.nil);
  });
});

test('a body in another image runs against that image own methods', async () => {
  await withRuntime(async (runtime) => {
    const {kernel: homeKernel, options: homeOptions} = await seed(runtime, 'home');
    const {kernel: awayKernel} = await seed(runtime, 'away');

    // `tag` exists in both images and answers differently, so the recorded value names the image the
    // body actually dispatched in.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'away', lane: 'neutral',
      classRef: awayKernel.integerClass, methods: [literalMethod('tag', integerValue(7))],
    });
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'home', lane: 'neutral',
      classRef: homeKernel.integerClass, methods: [literalMethod('tag', integerValue(1))],
    });

    const shape = objectRef('home', (await runtime.images.putShape('home', {
      id: 'recorder-shape', slots: [{id: 'seen-slot', name: 'seen'}],
    })).id);
    const recorder = await defineClass({images: runtime.images, imageId: 'home', name: 'Recorder', instanceShapeRef: shape});
    await defineMethodsFromSource({
      ...homeOptions,
      classRef: recorder.classRef,
      methods: [
        {selector: 'record:', source: '[ :v | seen := v. self ]'},
        {selector: 'seen', source: '[ seen ]'},
      ],
    });
    const instance = await evaluate(runtime, 'home', 'rec', '[ :c | c new ]', [recorder.classRef]);

    // The body lives in `away` and captures the `home` recorder: the object send goes home, the
    // immediate send stays away, which is exactly the rule under test.
    // `captures` declares name -> stable binding id; the *value* is bound by the block's lexical
    // environment, which is what makes a capture image-independent until it is installed.
    await runtime.images.putLexicalEnvironment('away', {
      id: 'away-body-env',
      bindings: {'away:recorder': {name: 'recorder', value: instance}},
    });
    const body = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'away',
      id: 'away-body',
      source: '[ recorder record: 0 tag ]',
      captures: {recorder: 'away:recorder'},
      environment: objectRef('away', 'away-body-env'),
    });

    await evaluate(runtime, 'home', 'drive-foreign',
      '[ :b | | i | i := 0. [ i = 1 ] whileFalse: [ b value. i := i + 1 ] ]',
      [objectRef('away', body.block.id)]);

    assert.deepEqual(
      await evaluate(runtime, 'home', 'read-rec', '[ :r | r seen ]', [instance]),
      integerValue(7),
      'the body used away tag, not home tag',
    );
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
// case the resumable ABI has to carry across suspension and resumption: the loop must fully return
// before `class` can be dispatched on its answer.
test('a loop result feeding another send resumes correctly in WASM', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app', {lane: 'wasm'});
    const source = '[ | i | i := 0. ([ i = 3 ] whileFalse: [ i := i + 1 ]) class ]';

    const neutral = await evaluate(runtime, 'app', 'nontail-neutral', source);
    assert.deepEqual(neutral, objectRef('app', 'smalltalk/class/UndefinedObject'),
      'the loop answers nil, whose class is UndefinedObject');

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
    assert.deepEqual(await runtime.executor.execute(activation), neutral,
      'both lanes agree, and the WASM lane resumed after the loop returned');
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
test('exhaustive-recovery: every write publishing the Block protocol', async () => {
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

// --- what the loop exposed, and ADR 0052 closed -------------------------------------------------

// This was a characterization test: it pinned the cost of ADR 0051 removing the depth ceiling, which
// exposed that every closure evaluation published a durable Block. ADR 0052 made closure instances
// execution-local, so the same shapes now allocate nothing, and the assertion is inverted.
test('closure-creating iterations allocate no durable records', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const source = (n) =>
      `[ | i | i := 0. [ i = ${n} ] whileFalse: [ (i = 999) ifTrue: [ 1 ] ifFalse: [ 2 ]. i := i + 1 ]. i ]`;
    const growth = async (id, n) => {
      const before = (await runtime.images.listRecords('app')).length;
      await evaluate(runtime, 'app', id, source(n));
      return (await runtime.images.listRecords('app')).length - before;
    };

    // The published prototypes for the source are the only writes, so growth does not scale with
    // iteration count — it is the same for fifty iterations and for a thousand.
    const fifty = await growth('grow-50', 50);
    const thousand = await growth('grow-1000', 1000);
    assert.equal(fifty, thousand,
      `iteration count must not affect durable growth: ${fifty} at 50, ${thousand} at 1000`);
    assert.ok(thousand < 20, `expected O(1) records, saw ${thousand}`);
  });
});
