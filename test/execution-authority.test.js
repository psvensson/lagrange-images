import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthorityError,
  bytesValue,
  createAuthorityService,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';

// A narrowly scoped host resource, standing in for the eventual declared host import. It is
// runtime-local and deliberately boring: the point is the authority check, not the data.
const HOST_VALUES = Object.freeze({
  'public-message': 'hello',
  'private-message': 'secret',
});
const READ = 'host-value/read';

const PROBE = 'authority-probe/v0';

// The probe executor stands in for a capability-bearing host import. It closes over nothing
// but `require` from its execution context: no authority object, no grant, no principal.
function createProbeExecutor() {
  return Object.freeze({
    async execute({activation, code}, context) {
      const plan = JSON.parse(code.content.value);

      if (plan.forward) {
        // A nested send. `attenuate` is a request; the executor never receives the resulting
        // context, and cannot observe what it became.
        return await context.sendMessage(
          {
            languageId: 'probe-language',
            receiver: objectRef('demo', plan.forward),
            message: textValue(plan.forward),
            arguments: [],
          },
          plan.attenuate ? {attenuate: plan.attenuate} : {},
        );
      }

      // Deliberately in this order: authorization is checked before the resource is touched.
      context.require({operation: READ, resource: plan.resource});
      return textValue(HOST_VALUES[plan.resource]);
    },
  });
}

async function seed({grants = null, principal = 'alice'} = {}) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    codeExecutors: {[PROBE]: createProbeExecutor()},
    // A trivial dispatcher so nested sends need no language personality.
    dispatchers: {
      'probe-language': {
        async resolveMessage(request) {
          return {block: objectRef('demo', request.message.value)};
        },
      },
    },
  });
  await runtime.images.createImage({id: 'demo'});

  const install = async (id, plan) => {
    const code = await runtime.images.putCodeArtifact('demo', {
      id: `${id}-code`, representation: PROBE, content: textValue(JSON.stringify(plan)),
    });
    await runtime.images.putBlock('demo', {
      id, code: objectRef('demo', code.id), environment: null,
    });
    return objectRef('demo', id);
  };

  const blocks = {
    readPublic: await install('read-public', {resource: 'public-message'}),
    readPrivate: await install('read-private', {resource: 'private-message'}),
    forwardPublic: await install('forward-public', {forward: 'read-public'}),
    forwardPrivate: await install('forward-private', {forward: 'read-private'}),
    forwardAttenuatedToPublic: await install('forward-attenuated', {
      forward: 'read-public', attenuate: [{operation: READ, resource: 'public-message'}],
    }),
    forwardAttenuatedToPrivate: await install('forward-attenuated-private', {
      forward: 'read-private', attenuate: [{operation: READ, resource: 'public-message'}],
    }),
    forwardEscalating: await install('forward-escalating', {
      forward: 'read-private', attenuate: [{operation: READ, resource: 'private-message'}],
    }),
  };

  const context = grants === null ? null : authority.issue({principal, grants});
  const call = async (blockRef) => {
    const activation = await runtime.invocations.invokeBlock(blockRef, []);
    return await runtime.executor.execute(activation, context === null ? {} : {authority: context});
  };
  return {runtime, authority, context, blocks, call};
}

// Case 1
test('an execution with no authority context has no capabilities', async () => {
  const {runtime, call, blocks} = await seed({grants: null});
  try {
    await assert.rejects(call(blocks.readPublic), /no authority context was supplied/);
  } finally {
    await runtime.close();
  }
});

// Cases 2 and 3
test('authority is checked per concrete resource, not per operation', async () => {
  const {runtime, call, blocks} = await seed({
    grants: [{operation: READ, resource: 'public-message'}],
  });
  try {
    assert.deepEqual(await call(blocks.readPublic), textValue('hello'));
    // Same context, same operation, different resource.
    await assert.rejects(call(blocks.readPrivate), /not authorized: host-value\/read on private-message/);
  } finally {
    await runtime.close();
  }
});

// Case 6
test('a nested send inherits the authority of its caller', async () => {
  const {runtime, call, blocks} = await seed({
    grants: [{operation: READ, resource: 'public-message'}],
  });
  try {
    assert.deepEqual(await call(blocks.forwardPublic), textValue('hello'));
    // Inheriting does not mean widening: the nested send is still bound by the same grants.
    await assert.rejects(call(blocks.forwardPrivate), /not authorized: host-value\/read on private-message/);
  } finally {
    await runtime.close();
  }
});

// Case 7
test('attenuation narrows a nested send and can never widen it', async () => {
  const {runtime, call, blocks} = await seed({
    grants: [
      {operation: READ, resource: 'public-message'},
      {operation: READ, resource: 'private-message'},
    ],
  });
  try {
    // The caller holds both grants, so it can read either directly.
    assert.deepEqual(await call(blocks.readPrivate), textValue('secret'));

    // Attenuated to public only: the nested send keeps the right it was given...
    assert.deepEqual(await call(blocks.forwardAttenuatedToPublic), textValue('hello'));
    // ...and has lost the one it was not.
    await assert.rejects(call(blocks.forwardAttenuatedToPrivate),
      /not authorized: host-value\/read on private-message/);
  } finally {
    await runtime.close();
  }

  // Attenuation cannot request a grant the parent does not hold, so a nested send cannot
  // recover a right its caller lacked.
  const narrow = await seed({grants: [{operation: READ, resource: 'public-message'}]});
  try {
    await assert.rejects(narrow.call(narrow.blocks.forwardEscalating),
      /attenuation may only narrow/);
  } finally {
    await narrow.runtime.close();
  }
});

// Case 8
test('no authority context, principal or grant becomes a Value or durable graph state', async () => {
  const {runtime, authority, context, call, blocks} = await seed({
    grants: [{operation: READ, resource: 'public-message'}],
    principal: 'alice',
  });
  try {
    const result = await call(blocks.readPublic);
    // Every execution result is a canonical Value, and no Value kind can hold authority.
    assert.deepEqual(Object.keys(result).sort(), ['kind', 'value']);
    assert.equal(result.kind, 'text');

    // The context is an empty opaque object: nothing to read, stash or serialize.
    assert.deepEqual(Object.keys(context), []);
    assert.equal(JSON.stringify(context), '{}');

    // The principal is reachable only through the service, for host-side audit.
    assert.equal(authority.principalOf(context), 'alice');

    // Nothing authority-shaped is anywhere in the durable graph.
    const graph = JSON.stringify(await runtime.images.getImage('demo'));
    for (const leak of ['alice', 'authority', 'principal', 'capabilit', 'grant']) {
      assert.ok(!graph.toLowerCase().includes(leak), `durable graph leaked ${leak}`);
    }

    // An authority context is not a Value and cannot be coerced into one.
    assert.throws(() => bytesValue(context), /ArrayBuffer|typed-array/);
  } finally {
    await runtime.close();
  }
});

test('the executor context exposes require and nothing else authority-shaped', async () => {
  const seen = {};
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority: createAuthorityService(),
    codeExecutors: {
      [PROBE]: {
        async execute(_input, context) {
          Object.assign(seen, {keys: Object.keys(context).sort()});
          return textValue('ok');
        },
      },
    },
  });
  try {
    await runtime.images.createImage({id: 'demo'});
    const code = await runtime.images.putCodeArtifact('demo', {
      id: 'c', representation: PROBE, content: textValue('{}'),
    });
    await runtime.images.putBlock('demo', {id: 'b', code: objectRef('demo', code.id), environment: null});
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'b'), []);
    await runtime.executor.execute(activation);

    assert.ok(seen.keys.includes('require'), 'executors must be able to ask');
    // No authority object, no service, no principal, no grant, no context.
    for (const forbidden of ['authority', 'authorityContext', 'principal', 'grants', 'context', 'attenuate']) {
      assert.ok(!seen.keys.includes(forbidden),
        `executor context must not expose ${forbidden}: ${seen.keys.join(', ')}`);
    }
  } finally {
    await runtime.close();
  }
});

test('the v0 grant algebra is exact-match, with no wildcards or hierarchy', async () => {
  const authority = createAuthorityService();
  const context = authority.issue({
    principal: 'alice',
    grants: [{operation: READ, resource: 'public-message'}],
  });

  assert.equal(authority.require(context, {operation: READ, resource: 'public-message'}), undefined,
    'require is check-only and returns nothing to stash');

  // None of these is "narrower" in the exact-match algebra, so none is permitted.
  for (const resource of ['*', 'public-message/child', 'public', 'PUBLIC-MESSAGE', 'public-message ']) {
    assert.throws(() => authority.require(context, {operation: READ, resource}), AuthorityError);
  }
  assert.throws(() => authority.require(context, {operation: '*', resource: 'public-message'}), AuthorityError);
  assert.throws(() => authority.require(context, {operation: 'host-value/write', resource: 'public-message'}),
    AuthorityError);

  // A demand is exactly an operation and a resource; nothing else is accepted.
  assert.throws(() => authority.require(context, {operation: READ}), /exactly operation, resource/);
  assert.throws(() => authority.require(context, {operation: READ, resource: 'x', extra: 1}),
    /exactly operation, resource/);
});

test('a context the service did not mint is rejected rather than interpreted', async () => {
  const authority = createAuthorityService();
  const forged = Object.freeze({});
  const alsoForged = Object.freeze({capabilities: ['everything']});

  for (const candidate of [forged, alsoForged, null, undefined, 'alice', 42]) {
    assert.throws(() => authority.require(candidate, {operation: READ, resource: 'public-message'}),
      AuthorityError, `forged context accepted: ${JSON.stringify(candidate)}`);
  }

  // Nor may a context from one service authorize against another.
  const other = createAuthorityService();
  const context = other.issue({principal: 'alice', grants: [{operation: READ, resource: 'public-message'}]});
  assert.throws(() => authority.require(context, {operation: READ, resource: 'public-message'}),
    /not issued by this service/);
});

test('revoking a context also stops every context attenuated from it', async () => {
  const authority = createAuthorityService();
  const grants = [{operation: READ, resource: 'public-message'}];
  const parent = authority.issue({principal: 'alice', grants});
  const child = authority.attenuate(parent, {grants});
  const grandchild = authority.attenuate(child, {grants});

  const demand = {operation: READ, resource: 'public-message'};
  for (const context of [parent, child, grandchild]) authority.require(context, demand);

  authority.revoke(parent);
  for (const context of [parent, child, grandchild]) {
    assert.throws(() => authority.require(context, demand), /authority revoked/);
  }
  assert.throws(() => authority.attenuate(parent, {grants}), /cannot attenuate a revoked/);
});
