import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_WASM_COMPILER_ID,
  WASM_MODULE_V1,
  createCompilationGroup,
  createRuntime,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  objectRef,
  textValue,
} from '../src/runtime.js';

test('cacheable compilers reuse immutable derived artifacts by declared identity and key', async () => {
  let compileCount = 0;
  const compiler = Object.freeze({
    identity: 'test-compiler/v1',
    cacheKey({source, options}) {
      return {content: source.content, mode: options.mode ?? 'default'};
    },
    async compile({source, options}) {
      compileCount += 1;
      return {
        languageId: source.languageId,
        content: textValue(`${source.content.value}:${options.mode ?? 'default'}`),
      };
    },
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    codeCompilers: [['test-source/v0', 'test-target/v0', compiler]],
  });
  await runtime.images.createImage({id: 'demo'});
  const source = await runtime.images.putCodeArtifact('demo', {
    id: 'source',
    languageId: 'any-language',
    representation: 'test-source/v0',
    content: textValue('meaning'),
  });

  const first = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'first',
    targetRepresentation: 'test-target/v0',
    options: {mode: 'fast'},
  });
  const reused = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'ignored-when-reused',
    targetRepresentation: 'test-target/v0',
    options: {mode: 'fast'},
  });
  assert.equal(compileCount, 1);
  assert.equal(reused.id, first.id);
  assert.equal(first.metadata.compilerIdentity, 'test-compiler/v1');
  assert.match(first.metadata.derivationKey, /^[0-9a-f]{64}$/);

  const changed = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'changed',
    targetRepresentation: 'test-target/v0',
    options: {mode: 'small'},
  });
  assert.equal(compileCount, 2);
  assert.notEqual(changed.id, first.id);

  const annotated = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'annotated',
    targetRepresentation: 'test-target/v0',
    options: {mode: 'fast'},
    metadata: {purpose: 'debug'},
  });
  assert.equal(compileCount, 3);
  assert.equal(annotated.id, 'annotated');
  assert.equal(annotated.metadata.purpose, 'debug');
  assert.notEqual(annotated.metadata.derivationKey, first.metadata.derivationKey);

  const forced = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'forced',
    targetRepresentation: 'test-target/v0',
    options: {mode: 'fast'},
    reuse: false,
  });
  assert.equal(compileCount, 4);
  assert.equal(forced.id, 'forced');
  assert.equal(forced.metadata.derivationKey, first.metadata.derivationKey);
  await runtime.close();
});

test('compilers without an explicit cache contract never reuse implicitly', async () => {
  let compileCount = 0;
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    codeCompilers: [['opaque-source/v0', 'opaque-target/v0', {
      async compile({source}) {
        compileCount += 1;
        return {content: source.content};
      },
    }]],
  });
  await runtime.images.createImage({id: 'demo'});
  const source = await runtime.images.putCodeArtifact('demo', {
    id: 'source', representation: 'opaque-source/v0', content: textValue('x'),
  });
  const first = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'one', targetRepresentation: 'opaque-target/v0',
  });
  const second = await runtime.compilation.compileArtifact(objectRef('demo', source.id), {
    id: 'two', targetRepresentation: 'opaque-target/v0',
  });
  assert.equal(compileCount, 2);
  assert.equal(first.id, 'one');
  assert.equal(second.id, 'two');
  assert.equal(first.metadata.derivationKey, undefined);
  await runtime.close();
});

test('compilation groups describe compiler policy without prescribing a source language', () => {
  const group = createCompilationGroup({
    policyId: 'package-or-crate/v0',
    targetRepresentation: WASM_MODULE_V1,
    members: [objectRef('image', 'java-method'), objectRef('image', 'rust-function')],
    options: {optimization: 'release', moduleBudget: 64},
  });
  assert.equal(group.kind, 'compilation-group');
  assert.equal(group.policyId, 'package-or-crate/v0');
  assert.deepEqual(group.members, [objectRef('image', 'java-method'), objectRef('image', 'rust-function')]);
  assert.deepEqual(group.options, {optimization: 'release', moduleBudget: 64});
  assert.ok(Object.isFrozen(group.options));
  assert.throws(() => createCompilationGroup({
    policyId: 'bad',
    targetRepresentation: WASM_MODULE_V1,
    members: [objectRef('image', 'same'), objectRef('image', 'same')],
  }), /duplicate compilation group member/);
});

test('independent WASM Block-tree installations reuse modules but keep function and Block identities separate', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'source-tree',
    source: '[ :x | [ :y | [ :z | x ] ] ]',
  });

  const first = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', installed.semanticArtifact.id),
    id: 'tree-one',
  });
  const modulesAfterFirst = (await runtime.images.listCodeArtifacts('demo'))
    .filter((artifact) => artifact.representation === WASM_MODULE_V1);
  assert.equal(modulesAfterFirst.length, 3);
  assert.ok(modulesAfterFirst.every((artifact) => artifact.metadata.compilerIdentity === LAGRANGE_CODE_WASM_COMPILER_ID));

  const second = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', installed.semanticArtifact.id),
    id: 'tree-two',
  });
  const modulesAfterSecond = (await runtime.images.listCodeArtifacts('demo'))
    .filter((artifact) => artifact.representation === WASM_MODULE_V1);
  assert.equal(modulesAfterSecond.length, 3);

  const firstModules = new Map(first.nodes.map((node) => [node.semanticBlockId ?? '$root', node.moduleArtifact.id]));
  const secondModules = new Map(second.nodes.map((node) => [node.semanticBlockId ?? '$root', node.moduleArtifact.id]));
  assert.deepEqual(secondModules, firstModules);
  assert.notEqual(first.block.id, second.block.id);
  assert.notEqual(first.functionArtifact.id, second.functionArtifact.id);
  assert.equal(first.group.policyId, 'wasm-nested-block-tree/v0');
  assert.equal(first.group.members.length, 3);
  assert.equal(first.group.options.physicalLayout, 'one-module-per-member');
  await runtime.close();
});
