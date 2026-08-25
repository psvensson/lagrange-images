import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHAPE_INDEXED,
  createAuthorityService,
  createRuntime,
  installCallableInterfaceV2,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  packCompositeValue,
  textValue,
} from '../src/runtime.js';
import {installImageMutationBinding, OBJECT_WRITE_OPERATION} from '../src/callable/image-mutation-binding.js';
import {OBJECT_EDGE_WRITE_OPERATION} from '../src/callable/image-creation-binding.js';
import {objectVersionToken} from '../src/object/version-token.js';
import {transientObjectId} from '../src/value/transient-ref.js';

// ADR 0065. The mutation lane can rewrite an existing object's indexed part — append leaf (under
// object/write alone), append ref (each added ref per-target object/edge-write, ADR 0042 §7), and
// reorder (object/write alone) — under the same version-token CAS. It must NEVER remove an element
// (edge removal, ADR 0062 §8 deferred), and element identity is canonical-Value identity (a pinned
// ref's identity includes its revision), so a ref->pin swap is a removal, not a no-op re-pin.

const writeGrant = (imageId, objectId) => ({operation: OBJECT_WRITE_OPERATION, resource: objectResource(imageId, objectId)});
const edgeGrant = (imageId, targetId) => ({operation: OBJECT_EDGE_WRITE_OPERATION, resource: objectResource(imageId, targetId)});

// A Perspective-like record: a label leaf slot plus an indexed part. The ref variant mutates the
// presentations ref-list; the leaf variant mutates an integer-list.
const PERSP_TYPES = normalizeTypeDeclarations({
  perspective: {kind: 'record', fields: [
    {name: 'label', type: 'string'},
    {name: 'presentations', type: {kind: 'list', element: 'string'}},
  ]},
});
const PERSP_FIELDS = [
  {name: 'label', slot: 'slot-label'},
  {name: 'presentations', indexed: true, edge: true},
];
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

async function seed({
  grants = null,
  types = PERSP_TYPES,
  fields = PERSP_FIELDS,
  initialIndexed = null, // array of canonical Values, or null for a non-indexed object
} = {}) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority});
  await runtime.images.createImage({id: 'demo'});

  const shape = await runtime.images.putShape('demo', {
    id: 'item-shape', slots: [{id: 'slot-label', name: 'label'}],
    ...(initialIndexed === null ? {} : {indexed: SHAPE_INDEXED.VALUES}),
  });
  // Durable edge targets.
  const targetShape = await runtime.images.putShape('demo', {id: 'target-shape', slots: []});
  for (const id of ['pres-1', 'pres-2', 'pres-3']) {
    await runtime.images.putObject('demo', {id, shape: objectRef('demo', targetShape.id), slots: {}, metadata: {}}, {expectedVersion: 0});
  }

  const stored = await runtime.images.putObject('demo', {
    id: 'item', shape: objectRef('demo', shape.id),
    slots: {'slot-label': textValue('original')},
    ...(initialIndexed === null ? {} : {indexed: initialIndexed}),
    metadata: {origin: 'seed'},
  }, {expectedVersion: 0});

  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'write-item',
    functionName: 'write-item', parameters: ['string', 'string', Object.keys(types)[0]], result: 'string', types,
  });
  await installImageMutationBinding({
    images: runtime.images, callableInterface: objectRef('demo', callableInterface.id),
    fields, bindingId: 'mutation', blockId: 'mutation-block',
  });

  const resolved = typeof grants === 'function' ? grants('item') : grants;
  const context = resolved === null ? null : authority.issue({principal: 'alice', grants: resolved});
  let version = stored._version;
  const write = async (value, token = objectVersionToken('demo', 'item', version)) => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'mutation-block'), [
      textValue('item'), textValue(token), packCompositeValue(value, Object.keys(types)[0], types),
    ]);
    const result = await runtime.executor.execute(activation, context === null ? {} : {authority: context});
    version += 1;
    return result;
  };
  const current = () => runtime.images.getObject('demo', 'item');
  return {runtime, authority, write, current, objectVersionToken, getVersion: () => version};
}

const R = (id) => objectRef('demo', id);

// --- append leaf under object/write alone ------------------------------------------------------------

test('appending a leaf element is authorized by object/write alone, no edge grant', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj)],
    types: LEAF_TYPES, fields: LEAF_FIELDS, initialIndexed: [integerValue(1)],
  });
  try {
    await write({label: 'original', values: [1n, 2n, 3n]});
    assert.deepEqual((await current()).indexed, [integerValue(1), integerValue(2), integerValue(3)]);
  } finally {
    await runtime.close();
  }
});

// --- append ref: per-target grant --------------------------------------------------------------------

test('appending a ref element is denied without its per-target edge grant, and nothing is written', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj)], // object/write only — NO edge grant on pres-2
    initialIndexed: [R('pres-1')],
  });
  try {
    await assert.rejects(
      write({label: 'original', presentations: ['pres-1', 'pres-2']}),
      (error) => error.name === 'AuthorityError' && /object\/edge-write/.test(error.message),
    );
    // The object is unchanged: the denied append did not commit.
    assert.deepEqual((await current()).indexed, [R('pres-1')]);
  } finally {
    await runtime.close();
  }
});

test('appending ref elements is permitted with the per-target grant, preserving existing edges', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj), edgeGrant('demo', 'pres-2'), edgeGrant('demo', 'pres-3')],
    initialIndexed: [R('pres-1')],
  });
  try {
    await write({label: 'original', presentations: ['pres-1', 'pres-2', 'pin:pres-3@4']});
    const indexed = (await current()).indexed;
    // pres-1 kept (no grant needed — it was already there); pres-2 added plain; pres-3 added pinned.
    assert.deepEqual(indexed[0], R('pres-1'));
    assert.deepEqual(indexed[1], R('pres-2'));
    assert.equal(indexed[2].kind, 'pinned-ref');
    assert.equal(indexed[2].objectId, 'pres-3');
    assert.equal(indexed[2].revision, '4');
  } finally {
    await runtime.close();
  }
});

test('a transient added element is refused before any write', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj), edgeGrant('demo', transientObjectId('ghost'))],
    initialIndexed: [R('pres-1')],
  });
  try {
    await assert.rejects(
      write({label: 'original', presentations: ['pres-1', transientObjectId('ghost')]}),
      /transient/,
    );
    assert.deepEqual((await current()).indexed, [R('pres-1')]);
  } finally {
    await runtime.close();
  }
});

// --- reorder under object/write alone -----------------------------------------------------------------

test('reordering existing elements is authorized by object/write alone, no edge grant', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj)], // no edge grant at all
    initialIndexed: [R('pres-1'), R('pres-2')],
  });
  try {
    await write({label: 'original', presentations: ['pres-2', 'pres-1']});
    assert.deepEqual((await current()).indexed, [R('pres-2'), R('pres-1')]);
  } finally {
    await runtime.close();
  }
});

// --- no removal: shrink is refused ---------------------------------------------------------------------

test('removing an element is refused (edge removal deferred), and the object is unchanged', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj), edgeGrant('demo', 'pres-1'), edgeGrant('demo', 'pres-2')],
    initialIndexed: [R('pres-1'), R('pres-2')],
  });
  try {
    await assert.rejects(
      write({label: 'original', presentations: ['pres-1']}), // drops pres-2
      /cannot remove indexed element/,
    );
    assert.deepEqual((await current()).indexed, [R('pres-1'), R('pres-2')]);
  } finally {
    await runtime.close();
  }
});

test('a ref->pin swap of an existing element is refused as a removal, not treated as a no-op re-pin', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj), edgeGrant('demo', 'pres-1')],
    initialIndexed: [R('pres-1')], // a PLAIN ref
  });
  try {
    // Replacing the plain ref with a pinned ref to the same target drops the plain edge (a removal)
    // and adds a different one. It must be refused as a shrink of the plain edge.
    await assert.rejects(
      write({label: 'original', presentations: ['pin:pres-1@2']}),
      /cannot remove indexed element/,
    );
    assert.deepEqual((await current()).indexed, [R('pres-1')]);
  } finally {
    await runtime.close();
  }
});

// --- multiset semantics (ADR 0065 §3): the no-removal invariant counts OCCURRENCES -------------------
//
// The no-removal rule is a multiset rule: `new` must contain every element of `old` with at least
// its old multiplicity, under canonical-Value identity. A counter that resets on a non-match would
// let a caller drop an edge without removal authority — an authority-semantics bug, not a list bug.
// These cases pin the exact transitions, including duplicates, through the public mutation behavior.

// old [1] -> new [1,2,3]: allowed (pure append).
test('multiset: [1] -> [1,2,3] is allowed', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj)],
    types: LEAF_TYPES, fields: LEAF_FIELDS, initialIndexed: [integerValue(1)],
  });
  try {
    await write({label: 'original', values: [1n, 2n, 3n]});
    assert.deepEqual((await current()).indexed, [integerValue(1), integerValue(2), integerValue(3)]);
  } finally {
    await runtime.close();
  }
});

// old [1,2,3] -> new [3,2,1]: allowed (reorder, multiset unchanged).
test('multiset: [1,2,3] -> [3,2,1] is allowed as a reorder', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj)],
    types: LEAF_TYPES, fields: LEAF_FIELDS, initialIndexed: [integerValue(1), integerValue(2), integerValue(3)],
  });
  try {
    await write({label: 'original', values: [3n, 2n, 1n]});
    assert.deepEqual((await current()).indexed, [integerValue(3), integerValue(2), integerValue(1)]);
  } finally {
    await runtime.close();
  }
});

// old [1,2,3] -> new [1,3]: rejected (2 is removed).
test('multiset: [1,2,3] -> [1,3] is rejected as a removal', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj)],
    types: LEAF_TYPES, fields: LEAF_FIELDS, initialIndexed: [integerValue(1), integerValue(2), integerValue(3)],
  });
  try {
    await assert.rejects(
      write({label: 'original', values: [1n, 3n]}),
      /cannot remove an indexed element/,
    );
    assert.deepEqual((await current()).indexed, [integerValue(1), integerValue(2), integerValue(3)]);
  } finally {
    await runtime.close();
  }
});

// old [1,1,2] -> new [1,2]: rejected (ONE occurrence of 1 removed — the multiset count drops 2->1).
test('multiset: [1,1,2] -> [1,2] is rejected — one occurrence of 1 is removed', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj)],
    types: LEAF_TYPES, fields: LEAF_FIELDS, initialIndexed: [integerValue(1), integerValue(1), integerValue(2)],
  });
  try {
    await assert.rejects(
      write({label: 'original', values: [1n, 2n]}),
      /cannot remove an indexed element/,
    );
    assert.deepEqual((await current()).indexed, [integerValue(1), integerValue(1), integerValue(2)]);
  } finally {
    await runtime.close();
  }
});

// old [1,1,2] -> new [2,1,1,3]: allowed (both occurrences of 1 kept, reordered, 3 appended).
test('multiset: [1,1,2] -> [2,1,1,3] is allowed — occurrences kept, reordered, one appended', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj)],
    types: LEAF_TYPES, fields: LEAF_FIELDS, initialIndexed: [integerValue(1), integerValue(1), integerValue(2)],
  });
  try {
    await write({label: 'original', values: [2n, 1n, 1n, 3n]});
    assert.deepEqual((await current()).indexed, [integerValue(2), integerValue(1), integerValue(1), integerValue(3)]);
  } finally {
    await runtime.close();
  }
});

// --- concurrency + preservation -----------------------------------------------------------------------

test('a stale version token conflicts on a concurrent append, never last-writer-wins', async () => {
  const {runtime, write, current, objectVersionToken} = await seed({
    grants: (obj) => [writeGrant('demo', obj), edgeGrant('demo', 'pres-2'), edgeGrant('demo', 'pres-3')],
    initialIndexed: [R('pres-1')],
  });
  try {
    // First append commits (version 1 -> 2): indexed becomes [pres-1, pres-2].
    await write({label: 'original', presentations: ['pres-1', 'pres-2']});
    // A second write with the STALE v1 token. It is a valid append against the CURRENT state
    // ([pres-1,pres-2,pres-3] — no removal), so the no-removal check passes and the failure is the
    // CAS conflict, not a removal refusal. It must conflict, never last-writer-wins.
    await assert.rejects(
      write({label: 'original', presentations: ['pres-1', 'pres-2', 'pres-3']}, objectVersionToken('demo', 'item', 1)),
      (error) => error.name === 'ObjectMutationConflictError',
    );
    // The winner's state stands; the loser's element was not silently merged.
    assert.deepEqual((await current()).indexed, [R('pres-1'), R('pres-2')]);
  } finally {
    await runtime.close();
  }
});

test('an indexed rewrite preserves slots and metadata on the whole-record rewrite', async () => {
  const {runtime, write, current} = await seed({
    grants: (obj) => [writeGrant('demo', obj)],
    types: LEAF_TYPES, fields: LEAF_FIELDS, initialIndexed: [integerValue(1)],
  });
  try {
    await write({label: 'renamed', values: [1n, 5n]});
    const object = await current();
    assert.deepEqual(object.slots['slot-label'], textValue('renamed'), 'the slot write applied');
    assert.deepEqual(object.indexed, [integerValue(1), integerValue(5)]);
    assert.deepEqual(object.metadata, {origin: 'seed'}, 'metadata is preserved');
  } finally {
    await runtime.close();
  }
});

// --- refusals: indexed field on a non-indexed object --------------------------------------------------

test('an indexed field on an object with no indexed part is refused', async () => {
  const {runtime, write} = await seed({
    grants: (obj) => [writeGrant('demo', obj)],
    initialIndexed: null, // non-indexed object
  });
  try {
    await assert.rejects(
      write({label: 'original', presentations: ['pres-1']}),
      /no indexed part/,
    );
  } finally {
    await runtime.close();
  }
});
