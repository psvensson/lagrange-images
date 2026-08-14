import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V0,
  NEUTRAL_EXPRESSION_V0,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';

test('executable artifacts can be deterministically rebuilt from semantic code', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const semantic = await runtime.images.putCodeArtifact('demo', {
    id: 'semantic',
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify({
      parameters: [{id: 'p0', name: 'value'}],
      captures: [],
      body: {op: 'argument', index: 0},
    })),
  });

  const first = await runtime.compilation.compileArtifact(objectRef('demo', semantic.id), {
    id: 'exec-a',
    targetRepresentation: NEUTRAL_EXPRESSION_V0,
  });
  const rebuilt = await runtime.compilation.compileArtifact(objectRef('demo', semantic.id), {
    id: 'exec-b',
    targetRepresentation: NEUTRAL_EXPRESSION_V0,
  });

  assert.deepEqual(first.content, rebuilt.content);
  assert.deepEqual(first.dependencies, []);
  assert.deepEqual(first.derivedFrom, [objectRef('demo', 'semantic')]);
  assert.deepEqual(rebuilt.derivedFrom, [objectRef('demo', 'semantic')]);
  assert.equal(JSON.parse(first.content.value).parameters, 1);
  await runtime.close();
});

test('in-process compilers may declare output artifact dependencies explicitly', async () => {
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    codeCompilers: [['example/source-v1', 'example/output-v1', {
      async compile() {
        return {
          content: textValue('compiled'),
          dependencies: [{role: 'runtime', artifact: objectRef('demo', 'runtime-library')}],
        };
      },
    }]],
  });
  await runtime.images.createImage({id: 'demo'});
  const library = await runtime.images.putCodeArtifact('demo', {
    id: 'runtime-library',
    representation: 'example/library-v1',
    content: textValue('library'),
  });
  const source = await runtime.images.putCodeArtifact('demo', {
    id: 'source',
    representation: 'example/source-v1',
    content: textValue('source'),
  });

  const compiled = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'compiled',
    targetRepresentation: 'example/output-v1',
  });
  assert.deepEqual(compiled.dependencies, [{role: 'runtime', artifact: objectRef('demo', library.id)}]);
  assert.deepEqual(compiled.derivedFrom, [objectRef('demo', source.id)]);
  await runtime.close();
});

test('runtime exposes the semantic compiler registry separately from executors', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  assert.equal(runtime.codeCompilers.has(LAGRANGE_CODE_V0, NEUTRAL_EXPRESSION_V0), true);
  assert.equal(runtime.codeExecutors.has(NEUTRAL_EXPRESSION_V0), true);
  await runtime.close();
});
