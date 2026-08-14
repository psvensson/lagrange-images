import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V0,
  SYMMETRIC_SMALLTALK_SOURCE_V0,
  SYMMETRIC_SMALLTALK_SYNTAX_V0,
  compileSymmetricSmalltalkBlock,
  createRuntime,
  integerValue,
  objectRef,
  installSymmetricSmalltalkBlock,
} from '../src/runtime.js';
import {NEUTRAL_EXPRESSION_V0} from '../src/execution/executor.js';

test('Symmetric Smalltalk compiles into language-neutral semantic code', () => {
  const {semanticProgram} = compileSymmetricSmalltalkBlock(
    '[ :target | target echo: captured ]',
    {captures: {captured: 'binding-captured'}},
  );
  assert.deepEqual(semanticProgram.parameters, [{id: 'root:parameter:0', name: 'target'}]);
  assert.deepEqual(semanticProgram.captures, [{id: 'binding-captured', name: 'captured'}]);
  assert.equal(semanticProgram.body.op, 'send');
  assert.equal(semanticProgram.body.languageId, 'symmetric-smalltalk');
  assert.deepEqual(semanticProgram.body.receiver, {op: 'argument', index: 0});
  assert.deepEqual(semanticProgram.body.arguments[0], {op: 'binding', id: 'binding-captured'});

  const selfProgram = compileSymmetricSmalltalkBlock('[ self ]').semanticProgram;
  assert.deepEqual(selfProgram.body, {op: 'receiver'});
});

test('nested Smalltalk Blocks automatically capture free lexical bindings', () => {
  const {semanticProgram} = compileSymmetricSmalltalkBlock('[ :x | [ :y | x echo: y ] ]');
  const nested = semanticProgram.body;
  assert.equal(nested.op, 'block');
  assert.deepEqual(nested.captures, [{
    id: 'root:parameter:0',
    name: 'x',
    value: {op: 'argument', index: 0},
  }]);
  assert.deepEqual(nested.program.captures, [{id: 'root:parameter:0', name: 'x'}]);
  assert.deepEqual(nested.program.parameters, [{id: 'root/block:0:parameter:0', name: 'y'}]);
  assert.deepEqual(nested.program.body.receiver, {op: 'binding', id: 'root:parameter:0'});
  assert.deepEqual(nested.program.body.arguments[0], {op: 'argument', index: 0});
});

test('installing a Smalltalk Block preserves source, syntax, semantic and executable provenance', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'demo',
    id: 'identity',
    source: '[ :value | value ]',
  });

  assert.equal(installed.sourceArtifact.representation, SYMMETRIC_SMALLTALK_SOURCE_V0);
  assert.equal(installed.syntaxArtifact.representation, SYMMETRIC_SMALLTALK_SYNTAX_V0);
  assert.equal(installed.semanticArtifact.representation, LAGRANGE_CODE_V0);
  assert.equal(installed.codeArtifact.representation, NEUTRAL_EXPRESSION_V0);
  assert.deepEqual(installed.syntaxArtifact.derivedFrom, [objectRef('demo', 'identity:source')]);
  assert.deepEqual(installed.semanticArtifact.derivedFrom, [objectRef('demo', 'identity:syntax')]);
  assert.deepEqual(installed.codeArtifact.derivedFrom, [objectRef('demo', 'identity:semantic')]);
  assert.deepEqual(installed.block.code, objectRef('demo', 'identity:code'));

  const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'identity'), [integerValue(7)]);
  assert.deepEqual(await runtime.executor.execute(activation), integerValue(7));
  await runtime.close();
});
