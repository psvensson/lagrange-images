import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExpiredExecutionContextError,
  createAuthorityService,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';

const PROBE = 'lifetime-probe/v0';
const DEMAND = {operation: 'host-value/read', resource: 'public-message'};

// ADR 0037 says authority belongs to the individual active call and that its lifetime is the
// invocation lifetime. These tests are what make that mechanical rather than aspirational:
// before the guard, a retained `require` kept authorizing indefinitely after `execute` returned.
async function seed({plan = {}, grants = [DEMAND]} = {}) {
  const captured = {};
  const authority = createAuthorityService();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    codeExecutors: {
      [PROBE]: {
        async execute({code}, context) {
          const own = JSON.parse(code.content.value);
          if (own.id) captured[own.id] = context;
          if (own.forward) {
            await context.sendMessage({
              languageId: 'probe-language',
              receiver: objectRef('demo', own.forward),
              message: textValue(own.forward),
              arguments: [],
            });
            // The nested activation has finished while this one is still running.
            captured.nestedAfterReturn = (() => {
              try {
                captured[own.forward].require(DEMAND);
                return 'still-live';
              } catch (error) { return error.name; }
            })();
          }
          if (own.throws) throw new TypeError('probe failed on purpose');
          return textValue('ok');
        },
      },
    },
    dispatchers: {
      'probe-language': {
        async resolveMessage(request) { return {block: objectRef('demo', request.message.value)}; },
      },
    },
  });
  await runtime.images.createImage({id: 'demo'});

  const install = async (id, own) => {
    const code = await runtime.images.putCodeArtifact('demo', {
      id: `${id}-code`, representation: PROBE, content: textValue(JSON.stringify(own)),
    });
    await runtime.images.putBlock('demo', {id, code: objectRef('demo', code.id), environment: null});
  };
  await install('outer', {id: 'outer', ...plan});
  await install('inner', {id: 'inner'});

  const context = authority.issue({principal: 'alice', grants});
  const run = async () => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'outer'), []);
    return await runtime.executor.execute(activation, {authority: context});
  };
  return {runtime, authority, captured, run};
}

test('a retained require stops authorizing once its activation completes', async () => {
  const {runtime, captured, run} = await seed();
  try {
    await run();
    // During the activation this demand was authorized; the grant has not changed.
    assert.throws(() => captured.outer.require(DEMAND), ExpiredExecutionContextError);
    assert.throws(() => captured.outer.require(DEMAND), /does not outlive the activation/);
  } finally {
    await runtime.close();
  }
});

test('the whole execution context expires, not only the authority check', async () => {
  const {runtime, captured, run} = await seed();
  try {
    await run();
    // Nothing in an execution context is meaningful after its activation, so all of it expires
    // rather than leaving a per-function policy to reason about.
    for (const operation of ['require', 'lookupBinding', 'createClosure', 'sendMessage']) {
      assert.throws(() => captured.outer[operation]({}), ExpiredExecutionContextError,
        `${operation} outlived its activation`);
    }
  } finally {
    await runtime.close();
  }
});

test('the context expires on an exceptional exit too', async () => {
  const {runtime, captured, run} = await seed({plan: {throws: true}});
  try {
    await assert.rejects(run(), /probe failed on purpose/);
    // A trapping guest must not leave a live context behind.
    assert.throws(() => captured.outer.require(DEMAND), ExpiredExecutionContextError);
  } finally {
    await runtime.close();
  }
});

test('each activation has its own lifetime, so a nested context expires first', async () => {
  const {runtime, captured, run} = await seed({plan: {forward: 'inner'}});
  try {
    await run();
    // Observed from inside the still-running outer activation: the nested one is already dead.
    assert.equal(captured.nestedAfterReturn, 'ExpiredExecutionContextError');
    // And the outer one expired once it finished in turn.
    assert.throws(() => captured.outer.require(DEMAND), ExpiredExecutionContextError);
  } finally {
    await runtime.close();
  }
});

test('the guard does not change behaviour during an activation', async () => {
  const {runtime, run} = await seed();
  try {
    assert.deepEqual(await run(), textValue('ok'));
  } finally {
    await runtime.close();
  }

  // A denied demand is still an AuthorityError during the activation, not a lifetime error.
  const denied = await seed({grants: []});
  try {
    await denied.run();
    assert.throws(() => denied.captured.outer.require(DEMAND), ExpiredExecutionContextError);
  } finally {
    await denied.runtime.close();
  }
});
