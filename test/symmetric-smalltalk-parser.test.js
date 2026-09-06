import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SymmetricSmalltalkSyntaxError,
  parseSymmetricSmalltalk,
  parseSymmetricSmalltalkBlock,
  tokenizeSymmetricSmalltalk,
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

// ==================================================================================================
// The Cuis legacy assignment arrow (bead lagrange-images-xxm.3).
//
// The lexical rule is MEASURED, not inferred from style: the oracle was executed against the
// pinned Cuis7.9-8090 image (Scanner new typedScanTokens:, Compiler evaluate:, Parser new
// parse:class:) and the mechanism confirmed in the pinned sources (Scanner>>xUnderscore, stamp
// jmv 26/Apr/2023): at a token boundary, `_` is the assignment arrow IFF the next character is
// not a letter, digit, underscore or colon. Everything else the underscore touches is a
// Cuis-legal identifier/keyword form and stays one natively. The tokenizer emits the arrow as the
// DISTINCT `legacyAssign` token; this parser refuses that token explicitly, once, for every
// position — direct native source has only canonical `:=`, and the Cuis import adapter owns the
// translation at the import boundary. Before this, `b _ a foo` parsed as the unary-send chain
// `((b _) a) foo` and COMPILED, which is how an imported Cuis method's name-resolution refusal
// was silently suppressed.
const LEGACY_ARROW_REFUSAL = /legacy assignment arrow `_` is Cuis dialect syntax, not native Symmetric Smalltalk; native assignment is `:=`/;

test('the measured legacy assignment arrow is a distinct token, never an identifier', () => {
  const typesOf = (source) => tokenizeSymmetricSmalltalk(source).slice(0, -1).map((token) => [token.type, token.value]);
  // The measured arrow forms: `_` followed by a non-identifier character (or end of source).
  assert.deepEqual(typesOf('a _ b'), [['identifier', 'a'], ['legacyAssign', '_'], ['identifier', 'b']]);
  assert.deepEqual(typesOf('a _ 7'), [['identifier', 'a'], ['legacyAssign', '_'], ['integer', '7']]);
  assert.deepEqual(typesOf('a _'), [['identifier', 'a'], ['legacyAssign', '_']]);
  assert.deepEqual(typesOf('_ a'), [['legacyAssign', '_'], ['identifier', 'a']]);
  // `x _y _ z` from the oracle: only the bare arrow is the arrow.
  assert.deepEqual(
    typesOf('x _y _ z'),
    [['identifier', 'x'], ['identifier', '_y'], ['legacyAssign', '_'], ['identifier', 'z']],
  );
  assert.deepEqual(typesOf('a _= b'), [['identifier', 'a'], ['legacyAssign', '_'], ['binary', '='], ['identifier', 'b']]);
});

test('every identifier form the Cuis oracle proved is preserved, byte for byte', () => {
  const valuesOf = (source) => tokenizeSymmetricSmalltalk(source).slice(0, -1).map((token) => [token.type, token.value]);
  // Measured Cuis identifiers/keywords, none of them assignment syntax: embedded, leading and
  // trailing underscores, `_7`, `__`, the `_:` and `foo_:` keywords, and the `#_` symbol.
  assert.deepEqual(valuesOf('a_b'), [['identifier', 'a_b']]);
  assert.deepEqual(valuesOf('_foo'), [['identifier', '_foo']]);
  assert.deepEqual(valuesOf('foo_'), [['identifier', 'foo_']]);
  assert.deepEqual(valuesOf('_7'), [['identifier', '_7']]);
  assert.deepEqual(valuesOf('__'), [['identifier', '__']]);
  assert.deepEqual(valuesOf('a__b'), [['identifier', 'a__b']]);
  assert.deepEqual(valuesOf('_: x'), [['keyword', '_:'], ['identifier', 'x']]);
  assert.deepEqual(valuesOf('foo_: x'), [['keyword', 'foo_:'], ['identifier', 'x']]);
  assert.deepEqual(valuesOf('#_'), [['symbol', '_']]);
  // The oracle's decisive spacing cases: `a _b` is a unary send of `_b`, `a_ b` reads `a_` then `b`.
  assert.deepEqual(valuesOf('a _b'), [['identifier', 'a'], ['identifier', '_b']]);
  assert.deepEqual(valuesOf('a_ b'), [['identifier', 'a_'], ['identifier', 'b']]);
  // Underscores inside strings and comments are data; no token is ever produced for them.
  assert.deepEqual(valuesOf("'a_b'"), [['string', 'a_b']]);
  assert.deepEqual(valuesOf('a "c _ d" b'), [['identifier', 'a'], ['identifier', 'b']]);
});

test('direct native source with the legacy arrow is an explicit syntax refusal at every position', () => {
  const cases = [
    'b _ a foo. b',        // the pre-repair absorption: `((b _) a) foo`
    '[ | a b | b _ a foo. b ]',
    '[ a _ 1 ]',           // assignment position
    '[ | _ | 1 ]',         // temporaries
    '[ :_ | 1 ]',          // block parameter
    '[ 3 _ 4 ]',           // not a variable target; still refused, not silently absorbed
    'a _ b',
  ];
  for (const source of cases) {
    assert.throws(
      () => parseSymmetricSmalltalk(source),
      (error) => error instanceof SymmetricSmalltalkSyntaxError && LEGACY_ARROW_REFUSAL.test(error.message),
      source,
    );
  }
  // The measurement this slice reverses: this used to be a chain of unary sends.
  assert.throws(() => parseSymmetricSmalltalk('[ | a b | b _ a foo. b ]'), LEGACY_ARROW_REFUSAL);
  // Canonical native assignment is untouched.
  assert.equal(parseSymmetricSmalltalk('[ | a | a := 1. a ]').body.kind, 'sequence');
  // And the proven identifier forms still parse as ordinary names.
  const syntax = parseSymmetricSmalltalk('[ | _foo a_b foo_ | _foo := 1. a_b := _foo. foo_ := a_b. foo_ ]');
  assert.equal(syntax.body.kind, 'sequence');
});
