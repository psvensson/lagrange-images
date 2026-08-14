import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  installSymmetricSmalltalkBlock,
  objectRef,
  textValue,
} from '../src/runtime.js';

test('compiled Symmetric Smalltalk sends resolve through image-resident behavior objects', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  await installSymmetricSmalltalkBlock({
    images: runtime.images,
    imageId: 'demo',
    id: 'echo-method',
    source: '[ :value | value ]',
  });

  const behaviorShape = await runtime.images.putShape('demo', {
    id: 'behavior-shape',
    slots: [{id: 'method-echo', name: 'echo:'}],
  });
  await runtime.images.putObject('demo', {
    id: 'EchoBehavior',
    shape: objectRef('demo', behaviorShape.id),
    slots: {'method-echo': objectRef('demo', 'echo-method')},
  });

  const receiverShape = await runtime.images.putShape('demo', {
    id: 'receiver-shape',
    slots: [],
  });
  await runtime.images.putObject('demo', {
    id: 'receiver',
    shape: objectRef('demo', receiverShape.id),
    behavior: objectRef('demo', 'EchoBehavior'),
    slots: {},
  });

  const caller = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    imageId: 'demo',
    id: 'caller',
    source: "[ :target | target echo: 'hello' ]",
  });
  const activation = await runtime.invocations.invokeBlock(
    objectRef('demo', caller.block.id),
    [objectRef('demo', 'receiver')],
  );
  assert.deepEqual(await runtime.executor.execute(activation), textValue('hello'));
  await runtime.close();
});

test('the default runtime registers the Symmetric Smalltalk dispatcher', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  assert.equal(runtime.dispatchers.has('symmetric-smalltalk'), true);
  await runtime.close();
});
