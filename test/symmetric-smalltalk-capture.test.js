import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  evaluateSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
} from '../src/runtime.js';

test('Symmetric Smalltalk compiled Blocks read captured bindings by stable id', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const environment = await runtime.images.putLexicalEnvironment('demo', {
    id: 'env',
    bindings: {
      'binding-answer': {name: 'answer', value: integerValue(42)},
    },
  });

  const result = await evaluateSymmetricSmalltalkBlock({
    runtime,
    imageId: 'demo',
    id: 'captured-answer',
    source: '[ answer ]',
    captures: {answer: 'binding-answer'},
    environment: objectRef('demo', environment.id),
  });
  assert.deepEqual(result, integerValue(42));
  await runtime.close();
});
