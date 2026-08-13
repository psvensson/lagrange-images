import test from 'node:test';
import assert from 'node:assert/strict';
import {bytesFromBase64, bytesValue, canonicalizeValue, objectRef, pinnedRef, textValue} from '../src/value/index.js';

test('bytes use canonical base64', () => {
  const value = bytesValue(new Uint8Array([0, 1, 2, 255]));
  assert.deepEqual(value, {kind: 'bytes', base64: 'AAEC/w=='});
  assert.deepEqual(bytesFromBase64(value.base64), value);
});

test('ordinary and historical references stay distinct', () => {
  assert.deepEqual(objectRef('image-a', 'fred'), {kind: 'ref', imageId: 'image-a', objectId: 'fred'});
  assert.deepEqual(pinnedRef('image-a', 'fred', 17), {
    kind: 'pinned-ref', imageId: 'image-a', objectId: 'fred', revision: '17',
  });
});

test('arbitrary host JSON is not a Value', () => {
  assert.throws(() => canonicalizeValue({nested: 'json'}), TypeError);
  assert.throws(() => canonicalizeValue('hello'), TypeError);
  assert.deepEqual(textValue('hello'), {kind: 'text', value: 'hello'});
});
