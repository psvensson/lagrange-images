import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService,
  booleanValue,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkControlFlow,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {SYMMETRIC_SMALLTALK_ID} from '../src/language/symmetric-smalltalk.js';
import {SmalltalkMethodRedefinitionError, methodBlockRef} from '../src/language/smalltalk-class-builder.js';

// ADR 0045: a boolean Value bridges to the dispatch image's `true`/`false` singleton for the
// duration of one send, and the conditional it answers is an ordinary method on True or False.
//
// The three things worth keeping in view while reading this file:
//
//   the Value never changes      a boolean goes in and the same boolean comes out
//   the receiver really changes  `self` inside True's protocol is the true *object*
//   the compiler learns nothing  a conditional is a send in the semantic artifact

async function withRuntime(body, options = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, ...options});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seed(runtime, imageId, {lane = 'neutral', controlFlow = true} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  if (controlFlow) {
    await installSmalltalkControlFlow({
      images: runtime.images, compilation: runtime.compilation, imageId, lane,
    });
  }
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// The caller compiled to WASM rather than to the neutral executor, which is what puts a *non-tail*
// send in reach: the conditional's result feeds a further send, so the effect cannot be a tail call.
async function evaluateThroughWasm(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const tree = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef(imageId, installed.semanticArtifact.id),
    id: `${id}:wasm-tree`,
  });
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, tree.block.id), args);
  return await runtime.executor.execute(activation);
}

const PLUS = {
  selector: '+',
  program: {
    parameters: [{id: 'plus:arg', name: 'aNumber'}],
    captures: [],
    body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}},
  },
};

// Every conditional, both answers, in both lanes. The methods are derived independently per lane
// from the same semantic definition, so this is two derivations proven — not one Block called twice.
for (const lane of ['neutral', 'wasm']) {
  test(`the conditional protocol answers correctly through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      const kernel = await seed(runtime, 'app', {lane});
      const cases = [
        ["[ :f | f ifTrue: [ 'yes' ] ifFalse: [ 'no' ] ]", textValue('yes'), textValue('no')],
        ["[ :f | f ifFalse: [ 'no' ] ifTrue: [ 'yes' ] ]", textValue('yes'), textValue('no')],
        ["[ :f | f ifTrue: [ 'yes' ] ]", textValue('yes'), kernel.nil],
        ["[ :f | f ifFalse: [ 'no' ] ]", kernel.nil, textValue('no')],
      ];
      for (const [index, [source, whenTrue, whenFalse]] of cases.entries()) {
        assert.deepEqual(
          await evaluate(runtime, 'app', `${lane}-true-${index}`, source, [booleanValue(true)]),
          whenTrue,
          `${source} with true, ${lane} lane`,
        );
        assert.deepEqual(
          await evaluate(runtime, 'app', `${lane}-false-${index}`, source, [booleanValue(false)]),
          whenFalse,
          `${source} with false, ${lane} lane`,
        );
      }
    });
  });
}

// The case a tail-only proof misses entirely: the conditional's result is consumed by a further
// send, so the WASM lane cannot compile the block invocation as a tail call and the resumable ABI
// has to carry it across the suspension.
test('a conditional whose result feeds another send runs as a non-tail WASM effect', async () => {
  for (const lane of ['neutral', 'wasm']) {
    await withRuntime(async (runtime) => {
      const kernel = await seed(runtime, 'app', {lane});
      await defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [PLUS], lane,
      });
      const source = '[ :f | (f ifTrue: [ 1 ] ifFalse: [ 2 ]) + 10 ]';
      assert.deepEqual(
        await evaluateThroughWasm(runtime, 'app', `nontail-true-${lane}`, source, [booleanValue(true)]),
        integerValue(11),
      );
      assert.deepEqual(
        await evaluateThroughWasm(runtime, 'app', `nontail-false-${lane}`, source, [booleanValue(false)]),
        integerValue(12),
      );
    });
  }
});

// Decision 3, and the reason the bridge is built rather than faked: a class chosen from a kind would
// answer the same conditionals while leaving `self` a boolean Value.
test('self inside True and False protocol is the singleton object', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const trueClass = (await runtime.images.getObject('app', kernel.true.objectId)).behavior;
    const falseClass = (await runtime.images.getObject('app', kernel.false.objectId)).behavior;
    const whoAmI = {selector: 'whoAmI', program: {parameters: [], captures: [], body: {op: 'receiver'}}};
    for (const classRef of [trueClass, falseClass]) {
      await defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef, methods: [whoAmI],
      });
    }

    assert.deepEqual(
      await evaluate(runtime, 'app', 'self-true', '[ :f | f whoAmI ]', [booleanValue(true)]),
      kernel.true,
      'self must be the true object, not the boolean Value that was sent to',
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'self-false', '[ :f | f whoAmI ]', [booleanValue(false)]),
      kernel.false,
    );
    assert.notDeepEqual(kernel.true, kernel.false);
  });
});

// Decision 1. The bridge is a receiver nomination for one send; it is not a conversion, so the Value
// the caller passed is the Value the caller gets back.
test('a boolean Value passes through a conditional unchanged', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    for (const flag of [true, false]) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `roundtrip-${flag}`, '[ :f | f ifTrue: [ f ] ifFalse: [ f ] ]', [booleanValue(flag)]),
        booleanValue(flag),
        'the boolean must survive being sent to, with no boxing and no singleton substitution',
      );
    }
  });
});

// Decision 8. Boolean does not become unreachable — it is where shared boolean protocol belongs, and
// True/False inherit from it.
test('a method on Boolean is reached from a boolean Value, and True can override it', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.booleanClass,
      methods: [{selector: 'label', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('from Boolean')}}}],
    });
    for (const flag of [true, false]) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `boolean-label-${flag}`, '[ :f | f label ]', [booleanValue(flag)]),
        textValue('from Boolean'),
      );
    }

    const trueClass = (await runtime.images.getObject('app', kernel.true.objectId)).behavior;
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: trueClass,
      methods: [{selector: 'label', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('from True')}}}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'true-label', '[ :f | f label ]', [booleanValue(true)]),
      textValue('from True'),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'false-label', '[ :f | f label ]', [booleanValue(false)]),
      textValue('from Boolean'),
      'overriding on True must not affect false',
    );
  });
});

// The singleton is an ordinary object, so it answers the same protocol with no bridge involved. If
// these two paths could diverge, `self` would not really be the object.
test('the true object answers the same conditionals as the boolean Value', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const source = "[ :f | f ifTrue: [ 'yes' ] ifFalse: [ 'no' ] ]";
    assert.deepEqual(await evaluate(runtime, 'app', 'ref-true', source, [kernel.true]), textValue('yes'));
    assert.deepEqual(await evaluate(runtime, 'app', 'ref-false', source, [kernel.false]), textValue('no'));
  });
});

// Decision 4. The compiler has no conditional selector; if it ever grows one, this is what notices.
test('a source conditional compiles to a send, never to the if op', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'shape',
      source: "[ :f | f ifTrue: [ 1 ] ifFalse: [ 2 ] ]",
    });
    const semantic = await runtime.images.getCodeArtifact('app', installed.semanticArtifact.id);
    const program = JSON.parse(semantic.content.value);
    assert.equal(program.body.op, 'send');
    assert.equal(program.body.message.value, 'ifTrue:ifFalse:');
    assert.doesNotMatch(semantic.content.value, /"op":"if"/, 'the front end must not emit the if op');
  });
});

// Decision 5. The lower-level primitive keeps working for everything that is not a Symmetric
// Smalltalk source conditional, and keeps consuming a boolean Value.
test('the if op still branches on a canonical boolean Value', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const code = await runtime.images.putCodeArtifact('app', {
      id: 'raw-if',
      languageId: 'some-other-language',
      representation: 'neutral-expression/v0',
      content: textValue(JSON.stringify({
        parameters: 1,
        body: {
          op: 'if',
          condition: {op: 'argument', index: 0},
          then: {op: 'literal', value: textValue('branched true')},
          else: {op: 'literal', value: textValue('branched false')},
        },
      })),
    });
    const block = await runtime.images.putBlock('app', {id: 'raw-if-block', code: objectRef('app', code.id)});
    const activation = await runtime.invocations.invokeBlock(objectRef('app', block.id), [booleanValue(true)]);
    assert.deepEqual(await runtime.executor.execute(activation), textValue('branched true'));
  });
});

// Decision 2's boundary. The bridge belongs to one dispatcher, so a personality sharing the image
// still receives the canonical Value.
test('another language personality receives the boolean Value, not a singleton', async () => {
  const identity = {
    async resolveMessage() {
      return {block: objectRef('app', 'identity-block')};
    },
  };
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const code = await runtime.images.putCodeArtifact('app', {
      id: 'identity-code',
      languageId: 'other-language',
      representation: 'neutral-expression/v0',
      content: textValue(JSON.stringify({parameters: 0, body: {op: 'receiver'}})),
    });
    await runtime.images.putBlock('app', {id: 'identity-block', code: objectRef('app', code.id)});

    const activation = await runtime.invocations.sendMessage({
      languageId: 'other-language',
      receiver: booleanValue(true),
      message: textValue('anything'),
    }, {dispatchImage: 'app'});
    assert.deepEqual(
      await runtime.executor.execute(activation),
      booleanValue(true),
      'the bridge is Symmetric-Smalltalk-specific; another personality sees the boolean',
    );
  }, {dispatchers: {'other-language': identity}});
});

test('a boolean send in an image with no kernel still fails as a missing kernel', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'bare'});
    await assert.rejects(
      evaluate(runtime, 'bare', 'no-kernel', '[ :f | f ifTrue: [ 1 ] ]', [booleanValue(true)]),
      (error) => error.name === 'SmalltalkKernelMissingError',
    );
  });
});

// The failure has to name what actually failed to understand the selector. Reporting the boolean
// would say `undefined/undefined`, and reporting "a boolean Value" would hide which singleton it was.
test('a selector missing on True names the singleton in the failure', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'missing', '[ :f | f nope ]', [booleanValue(true)]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError'
        && /app\/smalltalk\/true/.test(error.message),
    );
  });
});

// Decision 7's constraints, at the seam itself rather than through the language.
test('a dispatch resolution may only nominate an unpinned object ref as effective receiver', async () => {
  const resolutionsThatMustFail = {
    'immediate value': {block: objectRef('app', 'identity-block'), effectiveReceiver: integerValue(1)},
    'explicit null': {block: objectRef('app', 'identity-block'), effectiveReceiver: null},
    'unknown key': {block: objectRef('app', 'identity-block'), receiver: objectRef('app', 'smalltalk/true')},
  };
  for (const [label, resolution] of Object.entries(resolutionsThatMustFail)) {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app');
      await assert.rejects(
        runtime.invocations.sendMessage({
          languageId: 'other-language',
          receiver: booleanValue(true),
          message: textValue('anything'),
        }, {dispatchImage: 'app'}),
        /effectiveReceiver|must contain block/,
        `${label} must be refused`,
      );
    }, {dispatchers: {'other-language': {async resolveMessage() { return resolution; }}}});
  }
});

// A Symmetric Smalltalk send that needs no bridge must still produce the plain `{block}` resolution,
// so the new key stays absent for every send in the substrate that does not use it.
test('an ordinary send resolves without an effectiveReceiver key', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [PLUS],
    });
    const dispatcher = runtime.dispatchers.get(SYMMETRIC_SMALLTALK_ID);
    const resolved = await dispatcher.resolveMessage({
      kind: 'message-send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: integerValue(3),
      message: textValue('+'),
      arguments: [integerValue(4)],
    }, {images: runtime.images, dispatchImage: 'app'});
    // ADR 0050 adds a frame to a *method* resolution; what must stay absent for an ordinary send is
    // the effectiveReceiver key, which is what this test is about.
    assert.equal(Object.hasOwn(resolved, 'effectiveReceiver'), false);
    assert.deepEqual(resolved.frame.definingBehavior, kernel.integerClass, 'the defining Behavior travels with the resolution');
    assert.deepEqual(resolved.frame.self, integerValue(3));

    const bridged = await dispatcher.resolveMessage({
      kind: 'message-send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: booleanValue(true),
      message: textValue('ifTrue:'),
      arguments: [objectRef('app', 'anything')],
    }, {images: runtime.images, dispatchImage: 'app'});
    assert.deepEqual(bridged.effectiveReceiver, kernel.true);
  });
});

// The nil arm is a captured ref in the Block's own environment, not an operation in the common IR.
test('a nil-answering method carries nil as an ordinary captured binding', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const falseClass = (await runtime.images.getObject('app', kernel.false.objectId)).behavior;
    const ref = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: falseClass, selector: 'ifTrue:',
    });
    const method = await runtime.images.getBlock('app', ref.objectId);

    assert.ok(method.environment, 'the nil arm must carry a lexical environment');
    const environment = await runtime.images.getLexicalEnvironment(
      method.environment.imageId, method.environment.objectId,
    );
    assert.deepEqual(environment.bindings['smalltalk/control-flow/nil'], {name: 'nil', value: kernel.nil});

    const semantic = await runtime.images.getCodeArtifact('app', `${method.id}:semantic`);
    assert.doesNotMatch(semantic.content.value, /"op":"nil"/, 'nil must not become an IR operation');
  });
});

// A conditional arm is a Block invoked through `value`, so it is a separate activation with its own
// frame. ADR 0043's cells and ADR 0044 decision 8's nil-initialized temporaries meet ADR 0045 here
// for the first time: the outer frame's cell must be the one the arm writes, and an unassigned
// temporary read from inside an arm must still be nil.
test('a conditional arm shares the enclosing frame cells and sees nil temporaries', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'arm-assign', '[ :f | | n | f ifTrue: [ n := 7 ] ifFalse: [ n := 9 ]. n ]', [booleanValue(true)]),
      integerValue(7),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'arm-assign-false', '[ :f | | n | f ifTrue: [ n := 7 ] ifFalse: [ n := 9 ]. n ]', [booleanValue(false)]),
      integerValue(9),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'arm-nil-temp', '[ :f | | n | f ifTrue: [ n ] ifFalse: [ 0 ] ]', [booleanValue(true)]),
      kernel.nil,
    );
  });
});

// Matching capture counts is not matching bindings: an environment is keyed by capture id, so two
// captures sharing one would collapse into a single binding and silently drop a value — and in the
// WASM lane two distinct parameter positions would resolve to the same binding. `createClosure`
// already refuses this for a closure.
test('a method declaring two captures with one id is refused', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass,
        methods: [{
          selector: 'confused',
          program: {
            parameters: [],
            captures: [{id: 'dup', name: 'a'}, {id: 'dup', name: 'b'}],
            body: {op: 'binding', id: 'dup'},
          },
          captures: [
            {id: 'dup', name: 'a', value: kernel.nil},
            {id: 'dup', name: 'b', value: kernel.true},
          ],
        }],
      }),
      /duplicate capture id: dup/,
    );
    assert.equal(
      await runtime.images.getCodeArtifact('app', `${kernel.integerClass.objectId}/method/Y29uZnVzZWQ:semantic`),
      null,
      'a refused method must leave nothing behind',
    );
  });
});

// The method environment is durable state at a deterministic id, so it is held to the same exactness
// standard as an object, a Block or a CodeArtifact: `metadata` is part of the record, and an
// environment matching only in its bindings is a different environment. Comparing bindings alone
// would let a squatter be adopted as this method's environment.
test('an environment with the right bindings but foreign metadata is refused, not adopted', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const methodObjectId = `${kernel.integerClass.objectId}/method/YW5zd2VyTmls`;
    await runtime.images.putLexicalEnvironment('app', {
      id: `${methodObjectId}:environment`,
      bindings: {'nil/capture': {name: 'nil', value: kernel.nil}},
      metadata: {planted: 'by something else'},
    });

    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass,
        methods: [{
          selector: 'answerNil',
          program: {
            parameters: [],
            captures: [{id: 'nil/capture', name: 'nil'}],
            body: {op: 'binding', id: 'nil/capture'},
          },
          captures: [{id: 'nil/capture', name: 'nil', value: kernel.nil}],
        }],
      }),
      (error) => error.name === 'SmalltalkKernelConflictError' && /lexical environment/.test(error.message),
    );

    // Refused means overwritten nothing: the planted record is exactly as it was.
    const environment = await runtime.images.getLexicalEnvironment('app', `${methodObjectId}:environment`);
    assert.deepEqual(environment.metadata, {planted: 'by something else'});
  });
});

// The lost-acknowledgement check decides that an already-published selector is *this* definition, so
// it has to compare the environment this definition would write — not merely an environment whose
// bindings happen to match. Metadata drift on the stored record must break that identity.
test('a method whose stored environment metadata drifted is not treated as already installed', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const method = {
      selector: 'answerNil',
      program: {
        parameters: [],
        captures: [{id: 'nil/capture', name: 'nil'}],
        body: {op: 'binding', id: 'nil/capture'},
      },
      captures: [{id: 'nil/capture', name: 'nil', value: kernel.nil}],
    };
    const define = () => defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass, methods: [method],
    });
    await define();
    // An identical redefinition is an idempotent success while the graph still matches.
    await define();

    const environmentId = `${kernel.integerClass.objectId}/method/YW5zd2VyTmls:environment`;
    const stored = await runtime.images.getLexicalEnvironment('app', environmentId);
    await runtime.images.putLexicalEnvironment('app', {
      id: environmentId,
      bindings: stored.bindings,
      metadata: {smalltalk: 'something-else'},
    }, {expectedVersion: stored._version});

    await assert.rejects(
      define(),
      (error) => error instanceof SmalltalkMethodRedefinitionError,
      'a drifted environment must not pass as this method being already installed',
    );
  });
});

// The mirror case: a capture-free method carries no environment at all. Accepting any empty
// environment as equivalent to none would let two different Blocks count as the same method.
test('a capture-free method with a planted empty environment is not already installed', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const selector = 'marker';
    const methodObjectId = `${kernel.integerClass.objectId}/method/${Buffer.from(selector, 'utf8').toString('base64url')}`;
    const program = {parameters: [], captures: [], body: {op: 'literal', value: textValue('planted')}};

    // Forge everything the lost-acknowledgement check looks at — the semantic artifact, a Block with
    // the right lane metadata, and a dictionary entry pointing at it — except that the Block carries
    // an empty environment where a capture-free method must carry none.
    const empty = await runtime.images.putLexicalEnvironment('app', {id: 'planted-empty-env', bindings: {}});
    await runtime.images.putCodeArtifact('app', {
      id: `${methodObjectId}:semantic`,
      languageId: 'symmetric-smalltalk/v0',
      representation: 'lagrange-code/v0',
      content: textValue(JSON.stringify(program)),
    });
    const code = await runtime.images.putCodeArtifact('app', {
      id: 'planted-code',
      representation: 'neutral-expression/v0',
      content: textValue(JSON.stringify({parameters: 0, body: {op: 'literal', value: textValue('planted')}})),
    });
    await runtime.images.putBlock('app', {
      id: methodObjectId,
      code: objectRef('app', code.id),
      environment: objectRef('app', empty.id),
      metadata: {smalltalk: 'method', selector, lane: 'neutral'},
    });
    const slotId = `selector:${Buffer.from(selector, 'utf8').toString('base64url')}`;
    const shape = await runtime.images.putShape('app', {id: 'planted-shape', slots: [{id: slotId, name: selector}]});
    const dictionary = await runtime.images.getObject('app', `${kernel.integerClass.objectId}/methods`);
    await runtime.images.putObject('app', {
      id: dictionary.id,
      shape: objectRef('app', shape.id),
      slots: {[slotId]: objectRef('app', methodObjectId)},
      metadata: dictionary.metadata,
    }, {expectedVersion: dictionary._version});

    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass, methods: [{selector, program}],
      }),
      (error) => error instanceof SmalltalkMethodRedefinitionError,
      'an empty environment is not the same as no environment',
    );
  });
});

// Installing is idempotent, and installing twice must not attempt to redefine what is already there.
test('installing the control-flow protocol twice changes nothing', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const before = await runtime.images.getObject('app', 'smalltalk/class/True/methods');
    await installSmalltalkControlFlow({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
    });
    const after = await runtime.images.getObject('app', 'smalltalk/class/True/methods');
    assert.equal(after._version, before._version);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'after-reinstall', "[ :f | f ifTrue: [ 'yes' ] ]", [booleanValue(true)]),
      textValue('yes'),
    );
  });
});

// Decision 9: the kernel bootstrap creates identity, not protocol.
test('a kernel without the control-flow protocol fails as message-not-understood', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app', {controlFlow: false});
    await assert.rejects(
      evaluate(runtime, 'app', 'no-protocol', '[ :f | f ifTrue: [ 1 ] ]', [booleanValue(true)]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError',
    );
  });
});

// --- ADR 0056: the Boolean protocol --------------------------------------------------------------

// `not`, `and:` and `or:` are ordinary methods through the same bridge as the conditionals, derived
// independently per lane from one semantic definition — so this is two derivations proven, not one
// Block called twice.
for (const lane of ['neutral', 'wasm']) {
  test(`not, and: and or: answer correctly through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      const cases = [
        ['true not', false], ['false not', true],
        ['true and: [ true ]', true], ['true and: [ false ]', false],
        ['false and: [ true ]', false], ['false and: [ false ]', false],
        ['true or: [ true ]', true], ['true or: [ false ]', true],
        ['false or: [ true ]', true], ['false or: [ false ]', false],
      ];
      for (const [expression, expected] of cases) {
        assert.deepEqual(
          await evaluate(runtime, 'app', `bool-${lane}-${expression}`, `[ ${expression} ]`),
          booleanValue(expected),
          expression,
        );
      }
    });
  });

  // Laziness is the reason these are methods on True and False rather than eager operators, so it is
  // proven by observation: the skipped Block must not run at all.
  test(`and: and or: short-circuit through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      const kernel = await seed(runtime, 'app', {lane});
      await defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane,
        classRef: kernel.integerClass, methods: [PLUS],
      });

      // The skipped arm would set the counter; the answer carries it out.
      assert.deepEqual(
        await evaluate(runtime, 'app', `lazy-and-${lane}`,
          '[ | ran | ran := 0. false and: [ ran := 1. true ]. ran ]'),
        integerValue(0),
        'false and: must not evaluate its Block',
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `lazy-or-${lane}`,
          '[ | ran | ran := 0. true or: [ ran := 1. false ]. ran ]'),
        integerValue(0),
        'true or: must not evaluate its Block',
      );
      // And an evaluated Block runs exactly once, not zero or twice.
      assert.deepEqual(
        await evaluate(runtime, 'app', `once-and-${lane}`,
          '[ | ran | ran := 0. true and: [ ran := ran + 1. true ]. ran ]'),
        integerValue(1),
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `once-or-${lane}`,
          '[ | ran | ran := 0. false or: [ ran := ran + 1. true ]. ran ]'),
        integerValue(1),
      );
    });
  });
}

test('the Boolean protocol composes as a non-tail WASM effect', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app', {lane: 'wasm'});
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm',
      classRef: kernel.integerClass, methods: [PLUS],
    });
    // The `and:` result feeds a further send, so it cannot compile as a tail call.
    assert.deepEqual(
      await evaluateThroughWasm(runtime, 'app', 'bool-nontail',
        '[ ((true and: [ false ]) not) ifTrue: [ 7 ] ifFalse: [ 8 ] ]'),
      integerValue(7),
    );
  });
});

test('and: answers its evaluated Block value as-is, with no re-boxing', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // The Block answers a canonical boolean, and that exact Value comes back — no second
    // conversion step, and no singleton substituted for it.
    const answer = await evaluate(runtime, 'app', 'and-value', '[ true and: [ false ] ]');
    assert.deepEqual(answer, booleanValue(false));
    assert.equal(answer.kind, 'boolean', 'the answer must stay a canonical boolean Value');
  });
});

test('not, and: and or: compile to ordinary sends, and the compiler knows no selector', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'bool-shape', source: '[ true and: [ false not ] ]',
    });
    const program = JSON.parse(
      (await runtime.images.getCodeArtifact('app', installed.semanticArtifact.id)).content.value,
    );
    const json = JSON.stringify(program);
    assert.match(json, /"message":\{"kind":"text","value":"and:"\}/);
    assert.match(json, /"message":\{"kind":"text","value":"not"\}/);
    assert.ok(!/"op":"(not|and|or)"/.test(json), 'lagrange-code must gain no boolean operation');

    const {readFileSync} = await import('node:fs');
    for (const path of ['src/language/symmetric-smalltalk-semantic.js', 'src/language/symmetric-smalltalk-parser.js']) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      assert.ok(!/'and:'|'or:'|'not'/.test(source), `${path} must recognize no boolean selector`);
    }
  });
});

// The control-flow installer now publishes seven selectors per singleton rather than four, so it
// joins the exhaustive sweeps rather than being trusted to be idempotent.
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

const servicesFor = (images) => new CompilationService({
  images,
  compilers: createDefaultCodeCompilerRegistry(),
  groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
});

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write publishing the ${lane} Boolean protocol`, async () => {
    const total = await withRuntime(async (runtime) => {
      await runtime.images.createImage({id: 'count'});
      await installSmalltalkKernel({images: runtime.images, imageId: 'count'});
      const {images, writeCount} = faultingImages(runtime.images);
      await installSmalltalkControlFlow({
        images, compilation: servicesFor(images), imageId: 'count', lane,
      });
      return writeCount();
    });
    assert.ok(total > 10, `expected many writes across seven selectors and two singletons, saw ${total}`);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      for (const commitThenThrow of [false, true]) {
        await withRuntime(async (runtime) => {
          await runtime.images.createImage({id: 'app'});
          await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
          const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});

          await assert.rejects(
            installSmalltalkControlFlow({images, compilation: servicesFor(images), imageId: 'app', lane}),
            /injected/,
            `${lane} write ${failAt} (${commitThenThrow ? 'lost ack' : 'pre-commit'}) should have failed`,
          );

          // Retried with clean services, then exercised: converging on records is not the claim.
          await installSmalltalkControlFlow({
            images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane,
          });
          assert.deepEqual(
            await evaluate(runtime, 'app', `rec-${lane}-${failAt}-${commitThenThrow}`,
              '[ (true and: [ false ]) not ]'),
            booleanValue(true),
          );
        });
      }
    }
  });
}
