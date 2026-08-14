import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  installSymmetricSmalltalkBlock,
  objectRef,
} from '../src/runtime.js';

test('Symmetric Smalltalk self is the message receiver, not an implicit argument', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  await installSymmetricSmalltalkBlock({
    images: runtime.images,
    imageId: 'demo',
    id: 'yourself-method',
    source: '[ self ]',
  });
  const behaviorShape = await runtime.images.putShape('demo', {
    id: 'behavior-shape',
    slots: [{id: 'method-yourself', name: 'yourself'}],
  });
  await runtime.images.putObject('demo', {
    id: 'Behavior',
    shape: objectRef('demo', behaviorShape.id),
    slots: {'method-yourself': objectRef('demo', 'yourself-method')},
  });
  const receiverShape = await runtime.images.putShape('demo', {id: 'receiver-shape', slots: []});
  const receiver = await runtime.images.putObject('demo', {
    id: 'receiver',
    shape: objectRef('demo', receiverShape.id),
    behavior: objectRef('demo', 'Behavior'),
    slots: {},
  });

  const activation = await runtime.invocations.sendMessage({
    languageId: 'symmetric-smalltalk',
    receiver: objectRef('demo', receiver.id),
    message: {kind: 'text', value: 'yourself'},
    arguments: [],
  });
  assert.deepEqual(await runtime.executor.execute(activation), objectRef('demo', receiver.id));
  await runtime.close();
});
