import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V0,
  WASM_MODULE_V1,
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

test('WASM backend v0 rejects message sends instead of falling back', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const source = await semantic(runtime, 'send-semantic', {
    op: 'send',
    languageId: 'symmetric-smalltalk',
    receiver: {op: 'literal', value: integerValue(1)},
    message: textValue('yourself'),
    arguments: [],
  });
  await assert.rejects(
    runtime.compilation.compileArtifact(objectRef('demo', source.id), {
      id: 'send-wasm',
      targetRepresentation: WASM_MODULE_V1,
    }),
    /does not yet support message sends/,
  );
  await runtime.close();
});

test('WASM backend v0 refuses reference literals because metadata cannot hide graph edges', async () => {
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
