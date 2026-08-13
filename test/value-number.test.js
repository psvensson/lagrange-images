import test from 'node:test';
import assert from 'node:assert/strict';
import {float64FromBits, float64ToNumber, integerValue} from '../src/value/index.js';

test('integer values preserve arbitrary precision', () => {
  assert.equal(integerValue('90071992547409931234567890').value, '90071992547409931234567890');
  assert.equal(integerValue(42n).value, '42');
  assert.throws(() => integerValue(Number.MAX_SAFE_INTEGER + 1), TypeError);
});

test('float values preserve exact bits', () => {
  assert.equal(Object.is(float64ToNumber(float64FromBits('8000000000000000')), -0), true);
  assert.equal(Number.isNaN(float64ToNumber(float64FromBits('7ff8000000000001'))), true);
});
