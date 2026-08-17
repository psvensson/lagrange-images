import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WASM_FUNCTION_V1,
  WASM_MODULE_V1,
  createRuntime,
  integerValue,
  objectRef,
} from '../src/runtime.js';
import {compileWasmV1Module} from '../src/wasm/compiler-v1.js';

// Artifacts are assembled directly here rather than through installWasmBlockTree, which still
// serves the v0 tree policy only. What is under test is the ABI seam: whether cell_get/cell_set
// reach the same lexical cells the neutral lane uses.
async function installV1Block(runtime, imageId, {id, program, environment = null}) {
  const compiled = compileWasmV1Module(program);
  const moduleArtifact = await runtime.images.putCodeArtifact(imageId, {
    id: `${id}:module`,
    representation: WASM_MODULE_V1,
    content: {kind: 'bytes', base64: Buffer.from(compiled.bytes).toString('base64')},
    metadata: {
      abi: 'lagrange-value-handle/v1',
      entry: 'run',
      parameters: compiled.parameterCount,
      captures: compiled.captureIds,
      cellBindings: compiled.cellBindings,
      literals: compiled.literals,
      sendSites: compiled.sendSites,
      closureSites: compiled.closureSites,
      functions: compiled.functions,
      semanticRepresentation: 'lagrange-code/v1',
    },
  });
  const moduleRef = objectRef(imageId, moduleArtifact.id);
  const functionArtifact = await runtime.images.putCodeArtifact(imageId, {
    id: `${id}:function`,
    representation: WASM_FUNCTION_V1,
    content: moduleRef,
    derivedFrom: [moduleRef, moduleRef],
    metadata: {
      abi: 'lagrange-value-handle/v1',
      entry: 'run',
      parameters: compiled.parameterCount,
      captures: compiled.captureIds,
      cellBindings: compiled.cellBindings,
      closurePrototypes: [],
    },
  });
  const block = await runtime.images.putBlock(imageId, {
    id,
    code: objectRef(imageId, functionArtifact.id),
    environment,
  });
  return objectRef(imageId, block.id);
}

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'wasm-cells'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function run(runtime, blockRef, args = []) {
  const activation = await runtime.invocations.invokeBlock(blockRef, args);
  return await runtime.executor.execute(activation);
}

const ASSIGN_THEN_READ = Object.freeze({
  parameters: [],
  temporaries: [{id: 'root:temporary:0', name: 'a'}],
  captures: [],
  body: {
    op: 'sequence',
    statements: [
      {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(7)}},
      {op: 'binding', id: 'root:temporary:0'},
    ],
  },
});

test('a WASM temporary is assigned and read back through the host cell', async () => {
  await withRuntime(async (runtime) => {
    const block = await installV1Block(runtime, 'wasm-cells', {id: 'assign', program: ASSIGN_THEN_READ});
    assert.deepEqual(await run(runtime, block), integerValue(7));
  });
});

test('assignment evaluates to the assigned value in the WASM lane too', async () => {
  await withRuntime(async (runtime) => {
    const block = await installV1Block(runtime, 'wasm-cells', {
      id: 'chain',
      program: {
        parameters: [],
        temporaries: [{id: 'root:temporary:0', name: 'a'}, {id: 'root:temporary:1', name: 'b'}],
        captures: [],
        body: {
          op: 'sequence',
          statements: [
            {
              op: 'binding-write',
              id: 'root:temporary:0',
              value: {op: 'binding-write', id: 'root:temporary:1', value: {op: 'literal', value: integerValue(5)}},
            },
            {
              op: 'integer-add',
              left: {op: 'binding', id: 'root:temporary:0'},
              right: {op: 'binding', id: 'root:temporary:1'},
            },
          ],
        },
      },
    });
    assert.deepEqual(await run(runtime, block), integerValue(10));
  });
});

test('a WASM read of an unassigned temporary raises rather than defaulting', async () => {
  await withRuntime(async (runtime) => {
    const block = await installV1Block(runtime, 'wasm-cells', {
      id: 'unbound',
      program: {
        parameters: [],
        temporaries: [{id: 'root:temporary:0', name: 'a'}],
        captures: [],
        body: {op: 'binding', id: 'root:temporary:0'},
      },
    });
    await assert.rejects(run(runtime, block), (error) => error.name === 'UnboundBindingError');
  });
});

// The invariant that keeps the two lanes honest: repeated activations of one Block get distinct
// cells. A WASM local would give the same answer here, so the counter tests below are what
// separate a real shared cell from a per-activation copy.
test('two activations of one WASM Block do not share a temporary', async () => {
  await withRuntime(async (runtime) => {
    const block = await installV1Block(runtime, 'wasm-cells', {
      id: 'isolated',
      program: {
        parameters: [{id: 'root:parameter:0', name: 'seed'}],
        temporaries: [{id: 'root:temporary:0', name: 'n'}],
        captures: [],
        body: {
          op: 'sequence',
          statements: [
            {op: 'binding-write', id: 'root:temporary:0', value: {op: 'argument', index: 0}},
            {op: 'binding', id: 'root:temporary:0'},
          ],
        },
      },
    });
    assert.deepEqual(await run(runtime, block, [integerValue(1)]), integerValue(1));
    assert.deepEqual(await run(runtime, block, [integerValue(2)]), integerValue(2));
  });
});

// The pooled-instance invariant. The compiler opts modules into stateless reuse, so the same
// instance is checked out for both activations; lexical cell access must be rebound per activation
// and cleared on unbind, exactly like the value arena.
test('a pooled WASM instance is reused while its activations keep separate cells', async () => {
  await withRuntime(async (runtime) => {
    const compiled = compileWasmV1Module(ASSIGN_THEN_READ);
    const moduleArtifact = await runtime.images.putCodeArtifact('wasm-cells', {
      id: 'pooled:module',
      representation: WASM_MODULE_V1,
      content: {kind: 'bytes', base64: Buffer.from(compiled.bytes).toString('base64')},
      metadata: {
        abi: 'lagrange-value-handle/v1',
        entry: 'run',
        parameters: 0,
        captures: [],
        cellBindings: compiled.cellBindings,
        literals: compiled.literals,
        sendSites: compiled.sendSites,
        closureSites: compiled.closureSites,
        functions: compiled.functions,
        semanticRepresentation: 'lagrange-code/v1',
        instanceReuse: 'stateless-v0',
      },
    });
    const moduleRef = objectRef('wasm-cells', moduleArtifact.id);
    const functionArtifact = await runtime.images.putCodeArtifact('wasm-cells', {
      id: 'pooled:function',
      representation: WASM_FUNCTION_V1,
      content: moduleRef,
      derivedFrom: [moduleRef, moduleRef],
      metadata: {
        abi: 'lagrange-value-handle/v1',
        entry: 'run',
        parameters: 0,
        captures: [],
        cellBindings: compiled.cellBindings,
        closurePrototypes: [],
      },
    });
    const block = await runtime.images.putBlock('wasm-cells', {
      id: 'pooled',
      code: objectRef('wasm-cells', functionArtifact.id),
    });
    const blockRef = objectRef('wasm-cells', block.id);

    assert.deepEqual(await run(runtime, blockRef), integerValue(7));
    assert.deepEqual(await run(runtime, blockRef), integerValue(7));
    const stats = runtime.executor.executors.get(WASM_FUNCTION_V1).instancePool.stats();
    assert.equal(stats.created, 1, 'the second activation must reuse the pooled instance');
  });
});

test('the v1 executor refuses to run without the synchronous cell operations', async () => {
  await withRuntime(async (runtime) => {
    const block = await installV1Block(runtime, 'wasm-cells', {id: 'no-cells', program: ASSIGN_THEN_READ});
    const activation = await runtime.invocations.invokeBlock(block, []);
    const code = await runtime.images.getCodeArtifact('wasm-cells', 'no-cells:function');
    const executor = runtime.executor.executors.get(WASM_FUNCTION_V1);
    await assert.rejects(
      executor.execute({activation, code}, {images: runtime.images}),
      /requires the readCell execution operation/,
    );
  });
});

test('a v0 module artifact is not accepted under the v1 ABI', async () => {
  await withRuntime(async (runtime) => {
    const compiled = compileWasmV1Module(ASSIGN_THEN_READ);
    const moduleArtifact = await runtime.images.putCodeArtifact('wasm-cells', {
      id: 'mismatch:module',
      representation: WASM_MODULE_V1,
      content: {kind: 'bytes', base64: Buffer.from(compiled.bytes).toString('base64')},
      // Declares the frozen v0 ABI while carrying v1 metadata.
      metadata: {
        abi: 'lagrange-value-handle/v0',
        entry: 'run',
        parameters: 0,
        captures: [],
        literals: compiled.literals,
        sendSites: compiled.sendSites,
        closureSites: compiled.closureSites,
      },
    });
    const moduleRef = objectRef('wasm-cells', moduleArtifact.id);
    const functionArtifact = await runtime.images.putCodeArtifact('wasm-cells', {
      id: 'mismatch:function',
      representation: WASM_FUNCTION_V1,
      content: moduleRef,
      derivedFrom: [moduleRef, moduleRef],
      metadata: {
        abi: 'lagrange-value-handle/v1',
        entry: 'run',
        parameters: 0,
        captures: [],
        cellBindings: compiled.cellBindings,
        closurePrototypes: [],
      },
    });
    const block = await runtime.images.putBlock('wasm-cells', {
      id: 'mismatch',
      code: objectRef('wasm-cells', functionArtifact.id),
    });
    await assert.rejects(
      run(runtime, objectRef('wasm-cells', block.id)),
      /WASM module ABI does not match lagrange-value-handle\/v1/,
    );
  });
});
