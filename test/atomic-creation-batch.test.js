import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECT_CREATE_OPERATION,
  OBJECT_EDGE_WRITE_OPERATION,
  createAuthorityService,
  createRuntime,
  defineClass,
  installCallableInterfaceV2,
  installSmalltalkKernel,
  objectRef,
  objectResource,
  packCompositeValue,
  textValue,
} from '../src/runtime.js';
import {installImageCreationBatchBinding} from '../src/callable/image-creation-batch-binding.js';
import {SHAPE_INDEXED} from '../src/object/model.js';

// ADR 0067. The authorized atomic image-local creation batch lane: N create specs in ONE call,
// committed in ONE backend.transaction. The tests pin the fresh-target provenance rule: an edge to
// an existing object requires object/edge-write(T); an edge to a member created in THIS SAME batch
// is justified by that member's own object/create grant. Local names are request-syntax only.

// The member-record type: `class` (required), `name` (optional local name), plus data fields.
const MEMBER_TYPES = {
  member: {
    kind: 'record',
    fields: [
      {name: 'class', type: 'string'},
      {name: 'name', type: 'string'},
      {name: 'note', type: 'string'},
      {name: 'presentations', type: {kind: 'list', element: 'string'}},
    ],
  },
};

// Per-class field mappings: class-id -> field list.
const PRESENTATION_FIELDS = [
  {name: 'name', slot: 'slot-name'},
  {name: 'note', slot: 'slot-note'},
];
const PERSPECTIVE_FIELDS = [
  {name: 'name', slot: 'slot-name'},
  {name: 'note', slot: 'slot-note'},
  {name: 'presentations', indexed: true, edge: true},
];

const createGrant = (imageId, classId) => ({operation: OBJECT_CREATE_OPERATION, resource: objectResource(imageId, classId)});
const edgeGrant = (imageId, targetId) => ({operation: OBJECT_EDGE_WRITE_OPERATION, resource: objectResource(imageId, targetId)});

async function seed({grants = null, runtimeOptions = {}} = {}) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority, ...runtimeOptions});
  await runtime.images.createImage({id: 'demo'});
  await installSmalltalkKernel({images: runtime.images, imageId: 'demo'});

  // Two classes: Presentation (plain slots) and Perspective (indexed).
  const presentationShape = await runtime.images.putShape('demo', {
    id: 'presentation-shape',
    slots: [
      {id: 'slot-name', name: 'name'},
      {id: 'slot-note', name: 'note'},
    ],
  });
  const perspectiveShape = await runtime.images.putShape('demo', {
    id: 'perspective-shape',
    slots: [
      {id: 'slot-name', name: 'name'},
      {id: 'slot-note', name: 'note'},
    ],
    indexed: SHAPE_INDEXED.VALUES,
  });
  const {classRef: presentationClassRef} = await defineClass({
    images: runtime.images, imageId: 'demo', name: 'Presentation', instanceShapeRef: objectRef('demo', presentationShape.id),
  });
  const {classRef: perspectiveClassRef} = await defineClass({
    images: runtime.images, imageId: 'demo', name: 'Perspective', instanceShapeRef: objectRef('demo', perspectiveShape.id),
  });

  // A durable object an edge may point at.
  await runtime.images.putObject('demo', {
    id: 'target',
    shape: objectRef('demo', presentationShape.id),
    slots: {'slot-name': textValue('target'), 'slot-note': textValue('t')},
  });

  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'create-many',
    functionName: 'create-many', parameters: [{kind: 'list', element: 'member'}], result: 'string', types: MEMBER_TYPES,
  });
  const binding = await installImageCreationBatchBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', callableInterface.id),
    fields: {
      [presentationClassRef.objectId]: PRESENTATION_FIELDS,
      [perspectiveClassRef.objectId]: PERSPECTIVE_FIELDS,
    },
    bindingId: 'creation-batch', blockId: 'creation-batch-block',
  });

  // `grants` may be an array, or a function of the seeded class ids, so a test can grant on the
  // classes without knowing their ids before seeding.
  const resolved = typeof grants === 'function' ? grants({
    presentation: presentationClassRef.objectId,
    perspective: perspectiveClassRef.objectId,
  }) : grants;
  const context = resolved === null ? null : authority.issue({principal: 'alice', grants: resolved});
  const create = async (values) => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'creation-batch-block'), [
      packCompositeValue(values, {kind: 'list', element: 'member'}, MEMBER_TYPES),
    ]);
    return await runtime.executor.execute(activation, context === null ? {} : {authority: context});
  };
  const historyLength = async () => (await runtime.images.history('demo')).length;
  return {
    runtime, authority, context, binding, create, historyLength,
    presentationClassRef, perspectiveClassRef,
    presentationShape, perspectiveShape,
  };
}

// Read back the objects a batch create produced, by decoding the ids from the version tokens.
async function createdObjects(runtime, tokenText) {
  const tokens = tokenText.split(',');
  const objects = [];
  for (const token of tokens) {
    // object-version/v0:<objectResource(imageId,objectId)>:<version>
    const parts = token.split(':');
    const resource = parts[1];
    // objectResource is base64url(imageId).base64url(objectId)
    const dotIndex = resource.indexOf('.');
    const objectId = Buffer.from(resource.slice(dotIndex + 1), 'base64url').toString('utf8');
    objects.push(await runtime.images.getObject('demo', objectId));
  }
  return objects;
}

// --- happy path: multi-class atomic creation with local refs -----------------------------------------

test('a granted batch creates N objects atomically across classes with local refs resolved to minted ids', async () => {
  const {runtime, create, presentationClassRef, perspectiveClassRef, historyLength} = await seed({
    grants: ({presentation, perspective}) => [createGrant('demo', presentation), createGrant('demo', perspective)],
  });
  try {
    const before = await historyLength();
    const token = await create([
      {class: presentationClassRef.objectId, name: 'a', note: 'first', presentations: []},
      {class: presentationClassRef.objectId, name: 'b', note: 'second', presentations: []},
      {class: perspectiveClassRef.objectId, name: 'p', note: 'parent', presentations: ['local:a', 'local:b']},
    ]);
    assert.equal(token.kind, 'text');
    const objects = await createdObjects(runtime, token.value);
    assert.equal(objects.length, 3, 'three objects created');
    // All ids are server-minted, not caller-supplied.
    for (const obj of objects) {
      assert.ok(obj.id !== 'a' && obj.id !== 'b' && obj.id !== 'p', 'the lane minted fresh ids');
      assert.ok(obj.id.length > 0, 'id is non-empty');
    }
    // The parent's indexed part contains refs to the children's minted ids.
    const [childA, childB, parent] = objects;
    assert.equal(parent.indexed.length, 2, 'parent has two indexed refs');
    assert.equal(parent.indexed[0].kind, 'ref');
    assert.equal(parent.indexed[0].objectId, childA.id);
    assert.equal(parent.indexed[1].objectId, childB.id);
    // Each object got its own class's shape and behavior.
    assert.equal(childA.behavior.objectId, presentationClassRef.objectId);
    assert.equal(childB.behavior.objectId, presentationClassRef.objectId);
    assert.equal(parent.behavior.objectId, perspectiveClassRef.objectId);
    // History: exactly N object.put events appended.
    const after = await historyLength();
    assert.equal(after - before, 3, 'three history events, one per object');
  } finally {
    await runtime.close();
  }
});

// --- NEGATIVE TEST: the falsification anchor ---------------------------------------------------------

test('an edge to an existing object without edge-write denies the WHOLE batch, nothing written', async () => {
  const {runtime, create, presentationClassRef, perspectiveClassRef, historyLength} = await seed({
    grants: ({presentation, perspective}) => [createGrant('demo', presentation), createGrant('demo', perspective)],
  });
  try {
    const before = await historyLength();
    await assert.rejects(
      create([
        {class: presentationClassRef.objectId, name: 'a', note: 'first', presentations: []},
        {class: perspectiveClassRef.objectId, name: 'b', note: 'second', presentations: ['target']},
      ]),
      (error) => error.name === 'AuthorityError' && /object\/edge-write/.test(error.message),
    );
    assert.equal(await historyLength(), before, 'a denied batch commits nothing');
    assert.equal(await runtime.images.getObject('demo', 'a'), null, 'A does not exist');
    assert.equal(await runtime.images.getObject('demo', 'b'), null, 'B does not exist');
  } finally {
    await runtime.close();
  }
});

// --- fresh-target exemption: no object/edge-write on unknowable fresh ids -----------------------------

test('an intra-batch edge to a fresh member succeeds with only object/create grants', async () => {
  const {runtime, create, presentationClassRef, perspectiveClassRef} = await seed({
    grants: ({presentation, perspective}) => [createGrant('demo', presentation), createGrant('demo', perspective)],
  });
  try {
    const token = await create([
      {class: presentationClassRef.objectId, name: 'child', note: 'c', presentations: []},
      {class: perspectiveClassRef.objectId, name: 'parent', note: 'p', presentations: ['local:child']},
    ]);
    const objects = await createdObjects(runtime, token.value);
    assert.equal(objects.length, 2);
    const [child, parent] = objects;
    assert.equal(parent.indexed[0].objectId, child.id, 'parent references the fresh child by minted id');
  } finally {
    await runtime.close();
  }
});

// --- per-class denial: a member whose class lacks object/create ----------------------------------------

test('a member whose class lacks object/create denies the whole batch, nothing written', async () => {
  const {runtime, create, presentationClassRef, perspectiveClassRef, historyLength} = await seed({
    grants: ({presentation}) => [createGrant('demo', presentation)],
  });
  try {
    const before = await historyLength();
    await assert.rejects(
      create([
        {class: presentationClassRef.objectId, name: 'ok', note: 'fine', presentations: []},
        {class: perspectiveClassRef.objectId, name: 'denied', note: 'no grant', presentations: []},
      ]),
      /not authorized: object\/create/,
    );
    assert.equal(await historyLength(), before, 'a denied batch commits nothing');
    assert.equal(await runtime.images.getObject('demo', 'ok'), null, 'the valid member is not committed');
  } finally {
    await runtime.close();
  }
});

// --- no authority context at all ----------------------------------------------------------------------

test('a batch without any authority context is denied, nothing written', async () => {
  const {runtime, create, presentationClassRef, historyLength} = await seed({grants: null});
  try {
    const before = await historyLength();
    await assert.rejects(
      create([{class: presentationClassRef.objectId, name: 'x', note: 'n', presentations: []}]),
      /no authority context was supplied/,
    );
    assert.equal(await historyLength(), before, 'a denied batch commits nothing');
  } finally {
    await runtime.close();
  }
});

// --- atomicity: validation failure on the LAST member ------------------------------------------------

test('a validation failure on the last member denies the whole batch, history unchanged', async () => {
  const {runtime, create, presentationClassRef, perspectiveClassRef, historyLength} = await seed({
    grants: ({presentation, perspective}) => [createGrant('demo', presentation), createGrant('demo', perspective)],
  });
  try {
    const before = await historyLength();
    // The last member supplies a field that is not declared in the record type.
    await assert.rejects(
      create([
        {class: presentationClassRef.objectId, name: 'ok', note: 'fine', presentations: []},
        {class: perspectiveClassRef.objectId, name: 'bad', note: 'bad', presentations: [], subject: 'target'},
      ]),
      /InterfaceCompositeError.*composite.*has fields not in the type|does not map record field/,
    );
    assert.equal(await historyLength(), before, 'a validation failure commits nothing');
    assert.equal(await runtime.images.getObject('demo', 'ok'), null, 'the valid member is not committed');
  } finally {
    await runtime.close();
  }
});

// --- fail closed: a member carrying a field its class does not map ------------------------------------

test('a member supplying a field its class does not map rejects the whole batch, nothing written', async () => {
  const {runtime, create, presentationClassRef, perspectiveClassRef, historyLength} = await seed({
    grants: ({presentation, perspective}) => [createGrant('demo', presentation), createGrant('demo', perspective)],
  });
  try {
    const before = await historyLength();
    // `presentations` is Perspective-only; a Presentation member must not silently drop it.
    await assert.rejects(
      create([
        {class: presentationClassRef.objectId, name: 'a', note: 'first', presentations: ['target']},
        {class: perspectiveClassRef.objectId, name: 'p', note: 'parent', presentations: []},
      ]),
      (error) => error instanceof TypeError
        && /member 0/.test(error.message)
        && /presentations/.test(error.message)
        && /does not map/.test(error.message),
    );
    assert.equal(await historyLength(), before, 'an unmapped-field batch commits nothing');
    const objects = await runtime.images.listObjects('demo');
    assert.ok(!objects.some((o) => o.slots['slot-note']?.value === 'first'), 'the Presentation member does not exist');
    assert.ok(!objects.some((o) => o.slots['slot-note']?.value === 'parent'), 'the Perspective member does not exist');
  } finally {
    await runtime.close();
  }
});

// --- dangling/duplicate local names ------------------------------------------------------------------

test('a dangling local name rejects the batch, nothing written', async () => {
  const {runtime, create, presentationClassRef, perspectiveClassRef, historyLength} = await seed({
    grants: ({presentation, perspective}) => [createGrant('demo', presentation), createGrant('demo', perspective)],
  });
  try {
    const before = await historyLength();
    await assert.rejects(
      create([
        {class: presentationClassRef.objectId, name: 'a', note: 'first', presentations: []},
        {class: perspectiveClassRef.objectId, name: 'p', note: 'parent', presentations: ['local:missing']},
      ]),
      /unknown local name/,
    );
    assert.equal(await historyLength(), before, 'a dangling local name commits nothing');
  } finally {
    await runtime.close();
  }
});

test('a duplicate local name rejects the batch, nothing written', async () => {
  const {runtime, create, presentationClassRef, perspectiveClassRef, historyLength} = await seed({
    grants: ({presentation, perspective}) => [createGrant('demo', presentation), createGrant('demo', perspective)],
  });
  try {
    const before = await historyLength();
    await assert.rejects(
      create([
        {class: presentationClassRef.objectId, name: 'a', note: 'first', presentations: []},
        {class: perspectiveClassRef.objectId, name: 'a', note: 'duplicate', presentations: []},
      ]),
      /duplicate local name/,
    );
    assert.equal(await historyLength(), before, 'a duplicate local name commits nothing');
  } finally {
    await runtime.close();
  }
});

// --- local names never leak -------------------------------------------------------------------------

test('local names never leak into stored records or the returned token', async () => {
  const {runtime, create, presentationClassRef, perspectiveClassRef} = await seed({
    grants: ({presentation, perspective}) => [createGrant('demo', presentation), createGrant('demo', perspective)],
  });
  try {
    // A distinctive, token-like local name so "not contained in the token" is a genuine check rather
    // than vacuous (a generic word could simply never appear in a base64url id).
    const localName = 'zz-localhandle-qx7';
    const token = await create([
      {class: presentationClassRef.objectId, name: localName, note: 'c', presentations: []},
      {class: perspectiveClassRef.objectId, name: 'parent', note: 'p', presentations: [`local:${localName}`]},
    ]);
    assert.equal(token.kind, 'text');
    // The returned token must not contain the local name or the local: prefix.
    assert.ok(!token.value.includes('local:'), 'token does not contain local:');
    assert.ok(!token.value.includes(localName), 'token does not contain the local name');
    // The stored records must not contain local: strings anywhere.
    const objects = await createdObjects(runtime, token.value);
    for (const obj of objects) {
      const text = JSON.stringify(obj);
      assert.ok(!text.includes('local:'), `stored record ${obj.id} does not contain local:`);
    }
  } finally {
    await runtime.close();
  }
});
