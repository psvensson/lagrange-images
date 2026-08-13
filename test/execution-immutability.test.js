import test from 'node:test';
import assert from 'node:assert/strict';
import {MockBackend} from '../src/backend/index.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {objectRef, textValue} from '../src/value/index.js';

test('artifacts and blocks cannot be overwritten', async () => {
  const service = new ImageService({backend: new MockBackend()});
  await service.backend.start();
  await service.createImage({id: 'demo'});
  await service.putCodeArtifact('demo', {id: 'code', representation: 'source', content: textValue('body')});
  await service.putBlock('demo', {id: 'block', code: objectRef('demo', 'code')});
  await assert.rejects(service.putCodeArtifact('demo', {id: 'code', representation: 'source', content: textValue('body') }));
  await assert.rejects(service.putBlock('demo', {id: 'block', code: objectRef('demo', 'code')}));
});
