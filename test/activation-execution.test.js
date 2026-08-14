import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEUTRAL_EXPRESSION_V0,
  createRuntime,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

async function addBlock(runtime, imageId, {id, parameters, body, environment = null}) {
  const code = await runtime.images.putCodeArtifact(imageId, {
    id: `${id}-code`,
    representation: NEUTRAL_EXPRESSION_V0,
    content: textValue(JSON.stringify({parameters, body})),
  });
  const block = await runtime.images.putBlock(imageId, {
    id,
    code: objectRef(imageId, code.id),
    environment,
  });
  return objectRef(imageId, block.id);
}

test('positional arguments execute through the neutral calling convention', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const image = await runtime.images.createImage({id: 'calling'});
    const block = await addBlock(runtime, image.id, {
      id: 'add',
      parameters: 2,
      body: {
        op: 'integer-add',
        left: {op: 'argument', index: 0},
        right: {op: 'argument', index: 1},
      },
    });

    const activation = await runtime.invocations.invokeBlock(block, [integerValue(20), integerValue(22)]);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(42));

    const wrongArity = await runtime.invocations.invokeBlock(block, [integerValue(20)]);
    await assert.rejects(runtime.executor.execute(wrongArity), /expected 2 arguments, received 1/);
  } finally {
    await runtime.close();
  }
});

test('receiver is separate from positional arguments and message may be any Value', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const image = await runtime.images.createImage({id: 'receiver'});
    const block = await addBlock(runtime, image.id, {
      id: 'self',
      parameters: 0,
      body: {op: 'receiver'},
    });

    runtime.dispatchers.register('test-personality', {
      async resolveMessage() { return {block}; },
    });

    const activation = await runtime.invocations.sendMessage({
      languageId: 'test-personality',
      receiver: textValue('receiver-value'),
      message: integerValue(7),
      arguments: [],
    });
    assert.deepEqual(await runtime.executor.execute(activation), textValue('receiver-value'));
  } finally {
    await runtime.close();
  }
});
