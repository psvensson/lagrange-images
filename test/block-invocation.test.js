import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

async function seedRuntime(t) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => runtime.close());

  await runtime.images.createImage({id: 'demo'});
  await runtime.images.putCodeArtifact('demo', {
    id: 'code',
    languageId: 'test-language',
    representation: 'source',
    content: textValue('argument'),
  });
  await runtime.images.putLexicalEnvironment('demo', {
    id: 'environment',
    bindings: {
      captured: {name: 'captured', value: integerValue(41)},
    },
  });
  await runtime.images.putBlock('demo', {
    id: 'block',
    code: objectRef('demo', 'code'),
    environment: objectRef('demo', 'environment'),
  });

  return runtime;
}

test('direct block invocation prepares a transient activation request', async (t) => {
  const runtime = await seedRuntime(t);
  const before = await runtime.images.history('demo');

  const activation = await runtime.invocations.invokeBlock(
    objectRef('demo', 'block'),
    [integerValue(1)],
  );

  assert.equal(activation.kind, 'activation-request');
  assert.deepEqual(activation.block, objectRef('demo', 'block'));
  assert.deepEqual(activation.code, objectRef('demo', 'code'));
  assert.deepEqual(activation.environment, objectRef('demo', 'environment'));
  assert.equal(activation.receiver, null);
  assert.deepEqual(activation.arguments, [integerValue(1)]);
  assert.equal(activation.dispatch, null);

  const after = await runtime.images.history('demo');
  assert.equal(after.length, before.length);
});
