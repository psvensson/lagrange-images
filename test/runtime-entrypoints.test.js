import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import * as compatibility from '../src/index.js';
import * as canonical from '../src/runtime.js';
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

test('legacy source entrypoint re-exports the canonical graph runtime', async () => {
  assert.equal(compatibility.createRuntime, canonical.createRuntime);
  assert.equal(compatibility.ImageService, canonical.ImageService);

  const runtime = await compatibility.createRuntime({backend: {mode: 'mock'}});
  try {
    assert.ok(runtime.images instanceof canonical.ImageService);
    assert.ok(runtime.compilation);
    assert.ok(runtime.toolchains);
    assert.ok(runtime.invocations);
    assert.ok(runtime.executor);
  } finally {
    await runtime.close();
  }
});

test('the sole HTTP server exposes graph records and rejects legacy object shortcuts', async () => {
  const runtime = await canonical.createRuntime({backend: {mode: 'mock'}});
  const server = await createImageHttpServer({runtime});
  const address = await listen(server);

  try {
    assert.equal((await sendJson({
      port: address.port,
      method: 'POST',
      path: '/images',
      body: {id: 'demo', name: 'Demo'},
    })).status, 201);

    assert.equal((await sendJson({
      port: address.port,
      method: 'PUT',
      path: '/images/demo/shapes/item-shape',
      body: {slots: [{id: 'slot-value', name: 'value'}]},
    })).status, 201);

    assert.equal((await sendJson({
      port: address.port,
      method: 'PUT',
      path: '/images/demo/objects/item',
      body: {
        shape: canonical.objectRef('demo', 'item-shape'),
        slots: {'slot-value': canonical.integerValue(42)},
      },
    })).status, 200);

    const records = await sendJson({
      port: address.port,
      method: 'GET',
      path: '/images/demo/records',
    });
    assert.equal(records.status, 200);
    assert.deepEqual(records.body.map(({kind}) => kind).sort(), ['object', 'shape']);

    const legacy = await sendJson({
      port: address.port,
      method: 'PUT',
      path: '/images/demo/objects/legacy',
      body: {
        classId: 'LegacyThing',
        source: 'LegacyThing >> value [ ^ 42 ]',
        shape: canonical.objectRef('demo', 'item-shape'),
        slots: {'slot-value': canonical.integerValue(42)},
      },
    });
    assert.equal(legacy.status, 400);
    assert.match(legacy.body.message, /unknown generic object fields: classId, source/);
  } finally {
    await server.closeRuntime();
    await runtime.close();
  }
});
