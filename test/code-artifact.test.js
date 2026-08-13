import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodeArtifactRecord} from '../src/execution/model.js';
import {referencesOfRecord} from '../src/object/index.js';
import {objectRef, pinnedRef, textValue} from '../src/value/index.js';

test('code artifacts keep content and provenance language-neutral', () => {
  const artifact = createCodeArtifactRecord({
    id: 'increment-source',
    imageId: 'core',
    languageId: 'symmetric-smalltalk',
    representation: 'source',
    content: textValue('increment body'),
    derivedFrom: [pinnedRef('core', 'design-note', 'r7')],
  });
  assert.equal(artifact.kind, 'code-artifact');
  assert.equal(artifact.content.kind, 'text');
  assert.deepEqual(referencesOfRecord(artifact), [pinnedRef('core', 'design-note', 'r7')]);
});

test('code artifact content may be a graph reference', () => {
  const syntax = objectRef('core', 'syntax-root');
  const artifact = createCodeArtifactRecord({
    id: 'increment-syntax', imageId: 'core', representation: 'syntax-tree', content: syntax,
  });
  assert.deepEqual(referencesOfRecord(artifact), [syntax]);
});
