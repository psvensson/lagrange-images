import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodeArtifactRecord} from '../src/execution/model.js';
import {referencesOfRecord} from '../src/object/index.js';
import {objectRef, pinnedRef, textValue} from '../src/value/index.js';

test('code artifacts keep content, dependencies and provenance language-neutral', () => {
  const library = objectRef('core', 'library');
  const artifact = createCodeArtifactRecord({
    id: 'increment-source',
    imageId: 'core',
    languageId: 'symmetric-smalltalk',
    representation: 'source',
    content: textValue('increment body'),
    dependencies: [{role: 'library', artifact: library}],
    derivedFrom: [pinnedRef('core', 'design-note', 'r7')],
  });
  assert.equal(artifact.kind, 'code-artifact');
  assert.equal(artifact.content.kind, 'text');
  assert.deepEqual(artifact.dependencies, [{role: 'library', artifact: library}]);
  assert.deepEqual(referencesOfRecord(artifact), [library, pinnedRef('core', 'design-note', 'r7')]);
});

test('code artifact content may be a graph reference', () => {
  const syntax = objectRef('core', 'syntax-root');
  const artifact = createCodeArtifactRecord({
    id: 'increment-syntax', imageId: 'core', representation: 'syntax-tree', content: syntax,
  });
  assert.deepEqual(referencesOfRecord(artifact), [syntax]);
});

test('pre-dependency CodeArtifacts remain readable as dependency-free artifacts', () => {
  const current = createCodeArtifactRecord({
    id: 'legacy',
    imageId: 'core',
    representation: 'source',
    content: textValue('legacy'),
    derivedFrom: [objectRef('core', 'origin')],
  });
  const {dependencies, ...legacy} = current;
  assert.deepEqual(dependencies, []);
  assert.deepEqual(referencesOfRecord(Object.freeze(legacy)), [objectRef('core', 'origin')]);
});

test('artifact dependencies are explicit role-tagged unpinned refs', () => {
  assert.throws(() => createCodeArtifactRecord({
    id: 'self',
    imageId: 'core',
    representation: 'source',
    content: textValue('x'),
    dependencies: [{role: 'library', artifact: objectRef('core', 'self')}],
  }), /cannot depend on itself/);

  assert.throws(() => createCodeArtifactRecord({
    id: 'duplicate',
    imageId: 'core',
    representation: 'source',
    content: textValue('x'),
    dependencies: [
      {role: 'library', artifact: objectRef('core', 'dep')},
      {role: 'library', artifact: objectRef('core', 'dep')},
    ],
  }), /duplicate code artifact dependency/);

  assert.throws(() => createCodeArtifactRecord({
    id: 'pinned',
    imageId: 'core',
    representation: 'source',
    content: textValue('x'),
    dependencies: [{role: 'library', artifact: pinnedRef('core', 'dep', 'r1')}],
  }), /unpinned object ref/);
});
