import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEUTRAL_EXPRESSION_V0,
  WASM_FUNCTION_V1,
  WASM_MODULE_V1,
  createRuntime,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {NEUTRAL_EXPRESSION_V1} from '../src/execution/executor.js';
import {compileResumableWasmV2Module} from '../src/wasm/resumable-compiler-v2.js';

const ABI = 'lagrange-value-handle-resumable/v2';

// The proofs that separate a live cell from a saved Value handle. Each program suspends on a host
// effect in the middle of its body, so a resume segment runs afterwards; the question in every case
// is whether lexical state crossed that boundary as a cell or as a snapshot.
// A neutral-expression/v1 prototype, because only v1 reads a binding through readBinding and can
// therefore resolve a captured cell. A v0 prototype would reach the durable {cell: true} record and
// correctly raise EscapingMutableClosureError instead.
async function installNeutralPrototype(runtime, imageId, id, program) {
  const code = await runtime.images.putCodeArtifact(imageId, {
    id: `${id}:code`,
    representation: NEUTRAL_EXPRESSION_V1,
    content: textValue(JSON.stringify(program)),
  });
  const block = await runtime.images.putBlock(imageId, {id, code: objectRef(imageId, code.id)});
  return objectRef(imageId, block.id);
}

async function installResumableV1Block(runtime, imageId, {id, program, instanceReuse = null, prototypes = []}) {
  const compiled = compileResumableWasmV2Module(program);
  const moduleArtifact = await runtime.images.putCodeArtifact(imageId, {
    id: `${id}:module`,
    representation: WASM_MODULE_V1,
    content: {kind: 'bytes', base64: Buffer.from(compiled.bytes).toString('base64')},
    metadata: {
      abi: ABI,
      entry: 'run',
      parameters: compiled.parameterCount,
      captures: compiled.captureIds,
      cellBindings: compiled.cellBindings,
      literals: compiled.literals,
      sendSites: compiled.sendSites,
      closureSites: compiled.closureSites,
      effectSites: compiled.effectSites,
      continuations: compiled.continuations,
      functions: compiled.functions,
      semanticRepresentation: 'lagrange-code/v1',
      ...(instanceReuse === null ? {} : {instanceReuse}),
    },
  });
  const moduleRef = objectRef(imageId, moduleArtifact.id);
  const functionArtifact = await runtime.images.putCodeArtifact(imageId, {
    id: `${id}:function`,
    representation: WASM_FUNCTION_V1,
    content: moduleRef,
    derivedFrom: [moduleRef, moduleRef, ...prototypes],
    metadata: {
      abi: ABI,
      entry: 'run',
      parameters: compiled.parameterCount,
      captures: compiled.captureIds,
      cellBindings: compiled.cellBindings,
      closurePrototypes: compiled.closureSites.map((site, index) => ({
        blockId: site.blockId,
        siteIndex: index,
        derivedFromIndex: 2 + index,
      })),
    },
  });
  const block = await runtime.images.putBlock(imageId, {id, code: objectRef(imageId, functionArtifact.id)});
  return objectRef(imageId, block.id);
}

// The Block whose activation forces the suspension. It is an ordinary neutral Block, so the host
// effect is a real send that the executor must await and resume from.
async function installEffectBlock(runtime, imageId, id, program) {
  const code = await runtime.images.putCodeArtifact(imageId, {
    id: `${id}:code`,
    representation: NEUTRAL_EXPRESSION_V0,
    content: textValue(JSON.stringify(program)),
  });
  const block = await runtime.images.putBlock(imageId, {id, code: objectRef(imageId, code.id)});
  return objectRef(imageId, block.id);
}

function send(receiverExpression, argumentExpressions = []) {
  return {
    op: 'send',
    languageId: 'symmetric-smalltalk',
    message: textValue(argumentExpressions.length === 0 ? 'value' : 'value:'),
    receiver: receiverExpression,
    arguments: argumentExpressions,
  };
}

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'resume'});
    // `effect value` returns 99; its only job is to suspend the WASM activation.
    const effect = await installEffectBlock(runtime, 'resume', 'effect', {
      parameters: 0,
      body: {op: 'literal', value: integerValue(99)},
    });
    return await body(runtime, effect);
  } finally {
    await runtime.close();
  }
}

async function run(runtime, blockRef, args) {
  const activation = await runtime.invocations.invokeBlock(blockRef, args);
  return await runtime.executor.execute(activation);
}

// 1. A read after suspension sees the live cell, not a value saved at the suspension point.
test('a cell read after resumption sees the current cell contents', async () => {
  await withRuntime(async (runtime, effect) => {
    const block = await installResumableV1Block(runtime, 'resume', {
      id: 'read-after',
      program: {
        parameters: [{id: 'root:parameter:0', name: 'effect'}],
        temporaries: [{id: 'root:temporary:0', name: 'n'}],
        captures: [],
        body: {
          op: 'sequence',
          statements: [
            {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(1)}},
            send({op: 'argument', index: 0}),
            {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(2)}},
            {op: 'binding', id: 'root:temporary:0'},
          ],
        },
      },
    });
    assert.deepEqual(await run(runtime, block, [effect]), integerValue(2));
  });
});

// 4. An assignment whose right-hand side suspends must write only after resumption, with the
// returned result. A v2 that performed or prepared the write early would return 1 here.
test('an assignment whose right-hand side suspends writes the resumed result', async () => {
  await withRuntime(async (runtime, effect) => {
    const block = await installResumableV1Block(runtime, 'resume', {
      id: 'write-after',
      program: {
        parameters: [{id: 'root:parameter:0', name: 'effect'}],
        temporaries: [{id: 'root:temporary:0', name: 'n'}],
        captures: [],
        body: {
          op: 'sequence',
          statements: [
            {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(1)}},
            {op: 'binding-write', id: 'root:temporary:0', value: send({op: 'argument', index: 0})},
            {op: 'binding', id: 'root:temporary:0'},
          ],
        },
      },
    });
    assert.deepEqual(await run(runtime, block, [effect]), integerValue(99));
  });
});

// The structural invariant behind all of the above: cell identity is never continuation state. A
// cell binding must not appear as an entry parameter, so it can never be threaded through a resume
// signature the way a snapshot capture is.
test('cell bindings never become entry parameters or continuation state', () => {
  const compiled = compileResumableWasmV2Module({
    parameters: [{id: 'root:parameter:0', name: 'effect'}],
    temporaries: [{id: 'root:temporary:0', name: 'n'}],
    captures: [
      {id: 'outer:temporary:0', mode: 'cell', name: 'shared'},
      {id: 'outer:parameter:0', mode: 'snapshot', name: 'frozen'},
    ],
    body: {
      op: 'sequence',
      statements: [
        {op: 'binding-write', id: 'root:temporary:0', value: send({op: 'argument', index: 0})},
        {
          op: 'integer-add',
          left: {op: 'binding', id: 'root:temporary:0'},
          right: {op: 'binding', id: 'outer:temporary:0'},
        },
      ],
    },
  });

  // Only the snapshot capture is an entry parameter; both cells are reached through the slot table.
  assert.deepEqual(compiled.captureIds, ['outer:parameter:0']);
  assert.deepEqual(compiled.cellBindings, [
    {id: 'root:temporary:0', name: 'n', source: 'temporary'},
    {id: 'outer:temporary:0', name: 'shared', source: 'capture'},
  ]);
  for (const cell of compiled.cellBindings) {
    assert.ok(!compiled.captureIds.includes(cell.id), `${cell.id} must not be an entry parameter`);
  }
  // The suspension really happened, so the assertions above describe a resumed program.
  assert.equal(compiled.continuations.length, 1);
  assert.equal(compiled.continuations[0].entry, 'run$resume_0');
});

// 3. A mutation after resumption updates the same cell the pre-suspension code wrote, rather than
// a fresh one materialized in the resume segment.
test('a cell mutated after resumption keeps accumulating on the same cell', async () => {
  await withRuntime(async (runtime, effect) => {
    const block = await installResumableV1Block(runtime, 'resume', {
      id: 'mutate-after',
      program: {
        parameters: [{id: 'root:parameter:0', name: 'effect'}],
        temporaries: [{id: 'root:temporary:0', name: 'n'}],
        captures: [],
        body: {
          op: 'sequence',
          statements: [
            {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(10)}},
            send({op: 'argument', index: 0}),
            {
              op: 'binding-write',
              id: 'root:temporary:0',
              value: {
                op: 'integer-add',
                left: {op: 'binding', id: 'root:temporary:0'},
                right: {op: 'literal', value: integerValue(5)},
              },
            },
            {op: 'binding', id: 'root:temporary:0'},
          ],
        },
      },
    });
    assert.deepEqual(await run(runtime, block, [effect]), integerValue(15));
  });
});

// A value read from a cell *before* suspending is correctly saved across it: Smalltalk evaluation
// order says the read already happened. This is the other half of the rule, and it would break if
// cell reads were deferred to the resume segment.
test('a value read before suspension is saved across it', async () => {
  await withRuntime(async (runtime, effect) => {
    const block = await installResumableV1Block(runtime, 'resume', {
      id: 'read-before',
      program: {
        parameters: [{id: 'root:parameter:0', name: 'effect'}],
        temporaries: [{id: 'root:temporary:0', name: 'n'}],
        captures: [],
        body: {
          op: 'sequence',
          statements: [
            {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(3)}},
            {
              op: 'integer-add',
              left: {op: 'binding', id: 'root:temporary:0'},
              right: send({op: 'argument', index: 0}),
            },
          ],
        },
      },
    });
    // 3 was read before the send suspended; 99 came back from it.
    assert.deepEqual(await run(runtime, block, [effect]), integerValue(102));
  });
});

test('two activations of one resumable Block do not share a cell', async () => {
  await withRuntime(async (runtime, effect) => {
    const block = await installResumableV1Block(runtime, 'resume', {
      id: 'isolated',
      instanceReuse: 'stateless-v0',
      program: {
        parameters: [
          {id: 'root:parameter:0', name: 'effect'},
          {id: 'root:parameter:1', name: 'seed'},
        ],
        temporaries: [{id: 'root:temporary:0', name: 'n'}],
        captures: [],
        body: {
          op: 'sequence',
          statements: [
            {op: 'binding-write', id: 'root:temporary:0', value: {op: 'argument', index: 1}},
            send({op: 'argument', index: 0}),
            {op: 'binding', id: 'root:temporary:0'},
          ],
        },
      },
    });
    assert.deepEqual(await run(runtime, block, [effect, integerValue(4)]), integerValue(4));
    assert.deepEqual(await run(runtime, block, [effect, integerValue(6)]), integerValue(6));
    const stats = runtime.executor.executors.get(WASM_FUNCTION_V1).instancePool.stats();
    assert.equal(stats.created, 1, 'the second activation must reuse the pooled instance');
  });
});

// Assigning a newly created Block makes Block creation non-tail, which forces the resumable
// backend; capturing a cell exercises the mixed-mode closure path. The two together are what the
// quartet above never reached, because none of those programs creates a Block.
//
//   | n f |  n := 1.  f := [ n ].  f value
//
// A closure site with one cell capture and no snapshots has an ABI request arity of 0, so an
// executor counting every semantic capture demands one handle too many.
test('a resumable closure capturing only a cell passes no handles', async () => {
  await withRuntime(async (runtime) => {
    const readCell = await installNeutralPrototype(runtime, 'resume', 'reader', {
      parameters: 0,
      temporaries: [],
      body: {op: 'binding', id: 'root:temporary:0'},
    });
    const block = await installResumableV1Block(runtime, 'resume', {
      id: 'cell-closure',
      prototypes: [readCell],
      program: {
        parameters: [],
        temporaries: [
          {id: 'root:temporary:0', name: 'n'},
          {id: 'root:temporary:1', name: 'f'},
        ],
        captures: [],
        body: {
          op: 'sequence',
          statements: [
            {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(1)}},
            {
              op: 'binding-write',
              id: 'root:temporary:1',
              value: {
                op: 'block',
                blockId: 'root/block:0',
                captures: [{id: 'root:temporary:0', mode: 'cell', name: 'n'}],
                program: {
                  parameters: [],
                  temporaries: [],
                  captures: [{id: 'root:temporary:0', mode: 'cell', name: 'n'}],
                  body: {op: 'binding', id: 'root:temporary:0'},
                },
              },
            },
            send({op: 'binding', id: 'root:temporary:1'}),
          ],
        },
      },
    });
    assert.deepEqual(await run(runtime, block, []), integerValue(1));
  });
});

test('a resumable closure site with one cell capture declares zero request handles', () => {
  const compiled = compileResumableWasmV2Module({
    parameters: [],
    temporaries: [{id: 'root:temporary:0', name: 'n'}, {id: 'root:temporary:1', name: 'f'}],
    captures: [],
    body: {
      op: 'sequence',
      statements: [
        {
          op: 'binding-write',
          id: 'root:temporary:1',
          value: {
            op: 'block',
            blockId: 'root/block:0',
            captures: [{id: 'root:temporary:0', mode: 'cell', name: 'n'}],
            program: {parameters: [], temporaries: [], captures: [], body: {op: 'literal', value: integerValue(0)}},
          },
        },
        {op: 'binding', id: 'root:temporary:1'},
      ],
    },
  });
  const closureEffect = compiled.effectSites.find(({kind}) => kind === 'closure');
  assert.equal(closureEffect.requestArity, 0, 'a cell-only closure passes no Value handles');
  assert.equal(compiled.closureSites[0].captures.length, 1, 'the semantic capture is still recorded');
});

test('the resumable v2 executor refuses to run without the synchronous cell operations', async () => {
  await withRuntime(async (runtime, effect) => {
    const block = await installResumableV1Block(runtime, 'resume', {
      id: 'no-cells',
      program: {
        parameters: [{id: 'root:parameter:0', name: 'effect'}],
        temporaries: [{id: 'root:temporary:0', name: 'n'}],
        captures: [],
        body: {
          op: 'sequence',
          statements: [
            {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(1)}},
            {op: 'binding', id: 'root:temporary:0'},
          ],
        },
      },
    });
    const activation = await runtime.invocations.invokeBlock(block, [effect]);
    const code = await runtime.images.getCodeArtifact('resume', 'no-cells:function');
    await assert.rejects(
      runtime.executor.executors.get(WASM_FUNCTION_V1).execute({activation, code}, {images: runtime.images}),
      /requires the readCell execution operation/,
    );
  });
});
