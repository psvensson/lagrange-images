import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_MUTATION_BINDING_V1,
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  ObjectMutationConflictError,
  booleanValue,
  createAuthorityService,
  createRuntime,
  installCallableInterfaceV2,
  installImageMutationBinding,
  installImageProjectionBinding,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  objectVersionToken,
  packCompositeValue,
  parseObjectVersionToken,
  textValue,
  unpackCompositeValue,
} from '../src/runtime.js';

const ITEM_TYPES = normalizeTypeDeclarations({
  item: {
    kind: 'record',
    fields: [
      {name: 'name', type: 'string'},
      {name: 'quantity', type: 's64'},
    ],
  },
});
// Deliberately a subset of the shape's slots, so preservation of unmapped slots is observable.
const ITEM_FIELDS = [
  {name: 'name', slot: 'slot-name'},
  {name: 'quantity', slot: 'slot-quantity'},
];

const writeGrant = (objectId) => ({operation: OBJECT_WRITE_OPERATION, resource: objectResource('demo', objectId)});
const readGrant = (objectId) => ({operation: OBJECT_READ_OPERATION, resource: objectResource('demo', objectId)});

async function seed({grants = null, objects = ['counter']} = {}) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority});
  await runtime.images.createImage({id: 'demo'});
  const shape = await runtime.images.putShape('demo', {
    id: 'item-shape',
    slots: [
      {id: 'slot-name', name: 'name'},
      {id: 'slot-quantity', name: 'quantity'},
      {id: 'slot-note', name: 'note'},
    ],
  });
  const stored = {};
  for (const id of objects) {
    stored[id] = await runtime.images.putObject('demo', {
      id, shape: objectRef('demo', shape.id),
      slots: {
        'slot-name': textValue(`${id}-name`),
        'slot-quantity': integerValue(1),
        'slot-note': textValue('untouched'),
      },
    });
  }

  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'write-item',
    functionName: 'write-item', parameters: ['string', 'string', 'item'], result: 'string', types: ITEM_TYPES,
  });
  const binding = await installImageMutationBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', callableInterface.id),
    fields: ITEM_FIELDS, bindingId: 'mutation', blockId: 'mutation-block',
  });

  const context = grants === null ? null : authority.issue({principal: 'alice', grants});
  const write = async (objectId, token, value) => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'mutation-block'), [
      textValue(objectId), textValue(token), packCompositeValue(value, 'item', ITEM_TYPES),
    ]);
    return await runtime.executor.execute(activation, context === null ? {} : {authority: context});
  };
  const tokenFor = (objectId) => objectVersionToken('demo', objectId, stored[objectId]._version);
  const historyLength = async () => (await runtime.images.history('demo')).length;
  return {runtime, authority, context, binding, write, tokenFor, stored, historyLength, shape};
}

// Case 1
test('mutation is denied without authority, and nothing is read or written', async () => {
  const {runtime, write, tokenFor} = await seed({grants: null});
  try {
    await assert.rejects(write('counter', tokenFor('counter'), {name: 'x', quantity: 2n}),
      /no authority context was supplied/);
    const object = await runtime.images.getObject('demo', 'counter');
    assert.deepEqual(object.slots['slot-name'], textValue('counter-name'));
  } finally {
    await runtime.close();
  }
});

// Cases 2 and 3 — the corrected authority rule.
test('object/write alone suffices; object/read alone does not', async () => {
  // A write-only capability is real: no object/read grant at all.
  const writeOnly = await seed({grants: [writeGrant('counter')]});
  try {
    const next = await writeOnly.write('counter', writeOnly.tokenFor('counter'), {name: 'renamed', quantity: 5n});
    assert.equal(next.kind, 'text');
    const object = await writeOnly.runtime.images.getObject('demo', 'counter');
    assert.deepEqual(object.slots['slot-name'], textValue('renamed'));
  } finally {
    await writeOnly.runtime.close();
  }

  const readOnly = await seed({grants: [readGrant('counter')]});
  try {
    await assert.rejects(readOnly.write('counter', readOnly.tokenFor('counter'), {name: 'x', quantity: 2n}),
      /not authorized: object\/write/);
  } finally {
    await readOnly.runtime.close();
  }
});

// Cases 4 and 7
test('a matching token commits, returns the next token, and preserves unmapped slots', async () => {
  const {runtime, write, tokenFor} = await seed({grants: [writeGrant('counter')]});
  try {
    const next = await write('counter', tokenFor('counter'), {name: 'renamed', quantity: 42n});

    const object = await runtime.images.getObject('demo', 'counter');
    assert.deepEqual(object.slots['slot-name'], textValue('renamed'));
    assert.deepEqual(object.slots['slot-quantity'], integerValue(42));
    // Unmapped, therefore preserved rather than cleared.
    assert.deepEqual(object.slots['slot-note'], textValue('untouched'));

    // The returned token is the object's new token, and chains into a second mutation.
    assert.equal(parseObjectVersionToken(next.value, 'demo', 'counter'), object._version);
    const second = await write('counter', next.value, {name: 'again', quantity: 43n});
    assert.notEqual(second.value, next.value);
  } finally {
    await runtime.close();
  }
});

// Case 5 — strict.
test('a stale token conflicts and changes absolutely nothing', async () => {
  const {runtime, write, tokenFor, historyLength} = await seed({grants: [writeGrant('counter')]});
  try {
    const stale = tokenFor('counter');
    await write('counter', stale, {name: 'first', quantity: 10n});

    const before = await runtime.images.getObject('demo', 'counter');
    const historyBefore = await historyLength();

    await assert.rejects(write('counter', stale, {name: 'second', quantity: 99n}),
      ObjectMutationConflictError);

    const after = await runtime.images.getObject('demo', 'counter');
    // Not merely "an error was raised": the slots, the stored version and the history are all
    // exactly as they were.
    assert.deepEqual(after.slots, before.slots);
    assert.equal(after._version, before._version);
    assert.equal(await historyLength(), historyBefore);
  } finally {
    await runtime.close();
  }
});

test('a conflict never exposes the backend version or a replacement token', async () => {
  const {runtime, write, tokenFor} = await seed({grants: [writeGrant('counter')]});
  try {
    const stale = tokenFor('counter');
    await write('counter', stale, {name: 'first', quantity: 10n});
    const error = await write('counter', stale, {name: 'second', quantity: 2n}).then(() => null, (e) => e);

    assert.ok(error instanceof ObjectMutationConflictError);
    // The backend error carries collection, key, expectedVersion and actualVersion, and puts
    // both numbers in its message. None of that may survive translation.
    assert.equal(error.cause, undefined, 'attaching the cause would leave actualVersion reachable');
    for (const leaked of ['actualVersion', 'expectedVersion', 'collection', 'key']) {
      assert.equal(error[leaked], undefined, `conflict error exposed ${leaked}`);
    }
    assert.ok(!/\d+/.test(error.message.replace(/v0|v1/g, '')), `conflict message leaked a number: ${error.message}`);
  } finally {
    await runtime.close();
  }
});

// The cross-object token test.
test("a token for one object cannot mutate another sitting at the same version", async () => {
  const {runtime, write, tokenFor, historyLength} = await seed({
    grants: [writeGrant('a'), writeGrant('b')],
    objects: ['a', 'b'],
  });
  try {
    // Both were created identically, so both are at the same backend version. An unscoped
    // token would have matched, and the compare-and-set would have silently succeeded against
    // an object the caller never meant to name.
    const beforeB = await runtime.images.getObject('demo', 'b');
    const historyBefore = await historyLength();
    assert.equal((await runtime.images.getObject('demo', 'a'))._version, beforeB._version);

    await assert.rejects(write('b', tokenFor('a'), {name: 'hijacked', quantity: 7n}),
      /issued for a different object/);

    const afterB = await runtime.images.getObject('demo', 'b');
    assert.deepEqual(afterB.slots, beforeB.slots);
    assert.equal(afterB._version, beforeB._version);
    assert.equal(await historyLength(), historyBefore);
  } finally {
    await runtime.close();
  }
});

// Case 6
test('revoking between two mutations fails the second and commits nothing', async () => {
  const {runtime, authority, context, write, tokenFor, historyLength} = await seed({
    grants: [writeGrant('counter')],
  });
  try {
    const next = await write('counter', tokenFor('counter'), {name: 'first', quantity: 1n});
    const before = await runtime.images.getObject('demo', 'counter');
    const historyBefore = await historyLength();

    authority.revoke(context);
    await assert.rejects(write('counter', next.value, {name: 'second', quantity: 2n}), /authority revoked/);

    const after = await runtime.images.getObject('demo', 'counter');
    assert.deepEqual(after.slots, before.slots);
    assert.equal(after._version, before._version);
    assert.equal(await historyLength(), historyBefore);
  } finally {
    await runtime.close();
  }
});

test('a malformed token is rejected rather than interpreted, before anything is written', async () => {
  const {runtime, write, historyLength} = await seed({grants: [writeGrant('counter')]});
  try {
    const historyBefore = await historyLength();
    for (const token of ['', '3', 'object-version/v0:x', 'object-version/v1:a.b:Mw', 'nonsense']) {
      await assert.rejects(write('counter', token, {name: 'x', quantity: 2n}),
        /malformed|different object|non-empty/);
    }
    assert.equal(await historyLength(), historyBefore, 'a rejected token must write nothing');
  } finally {
    await runtime.close();
  }
});

// Case 8
test('a value violating the declared field type is rejected before any write', async () => {
  const {runtime, tokenFor, historyLength, runtime: rt} = await seed({grants: [writeGrant('counter')]});
  try {
    const historyBefore = await historyLength();
    // s64 declared, text supplied: the composite codec refuses to pack it at all.
    assert.throws(() => packCompositeValue({name: 'x', quantity: 'seven'}, 'item', ITEM_TYPES),
      /must be an integer/);
    assert.equal(await historyLength(), historyBefore);
    void tokenFor; void rt;
  } finally {
    await runtime.close();
  }
});

// Case 9
test('a mapped slot holding a ref is rejected, never written through', async () => {
  const {runtime, write, tokenFor, historyLength} = await seed({grants: [writeGrant('counter')]});
  try {
    // Put a ref into a mapped slot out of band, then attempt a mutation over it.
    const shape = await runtime.images.putShape('demo', {
      id: 'ref-shape', slots: [{id: 'slot-name', name: 'name'}, {id: 'slot-quantity', name: 'quantity'}],
    });
    await runtime.images.putObject('demo', {
      id: 'linked', shape: objectRef('demo', shape.id),
      slots: {'slot-name': objectRef('demo', 'counter'), 'slot-quantity': integerValue(1)},
    });
    const historyBefore = await historyLength();
    const token = objectVersionToken('demo', 'linked', (await runtime.images.getObject('demo', 'linked'))._version);
    const context = runtime.authority.issue({principal: 'alice', grants: [writeGrant('linked')]});
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'mutation-block'), [
      textValue('linked'), textValue(token), packCompositeValue({name: 'x', quantity: 2n}, 'item', ITEM_TYPES),
    ]);
    await assert.rejects(runtime.executor.execute(activation, {authority: context}),
      /never writes through refs/);
    assert.equal(await historyLength(), historyBefore);
    void write; void tokenFor;
  } finally {
    await runtime.close();
  }
});

// Case 10
test('state and history commit together', async () => {
  const {runtime, write, tokenFor, historyLength} = await seed({grants: [writeGrant('counter')]});
  try {
    const before = await historyLength();
    await write('counter', tokenFor('counter'), {name: 'renamed', quantity: 3n});
    const after = await historyLength();
    assert.equal(after, before + 1, 'exactly one history event accompanies one committed write');
    const events = await runtime.images.history('demo');
    assert.equal(events.at(-1).type, 'object.put');
    assert.equal(events.at(-1).objectId, 'counter');
  } finally {
    await runtime.close();
  }
});

// Cases 11 and 12
test('the mutation Block writes only its own image, and its binding carries nothing authority-shaped', async () => {
  const {runtime, binding, write, tokenFor} = await seed({grants: [writeGrant('counter')]});
  try {
    // A same-named object elsewhere is unreachable: the caller supplies only an id.
    await runtime.images.createImage({id: 'elsewhere'});
    const shape = await runtime.images.putShape('elsewhere', {id: 's', slots: [{id: 'slot-name', name: 'name'}]});
    await runtime.images.putObject('elsewhere', {
      id: 'counter', shape: objectRef('elsewhere', shape.id), slots: {'slot-name': textValue('OTHER')},
    });
    await write('counter', tokenFor('counter'), {name: 'renamed', quantity: 4n});
    assert.deepEqual(
      (await runtime.images.getObject('elsewhere', 'counter')).slots['slot-name'],
      textValue('OTHER'),
    );

    const descriptor = JSON.parse(binding.bindingArtifact.content.value);
    assert.deepEqual(Object.keys(descriptor).sort(), ['abi', 'fields']);
    const serialised = JSON.stringify(binding.bindingArtifact).toLowerCase();
    for (const leak of ['alice', 'principal', 'grant', 'authority', 'object/write', 'counter']) {
      assert.ok(!serialised.includes(leak), `binding leaked ${leak}`);
    }
    assert.deepEqual(binding.bindingArtifact.dependencies.map(({role}) => role), ['interface']);
    assert.equal(binding.bindingArtifact.representation, IMAGE_MUTATION_BINDING_V1);
  } finally {
    await runtime.close();
  }
});

// Case 14
test('projection remains unchanged and composes with mutation', async () => {
  const {runtime, write, tokenFor} = await seed({grants: [writeGrant('counter'), readGrant('counter')]});
  try {
    const projectionInterface = await installCallableInterfaceV2({
      images: runtime.images, imageId: 'demo', interfaceId: 'read-item',
      functionName: 'read-item', parameters: ['string'], result: 'item', types: ITEM_TYPES,
    });
    const projection = await installImageProjectionBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', projectionInterface.id),
      fields: ITEM_FIELDS, bindingId: 'projection', blockId: 'projection-block',
    });
    const context = runtime.authority.issue({
      principal: 'alice', grants: [writeGrant('counter'), readGrant('counter')],
    });
    const project = async () => {
      const activation = await runtime.invocations.invokeBlock(
        objectRef('demo', projection.block.id), [textValue('counter')],
      );
      return unpackCompositeValue(
        await runtime.executor.execute(activation, {authority: context}), 'item', ITEM_TYPES,
      );
    };

    assert.deepEqual(await project(), {name: 'counter-name', quantity: 1n});
    await write('counter', tokenFor('counter'), {name: 'mutated', quantity: 8n});
    assert.deepEqual(await project(), {name: 'mutated', quantity: 8n});
  } finally {
    await runtime.close();
  }
});

test('v1 rejects an interface shape it cannot mutate', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority: createAuthorityService()});
  try {
    await runtime.images.createImage({id: 'demo'});
    const install = async (id, options) => {
      const callableInterface = await installCallableInterfaceV2({
        images: runtime.images, imageId: 'demo', interfaceId: id, functionName: 'f', ...options,
      });
      return await installImageMutationBinding({
        images: runtime.images,
        callableInterface: objectRef('demo', callableInterface.id),
        fields: ITEM_FIELDS, bindingId: `${id}-b`, blockId: `${id}-bl`,
      });
    };
    await assert.rejects(install('bad-params', {
      parameters: ['string', 'item'], result: 'string', types: ITEM_TYPES,
    }), /requires parameters \(object-id/);
    await assert.rejects(install('bad-result', {
      parameters: ['string', 'string', 'item'], result: 'item', types: ITEM_TYPES,
    }), /must return the next version token as string/);
    await assert.rejects(install('nested', {
      parameters: ['string', 'string', 'nested'], result: 'string', types: {
        nested: {kind: 'record', fields: [{name: 'items', type: {kind: 'list', element: 'string'}}]},
      },
    }), /must be a leaf type; v1 does not write nested values/);
  } finally {
    await runtime.close();
  }
});
