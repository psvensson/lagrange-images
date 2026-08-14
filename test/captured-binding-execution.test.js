import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEUTRAL_EXPRESSION_V0,
  createRuntime,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

test('captured binding lookup walks lexical parents by stable binding id', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const image = await runtime.images.createImage({id: 'closures'});

    const parent = await runtime.images.putLexicalEnvironment(image.id, {
      id: 'parent-env',
      bindings: {
        'binding-base': {name: 'base', value: integerValue(40)},
      },
    });
    const child = await runtime.images.putLexicalEnvironment(image.id, {
      id: 'child-env',
      parent: objectRef(image.id, parent.id),
      bindings: {
        'binding-delta': {name: 'delta', value: integerValue(2)},
      },
    });
    const code = await runtime.images.putCodeArtifact(image.id, {
      id: 'sum-code',
      representation: NEUTRAL_EXPRESSION_V0,
      content: textValue(JSON.stringify({
        parameters: 0,
        body: {
          op: 'integer-add',
          left: {op: 'binding', id: 'binding-base'},
          right: {op: 'binding', id: 'binding-delta'},
        },
      })),
    });
    const block = await runtime.images.putBlock(image.id, {
      id: 'sum-block',
      code: objectRef(image.id, code.id),
      environment: objectRef(image.id, child.id),
    });
    const blockRef = objectRef(image.id, block.id);

    const first = await runtime.invocations.invokeBlock(blockRef, []);
    assert.deepEqual(await runtime.executor.execute(first), integerValue(42));

    await runtime.images.putLexicalEnvironment(image.id, {
      id: parent.id,
      bindings: {
        'binding-base': {name: 'renamedBase', value: integerValue(50)},
      },
    });

    const second = await runtime.invocations.invokeBlock(blockRef, []);
    assert.deepEqual(await runtime.executor.execute(second), integerValue(52));
    assert.deepEqual(second.environment, first.environment);
  } finally {
    await runtime.close();
  }
});
