import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  evaluateSymmetricSmalltalkBlock,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

test('nested Smalltalk Blocks capture outer parameters and execute through value:', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  const result = await evaluateSymmetricSmalltalkBlock({
    runtime,
    imageId: 'demo',
    id: 'capture-block',
    source: '[ :x | [ :y | x ] value: 99 ]',
    arguments: [integerValue(7)],
  });
  assert.deepEqual(result, integerValue(7));

  // ADR 0052 changed what this test is about. It used to assert that the capture was *materialized*
  // — a durable LexicalEnvironment and a durable Block per evaluation. A closure that never escapes
  // is now execution-local, so the observable contract is the answer plus the absence of writes.
  // The capture itself is proven by the answer: `x` reached the inner Block, which is the thing the
  // durable environment was only ever evidence of.
  assert.deepEqual(await runtime.images.listLexicalEnvironments('demo'), []);
  const materialized = (await runtime.images.listBlocks('demo'))
    .find((block) => block.metadata?.prototypeBlockId === 'capture-block:prototype:root_block_0');
  assert.equal(materialized, undefined, 'a closure that never escaped must not be published');
  await runtime.close();
});

test('deep nested Blocks pass the same stable captured binding through intermediate scopes', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  const result = await evaluateSymmetricSmalltalkBlock({
    runtime,
    imageId: 'demo',
    id: 'deep-capture',
    source: '[ :x | [ [ x ] value ] value ]',
    arguments: [integerValue(11)],
  });
  assert.deepEqual(result, integerValue(11));

  // Two closures were created and neither escaped, so neither is durable (ADR 0052). That the same
  // binding threaded through both scopes is what the answer demonstrates.
  assert.deepEqual(await runtime.images.listLexicalEnvironments('demo'), []);
  await runtime.close();
});

test('self crossing a Block boundary is captured lexically rather than becoming the Block receiver', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});

  await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'nested-yourself-method',
    source: '[ [ self ] value ]',
  });
  const behaviorShape = await runtime.images.putShape('demo', {
    id: 'behavior-shape',
    slots: [{id: 'method-nested-yourself', name: 'nestedYourself'}],
  });
  await runtime.images.putObject('demo', {
    id: 'Behavior',
    shape: objectRef('demo', behaviorShape.id),
    slots: {'method-nested-yourself': objectRef('demo', 'nested-yourself-method')},
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
    message: textValue('nestedYourself'),
    arguments: [],
  });
  assert.deepEqual(await runtime.executor.execute(activation), objectRef('demo', receiver.id));
  await runtime.close();
});
