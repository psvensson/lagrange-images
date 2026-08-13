import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLexicalEnvironmentLayoutCompatible,
  createLexicalEnvironmentRecord,
} from '../src/execution/model.js';
import {referencesOfRecord} from '../src/object/index.js';
import {integerValue, objectRef} from '../src/value/index.js';

test('lexical environments use stable binding ids and diagnostic names', () => {
  const first = createLexicalEnvironmentRecord({
    id: 'env', imageId: 'demo',
    bindings: {
      'binding-x': {name: 'x', value: integerValue(1)},
      'binding-peer': {name: 'peer', value: objectRef('demo', 'peer')},
    },
  });
  const renamed = createLexicalEnvironmentRecord({
    id: 'env', imageId: 'demo',
    bindings: {
      'binding-x': {name: 'count', value: integerValue(2)},
      'binding-peer': {name: 'peer', value: objectRef('demo', 'peer')},
    },
  });
  assertLexicalEnvironmentLayoutCompatible(first, renamed);
  assert.equal(renamed.bindings['binding-x'].name, 'count');
  assert.deepEqual(referencesOfRecord(renamed), [objectRef('demo', 'peer')]);
});

test('environment parent and binding identities form a stable layout', () => {
  const parent = objectRef('demo', 'outer');
  const first = createLexicalEnvironmentRecord({
    id: 'env', imageId: 'demo', parent,
    bindings: {'binding-x': {name: 'x', value: integerValue(1)}},
  });
  const changed = createLexicalEnvironmentRecord({
    id: 'env', imageId: 'demo', parent,
    bindings: {'binding-y': {name: 'y', value: integerValue(1)}},
  });
  assert.throws(() => assertLexicalEnvironmentLayoutCompatible(first, changed), /binding ids/);
  assert.throws(() => createLexicalEnvironmentRecord({
    id: 'env', imageId: 'demo', parent: objectRef('demo', 'env'), bindings: {},
  }), /own parent/);
});

test('environment binding values must be tagged Values', () => {
  assert.throws(() => createLexicalEnvironmentRecord({
    id: 'env', imageId: 'demo', bindings: {'binding-x': {name: 'x', value: 42}},
  }), TypeError);
});
