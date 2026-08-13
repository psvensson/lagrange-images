import test from 'node:test';
import assert from 'node:assert/strict';
import {MockBackend} from '../src/backend/index.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {integerValue, objectRef, textValue} from '../src/value/index.js';

test('blocks share durable environment identity', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({backend});
  await service.createImage({id: 'core'});
  await service.createImage({id: 'app'});
  await service.putCodeArtifact('core', {id: 'code', representation: 'source', content: textValue('body')});
  const environment = await service.putLexicalEnvironment('app', {
    id: 'env', bindings: {'captured': {name: 'captured', value: integerValue(1)}},
  });
  const block = await service.putBlock('app', {
    id: 'block', code: objectRef('core', 'code'), environment: objectRef('app', 'env'),
  });
  const updated = await service.putLexicalEnvironment('app', {
    id: 'env', bindings: {'captured': {name: 'count', value: integerValue(2)}},
  }, {expectedVersion: environment._version});
  assert.equal(updated._version, 2);
  assert.deepEqual(block.environment, objectRef('app', 'env'));
});

test('semantic refs are checked by record kind', async () => {
  const backend = new MockBackend();
  await backend.start();
  const service = new ImageService({backend});
  await service.createImage({id: 'demo'});
  await service.putLexicalEnvironment('demo', {id: 'env', bindings: {}});
  await assert.rejects(service.putBlock('demo', {id: 'bad', code: objectRef('demo', 'env')}), /code-artifact/);
});
