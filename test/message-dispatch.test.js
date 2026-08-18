import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DispatchNotFoundError,
  createRuntime,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

async function seedRuntime(t, dispatchers = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, dispatchers});
  t.after(async () => runtime.close());

  await runtime.images.createImage({id: 'demo'});
  await runtime.images.putCodeArtifact('demo', {
    id: 'code',
    languageId: 'test-language',
    representation: 'source',
    content: textValue('body'),
  });
  await runtime.images.putBlock('demo', {
    id: 'block',
    code: objectRef('demo', 'code'),
  });

  return runtime;
}

test('message dispatch resolves language semantics to a block, then uses common activation', async (t) => {
  let seenRequest = null;
  const dispatcher = {
    async resolveMessage(request, {images}) {
      seenRequest = request;
      assert.equal((await images.getBlock('demo', 'block')).kind, 'block');
      return {block: objectRef('demo', 'block')};
    },
  };
  const runtime = await seedRuntime(t, {'test-language': dispatcher});

  const receiver = integerValue(41);
  const message = objectRef('demo', 'message-object');
  const activation = await runtime.invocations.sendMessage({
    languageId: 'test-language',
    receiver,
    message,
    arguments: [integerValue(1)],
  });

  assert.equal(seenRequest.kind, 'message-send');
  assert.deepEqual(seenRequest.receiver, receiver);
  assert.deepEqual(seenRequest.message, message);
  assert.deepEqual(seenRequest.arguments, [integerValue(1)]);

  assert.deepEqual(activation.block, objectRef('demo', 'block'));
  assert.deepEqual(activation.receiver, receiver);
  assert.deepEqual(activation.arguments, [integerValue(1)]);
  assert.deepEqual(activation.dispatch, {
    languageId: 'test-language',
    message,
  });
});

// ADR 0045 decision 7. The generic seam, independent of any language: a resolution may nominate the
// object that actually receives the message, and absence of the key means the original receiver.
test('a resolution may nominate the object that actually receives the message', async (t) => {
  const runtime = await seedRuntime(t, {
    'test-language': {
      async resolveMessage() {
        return {block: objectRef('demo', 'block'), effectiveReceiver: objectRef('demo', 'stand-in')};
      },
    },
  });

  const activation = await runtime.invocations.sendMessage({
    languageId: 'test-language',
    receiver: integerValue(41),
    message: textValue('anything'),
  });
  assert.deepEqual(
    activation.receiver,
    objectRef('demo', 'stand-in'),
    'the activation receives the nominated object, not the Value the message was sent to',
  );
});

test('an effective receiver must be an unpinned object ref', async (t) => {
  const runtime = await seedRuntime(t, {
    'test-language': {
      async resolveMessage() {
        return {block: objectRef('demo', 'block'), effectiveReceiver: integerValue(1)};
      },
    },
  });

  await assert.rejects(
    runtime.invocations.sendMessage({
      languageId: 'test-language',
      receiver: integerValue(41),
      message: textValue('anything'),
    }),
    /effectiveReceiver must be an unpinned object ref/,
  );
});

test('message send fails clearly when no language dispatcher is registered', async (t) => {
  const runtime = await seedRuntime(t);

  await assert.rejects(
    runtime.invocations.sendMessage({
      languageId: 'missing-language',
      receiver: integerValue(1),
      message: textValue('anything'),
    }),
    DispatchNotFoundError,
  );
});

test('dispatcher resolution must target an actual block', async (t) => {
  const runtime = await seedRuntime(t, {
    'test-language': {
      async resolveMessage() {
        return {block: objectRef('demo', 'code')};
      },
    },
  });

  await assert.rejects(
    runtime.invocations.sendMessage({
      languageId: 'test-language',
      receiver: integerValue(1),
      message: textValue('anything'),
    }),
    /activation block not found/,
  );
});
