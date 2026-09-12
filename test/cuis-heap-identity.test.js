import test from 'node:test';
import assert from 'node:assert/strict';
import {findSpurHeapIdentity} from './support/cuis-heap-identity.js';

const numericUuid = '12345678-1234-4234-8234-123456789012';
test('native UUID identity is not a Spur address, even with decimal-only segments', () => {
  for (const identity of [
    'object/1/80781894-9a44-4054-8a2c-ac3f08adebea',
    `object/1/${numericUuid}`,
    JSON.stringify([`object/1/${numericUuid}`, 'native-image']),
    'cuis-method/Alien-Core/Alien/instance/oopAt:',
  ]) assert.equal(findSpurHeapIdentity(identity), null, identity);
});

test('explicit heap addresses and bare decimal identities remain causal counterexamples', () => {
  for (const identity of [
    'cuis-method/P/C/instance/0x0000abcdef12',
    'cuis-method/P/C/instance/foo@abcdef12',
    'object/123456789',
    '123456789',
    JSON.stringify(['123456789']),
    `object/1/${numericUuid}/123456789`,
    `object/@${numericUuid}`,
    // Not a valid native UUID: an address-like decimal prefix must remain visible.
    'object/1/12345678-1234-4234-1234-123456789012',
  ]) assert.notEqual(findSpurHeapIdentity(identity), null, identity);
});
