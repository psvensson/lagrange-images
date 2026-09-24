import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createRuntime, integerValue, objectRef} from '../src/runtime.js';
import {createImageHttpServer} from '../src/server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function sendJson({port, method, path, body = null}) {
  return new Promise((resolve, reject) => {
    const bytes = body === null ? null : Buffer.from(JSON.stringify(body));
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: bytes === null ? {} : {
        'content-type': 'application/json',
        'content-length': bytes.length,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          body: text.length === 0 ? null : JSON.parse(text),
        });
      });
    });
    request.once('error', reject);
    if (bytes !== null) request.write(bytes);
    request.end();
  });
}

// Every test serves the same injected mock-backed runtime on an ephemeral
// loopback port; the server never owns the injected runtime, so both are closed.
async function startContractServer() {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const server = await createImageHttpServer({runtime});
  const address = await listen(server);
  return {
    runtime,
    server,
    port: address.port,
    request: ({method, path, body = null}) => sendJson({port: address.port, method, path, body}),
    async close() {
      await server.closeRuntime();
      await runtime.close();
    },
  };
}

async function seedImageAndShape(contract, {imageId = 'contract'} = {}) {
  const created = await contract.request({
    method: 'POST',
    path: '/images',
    body: {id: imageId, name: 'Contract'},
  });
  assert.equal(created.status, 201);

  const shape = await contract.request({
    method: 'PUT',
    path: `/images/${imageId}/shapes/item-shape`,
    body: {slots: [{id: 'slot-value', name: 'value'}]},
  });
  assert.equal(shape.status, 201);
  return {imageId};
}

test('GET /health returns the ok envelope with backend fields', async () => {
  const contract = await startContractServer();
  try {
    const health = await contract.request({method: 'GET', path: '/health'});
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, {
      ok: true,
      backend: 'mock',
      durable: false,
      integration: {selectedBy: 'explicit'},
    });
  } finally {
    await contract.close();
  }
});

test('image create/list/get, the unknown-image failure shape and unknown routes', async () => {
  const contract = await startContractServer();
  try {
    const created = await contract.request({
      method: 'POST',
      path: '/images',
      body: {id: 'contract', name: 'Contract'},
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'contract');
    assert.equal(created.body.name, 'Contract');
    assert.equal(created.body.language, 'symmetric-smalltalk');
    assert.equal(created.body._version, 1);

    const listed = await contract.request({method: 'GET', path: '/images'});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.map(({id}) => id), ['contract']);

    const fetched = await contract.request({method: 'GET', path: '/images/contract'});
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, 'contract');
    assert.equal(fetched.body.name, 'Contract');

    // The unknown-image failure shape: a 400 error envelope carrying the
    // thrown error's name and message.
    const missing = await contract.request({method: 'GET', path: '/images/missing'});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'TypeError');
    assert.match(missing.body.message, /image not found: missing/);

    // Unknown routes — both outside and inside the /images branch — are a 404
    // not-found envelope, never a 400.
    const unknown = await contract.request({method: 'GET', path: '/definitely-not-a-route'});
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, {error: 'not found'});

    const unknownSubroute = await contract.request({method: 'GET', path: '/images/contract/bogus'});
    assert.equal(unknownSubroute.status, 404);
    assert.deepEqual(unknownSubroute.body, {error: 'not found'});
  } finally {
    await contract.close();
  }
});

test('records, shapes and objects routes, with optimistic expectedVersion object writes', async () => {
  const contract = await startContractServer();
  try {
    const {imageId} = await seedImageAndShape(contract);

    const shapes = await contract.request({method: 'GET', path: `/images/${imageId}/shapes`});
    assert.equal(shapes.status, 200);
    assert.equal(shapes.body.length, 1);
    assert.equal(shapes.body[0].kind, 'shape');
    assert.equal(shapes.body[0].id, 'item-shape');
    assert.equal(shapes.body[0]._version, 1);

    const noObjects = await contract.request({method: 'GET', path: `/images/${imageId}/objects`});
    assert.equal(noObjects.status, 200);
    assert.deepEqual(noObjects.body, []);

    // Insert-only create: expectedVersion 0 admits the write exactly once.
    const created = await contract.request({
      method: 'PUT',
      path: `/images/${imageId}/objects/item`,
      body: {
        shape: objectRef(imageId, 'item-shape'),
        slots: {'slot-value': integerValue(42)},
        expectedVersion: 0,
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.kind, 'object');
    assert.equal(created.body.id, 'item');
    assert.equal(created.body._version, 1);
    assert.equal(created.body.slots['slot-value'].value, '42');

    // A write carrying the current version succeeds and advances the record.
    const updated = await contract.request({
      method: 'PUT',
      path: `/images/${imageId}/objects/item`,
      body: {
        shape: objectRef(imageId, 'item-shape'),
        slots: {'slot-value': integerValue(43)},
        expectedVersion: 1,
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body._version, 2);
    assert.equal(updated.body.slots['slot-value'].value, '43');

    // A stale expectation is refused with the version-conflict error envelope,
    // and the record is left at the version the conflict reported.
    const stale = await contract.request({
      method: 'PUT',
      path: `/images/${imageId}/objects/item`,
      body: {
        shape: objectRef(imageId, 'item-shape'),
        slots: {'slot-value': integerValue(44)},
        expectedVersion: 1,
      },
    });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error, 'VersionConflictError');
    assert.match(stale.body.message, /version conflict/);

    // Insert-only is also refused once the record exists.
    const reinsert = await contract.request({
      method: 'PUT',
      path: `/images/${imageId}/objects/item`,
      body: {
        shape: objectRef(imageId, 'item-shape'),
        slots: {'slot-value': integerValue(45)},
        expectedVersion: 0,
      },
    });
    assert.equal(reinsert.status, 400);
    assert.equal(reinsert.body.error, 'VersionConflictError');

    const objects = await contract.request({method: 'GET', path: `/images/${imageId}/objects`});
    assert.equal(objects.status, 200);
    assert.equal(objects.body.length, 1);
    assert.equal(objects.body[0]._version, 2);
    assert.equal(objects.body[0].slots['slot-value'].value, '43');

    const records = await contract.request({method: 'GET', path: `/images/${imageId}/records`});
    assert.equal(records.status, 200);
    assert.deepEqual(records.body.map(({kind}) => kind).sort(), ['object', 'shape']);
  } finally {
    await contract.close();
  }
});

test('history and snapshot routes', async () => {
  const contract = await startContractServer();
  try {
    const {imageId} = await seedImageAndShape(contract);
    const created = await contract.request({
      method: 'PUT',
      path: `/images/${imageId}/objects/item`,
      body: {
        shape: objectRef(imageId, 'item-shape'),
        slots: {'slot-value': integerValue(42)},
        expectedVersion: 0,
      },
    });
    assert.equal(created.status, 200);

    const history = await contract.request({method: 'GET', path: `/images/${imageId}/history`});
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.map(({type}) => type), [
      'image.created',
      'shape.put',
      'object.put',
    ]);
    assert.deepEqual(history.body.map(({revision}) => revision), [1, 2, 3]);

    const snapshot = await contract.request({
      method: 'POST',
      path: `/images/${imageId}/snapshots`,
      body: {label: 'contract-snapshot'},
    });
    assert.equal(snapshot.status, 201);
    assert.equal(typeof snapshot.body.id, 'string');
    assert.notEqual(snapshot.body.id.length, 0);
    assert.equal(snapshot.body.imageId, imageId);
    assert.equal(snapshot.body.label, 'contract-snapshot');
    assert.equal(snapshot.body.image.id, imageId);
    assert.deepEqual(snapshot.body.records.map(({kind}) => kind).sort(), ['object', 'shape']);
  } finally {
    await contract.close();
  }
});
