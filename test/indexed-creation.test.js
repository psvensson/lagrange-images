import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHAPE_INDEXED,
  createAuthorityService,
  createRuntime,
  defineClass,
  installCallableInterfaceV2,
  installSmalltalkKernel,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  packCompositeValue,
  pinnedRef,
  textValue,
} from '../src/runtime.js';
import {installImageCreationBinding, OBJECT_CREATE_OPERATION, OBJECT_EDGE_WRITE_OPERATION} from '../src/callable/image-creation-binding.js';
import {referencesOfRecord} from '../src/graph/references.js';
import {transientObjectId} from '../src/value/transient-ref.js';

// ADR 0064. The creation lane can create an object with an initial INDEXED part — the substrate's
// native ordered-ref collection (ADR 0047). Each ref element travels as a ref-free string and is
// authorized by the existing per-target object/edge-write grant at canonicalize time; a leaf-list
// carries scalars; an indexed field on a non-indexed class refuses; an indexed class with no indexed
// field begins zero-length (basicNew parity). What is under test is that this composes with the ADR
// 0062 authority model without a new operation.

const createGrant = (imageId, classId) => ({operation: OBJECT_CREATE_OPERATION, resource: objectResource(imageId, classId)});
const edgeGrant = (imageId, targetId) => ({operation: OBJECT_EDGE_WRITE_OPERATION, resource: objectResource(imageId, targetId)});

// The Perspective shape: a `subject` ref slot plus an ordered indexed part of presentation refs.
const PERSPECTIVE_TYPES = normalizeTypeDeclarations({
  perspective: {kind: 'record', fields: [
    {name: 'subject', type: 'string'},
    {name: 'presentations', type: {kind: 'list', element: 'string'}},
  ]},
});
const PERSPECTIVE_FIELDS = [
  {name: 'subject', slot: 'slot-subject', edge: true},
  {name: 'presentations', indexed: true, edge: true},
];

// A leaf-list variant: an indexed part of plain integers (no edges anywhere).
const LEAF_TYPES = normalizeTypeDeclarations({
  bag: {kind: 'record', fields: [
    {name: 'label', type: 'string'},
    {name: 'values', type: {kind: 'list', element: 's64'}},
  ]},
});
const LEAF_FIELDS = [
  {name: 'label', slot: 'slot-label'},
  {name: 'values', indexed: true},
];

async function seed({grants = null, indexedShape = true, types = PERSPECTIVE_TYPES, fields = PERSPECTIVE_FIELDS, shapeId = 'perspective-shape', slots = [{id: 'slot-subject', name: 'subject'}]} = {}) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority});
  await runtime.images.createImage({id: 'demo'});
  await installSmalltalkKernel({images: runtime.images, imageId: 'demo'});

  const shape = await runtime.images.putShape('demo', {
    id: shapeId, slots, ...(indexedShape ? {indexed: SHAPE_INDEXED.VALUES} : {}),
  });
  const {classRef} = await defineClass({
    images: runtime.images, imageId: 'demo', name: 'Item', instanceShapeRef: objectRef('demo', shape.id),
  });

  // Durable objects an edge may point at.
  const targetShape = await runtime.images.putShape('demo', {id: 'target-shape', slots: []});
  for (const id of ['subject-1', 'pres-1', 'pres-2']) {
    await runtime.images.putObject('demo', {id, shape: objectRef('demo', targetShape.id), slots: {}, metadata: {}}, {expectedVersion: 0});
  }

  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'create-item',
    functionName: 'create-item', parameters: ['string', Object.keys(types)[0]], result: 'string', types,
  });
  await installImageCreationBinding({
    images: runtime.images, callableInterface: objectRef('demo', callableInterface.id),
    fields, bindingId: 'creation', blockId: 'creation-block',
  });

  const resolved = typeof grants === 'function' ? grants(classRef.objectId) : grants;
  const context = resolved === null ? null : authority.issue({principal: 'alice', grants: resolved});
  const create = async (classId, value) => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'creation-block'), [
      textValue(classId), packCompositeValue(value, Object.keys(types)[0], types),
    ]);
    return await runtime.executor.execute(activation, context === null ? {} : {authority: context});
  };
  const lastCreated = async () => {
    const history = await runtime.images.history('demo');
    const puts = history.filter((e) => e.type === 'object.put' && e.object?.shape?.objectId === shape.id);
    return await runtime.images.getObject('demo', puts[puts.length - 1].objectId);
  };
  return {runtime, authority, create, classRef, shape, lastCreated};
}

// --- the happy path: an indexed ref-list, per-target grants ----------------------------------------

test('creation builds an ordered indexed part of refs, each authorized per-target', async () => {
  const {runtime, create, classRef, lastCreated} = await seed({
    grants: (classId) => [
      createGrant('demo', classId),
      edgeGrant('demo', 'subject-1'), edgeGrant('demo', 'pres-1'), edgeGrant('demo', 'pres-2'),
    ],
  });
  try {
    await create(classRef.objectId, {subject: 'subject-1', presentations: ['pres-1', 'pres-2']});
    const object = await lastCreated();
    // The indexed part holds the ordered refs, canonicalized from strings.
    assert.deepEqual(object.indexed, [objectRef('demo', 'pres-1'), objectRef('demo', 'pres-2')]);
    assert.deepEqual(object.slots['slot-subject'], objectRef('demo', 'subject-1'));
    // And every element is walk-visible as a graph edge (ADR 0047 §4).
    const refs = referencesOfRecord(object).map((r) => r.objectId);
    for (const id of ['subject-1', 'pres-1', 'pres-2']) {
      assert.ok(refs.includes(id), `referencesOfRecord must reach ${id}`);
    }
  } finally {
    await runtime.close();
  }
});

test('a pinned-ref indexed element is authorized by the same per-target grant', async () => {
  const {runtime, create, classRef, lastCreated} = await seed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', 'subject-1'), edgeGrant('demo', 'pres-1')],
  });
  try {
    await create(classRef.objectId, {subject: 'subject-1', presentations: ['pin:pres-1@5']});
    const object = await lastCreated();
    assert.equal(object.indexed[0].kind, 'pinned-ref');
    assert.equal(object.indexed[0].objectId, 'pres-1');
    assert.equal(object.indexed[0].revision, '5');
  } finally {
    await runtime.close();
  }
});

// --- authority: per-target, no broad reach ----------------------------------------------------------

test('an indexed ref element without its per-target grant is denied, and nothing is written', async () => {
  const {runtime, create, classRef, shape} = await seed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', 'subject-1'), edgeGrant('demo', 'pres-1')],
  });
  try {
    // pres-2 has NO edge grant. The whole create must fail and publish no instance.
    const before = (await runtime.images.history('demo')).filter((e) => e.type === 'object.put' && e.object?.shape?.objectId === shape.id).length;
    await assert.rejects(
      create(classRef.objectId, {subject: 'subject-1', presentations: ['pres-1', 'pres-2']}),
      (error) => error.name === 'AuthorityError' && /object\/edge-write/.test(error.message),
    );
    const after = (await runtime.images.history('demo')).filter((e) => e.type === 'object.put' && e.object?.shape?.objectId === shape.id).length;
    assert.equal(after, before, 'a denied element must publish no instance');
  } finally {
    await runtime.close();
  }
});

test('a transient indexed element is refused before any write', async () => {
  const {runtime, create, classRef, shape} = await seed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', 'subject-1'), edgeGrant('demo', transientObjectId('ghost'))],
  });
  try {
    const before = (await runtime.images.history('demo')).filter((e) => e.type === 'object.put' && e.object?.shape?.objectId === shape.id).length;
    await assert.rejects(
      create(classRef.objectId, {subject: 'subject-1', presentations: [transientObjectId('ghost')]}),
      (error) => error.name === 'ObjectCreationConflictError' && /transient/.test(error.message),
    );
    const after = (await runtime.images.history('demo')).filter((e) => e.type === 'object.put' && e.object?.shape?.objectId === shape.id).length;
    assert.equal(after, before, 'a transient element must publish no instance');
  } finally {
    await runtime.close();
  }
});

// --- leaf-list: no edges anywhere -------------------------------------------------------------------

test('a leaf indexed list carries scalars and requires no edge grant', async () => {
  const {runtime, create, classRef, lastCreated} = await seed({
    grants: (classId) => [createGrant('demo', classId)],
    types: LEAF_TYPES, fields: LEAF_FIELDS, shapeId: 'bag-shape', slots: [{id: 'slot-label', name: 'label'}],
  });
  try {
    await create(classRef.objectId, {label: 'nums', values: [10n, 20n, 30n]});
    const object = await lastCreated();
    assert.deepEqual(object.indexed, [integerValue(10), integerValue(20), integerValue(30)]);
    assert.deepEqual(object.slots['slot-label'], textValue('nums'));
  } finally {
    await runtime.close();
  }
});

// --- refusals: non-indexed class, nested composite --------------------------------------------------

test('an indexed field on a non-indexed class is refused before any write', async () => {
  const {runtime, create, classRef} = await seed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', 'subject-1')],
    indexedShape: false, // the Shape is NOT indexed
  });
  try {
    await assert.rejects(
      create(classRef.objectId, {subject: 'subject-1', presentations: ['pres-1']}),
      /not indexed/,
    );
  } finally {
    await runtime.close();
  }
});

// --- zero-length parity: an indexed class with no indexed field -------------------------------------

test('an indexed class with no indexed field supplied begins at the zero-length form', async () => {
  // A binding whose record carries only the subject slot — no presentations field at all.
  const SUBJECT_ONLY_TYPES = normalizeTypeDeclarations({
    perspective: {kind: 'record', fields: [{name: 'subject', type: 'string'}]},
  });
  const {runtime, create, classRef, lastCreated} = await seed({
    grants: (classId) => [createGrant('demo', classId), edgeGrant('demo', 'subject-1')],
    types: SUBJECT_ONLY_TYPES, fields: [{name: 'subject', slot: 'slot-subject', edge: true}],
  });
  try {
    await create(classRef.objectId, {subject: 'subject-1'});
    const object = await lastCreated();
    assert.deepEqual(object.indexed, [], 'basicNew parity: an indexed class with no elements is zero-length');
  } finally {
    await runtime.close();
  }
});
