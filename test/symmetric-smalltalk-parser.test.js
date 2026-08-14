import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SymmetricSmalltalkSyntaxError,
  parseSymmetricSmalltalk,
  parseSymmetricSmalltalkBlock,
} from '../src/language/index.js';

test('Symmetric Smalltalk parses block parameters, comments and escaped strings', () => {
  const syntax = parseSymmetricSmalltalkBlock("[ :name | \"comment\" name echo: 'it''s fine' ]");
  assert.equal(syntax.kind, 'block');
  assert.deepEqual(syntax.parameters, ['name']);
  assert.equal(syntax.body.kind, 'send');
  assert.equal(syntax.body.selector, 'echo:');
  assert.equal(syntax.body.receiver.kind, 'name');
  assert.equal(syntax.body.arguments[0].kind, 'string');
  assert.equal(syntax.body.arguments[0].value, "it's fine");
});

test('Symmetric Smalltalk keeps unary, binary and keyword precedence', () => {
  const syntax = parseSymmetricSmalltalk('target size + offset scaledBy: factor');
  assert.equal(syntax.kind, 'send');
  assert.equal(syntax.selector, 'scaledBy:');
  assert.equal(syntax.receiver.kind, 'send');
  assert.equal(syntax.receiver.selector, '+');
  assert.equal(syntax.receiver.receiver.kind, 'send');
  assert.equal(syntax.receiver.receiver.selector, 'size');
  assert.equal(syntax.arguments[0].kind, 'name');
  assert.equal(syntax.arguments[0].name, 'factor');
});

test('Symmetric Smalltalk parses nested block syntax before runtime closure creation exists', () => {
  const syntax = parseSymmetricSmalltalkBlock('[ [ :x | x ] ]');
  assert.equal(syntax.body.kind, 'block');
  assert.deepEqual(syntax.body.parameters, ['x']);
});

test('Symmetric Smalltalk reports duplicate block parameters', () => {
  assert.throws(
    () => parseSymmetricSmalltalkBlock('[ :x :x | x ]'),
    SymmetricSmalltalkSyntaxError,
  );
});
