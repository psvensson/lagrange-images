import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutorNotFoundError,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';

test('unknown code representations fail explicitly', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const image = await runtime.images.createImage({id: 'unknown-executor'});
    const code = await runtime.images.putCodeArtifact(image.id, {
      id: 'unknown-code',
      representation: 'example/unknown',
      content: textValue('opaque'),
    });
    const block = await runtime.images.putBlock(image.id, {
      id: 'unknown-block',
      code: objectRef(image.id, code.id),
    });
    const activation = await runtime.invocations.invokeBlock(objectRef(image.id, block.id), []);
    await assert.rejects(runtime.executor.execute(activation), ExecutorNotFoundError);
  } finally {
    await runtime.close();
  }
});

test('custom representation executors plug into the same activation path', async () => {
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    codeExecutors: {
      'example/echo': {
        async execute({activation}) { return activation.arguments[0]; },
      },
    },
  });
  try {
    const image = await runtime.images.createImage({id: 'custom-executor'});
    const code = await runtime.images.putCodeArtifact(image.id, {
      id: 'echo-code',
      representation: 'example/echo',
      content: textValue('unused'),
    });
    const block = await runtime.images.putBlock(image.id, {
      id: 'echo-block',
      code: objectRef(image.id, code.id),
    });
    const activation = await runtime.invocations.invokeBlock(
      objectRef(image.id, block.id),
      [textValue('hello')],
    );
    assert.deepEqual(await runtime.executor.execute(activation), textValue('hello'));
  } finally {
    await runtime.close();
  }
});
