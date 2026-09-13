import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime, installSmalltalkStringEqualityProtocol, installSymmetricSmalltalkStandardImage,
  booleanValue, integerValue, textValue, objectRef, findSmalltalkKernel,
  ensureNamedClass, ensureSmalltalkShape, defineMethodsFromSource,
} from '../src/runtime.js';
import {seedStringEquality, stringEqualitySender} from './support/string-equality-fixture.js';

for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} string equality preserves spelling, hash, identity and Dictionary keys`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      const imageId = 'string-equality';
      const options = await seedStringEquality(runtime, imageId, lane);
      const send = stringEqualitySender(runtime, imageId);
      const original = await send(textValue('to'), 'asSymbol');
      assert.deepEqual(await send(original, '=', [textValue('to')]), booleanValue(false), 'bare Object equality stays identity');
      await installSmalltalkStringEqualityProtocol(options);
      for (const spelling of ['', 'to', 'note', 'to:', 'λ', '𝄞', 'é', 'e\u0301']) {
        const text = textValue(spelling);
        const symbol = await send(text, 'asSymbol');
        assert.deepEqual(await send(symbol, 'asString'), text);
        for (const [left, right] of [[symbol, text], [text, symbol], [symbol, symbol], [text, text]]) {
          assert.deepEqual(await send(left, '=', [right]), booleanValue(true), 'string equality in both orders');
          assert.deepEqual(await send(left, 'hash'), await send(right, 'hash'), 'equal strings have equal hashes');
        }
        assert.deepEqual(await send(symbol, '==', [text]), booleanValue(false), 'Symbol identity remains distinct from Text');
        assert.deepEqual(await send(text, '==', [symbol]), booleanValue(false), 'Text identity remains distinct from Symbol');
        assert.deepEqual(await send(symbol, '~~', [text]), booleanValue(true));
        assert.deepEqual(await send(text, 'asSymbol'), symbol, 'interning identity is unchanged');
      }
      assert.deepEqual(await send(textValue('to'), 'asSymbol'), original, 'installation preserves existing Symbol identity');
      for (const [left, right] of [['to', 'To'], ['to', 'to '], ['é', 'e\u0301']]) {
        const symbol = await send(textValue(left), 'asSymbol');
        assert.deepEqual(await send(symbol, '=', [textValue(right)]), booleanValue(false));
        assert.deepEqual(await send(textValue(right), '=', [symbol]), booleanValue(false), 'exact spelling; no normalization');
      }
      const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
      const shape = await ensureSmalltalkShape(runtime.images, imageId, {id: 'non-string', slots: []});
      const {classRef} = await ensureNamedClass({...options, name: 'NotAString', superclassRef: kernel.objectClass, instanceShapeRef: shape});
      await defineMethodsFromSource({...options, classRef, methods: [{selector: 'asString', source: '[ self mustNotConvert ]'}]});
      const nonString = await send(classRef, 'new');
      for (const other of [nonString, integerValue(1), booleanValue(false), kernel.nil]) {
        assert.deepEqual(await send(original, '=', [other]), booleanValue(false), 'non-string is rejected without conversion');
        assert.deepEqual(await send(textValue('to'), '=', [other]), booleanValue(false));
      }
      for (const [first, second] of [[original, textValue('to')], [textValue('to'), original]]) {
        const dictionary = await send(objectRef(imageId, 'smalltalk/class/Dictionary'), 'new');
        await send(dictionary, 'at:put:', [first, integerValue(1)]);
        assert.deepEqual(await send(dictionary, 'at:', [second]), integerValue(1), 'interchangeable Dictionary key');
        await send(dictionary, 'at:put:', [second, integerValue(2)]);
        assert.deepEqual(await send(dictionary, 'size'), integerValue(1), 'equal-key overwrite keeps one entry');
        assert.deepEqual(await send(dictionary, 'at:', [first]), integerValue(2));
      }
      const frontier = await runtime.images.frontier(imageId);
      await installSmalltalkStringEqualityProtocol(options);
      assert.equal(await runtime.images.frontier(imageId), frontier, 'protocol replay is write-free');
    } finally { await runtime.close(); }
  });
}

test('string equality rejects missing prerequisites before publishing any method', async () => {
  for (const [omit, missing] of [['equality', 'Object =='], ['stringTesting', 'Object isString'], ['text', 'Text asString'], ['controlFlow', 'True and:']]) {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      const options = await seedStringEquality(runtime, 'missing', 'neutral', omit);
      const frontier = await runtime.images.frontier('missing');
      await assert.rejects(installSmalltalkStringEqualityProtocol(options), new RegExp(`has no ${missing} method`));
      assert.equal(await runtime.images.frontier('missing'), frontier, omit);
    } finally { await runtime.close(); }
  }
});

test('standard-image composition installs string equality and replays without writes', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const imageId = 'composed-string-equality';
    await runtime.images.createImage({id: imageId});
    const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane: 'wasm'};
    await installSymmetricSmalltalkStandardImage(options);
    const send = stringEqualitySender(runtime, imageId);
    const symbol = await send(textValue('to'), 'asSymbol');
    assert.deepEqual(await send(symbol, '=', [textValue('to')]), booleanValue(true));
    const frontier = await runtime.images.frontier(imageId);
    await installSymmetricSmalltalkStandardImage(options);
    assert.equal(await runtime.images.frontier(imageId), frontier);
  } finally { await runtime.close(); }
});
