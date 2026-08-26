import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_OBJECT_READ_BINDING_V1,
  OBJECT_NOT_FOUND_CODE,
  OBJECT_READ_OPERATION,
  createAuthorityService,
  createRuntime,
  defineClass,
  installCallableInterfaceV2,
  installImageObjectReadBinding,
  installSmalltalkKernel,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  parseObjectVersionToken,
  pinnedRef,
  textValue,
  unpackCompositeValue,
} from '../src/runtime.js';

// ADR 0068. The authorized whole-record object-read lane: one `require(object/read)` then the
// complete generic object — every named slot and the indexed part verbatim, plus an opaque
// version token from the same read. Refs are identity, never followed. Denied authority is
// AuthorityError before any existence check; authorized-but-missing is a distinct not-found.

const TYPES = normalizeTypeDeclarations({
  'slot-value': {
    kind: 'record',
    fields: [{name: 'value', type: 'string'}],
  },
  'slot-entry': {
    kind: 'record',
    fields: [
      {name: 'name', type: 'string'},
      {name: 'value', type: 'slot-value'},
    ],
  },
  'object-record': {
    kind: 'record',
    fields: [
      {name: 'slots', type: {kind: 'list', element: 'slot-entry'}},
      {name: 'indexed', type: {kind: 'list', element: 'slot-value'}},
    ],
  },
  'object-read-result': {
    kind: 'record',
    fields: [
      {name: 'version-token', type: 'string'},
      {name: 'value', type: 'object-record'},
    ],
  },
});

const readGrant = (id) => ({operation: OBJECT_READ_OPERATION, resource: objectResource('demo', id)});

async function seed({grants = null, objects = ['item']} = {}) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority});
  await runtime.images.createImage({id: 'demo'});
  await installSmalltalkKernel({images: runtime.images, imageId: 'demo'});

  const shape = await runtime.images.putShape('demo', {
    id: 'item-shape',
    slots: [
      {id: 'slot-name', name: 'name'},
      {id: 'slot-count', name: 'count'},
      {id: 'slot-target', name: 'target'},
      {id: 'slot-pin', name: 'pin'},
    ],
  });
  const {classRef} = await defineClass({
    images: runtime.images, imageId: 'demo', name: 'Item', instanceShapeRef: objectRef('demo', shape.id),
  });

  const indexedShape = await runtime.images.putShape('demo', {
    id: 'perspective-shape',
    slots: [{id: 'slot-title', name: 'title'}],
    indexed: 'values',
  });
  await defineClass({
    images: runtime.images, imageId: 'demo', name: 'Perspective', instanceShapeRef: objectRef('demo', indexedShape.id),
  });

  for (const id of objects) {
    if (id === 'perspective') {
      await runtime.images.putObject('demo', {
        id, shape: objectRef('demo', indexedShape.id),
        slots: {'slot-title': textValue('root')},
        indexed: [objectRef('demo', 'item'), pinnedRef('demo', 'item', '2'), textValue('leaf')],
      });
    } else {
      await runtime.images.putObject('demo', {
        id, shape: objectRef('demo', shape.id),
        slots: {
          'slot-name': textValue(`${id}-name`),
          'slot-count': integerValue(7),
          'slot-target': objectRef('demo', 'smalltalk/nil'),
          'slot-pin': pinnedRef('demo', 'smalltalk/nil', '1'),
        },
      });
    }
  }

  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'read-object',
    functionName: 'read-object', parameters: ['string'], result: 'object-read-result', types: TYPES,
  });
  const binding = await installImageObjectReadBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', callableInterface.id),
    bindingId: 'object-read', blockId: 'object-read-block',
  });

  const context = grants === null ? null : authority.issue({principal: 'alice', grants});
  const options = () => (context === null ? {} : {authority: context});
  const readObject = async (objectId) => {
    const activation = await runtime.invocations.invokeBlock(
      objectRef('demo', 'object-read-block'), [textValue(objectId)],
    );
    const packed = await runtime.executor.execute(activation, options());
    return unpackCompositeValue(packed, 'object-read-result', TYPES);
  };
  return {runtime, authority, context, binding, readObject, classRef, shape, indexedShape};
}

// Case 1 — the happy path: an authorized read returns the COMPLETE object plus an opaque token.
test('an authorized read returns every named slot verbatim and an opaque version token', async () => {
  const {runtime, readObject} = await seed({grants: [readGrant('item')]});
  try {
    const result = await readObject('item');
    assert.deepEqual(Object.keys(result).sort(), ['value', 'version-token']);
    assert.equal(typeof result['version-token'], 'string');
    assert.match(result['version-token'], /^object-version\/v0:/);
    assert.notEqual(result['version-token'], String(1), 'the token is not a raw number');

    const slots = Object.fromEntries(result.value.slots.map(({name, value}) => [name, JSON.parse(value.value)]));
    assert.deepEqual(slots, {
      'slot-name': textValue('item-name'),
      'slot-count': integerValue(7),
      'slot-target': objectRef('demo', 'smalltalk/nil'),
      'slot-pin': pinnedRef('demo', 'smalltalk/nil', '1'),
    });
    assert.deepEqual(result.value.indexed.map((entry) => JSON.parse(entry.value)), [], 'a non-indexed object reads as an empty indexed part');
  } finally {
    await runtime.close();
  }
});

// Case 2 — an indexed object: the indexed part comes back verbatim, including ref identity.
test('an indexed object returns its indexed elements verbatim, including ref identity', async () => {
  const {runtime, readObject} = await seed({grants: [readGrant('perspective')], objects: ['item', 'perspective']});
  try {
    const result = await readObject('perspective');
    const slots = Object.fromEntries(result.value.slots.map(({name, value}) => [name, JSON.parse(value.value)]));
    assert.deepEqual(slots, {'slot-title': textValue('root')});
    const indexed = result.value.indexed.map((entry) => JSON.parse(entry.value));
    assert.deepEqual(indexed, [
      objectRef('demo', 'item'),
      pinnedRef('demo', 'item', '2'),
      textValue('leaf'),
    ]);
  } finally {
    await runtime.close();
  }
});

// Case 3 — ref/pinned-ref slots are identity, never followed.
test('ref and pinned-ref slots are returned as identity, never followed', async () => {
  const {runtime, readObject} = await seed({grants: [readGrant('item')]});
  try {
    const result = await readObject('item');
    const slots = Object.fromEntries(result.value.slots.map(({name, value}) => [name, JSON.parse(value.value)]));
    assert.deepEqual(slots['slot-target'], objectRef('demo', 'smalltalk/nil'));
    assert.deepEqual(slots['slot-pin'], pinnedRef('demo', 'smalltalk/nil', '1'));
    // Identity only: no second object was read, no traversal require implied.
  } finally {
    await runtime.close();
  }
});

// Case 4 — denied authority: AuthorityError naming object/read, identical whether the object
// exists or not. The lane is no existence oracle.
test('denied authority is AuthorityError naming object/read, identical for existing and missing objects', async () => {
  const denied = await seed({grants: null});
  try {
    await assert.rejects(denied.readObject('item'), /no authority context was supplied/);
    await assert.rejects(denied.readObject('no-such-object'), /no authority context was supplied/);
  } finally {
    await denied.runtime.close();
  }

  const wrong = await seed({grants: [readGrant('other')]});
  try {
    await assert.rejects(wrong.readObject('item'), (error) => error.name === 'AuthorityError' && /object\/read/.test(error.message));
    await assert.rejects(wrong.readObject('no-such-object'), (error) => error.name === 'AuthorityError' && /object\/read/.test(error.message));
  } finally {
    await wrong.runtime.close();
  }
});

// Case 5 — authorized but nonexistent: a distinct not-found error, never conflated with denied, and
// machine-readable via a stable lane-owned code (ADR 0068: denied != not-found != operational).
test('authorized but nonexistent is a distinct not-found error, not AuthorityError and not null', async () => {
  const {runtime, readObject} = await seed({grants: [readGrant('no-such-object')]});
  try {
    await assert.rejects(readObject('no-such-object'), (error) => {
      // A lane-owned discriminator: machine-readable by code, not by matching message text.
      assert.equal(error.name, 'ObjectReadNotFoundError');
      assert.equal(error.code, OBJECT_NOT_FOUND_CODE);
      assert.notEqual(error.name, 'AuthorityError');
      // Still a TypeError with the human-readable message for continuity.
      assert.equal(error instanceof TypeError, true);
      assert.match(error.message, /object not found: demo\/no-such-object/);
      return true;
    });
  } finally {
    await runtime.close();
  }
});

// Case 6 — the token couples to the read state: it parses back to the stored version.
test('the version token couples to the read state', async () => {
  const {runtime, readObject} = await seed({grants: [readGrant('item')]});
  try {
    const result = await readObject('item');
    const stored = await runtime.images.getObject('demo', 'item');
    assert.equal(parseObjectVersionToken(result['version-token'], 'demo', 'item'), stored._version);
  } finally {
    await runtime.close();
  }
});
