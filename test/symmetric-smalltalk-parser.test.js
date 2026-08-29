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

// ADR 0057 workstream 3. Real Smalltalk source (upstream MessagePack-Core) writes integer literals
// in radix form — `16rFF`, `2r10100000`, `16r100000000`. Radix is *source syntax*, never runtime
// representation: the token lowers to the same canonical decimal text an ordinary `255` would, so
// the parser, the semantic layer and `integerValue` (which accepts only `/^-?\d+$/`) see no radix.
test('Symmetric Smalltalk parses radix integer literals to their decimal value', () => {
  const body = parseSymmetricSmalltalk('[ 16rFF. 2r1010. 16r100000000. 10r42 ]').body;
  assert.equal(body.kind, 'sequence');
  assert.deepEqual(
    body.statements.map((statement) => [statement.kind, statement.value]),
    [['integer', '255'], ['integer', '10'], ['integer', '4294967296'], ['integer', '42']],
  );
});

test('Symmetric Smalltalk applies unary minus to a radix literal as a send, not a sign', () => {
  // `-16r80` is `16r80 negated`-style: the leading `-` is a binary selector send in source order.
  // Here it binds as the argument's receiver, exactly as `- 5` would.
  const body = parseSymmetricSmalltalk('[ 0 - 16r80 ]').body;
  assert.equal(body.kind, 'send');
  assert.equal(body.selector, '-');
  assert.equal(body.arguments[0].kind, 'integer');
  assert.equal(body.arguments[0].value, '128');
});

test('Symmetric Smalltalk rejects a radix literal with a digit outside its base', () => {
  assert.throws(() => parseSymmetricSmalltalk('[ 2r102 ]'), SymmetricSmalltalkSyntaxError);
  assert.throws(() => parseSymmetricSmalltalk('[ 16r ]'), SymmetricSmalltalkSyntaxError);
  assert.throws(() => parseSymmetricSmalltalk('[ 37r10 ]'), SymmetricSmalltalkSyntaxError);
});
