import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEUTRAL_EXPRESSION_V0,
  createRuntime,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

test('neutral expression equality and if return tagged Values', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const image = await runtime.images.createImage({id: 'neutral-control'});
    const code = await runtime.images.putCodeArtifact(image.id, {
      id: 'choose-code',
      representation: NEUTRAL_EXPRESSION_V0,
      content: textValue(JSON.stringify({
        parameters: 1,
        body: {
          op: 'if',
          condition: {
            op: 'equals',
            left: {op: 'argument', index: 0},
            right: {op: 'literal', value: integerValue(1)},
          },
          then: {op: 'literal', value: textValue('one')},
          else: {op: 'literal', value: textValue('other')},
        },
      })),
    });
    const block = await runtime.images.putBlock(image.id, {
      id: 'choose-block',
      code: objectRef(image.id, code.id),
    });
    const blockRef = objectRef(image.id, block.id);

    const one = await runtime.invocations.invokeBlock(blockRef, [integerValue(1)]);
    const other = await runtime.invocations.invokeBlock(blockRef, [integerValue(2)]);
    assert.deepEqual(await runtime.executor.execute(one), textValue('one'));
    assert.deepEqual(await runtime.executor.execute(other), textValue('other'));
  } finally {
    await runtime.close();
  }
});
