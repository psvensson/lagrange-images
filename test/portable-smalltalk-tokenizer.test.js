import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenizeSymmetricSmalltalk, SymmetricSmalltalkSyntaxError} from 'lagrange-images/language';
import * as runtime from 'lagrange-images';
import * as portable from '../src/portable-runtime.js';

// Public lexical contract used by source displays; this proves no rendering policy.
test('portable, Node and language entries expose one tokenizer by identity', () => {
  assert.equal(typeof portable.tokenizeSymmetricSmalltalk, 'function');
  assert.equal(portable.tokenizeSymmetricSmalltalk, tokenizeSymmetricSmalltalk);
  assert.equal(runtime.tokenizeSymmetricSmalltalk, tokenizeSymmetricSmalltalk);
});

test('portable tokens preserve original UTF-16 spans, spellings and lexical distinctions', () => {
  const source = "$😀 x:=16rFF.\r\n\" := ^ \" ^'it''s := ^'. $^ $: #at:put: _ _name ^:=";
  const tokens = portable.tokenizeSymmetricSmalltalk(source);
  assert.deepEqual(tokens, [
    {"type": "character", "value": "😀", "start": 0, "end": 3},
    {"type": "identifier", "value": "x", "start": 4, "end": 5},
    {"type": "assign", "value": ":=", "start": 5, "end": 7},
    {"type": "integer", "value": "255", "start": 7, "end": 12},
    {"type": ".", "value": ".", "start": 12, "end": 13},
    {"type": "caret", "value": "^", "start": 24, "end": 25},
    {"type": "string", "value": "it's := ^", "start": 25, "end": 37},
    {"type": ".", "value": ".", "start": 37, "end": 38},
    {"type": "character", "value": "^", "start": 39, "end": 41},
    {"type": "character", "value": ":", "start": 42, "end": 44},
    {"type": "symbol", "value": "at:put:", "start": 45, "end": 53},
    {"type": "legacyAssign", "value": "_", "start": 54, "end": 55},
    {"type": "identifier", "value": "_name", "start": 56, "end": 61},
    {"type": "caret", "value": "^", "start": 62, "end": 63},
    {"type": "assign", "value": ":=", "start": 63, "end": 65},
    {"type": "eof", "value": "", "start": 65, "end": 65}
  ]);
  assert.deepEqual(tokens.map(({start, end}) => source.slice(start, end)),
    ["$😀", "x", ":=", "16rFF", ".", "^", "'it''s := ^'", ".", "$^", "$:", "#at:put:", "_", "_name", "^", ":=", ""]);
  assert.ok(Object.isFrozen(tokens));
  assert.ok(tokens.every(Object.isFrozen));
});

test('portable lexical failures retain owner type and UTF-16 positions, without partial results', () => {
  for (const source of ["$😀 x := 'unterminated", '$😀 x := "unterminated']) {
    let result;
    assert.throws(() => { result = portable.tokenizeSymmetricSmalltalk(source); },
      (error) => error instanceof SymmetricSmalltalkSyntaxError
        && error.name === 'SymmetricSmalltalkSyntaxError' && error.position === 9);
    assert.equal(result, undefined);
  }
  for (const source of [null, undefined, 42, {}]) {
    assert.throws(() => portable.tokenizeSymmetricSmalltalk(source), TypeError);
  }
  for (const source of ['$😀 x ← 1', '$😀 x ↑ 1']) {
    assert.throws(() => portable.tokenizeSymmetricSmalltalk(source),
      (error) => error instanceof SymmetricSmalltalkSyntaxError && error.position === 6);
  }
});
