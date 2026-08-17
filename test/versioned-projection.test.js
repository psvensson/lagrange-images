import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_PROJECTION_BINDING_V1,
  IMAGE_VERSIONED_PROJECTION_BINDING_V1,
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  ObjectMutationConflictError,
  createAuthorityService,
  createRuntime,
  installCallableInterfaceV2,
  installImageMutationBinding,
  installImageProjectionBinding,
  installImageVersionedProjectionBinding,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  packCompositeValue,
  parseObjectVersionToken,
  textValue,
  unpackCompositeValue,
} from '../src/runtime.js';

const TYPES = normalizeTypeDeclarations({
  item: {
    kind: 'record',
    fields: [
      {name: 'name', type: 'string'},
      {name: 'quantity', type: 's64'},
    ],
  },
  'versioned-item': {
    kind: 'record',
    fields: [
      {name: 'version-token', type: 'string'},
      {name: 'value', type: 'item'},
    ],
  },
});
const FIELDS = [
  {name: 'name', slot: 'slot-name'},
  {name: 'quantity', slot: 'slot-quantity'},
];

const readGrant = (id) => ({operation: OBJECT_READ_OPERATION, resource: objectResource('demo', id)});
const writeGrant = (id) => ({operation: OBJECT_WRITE_OPERATION, resource: objectResource('demo', id)});

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
  for (const id of objects) {
    await runtime.images.putObject('demo', {
      id, shape: objectRef('demo', shape.id),
      slots: {
        'slot-name': textValue(`${id}-name`),
        'slot-quantity': integerValue(1),
        'slot-note': textValue('untouched'),
      },
    });
  }

  const readInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'read-versioned',
    functionName: 'read-versioned-item', parameters: ['string'], result: 'versioned-item', types: TYPES,
  });
  const versioned = await installImageVersionedProjectionBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', readInterface.id),
    fields: FIELDS, bindingId: 'versioned', blockId: 'versioned-block',
  });
  const writeInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'write-item',
    functionName: 'write-item', parameters: ['string', 'string', 'item'], result: 'string', types: TYPES,
  });
  const mutation = await installImageMutationBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', writeInterface.id),
    fields: FIELDS, bindingId: 'mutation', blockId: 'mutation-block',
  });

  const context = grants === null ? null : authority.issue({principal: 'alice', grants});
  const options = () => (context === null ? {} : {authority: context});
  const readVersioned = async (objectId) => {
    const activation = await runtime.invocations.invokeBlock(
      objectRef('demo', 'versioned-block'), [textValue(objectId)],
    );
    const packed = await runtime.executor.execute(activation, options());
    return unpackCompositeValue(packed, 'versioned-item', TYPES);
  };
  const write = async (objectId, token, value) => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'mutation-block'), [
      textValue(objectId), textValue(token), packCompositeValue(value, 'item', TYPES),
    ]);
    return await runtime.executor.execute(activation, options());
  };
  const historyLength = async () => (await runtime.images.history('demo')).length;
  return {runtime, authority, context, versioned, mutation, readVersioned, write, historyLength, shape};
}

// Case 1
test('without object/read there is no value, no token and no existence leak', async () => {
  const {runtime, readVersioned} = await seed({grants: null});
  try {
    await assert.rejects(readVersioned('counter'), /no authority context was supplied/);
    // Not even for an object that does not exist: the failure is identical.
    await assert.rejects(readVersioned('no-such-object'), /no authority context was supplied/);
  } finally {
    await runtime.close();
  }

  const wrong = await seed({grants: [readGrant('other')]});
  try {
    await assert.rejects(wrong.readVersioned('counter'), /not authorized: object\/read/);
  } finally {
    await wrong.runtime.close();
  }
});

// Case 2
test('a versioned read returns the projected value and a token for that same stored version', async () => {
  const {runtime, readVersioned} = await seed({grants: [readGrant('counter')]});
  try {
    const result = await readVersioned('counter');
    assert.deepEqual(Object.keys(result).sort(), ['value', 'version-token']);
    assert.deepEqual(result.value, {name: 'counter-name', quantity: 1n});

    const stored = await runtime.images.getObject('demo', 'counter');
    // Both halves came from one read, so the token describes exactly the state of the value.
    assert.equal(parseObjectVersionToken(result['version-token'], 'demo', 'counter'), stored._version);
  } finally {
    await runtime.close();
  }
});

// Case 3
test('the token is accepted directly by the mutation lane', async () => {
  const {runtime, readVersioned, write} = await seed({
    grants: [readGrant('counter'), writeGrant('counter')],
  });
  try {
    const {'version-token': token, value} = await readVersioned('counter');
    const next = await write('counter', token, {...value, name: 'renamed'});
    assert.equal(next.kind, 'text');
    assert.deepEqual(
      (await runtime.images.getObject('demo', 'counter')).slots['slot-name'],
      textValue('renamed'),
    );
  } finally {
    await runtime.close();
  }
});

// Case 4 — the complete cycle.
test('read, modify, write, then chain again on the returned token', async () => {
  const {runtime, readVersioned, write} = await seed({
    grants: [readGrant('counter'), writeGrant('counter')],
  });
  try {
    const first = await readVersioned('counter');
    const t2 = await write('counter', first['version-token'], {...first.value, quantity: 2n});
    // The token returned by the mutation chains without another read.
    const t3 = await write('counter', t2.value, {name: 'third', quantity: 3n});
    assert.notEqual(t2.value, t3.value);

    const object = await runtime.images.getObject('demo', 'counter');
    assert.deepEqual(object.slots['slot-name'], textValue('third'));
    assert.deepEqual(object.slots['slot-quantity'], integerValue(3));
    // Unmapped slot untouched throughout.
    assert.deepEqual(object.slots['slot-note'], textValue('untouched'));
    // And a fresh read agrees with the last token issued.
    const again = await readVersioned('counter');
    assert.equal(again['version-token'], t3.value);
  } finally {
    await runtime.close();
  }
});

// Case 5
test('a concurrent mutation after the read makes the original token conflict', async () => {
  const {runtime, readVersioned, write, historyLength} = await seed({
    grants: [readGrant('counter'), writeGrant('counter')],
  });
  try {
    const stale = await readVersioned('counter');
    // Someone else writes in between.
    await write('counter', stale['version-token'], {name: 'winner', quantity: 10n});

    const before = await runtime.images.getObject('demo', 'counter');
    const historyBefore = await historyLength();
    await assert.rejects(write('counter', stale['version-token'], {name: 'loser', quantity: 99n}),
      ObjectMutationConflictError);

    const after = await runtime.images.getObject('demo', 'counter');
    assert.deepEqual(after.slots, before.slots);
    assert.equal(after._version, before._version);
    assert.equal(await historyLength(), historyBefore);
  } finally {
    await runtime.close();
  }
});

// Case 6
test("a token read from one object cannot mutate another at the same version", async () => {
  const {runtime, readVersioned, write, historyLength} = await seed({
    grants: [readGrant('a'), writeGrant('a'), readGrant('b'), writeGrant('b')],
    objects: ['a', 'b'],
  });
  try {
    const a = await readVersioned('a');
    const b = await readVersioned('b');
    // Created identically, so their backend versions match: an unscoped token would have matched.
    assert.equal(
      parseObjectVersionToken(a['version-token'], 'demo', 'a'),
      parseObjectVersionToken(b['version-token'], 'demo', 'b'),
    );
    assert.notEqual(a['version-token'], b['version-token'], 'tokens must be object-scoped');

    const beforeB = await runtime.images.getObject('demo', 'b');
    const historyBefore = await historyLength();
    await assert.rejects(write('b', a['version-token'], {name: 'hijacked', quantity: 7n}),
      /issued for a different object/);

    const afterB = await runtime.images.getObject('demo', 'b');
    assert.deepEqual(afterB.slots, beforeB.slots);
    assert.equal(afterB._version, beforeB._version);
    assert.equal(await historyLength(), historyBefore);
  } finally {
    await runtime.close();
  }
});

// Case 7
test('versioned projection keeps ADR 0039 rules: refs refused, typing enforced', async () => {
  const {runtime, readVersioned, shape} = await seed({grants: [readGrant('linked'), readGrant('narrow')]});
  try {
    await runtime.images.putObject('demo', {
      id: 'linked', shape: objectRef('demo', shape.id),
      slots: {
        'slot-name': objectRef('demo', 'counter'),
        'slot-quantity': integerValue(1),
        'slot-note': textValue('x'),
      },
    });
    await assert.rejects(readVersioned('linked'), /never follows refs/);

    // A mapped slot the object's shape does not declare is an error, not a default.
    const narrowShape = await runtime.images.putShape('demo', {
      id: 'narrow-shape', slots: [{id: 'slot-name', name: 'name'}],
    });
    await runtime.images.putObject('demo', {
      id: 'narrow', shape: objectRef('demo', narrowShape.id), slots: {'slot-name': textValue('x')},
    });
    await assert.rejects(readVersioned('narrow'), /has no slot slot-quantity for field quantity/);
  } finally {
    await runtime.close();
  }
});

// Case 8
test('ordinary projection v1 is untouched and stays version-free', async () => {
  const {runtime} = await seed({grants: [readGrant('counter')]});
  try {
    const plainInterface = await installCallableInterfaceV2({
      images: runtime.images, imageId: 'demo', interfaceId: 'read-plain',
      functionName: 'read-item', parameters: ['string'], result: 'item', types: TYPES,
    });
    const plain = await installImageProjectionBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', plainInterface.id),
      fields: FIELDS, bindingId: 'plain', blockId: 'plain-block',
    });
    assert.equal(plain.bindingArtifact.representation, IMAGE_PROJECTION_BINDING_V1);

    const context = runtime.authority.issue({principal: 'alice', grants: [readGrant('counter')]});
    const activation = await runtime.invocations.invokeBlock(
      objectRef('demo', plain.block.id), [textValue('counter')],
    );
    const projected = unpackCompositeValue(
      await runtime.executor.execute(activation, {authority: context}), 'item', TYPES,
    );
    // Exactly the record, with no token field grafted on.
    assert.deepEqual(Object.keys(projected).sort(), ['name', 'quantity']);
  } finally {
    await runtime.close();
  }
});

// Case 9
test('the token is opaque text and no backend version escapes', async () => {
  const {runtime, readVersioned, versioned} = await seed({grants: [readGrant('counter')]});
  try {
    const result = await readVersioned('counter');
    const token = result['version-token'];
    assert.equal(typeof token, 'string');
    // No raw version anywhere in the returned pair.
    const shown = JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? String(v) : v));
    assert.equal(shown.includes('_version'), false);
    assert.match(token, /^object-version\/v0:/);
    // The decimal version is not readable from the token without the codec.
    const stored = await runtime.images.getObject('demo', 'counter');
    assert.ok(!token.includes(`:${stored._version}`), 'the token must not embed a bare decimal version');

    // The binding's durable content carries no version at all. Checked on the content rather
    // than the whole artifact, because every stored record carries its own `_version` and that
    // is the artifact's storage metadata, not the projected object's version.
    const content = versioned.bindingArtifact.content.value.toLowerCase();
    for (const leak of ['_version', 'object-version', 'counter']) {
      assert.ok(!content.includes(leak), `binding content leaked ${leak}`);
    }
    const serialised = JSON.stringify(versioned.bindingArtifact).toLowerCase();
    for (const leak of ['alice', 'principal', 'grant', 'authority']) {
      assert.ok(!serialised.includes(leak), `binding leaked ${leak}`);
    }
    assert.equal(versioned.bindingArtifact.representation, IMAGE_VERSIONED_PROJECTION_BINDING_V1);
  } finally {
    await runtime.close();
  }
});

// Case 10
test('a versioned read has no durable effect', async () => {
  const {runtime, readVersioned, historyLength} = await seed({grants: [readGrant('counter')]});
  try {
    const before = await runtime.images.getObject('demo', 'counter');
    const historyBefore = await historyLength();

    await readVersioned('counter');
    await readVersioned('counter');

    const after = await runtime.images.getObject('demo', 'counter');
    assert.deepEqual(after.slots, before.slots);
    assert.equal(after._version, before._version, 'a read must not advance the version');
    assert.equal(await historyLength(), historyBefore, 'a read must append no history event');
  } finally {
    await runtime.close();
  }
});

test('v1 rejects a result shape it cannot produce', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority: createAuthorityService()});
  try {
    await runtime.images.createImage({id: 'demo'});
    const install = async (id, options) => {
      const callableInterface = await installCallableInterfaceV2({
        images: runtime.images, imageId: 'demo', interfaceId: id, functionName: 'f', ...options,
      });
      return await installImageVersionedProjectionBinding({
        images: runtime.images,
        callableInterface: objectRef('demo', callableInterface.id),
        fields: FIELDS, bindingId: `${id}-b`, blockId: `${id}-bl`,
      });
    };
    // A plain record result is the ordinary projection's shape, not this one's.
    await assert.rejects(install('plain', {parameters: ['string'], result: 'item', types: TYPES}),
      /must declare exactly version-token then value/);
    // Field order is part of the type, so a swapped wrapper is a different type.
    await assert.rejects(install('swapped', {
      parameters: ['string'], result: 'swapped-wrapper', types: {
        ...JSON.parse(JSON.stringify({item: TYPES.item})),
        'swapped-wrapper': {kind: 'record', fields: [
          {name: 'value', type: 'item'}, {name: 'version-token', type: 'string'},
        ]},
      },
    }), /must declare exactly version-token then value/);
    // A token must be opaque text, never a number.
    await assert.rejects(install('numeric', {
      parameters: ['string'], result: 'numeric-wrapper', types: {
        ...JSON.parse(JSON.stringify({item: TYPES.item})),
        'numeric-wrapper': {kind: 'record', fields: [
          {name: 'version-token', type: 's64'}, {name: 'value', type: 'item'},
        ]},
      },
    }), /must be string; a token is opaque text/);
  } finally {
    await runtime.close();
  }
});
