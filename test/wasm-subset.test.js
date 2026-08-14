import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V0,
  WASM_MODULE_V1,
  WASM_RESUMABLE_VALUE_HANDLE_ABI_V1,
  createRuntime,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

async function semantic(runtime, id, body) {
  return await runtime.images.putCodeArtifact('demo', {
    id,
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify({parameters: [], captures: [], body})),
  });
}

test('WASM compiler selects the resumable ABI for a non-tail message send', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const source = await semantic(runtime, 'send-semantic', {
    op: 'integer-add',
    left: {
      op: 'send',
      languageId: 'symmetric-smalltalk',
      receiver: {op: 'literal', value: integerValue(1)},
      message: textValue('yourself'),
      arguments: [],
    },
    right: {op: 'literal', value: integerValue(1)},
  });
  const module = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'send-wasm',
    targetRepresentation: WASM_MODULE_V1,
  });
  assert.equal(module.metadata.abi, WASM_RESUMABLE_VALUE_HANDLE_ABI_V1);
  assert.equal(module.metadata.effectSites.length, 1);
  assert.equal(module.metadata.effectSites[0].kind, 'send');
  assert.match(module.metadata.effectSites[0].resumeEntry, /\$resume_/);
  assert.equal(module.metadata.continuations.length, 1);
  await runtime.close();
});

test('WASM compiler selects the resumable ABI for non-tail nested Block creation', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const source = await semantic(runtime, 'block-semantic', {
    op: 'send',
    languageId: 'symmetric-smalltalk',
    receiver: {
      op: 'block',
      blockId: 'root/block:0',
      captures: [],
      program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(1)}},
    },
    message: textValue('value'),
    arguments: [],
  });
  const module = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'block-wasm',
    targetRepresentation: WASM_MODULE_V1,
  });
  assert.equal(module.metadata.abi, WASM_RESUMABLE_VALUE_HANDLE_ABI_V1);
  assert.deepEqual(module.metadata.effectSites.map(({kind}) => kind), ['closure', 'send']);
  assert.match(module.metadata.effectSites[0].resumeEntry, /\$resume_/);
  assert.equal(module.metadata.effectSites[1].resumeEntry, null);
  await runtime.close();
});

test('WASM backend refuses reference literals because metadata cannot hide graph edges', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const source = await semantic(runtime, 'ref-semantic', {
    op: 'literal',
    value: objectRef('demo', 'some-object'),
  });
  await assert.rejects(
    runtime.compilation.compileArtifact(objectRef('demo', source.id), {
      id: 'ref-wasm',
      targetRepresentation: WASM_MODULE_V1,
    }),
    /does not embed reference literals/,
  );
  await runtime.close();
});
