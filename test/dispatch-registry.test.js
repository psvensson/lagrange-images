import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DispatchNotFoundError,
  DispatchRegistrationError,
  DispatchRegistry,
} from '../src/runtime.js';

test('dispatch registry registers one resolver per language personality', () => {
  const registry = new DispatchRegistry();
  const dispatcher = {resolveMessage() { return null; }};

  assert.equal(registry.register('test-language', dispatcher), dispatcher);
  assert.equal(registry.get('test-language'), dispatcher);
  assert.equal(registry.has('test-language'), true);
  assert.deepEqual(registry.list(), ['test-language']);

  assert.throws(
    () => registry.register('test-language', dispatcher),
    DispatchRegistrationError,
  );
  assert.throws(
    () => registry.get('missing-language'),
    DispatchNotFoundError,
  );
});

test('dispatcher must expose message resolution rather than execution', () => {
  const registry = new DispatchRegistry();
  assert.throws(
    () => registry.register('bad', {execute() {}}),
    /resolveMessage/,
  );
});
