import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  IMAGE_PROJECTION_BINDING_V1,
  OBJECT_READ_OPERATION,
  WASM_COMPONENT_V1,
  booleanValue,
  bytesValue,
  createAuthorityService,
  createJcoComponentRuntime,
  createRuntime,
  installCallableInterfaceV2,
  installImageProjectionBinding,
  installWasmComponentBinding,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  packCompositeValue,
  parseObjectResource,
  textValue,
  unpackCompositeValue,
} from '../src/runtime.js';

const COMPONENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'normalize-component', 'normalize.component.wasm',
);

const ITEM_TYPES = normalizeTypeDeclarations({
  item: {
    kind: 'record',
    fields: [
      {name: 'name', type: 'string'},
      {name: 'quantity', type: 's64'},
      {name: 'enabled', type: 'bool'},
    ],
  },
});
const ITEM_FIELDS = [
  {name: 'name', slot: 'slot-name'},
  {name: 'quantity', slot: 'slot-quantity'},
  {name: 'enabled', slot: 'slot-enabled'},
];

async function seed({grants = null, objects = null} = {}) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    componentRuntime: createJcoComponentRuntime(),
  });
  await runtime.images.createImage({id: 'demo'});
  const shape = await runtime.images.putShape('demo', {
    id: 'item-shape',
    slots: [
      {id: 'slot-name', name: 'name'},
      {id: 'slot-quantity', name: 'quantity'},
      {id: 'slot-enabled', name: 'enabled'},
    ],
  });

  const seeded = objects ?? {
    counter: {'slot-name': textValue('  Widget  One '), 'slot-quantity': integerValue(7), 'slot-enabled': booleanValue(true)},
    other: {'slot-name': textValue('Secret'), 'slot-quantity': integerValue(-1), 'slot-enabled': booleanValue(false)},
  };
  for (const [id, slots] of Object.entries(seeded)) {
    await runtime.images.putObject('demo', {id, shape: objectRef('demo', shape.id), slots});
  }

  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'read-item',
    functionName: 'read-item', parameters: ['string'], result: 'item', types: ITEM_TYPES,
  });
  const binding = await installImageProjectionBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', callableInterface.id),
    fields: ITEM_FIELDS,
    bindingId: 'read-item-binding', blockId: 'read-item-block',
  });

  const context = grants === null ? null : authority.issue({principal: 'alice', grants});
  const project = async (objectId) => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'read-item-block'), [textValue(objectId)]);
    return await runtime.executor.execute(activation, context === null ? {} : {authority: context});
  };
  const grantFor = (objectId) => ({operation: OBJECT_READ_OPERATION, resource: objectResource('demo', objectId)});
  return {runtime, authority, context, binding, project, grantFor, shape};
}

const readGrant = (objectId) => ({operation: OBJECT_READ_OPERATION, resource: objectResource('demo', objectId)});

// Case 1
test('projection is denied without authority, and no slot is read', async () => {
  const {runtime, project} = await seed({grants: null});
  try {
    await assert.rejects(project('counter'), /no authority context was supplied/);
  } finally {
    await runtime.close();
  }
});

// Cases 2 and 3
test('a granted object projects; a different object with the same shape does not', async () => {
  const {runtime, project} = await seed({grants: [readGrant('counter')]});
  try {
    const packed = await project('counter');
    assert.deepEqual(unpackCompositeValue(packed, 'item', ITEM_TYPES), {
      name: '  Widget  One ', quantity: 7n, enabled: true,
    });
    // Exact-match granularity, made observable rather than assumed: one grant, one object.
    await assert.rejects(project('other'), /not authorized: object\/read/);
  } finally {
    await runtime.close();
  }
});

// Case 4
test('revoking between two projections stops the second', async () => {
  const {runtime, authority, context, project} = await seed({grants: [readGrant('counter')]});
  try {
    await project('counter');
    authority.revoke(context);
    await assert.rejects(project('counter'), /authority revoked/);
  } finally {
    await runtime.close();
  }
});

// Cases 5 and 6
test('the projected result carries no ref, and the binding carries nothing authority-shaped', async () => {
  const {runtime, binding, project} = await seed({grants: [readGrant('counter')]});
  try {
    const packed = await project('counter');
    assert.equal(packed.kind, 'bytes');
    // A composite envelope is opaque bytes; there is no Value kind in it that could be a ref.
    assert.deepEqual(Object.keys(packed).sort(), ['base64', 'kind']);

    const descriptor = JSON.parse(binding.bindingArtifact.content.value);
    assert.deepEqual(Object.keys(descriptor).sort(), ['abi', 'fields']);
    const serialised = JSON.stringify(binding.bindingArtifact).toLowerCase();
    for (const leak of ['alice', 'principal', 'grant', 'authority', 'object/read', 'counter']) {
      assert.ok(!serialised.includes(leak), `binding leaked ${leak}`);
    }
    // The implementation is the image itself, so there is no implementation dependency.
    assert.deepEqual(binding.bindingArtifact.dependencies.map(({role}) => role), ['interface']);
  } finally {
    await runtime.close();
  }
});

// Case 7 — the point of the ADR.
test('a projected record enters the Component lane as an ordinary argument', async () => {
  const {runtime, project} = await seed({grants: [readGrant('counter')]});
  try {
    const component = await runtime.images.putCodeArtifact('demo', {
      id: 'component', representation: WASM_COMPONENT_V1,
      content: bytesValue(await readFile(COMPONENT_PATH)), languageId: 'rust',
    });
    const relabelInterface = await installCallableInterfaceV2({
      images: runtime.images, imageId: 'demo', interfaceId: 'relabel',
      functionName: 'relabel', parameters: ['item'], result: 'item', types: ITEM_TYPES,
    });
    const componentLane = await installWasmComponentBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', relabelInterface.id),
      component: objectRef('demo', component.id),
      bindingId: 'relabel-binding', blockId: 'relabel-block',
    });

    // The projection's output is passed straight in, with no unpacking or conversion.
    const projected = await project('counter');
    const activation = await runtime.invocations.invokeBlock(
      objectRef('demo', componentLane.block.id), [projected],
    );
    const result = await runtime.executor.execute(activation);
    assert.deepEqual(unpackCompositeValue(result, 'item', ITEM_TYPES), {
      name: 'widget one', quantity: 7n, enabled: false,
    });

    // Indistinguishable from a literal: the same bytes constructed by hand behave identically.
    const literal = packCompositeValue(
      {name: '  Widget  One ', quantity: 7n, enabled: true}, 'item', ITEM_TYPES,
    );
    assert.deepEqual(literal, projected);
  } finally {
    await runtime.close();
  }
});

// Case 8
test('a missing or mistyped slot fails rather than coercing', async () => {
  // The object model already guarantees that an object's slots match its shape, so a slot can
  // only be missing when the object's shape does not declare it at all. That is exactly the
  // case a structural projection has to handle: the shape is not part of compatibility, so
  // nothing stops a projection being pointed at an object that lacks a mapped slot.
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority: createAuthorityService()});
  const authority = runtime.authority;
  try {
    await runtime.images.createImage({id: 'demo'});
    const narrowShape = await runtime.images.putShape('demo', {
      id: 'narrow', slots: [{id: 'slot-name', name: 'name'}, {id: 'slot-quantity', name: 'quantity'}],
    });
    await runtime.images.putObject('demo', {
      id: 'counter', shape: objectRef('demo', narrowShape.id),
      slots: {'slot-name': textValue('x'), 'slot-quantity': integerValue(1)},
    });
    const callableInterface = await installCallableInterfaceV2({
      images: runtime.images, imageId: 'demo', interfaceId: 'read-item',
      functionName: 'read-item', parameters: ['string'], result: 'item', types: ITEM_TYPES,
    });
    await installImageProjectionBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', callableInterface.id),
      fields: ITEM_FIELDS, bindingId: 'b', blockId: 'bl',
    });
    const context = authority.issue({principal: 'alice', grants: [readGrant('counter')]});
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'bl'), [textValue('counter')]);
    await assert.rejects(runtime.executor.execute(activation, {authority: context}),
      /has no slot slot-enabled for field enabled/);
  } finally {
    await runtime.close();
  }

  const mistyped = await seed({
    grants: [readGrant('counter')],
    objects: {
      counter: {'slot-name': textValue('x'), 'slot-quantity': textValue('7'), 'slot-enabled': booleanValue(true)},
    },
  });
  try {
    await assert.rejects(mistyped.project('counter'), /must be an integer Value for s64/);
  } finally {
    await mistyped.runtime.close();
  }
});

// Case 13
test('a mapped slot holding a ref is rejected, never followed', async () => {
  const {runtime, project} = await seed({
    grants: [readGrant('counter')],
    objects: {
      counter: {
        'slot-name': textValue('x'),
        'slot-quantity': integerValue(1),
        // Authority for this object must not imply authority for whatever it points at.
        'slot-enabled': objectRef('demo', 'other'),
      },
      other: {'slot-name': textValue('Secret'), 'slot-quantity': integerValue(0), 'slot-enabled': booleanValue(true)},
    },
  });
  try {
    await assert.rejects(project('counter'), /never follows refs/);
  } finally {
    await runtime.close();
  }
});

// Case 11 — the collision this ADR exists to prevent.
test('objectResource is injective, so a grant cannot cross image and object boundaries', () => {
  const collidingUnderNaiveConcatenation = [['a/b', 'c'], ['a', 'b/c']];
  const [first, second] = collidingUnderNaiveConcatenation.map(([i, o]) => objectResource(i, o));
  assert.equal(`${collidingUnderNaiveConcatenation[0].join('/')}`, 'a/b/c');
  assert.equal(`${collidingUnderNaiveConcatenation[1].join('/')}`, 'a/b/c');
  assert.notEqual(first, second, 'a naive key would make these one resource');

  // Round-trip proves injectivity rather than merely asserting difference.
  for (const [imageId, objectId] of [...collidingUnderNaiveConcatenation, ['demo', 'counter'], ['.', '.'], ['a=b', 'c+d']]) {
    assert.deepEqual(parseObjectResource(objectResource(imageId, objectId)), {imageId, objectId});
  }
  assert.throws(() => objectResource('', 'x'), /must be a non-empty string/);
});

test('a grant for one object does not authorize a colliding-looking other object', async () => {
  const authority = createAuthorityService();
  const context = authority.issue({
    principal: 'alice',
    grants: [{operation: OBJECT_READ_OPERATION, resource: objectResource('a/b', 'c')}],
  });
  authority.require(context, {operation: OBJECT_READ_OPERATION, resource: objectResource('a/b', 'c')});
  assert.throws(
    () => authority.require(context, {operation: OBJECT_READ_OPERATION, resource: objectResource('a', 'b/c')}),
    /not authorized/,
  );
});

// Case 12
test('a projection is structural: shape identity is not part of compatibility', async () => {
  const {runtime, project} = await seed({grants: [readGrant('counter'), readGrant('other')]});
  try {
    // A second shape with the same stable slot IDs, and an object using it.
    const otherShape = await runtime.images.putShape('demo', {
      id: 'other-shape',
      slots: [
        {id: 'slot-name', name: 'label'},
        {id: 'slot-quantity', name: 'count'},
        {id: 'slot-enabled', name: 'flag'},
        {id: 'slot-extra', name: 'extra'},
      ],
    });
    await runtime.images.putObject('demo', {
      id: 'other',
      shape: objectRef('demo', otherShape.id),
      slots: {
        'slot-name': textValue('Second'), 'slot-quantity': integerValue(3),
        'slot-enabled': booleanValue(false), 'slot-extra': textValue('ignored'),
      },
    });

    // Different shape identity, different slot *names*, an extra slot: still projects, because
    // v1 matches on stable slot IDs and declared types.
    assert.deepEqual(unpackCompositeValue(await project('other'), 'item', ITEM_TYPES), {
      name: 'Second', quantity: 3n, enabled: false,
    });
    assert.deepEqual(unpackCompositeValue(await project('counter'), 'item', ITEM_TYPES), {
      name: '  Widget  One ', quantity: 7n, enabled: true,
    });
  } finally {
    await runtime.close();
  }
});

// Case 9
test('a projection Block reads only its own binding image', async () => {
  const {runtime, project} = await seed({grants: [readGrant('counter')]});
  try {
    // A same-named object in another image is unreachable: the caller supplies only an id.
    await runtime.images.createImage({id: 'elsewhere'});
    const shape = await runtime.images.putShape('elsewhere', {id: 's', slots: [{id: 'slot-name', name: 'name'}]});
    await runtime.images.putObject('elsewhere', {
      id: 'counter', shape: objectRef('elsewhere', shape.id), slots: {'slot-name': textValue('OTHER IMAGE')},
    });
    const packed = await project('counter');
    assert.equal(unpackCompositeValue(packed, 'item', ITEM_TYPES).name, '  Widget  One ');
  } finally {
    await runtime.close();
  }
});

test('v1 rejects an interface shape it cannot project', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority: createAuthorityService()});
  try {
    await runtime.images.createImage({id: 'demo'});
    const install = async (id, options) => {
      const callableInterface = await installCallableInterfaceV2({
        images: runtime.images, imageId: 'demo', interfaceId: id, functionName: 'f', ...options,
      });
      return await installImageProjectionBinding({
        images: runtime.images,
        callableInterface: objectRef('demo', callableInterface.id),
        fields: ITEM_FIELDS, bindingId: `${id}-b`, blockId: `${id}-bl`,
      });
    };

    // Not one string parameter.
    await assert.rejects(install('two-params', {
      parameters: ['string', 'string'], result: 'item', types: ITEM_TYPES,
    }), /exactly one string parameter/);
    // Result is not a record.
    await assert.rejects(install('scalar-result', {parameters: ['string'], result: 'string'}),
      /result must be a declared record type/);
    // Nested field type: v1 does not project nested values, so it cannot reach a second object.
    await assert.rejects(install('nested', {
      parameters: ['string'], result: 'nested', types: {
        nested: {kind: 'record', fields: [{name: 'items', type: {kind: 'list', element: 'string'}}]},
      },
    }), /must be a leaf type; v1 does not project nested values/);
    // Field mapping must cover the record exactly.
    await assert.rejects(install('unmapped', {
      parameters: ['string'], result: 'wide', types: {
        wide: {kind: 'record', fields: [...ITEM_TYPES.item.fields, {name: 'extra', type: 'string'}]},
      },
    }), /does not map record field extra/);
  } finally {
    await runtime.close();
  }
});
