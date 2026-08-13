import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertObjectMatchesShape,
  createObjectRecord,
  createShapeRecord,
  referencesOfRecord,
} from '../src/object/index.js';
import {integerValue, objectRef, pinnedRef} from '../src/value/index.js';

test('slot identity survives a display-name rename across shape versions', () => {
  const first = createShapeRecord({
    id: 'address-v1', imageId: 'demo', slots: [{id: 'slot-postal', name: 'postalCode'}],
  });
  const second = createShapeRecord({
    id: 'address-v2', imageId: 'demo', slots: [{id: 'slot-postal', name: 'postcode'}],
  });
  assert.equal(first.slots[0].id, second.slots[0].id);
  assert.notEqual(first.slots[0].name, second.slots[0].name);
});

test('objects separate shape, behavior and value slots', () => {
  const shape = createShapeRecord({
    id: 'node-shape',
    imageId: 'demo',
    slots: [
      {id: 'slot-count', name: 'count'},
      {id: 'slot-peer', name: 'peer'},
      {id: 'slot-history', name: 'history'},
    ],
  });
  const object = createObjectRecord({
    id: 'node-a',
    imageId: 'demo',
    shape: objectRef('demo', 'node-shape'),
    behavior: objectRef('smalltalk-core', 'Node'),
    slots: {
      'slot-count': integerValue(1),
      'slot-peer': objectRef('demo', 'node-b'),
      'slot-history': pinnedRef('demo', 'node-b', 'snapshot:one'),
    },
  });
  assertObjectMatchesShape(object, shape);
  assert.deepEqual(
    referencesOfRecord(object).map(({kind, imageId, objectId}) => [kind, imageId, objectId]),
    [
      ['ref', 'demo', 'node-shape'],
      ['ref', 'smalltalk-core', 'Node'],
      ['ref', 'demo', 'node-b'],
      ['pinned-ref', 'demo', 'node-b'],
    ],
  );
});

test('object slots reject arbitrary host values', () => {
  assert.throws(() => createObjectRecord({
    id: 'bad', imageId: 'demo', shape: objectRef('demo', 'shape'), slots: {'slot-value': 42},
  }), TypeError);
});

test('object slot keys must match their shape exactly', () => {
  const shape = createShapeRecord({
    id: 'pair-shape', imageId: 'demo', slots: [{id: 'left', name: 'left'}, {id: 'right', name: 'right'}],
  });
  const incomplete = createObjectRecord({
    id: 'pair', imageId: 'demo', shape: objectRef('demo', 'pair-shape'), slots: {left: integerValue(1)},
  });
  assert.throws(() => assertObjectMatchesShape(incomplete, shape), TypeError);
});

test('metadata cannot hide graph references', () => {
  assert.throws(() => createObjectRecord({
    id: 'bad-metadata',
    imageId: 'demo',
    shape: objectRef('demo', 'shape'),
    slots: {},
    metadata: {owner: objectRef('demo', 'someone')},
  }), /graph edges belong in slots/);
});
