import test from 'node:test';
import assert from 'node:assert/strict';
import {BackendContractError, createBackend, LagrangeIntegrationError} from '../src/backend/index.js';

test('auto mode falls back to the mock when Lagrange is unavailable', async () => {
  const backend = await createBackend({
    mode: 'auto',
    lagrangeSpecifier: 'definitely-not-a-real-lagrange-package',
  });

  assert.equal(backend.kind, 'mock');
  assert.equal(backend.integration.lagrangeLoaded, false);
});

test('lagrange mode fails clearly when the package is unavailable', async () => {
  await assert.rejects(
    createBackend({
      mode: 'lagrange',
      lagrangeSpecifier: 'definitely-not-a-real-lagrange-package',
    }),
    LagrangeIntegrationError,
  );
});

test('a loaded Lagrange module can provide the backend through a factory', async () => {
  const backend = await createBackend({
    mode: 'lagrange',
    lagrangeSpecifier: new URL('../fixtures/fake-lagrange.js', import.meta.url).href,
    lagrangeFactory: async () => ({
      kind: 'lagrange-test',
      async start() {},
      async stop() {},
      async get() { return null; },
      async put(_collection, _key, value) { return value; },
      async scan() { return []; },
      async append(_stream, event) { return event; },
      async readStream() { return []; },
      async transaction(work) { return await work(this); },
    }),
  });

  assert.equal(backend.kind, 'lagrange-test');
});


test('injected backends must implement the atomic transaction contract', async () => {
  await assert.rejects(
    createBackend({
      mode: 'lagrange',
      lagrangeSpecifier: new URL('../fixtures/fake-lagrange.js', import.meta.url).href,
      lagrangeFactory: async () => ({
        async start() {},
        async stop() {},
        async get() { return null; },
        async put(_collection, _key, value) { return value; },
        async scan() { return []; },
        async append(_stream, event) { return event; },
        async readStream() { return []; },
      }),
    }),
    BackendContractError,
  );
});
