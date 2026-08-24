import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_CREATION_BINDING_V1,
  OBJECT_CREATE_OPERATION,
  OBJECT_EDGE_WRITE_OPERATION,
  createAuthorityService,
  createRuntime,
  defineClass,
  installCallableInterfaceV2,
  installImageCreationBinding,
  installSmalltalkKernel,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  packCompositeValue,
  textValue,
} from '../src/runtime.js';
import {installImageCreationBinding as installBinding} from '../src/callable/image-creation-binding.js';
import {installImageMutationBinding, OBJECT_WRITE_OPERATION} from '../src/callable/image-mutation-binding.js';
import {objectVersionToken} from '../src/object/version-token.js';
import {transientObjectId} from '../src/value/transient-ref.js';

// ADR 0062. The authorized object-creation lane: object/create scoped per (image, class), deriving
// shape/behavior from the class, nil-filling the complete layout, minting the id itself, and
// authorizing each initial ref slot by a separate per-target object/edge-write grant. What is under
// test is the authority shape and the coherence with basicNew — not merely that an object appears.

// A "no edge" item: only the text slots. A separate type adds the edge field, so the binding can be
// installed against either record shape.
const ITEM_TYPES = normalizeTypeDeclarations({
  item: {
    kind: 'record',
    fields: [
      {name: 'name', type: 'string'},
      {name: 'note', type: 'string'},
    ],
  },
});
const ITEM_EDGE_TYPES = normalizeTypeDeclarations({
  item: {
    kind: 'record',
    fields: [
      {name: 'name', type: 'string'},
      {name: 'note', type: 'string'},
      {name: 'subject', type: 'string'}, // an edge field: a ref target id travels as a string
    ],
  },
});
// name -> a text slot; note deliberately unmapped in some tests. ITEM_EDGE_FIELDS adds the edge field.
const ITEM_FIELDS = [
  {name: 'name', slot: 'slot-name'},
  {name: 'note', slot: 'slot-note'},
];
const ITEM_EDGE_FIELDS = [
  ...ITEM_FIELDS,
  {name: 'subject', slot: 'slot-subject', edge: true},
];

const createGrant = (imageId, classId) => ({operation: OBJECT_CREATE_OPERATION, resource: objectResource(imageId, classId)});
const edgeGrant = (imageId, targetId) => ({operation: OBJECT_EDGE_WRITE_OPERATION, resource: objectResource(imageId, targetId)});

async function seed({grants = null, runtimeOptions = {}, types = ITEM_TYPES, fields = ITEM_FIELDS} = {}) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority, ...runtimeOptions});
  await runtime.images.createImage({id: 'demo'});
  await installSmalltalkKernel({images: runtime.images, imageId: 'demo'});

  // A class to instantiate: a Behavior with a fixed instance Shape.
  const shape = await runtime.images.putShape('demo', {
    id: 'item-shape',
    slots: [
      {id: 'slot-name', name: 'name'},
      {id: 'slot-note', name: 'note'},
      {id: 'slot-subject', name: 'subject'},
    ],
  });
  const {classRef} = await defineClass({
    images: runtime.images, imageId: 'demo', name: 'Item', instanceShapeRef: objectRef('demo', shape.id),
  });

  // A durable object an edge may point at.
  await runtime.images.putObject('demo', {
    id: 'target',
    shape: objectRef('demo', shape.id),
    slots: {'slot-name': textValue('target'), 'slot-note': textValue('t'), 'slot-subject': objectRef('demo', 'smalltalk/nil')},
  });

  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'create-item',
    functionName: 'create-item', parameters: ['string', 'item'], result: 'string', types,
  });
  const binding = await installBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', callableInterface.id),
    fields, bindingId: 'creation', blockId: 'creation-block',
  });

  // `grants` may be an array, or a function of the seeded class id, so a test can grant on the class
  // without knowing its id before seeding.
  const resolved = typeof grants === 'function' ? grants(classRef.objectId) : grants;
  const context = resolved === null ? null : authority.issue({principal: 'alice', grants: resolved});
  const create = async (classId, value) => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'creation-block'), [
      textValue(classId), packCompositeValue(value, 'item', types),
    ]);
    return await runtime.executor.execute(activation, context === null ? {} : {authority: context});
  };
  const historyLength = async () => (await runtime.images.history('demo')).length;
  return {runtime, authority, context, binding, create, classRef, shape, historyLength};
}

// A seed whose record carries the edge field `subject`, so the binding exercises an edge slot.
const edgeSeed = (options = {}) => seed({...options, types: ITEM_EDGE_TYPES, fields: ITEM_EDGE_FIELDS});

// Read back the object a create produced, by parsing the id out of the version token's scope.
async function createdObject(runtime, tokenText) {
  // object-version/v0:<objectResource(imageId,objectId)>:<version> — decode via the history's last put.
  const history = await runtime.images.history('demo');
  const last = history[history.length - 1];
  return await runtime.images.getObject('demo', last.objectId);
}

// --- authority: no grant, no write ------------------------------------------------------------------

test('creation is denied without authority, and nothing is written', async () => {
  const {runtime, create, classRef, historyLength} = await seed({grants: null});
  try {
    const before = await historyLength();
    await assert.rejects(create(classRef.objectId, {name: 'x', note: 'n'}), /no authority context was supplied/);
    assert.equal(await historyLength(), before, 'a denied create commits nothing');
  } finally {
    await runtime.close();
  }
});

test('creation is denied with only object/write on the class, and names object/create', async () => {
  const {create, classRef} = await seed({grants: null});
  const withWrite = await seed({
    grants: [{operation: OBJECT_WRITE_OPERATION, resource: objectResource('demo', classRef.objectId)}],
  });
  try {
    await assert.rejects(withWrite.create(classRef.objectId, {name: 'x', note: 'n'}), /not authorized: object\/create/);
  } finally {
    await withWrite.runtime.close();
  }
});

// --- the happy path: derive from the class, nil-fill, mint the id ----------------------------------

test('a granted create derives shape/behavior from the class, nil-fills, and mints the id', async () => {
  const {runtime, create, classRef, shape} = await seed({grants: (classId) => [createGrant('demo', classId)]});
  try {
    const token = await create(classRef.objectId, {name: 'widget', note: 'n'});
    assert.equal(token.kind, 'text');
    const object = await createdObject(runtime, token.value);
    // shape = class.instanceShape, behavior = class — exactly as basicNew.
    assert.equal(object.shape.objectId, shape.id, 'shape derives from the class instanceShape');
    assert.equal(object.behavior.objectId, classRef.objectId, 'behavior is the class');
    // Mapped field set; a slot the record does not map is nil-filled to the complete layout.
    assert.deepEqual(object.slots['slot-name'], textValue('widget'));
    assert.equal(object.slots['slot-subject'].objectId, 'smalltalk/nil', 'an unmapped slot is nil-filled');
    // The id is server-minted, not caller-supplied.
    assert.ok(object.id !== 'widget' && object.id.length > 0, 'the lane minted a fresh id');
  } finally {
    await runtime.close();
  }
});

// --- edge authority: per-target, separate grant -----------------------------------------------------

test('an edge field without an edge grant is denied, naming the target, and nothing is written', async () => {
  const {runtime, create, classRef, historyLength} = await edgeSeed({grants: (classId) => [createGrant('demo', classId)]});
  try {
    const before = await historyLength();
    await assert.rejects(
      create(classRef.objectId, {name: 'x', note: 'n', subject: 'target'}),
      (error) => error.name === 'AuthorityError' && /object\/edge-write/.test(error.message),
    );
    assert.equal(await historyLength(), before, 'a denied edge create commits nothing');
  } finally {
    await runtime.close();
  }
});

test('an edge field with a per-target edge grant creates the edge', async () => {
  const {runtime, create, classRef} = await edgeSeed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', 'target')],
  });
  try {
    const token = await create(classRef.objectId, {name: 'x', note: 'n', subject: 'target'});
    const object = await createdObject(runtime, token.value);
    assert.deepEqual(object.slots['slot-subject'], objectRef('demo', 'target'), 'the edge is durable');
  } finally {
    await runtime.close();
  }
});

test('an edge grant on a DIFFERENT target does not authorize this target', async () => {
  const {create, classRef} = await edgeSeed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', 'someone-else')],
  });
  await assert.rejects(
    create(classRef.objectId, {name: 'x', note: 'n', subject: 'target'}),
    /not authorized: object\/edge-write/,
  );
});

test('a pinned-ref edge is authorized by the same per-target grant', async () => {
  const {runtime, create, classRef} = await edgeSeed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', 'target')],
  });
  try {
    const token = await create(classRef.objectId, {name: 'x', note: 'n', subject: 'pin:target@3'});
    const object = await createdObject(runtime, token.value);
    assert.equal(object.slots['slot-subject'].kind, 'pinned-ref');
    assert.equal(object.slots['slot-subject'].objectId, 'target');
    assert.equal(object.slots['slot-subject'].revision, '3');
  } finally {
    await runtime.close();
  }
});

test('a transient edge target is refused before any write, with a creation-conflict error', async () => {
  const {runtime, create, classRef, historyLength} = await edgeSeed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', transientObjectId('ghost'))],
  });
  try {
    const before = await historyLength();
    // The LANE's clean require-time refusal (ObjectCreationConflictError), not the write-seam
    // backstop — the two layers are pinned independently so removing the require-time check goes red.
    await assert.rejects(
      create(classRef.objectId, {name: 'x', note: 'n', subject: transientObjectId('ghost')}),
      (error) => error.name === 'ObjectCreationConflictError' && /transient/.test(error.message),
    );
    assert.equal(await historyLength(), before, 'a transient edge commits nothing');
  } finally {
    await runtime.close();
  }
});

test('a transient target is refused BEFORE the edge require, so no grant can satisfy it', async () => {
  // Grant only object/create — no edge grant at all. If the lane required first, this would be an
  // AuthorityError; the ADR §4 rule is that the transient refusal happens first, so it must surface.
  const {runtime, create, classRef} = await edgeSeed({grants: (classId) => [createGrant('demo', classId)]});
  try {
    await assert.rejects(
      create(classRef.objectId, {name: 'x', note: 'n', subject: transientObjectId('ghost')}),
      (error) => error.name === 'ObjectCreationConflictError' && /transient/.test(error.message),
    );
  } finally {
    await runtime.close();
  }
});

// ADR §4's leak check: creation must not read or follow the target. A create may therefore name a
// target that does not (yet) exist; the lane authorizes the id without confirming it. This is the
// intended "confirms at most that T exists, by construction" reading — pinned so it cannot drift.
test('creation authorizes an edge target without reading it, so a dangling edge is permitted', async () => {
  const {runtime, create, classRef} = await edgeSeed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', 'ghost')],
  });
  try {
    const token = await create(classRef.objectId, {name: 'x', note: 'n', subject: 'ghost'});
    const object = await createdObject(runtime, token.value);
    assert.deepEqual(object.slots['slot-subject'], objectRef('demo', 'ghost'), 'the edge is written without resolving the target');
  } finally {
    await runtime.close();
  }
});

// --- refusals: not a Behavior, nil shape, foreign Behavior, extra slot ------------------------------

test('creating from a non-Behavior class id is refused', async () => {
  const {create} = await seed({grants: [createGrant('demo', 'target')]});
  await assert.rejects(create('target', {name: 'x', note: 'n'}), /not a Behavior/);
});

test('creating from a class with nil instanceShape is refused', async () => {
  const {runtime, create} = await seed({grants: null});
  try {
    const {classRef: nilShapeClass} = await defineClass({
      images: runtime.images, imageId: 'demo', name: 'Abstract',
    });
    const grantee = runtime.authority.issue({principal: 'alice', grants: [createGrant('demo', nilShapeClass.objectId)]});
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'creation-block'), [
      textValue(nilShapeClass.objectId), packCompositeValue({name: 'x', note: 'n'}, 'item', ITEM_TYPES),
    ]);
    await assert.rejects(
      runtime.executor.execute(activation, {authority: grantee}),
      /not instantiable/,
    );
  } finally {
    await runtime.close();
  }
});

test('a Behavior-shaped object from another image is not this image Behavior', async () => {
  const {runtime, create} = await seed({grants: [createGrant('demo', 'foreign-behavior')]});
  try {
    // A record in this image whose Shape points at ANOTHER image's behavior Shape. The foreign image
    // must exist for the write to be admitted; the lane then refuses on locality, without fetching it.
    await runtime.images.createImage({id: 'elsewhere'});
    await runtime.images.putShape('elsewhere', {id: 'smalltalk/behavior-shape/v1', slots: [{id: 'behavior-instance-shape', name: 'instanceShape'}]});
    await runtime.images.putShape('demo', {id: 'dummy', slots: []});
    await runtime.images.putObject('demo', {
      id: 'foreign-behavior',
      shape: objectRef('elsewhere', 'smalltalk/behavior-shape/v1'),
      slots: {'behavior-instance-shape': objectRef('demo', 'dummy')},
      metadata: {},
    }, {expectedVersion: 0});
    // The lane must refuse on the locality of the Behavior's Shape, not on any fetch of `elsewhere`.
    const grantee = runtime.authority.issue({principal: 'alice', grants: [createGrant('demo', 'foreign-behavior')]});
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'creation-block'), [
      textValue('foreign-behavior'), packCompositeValue({name: 'x', note: 'n'}, 'item', ITEM_TYPES),
    ]);
    await assert.rejects(runtime.executor.execute(activation, {authority: grantee}), /not a Behavior/);
  } finally {
    await runtime.close();
  }
});

test('a class id in another image is simply not found here', async () => {
  const {create} = await seed({grants: [createGrant('demo', 'smalltalk/class/Ghost')]});
  await assert.rejects(create('smalltalk/class/Ghost', {name: 'x', note: 'n'}), /class not found/);
});

// --- the lane mints the id: collision retry ---------------------------------------------------------

test('a colliding candidate id is retried with a fresh one', async () => {
  const identities = ['collision', 'collision', 'fresh-id'];
  let index = 0;
  const {runtime, create, classRef, shape} = await seed({
    grants: (classId) => [createGrant('demo', classId)],
    runtimeOptions: {smalltalkObjectIds: () => identities[Math.min(index++, identities.length - 1)]},
  });
  try {
    // Squat the first candidate.
    await runtime.images.putObject('demo', {
      id: 'collision', shape: objectRef('demo', shape.id),
      slots: {'slot-name': textValue('squat'), 'slot-note': textValue('s'), 'slot-subject': objectRef('demo', 'smalltalk/nil')},
    });
    const token = await create(classRef.objectId, {name: 'x', note: 'n'});
    const object = await createdObject(runtime, token.value);
    assert.equal(object.id, 'fresh-id', 'a collision chose another candidate');
    // The squatter is untouched.
    assert.deepEqual((await runtime.images.getObject('demo', 'collision')).slots['slot-name'], textValue('squat'));
  } finally {
    await runtime.close();
  }
});

test('a generator that never finds a free id fails with ObjectCreationConflictError', async () => {
  // Always answers the squatted id: after maxIdentityAttempts the lane must report exhaustion, not
  // loop forever or overwrite. This pins the terminal error type the ADR names for this path.
  const {runtime, create, classRef, shape} = await seed({
    grants: (classId) => [createGrant('demo', classId)],
    runtimeOptions: {smalltalkObjectIds: () => 'collision'},
  });
  try {
    await runtime.images.putObject('demo', {
      id: 'collision', shape: objectRef('demo', shape.id),
      slots: {'slot-name': textValue('squat'), 'slot-note': textValue('s'), 'slot-subject': objectRef('demo', 'smalltalk/nil')},
    });
    await assert.rejects(
      create(classRef.objectId, {name: 'x', note: 'n'}),
      (error) => error.name === 'ObjectCreationConflictError' && /free object identity/.test(error.message),
    );
  } finally {
    await runtime.close();
  }
});

// --- chaining: the returned token drives a subsequent object/write -----------------------------------

test('the returned initial version token chains into a subsequent object/write', async () => {
  const {runtime, create, classRef} = await seed({
    grants: (classId) => [createGrant('demo', classId)],
  });
  try {
    const token = await create(classRef.objectId, {name: 'original', note: 'n'});
    const object = await createdObject(runtime, token.value);

    // Install the mutation lane on the new object and write through it with the create token.
    const MUT_FIELDS = [{name: 'name', slot: 'slot-name'}];
    const MUT_TYPES = normalizeTypeDeclarations({item: {kind: 'record', fields: [{name: 'name', type: 'string'}]}});
    const mutInterface = await installCallableInterfaceV2({
      images: runtime.images, imageId: 'demo', interfaceId: 'write-item',
      functionName: 'write-item', parameters: ['string', 'string', 'item'], result: 'string', types: MUT_TYPES,
    });
    await installImageMutationBinding({
      images: runtime.images, callableInterface: objectRef('demo', mutInterface.id),
      fields: MUT_FIELDS, bindingId: 'mutation', blockId: 'mutation-block',
    });
    const writer = runtime.authority.issue({
      principal: 'alice',
      grants: [{operation: OBJECT_WRITE_OPERATION, resource: objectResource('demo', object.id)}],
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'mutation-block'), [
      textValue(object.id), token, packCompositeValue({name: 'renamed'}, 'item', MUT_TYPES),
    ]);
    await runtime.executor.execute(activation, {authority: writer});
    assert.deepEqual(
      (await runtime.images.getObject('demo', object.id)).slots['slot-name'],
      textValue('renamed'),
      'the create token chained into a mutation',
    );
  } finally {
    await runtime.close();
  }
});

// --- the binding carries nothing authority-shaped ----------------------------------------------------

test('the create Block writes only its own image, and its binding carries no authority', async () => {
  const {runtime, binding} = await seed({grants: null});
  try {
    const artifact = await runtime.images.getCodeArtifact('demo', binding.bindingArtifact.id);
    const text = JSON.stringify(artifact);
    for (const leak of ['alice', 'principal', 'grant', 'authority', 'object/create', 'object/edge-write']) {
      assert.ok(!text.includes(leak), `the binding leaked ${leak}`);
    }
  } finally {
    await runtime.close();
  }
});
