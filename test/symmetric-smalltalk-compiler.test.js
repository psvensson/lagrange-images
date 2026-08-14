import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYMMETRIC_SMALLTALK_SOURCE_V0,
  SYMMETRIC_SMALLTALK_SYNTAX_V0,
  compileSymmetricSmalltalkBlock,
  createRuntime,
  integerValue,
  objectRef,
  installSymmetricSmalltalkBlock,
} from '../src/runtime.js';
import {NEUTRAL_EXPRESSION_V0} from '../src/execution/executor.js';

test('Symmetric Smalltalk compiles parameters, captures, self and sends to neutral expressions', () => {
  const {program} = compileSymmetricSmalltalkBlock(
    '[ :target | target echo: captured ]',
    {captures: {captured: 'binding-captured'}},
  );
  assert.equal(program.parameters, 1);
  assert.equal(program.body.op, 'send');
  assert.equal(program.body.languageId, 'symmetric-smalltalk');
  assert.deepEqual(program.body.receiver, {op: 'argument', index: 0});
  assert.deepEqual(program.body.arguments[0], {op: 'binding', id: 'binding-captured'});
  assert.equal(program.body.message.kind, 'text');
  assert.equal(program.body.message.value, 'echo:');

  const selfProgram = compileSymmetricSmalltalkBlock('[ self ]').program;
  assert.deepEqual(selfProgram.body, {op: 'receiver'});
});

test('Symmetric Smalltalk rejects unbound names and nested executable blocks for now', () => {
  assert.throws(() => compileSymmetricSmalltalkBlock('[ missing ]'), /unbound/);
  assert.throws(() => compileSymmetricSmalltalkBlock('[ [ :x | x ] ]'), /nested block literals/);
});

test('installing a Symmetric Smalltalk Block preserves source, syntax and compiled provenance', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    imageId: 'demo',
    id: 'identity',
    source: '[ :value | value ]',
  });

  assert.equal(installed.sourceArtifact.representation, SYMMETRIC_SMALLTALK_SOURCE_V0);
  assert.equal(installed.syntaxArtifact.representation, SYMMETRIC_SMALLTALK_SYNTAX_V0);
  assert.equal(installed.codeArtifact.representation, NEUTRAL_EXPRESSION_V0);
  assert.deepEqual(installed.syntaxArtifact.derivedFrom, [objectRef('demo', 'identity:source')]);
  assert.deepEqual(installed.codeArtifact.derivedFrom, [objectRef('demo', 'identity:syntax')]);
  assert.deepEqual(installed.block.code, objectRef('demo', 'identity:code'));

  const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'identity'), [integerValue(7)]);
  assert.deepEqual(await runtime.executor.execute(activation), integerValue(7));
  await runtime.close();
});
