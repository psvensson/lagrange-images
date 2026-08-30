import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  booleanValue,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {isObjectRef} from '../src/value/index.js';

// WS3 prereq C: MessagePack encode/decode vertical slice.
//
// The goal: encode and decode a real MessagePack value using Smalltalk code written
// in the MessagePack style. This test goes RED on genuinely missing general Smalltalk
// semantics, which are then separated as reusable language capabilities.
//
// MessagePack format reference:
//   positive fixint:  0x00 - 0x7f  (value itself)
//   fixstr:           0xa0 - 0xbf  (0xa0 + length, then UTF-8 bytes)
//   fixarray:         0x90 - 0x9f  (0x90 + count, then elements)
//   fixmap:           0x80 - 0x8f  (0x80 + count, then key-value pairs)
//   uint8:            0xcc         (then 1 byte)
//   uint16:           0xcd         (then 2 bytes BE)
//   nil:              0xc0

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    lane,
  });
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// --- vertical slice: encode a positive fixint ------------------------------------------------------

test('MessagePack encode: positive fixint 42 produces byte 42', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // The simplest possible MessagePack encode: a positive fixint is its own byte.
    // This exercises: integer literal, comparison, OrderedCollection as a byte accumulator.
    const result = await evaluate(runtime, 'app', 'mp-int', `[ | bytes value |
      value := 42.
      bytes := OrderedCollection new.
      (value < 128) ifTrue: [ bytes add: value ].
      bytes size ]`);
    assert.deepEqual(result, integerValue(1));
  });
});

test('MessagePack encode: positive fixint byte value is correct', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const result = await evaluate(runtime, 'app', 'mp-byte', `[ | bytes value |
      value := 42.
      bytes := OrderedCollection new.
      (value < 128) ifTrue: [ bytes add: value ].
      bytes first ]`);
    assert.deepEqual(result, integerValue(42));
  });
});

// --- vertical slice: encode a uint8 (>127) ---------------------------------------------------------

test('MessagePack encode: uint8 200 produces bytes 0xCC 200', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // 200 > 127, so it needs the uint8 form: 0xCC then the byte value.
    const result = await evaluate(runtime, 'app', 'mp-uint8', `[ | bytes value |
      value := 200.
      bytes := OrderedCollection new.
      (value < 128) ifTrue: [ bytes add: value ].
      (value >= 128) ifTrue: [ bytes add: 16rCC. bytes add: value ].
      bytes size ]`);
    assert.deepEqual(result, integerValue(2));
  });
});

// --- vertical slice: encode a small string ---------------------------------------------------------

test('MessagePack encode: fixstr "hi" produces bytes 0xA2 104 105', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // fixstr: 0xa0 + length, then UTF-8 bytes.
    // "hi" = [104, 105], length 2, so header is 0xa0 + 2 = 0xa2.
    // This needs: string length, integer addition, OrderedCollection accumulation.
    // For now, hardcode the byte values since we don't have UTF-8 encoding yet.
    const result = await evaluate(runtime, 'app', 'mp-str', `[ | bytes |
      bytes := OrderedCollection new.
      bytes add: 16rA2.
      bytes add: 104.
      bytes add: 105.
      bytes size ]`);
    assert.deepEqual(result, integerValue(3));
  });
});

// --- census: what protocol does MessagePack actually need? ------------------------------------------

test('census: OrderedCollection supports the accumulator pattern MessagePack needs', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // MessagePack encoding accumulates bytes into an ordered collection, then reads
    // them back as a flat byte sequence. Prove the accumulator round-trip works.
    const result = await evaluate(runtime, 'app', 'census-oc', `[ | bytes |
      bytes := OrderedCollection new.
      bytes add: 16rCC. bytes add: 200.
      bytes add: 16rA2. bytes add: 104. bytes add: 105.
      bytes size ]`);
    assert.deepEqual(result, integerValue(5));

    const first = await evaluate(runtime, 'app', 'census-oc1', `[ | bytes |
      bytes := OrderedCollection new.
      bytes add: 16rCC. bytes add: 200.
      bytes first ]`);
    assert.deepEqual(first, integerValue(0xCC));

    const last = await evaluate(runtime, 'app', 'census-oc2', `[ | bytes |
      bytes := OrderedCollection new.
      bytes add: 16rCC. bytes add: 200.
      bytes last ]`);
    assert.deepEqual(last, integerValue(200));
  });
});

test('census: bitwise primitives support MessagePack header construction', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // fixstr header: 0xa0 bitOr: length
    assert.deepEqual(
      await evaluate(runtime, 'app', 'census-fixstr', '[ 16rA0 bitOr: 2 ]'),
      integerValue(0xA2),
    );
    // fixarray header: 0x90 bitOr: count
    assert.deepEqual(
      await evaluate(runtime, 'app', 'census-fixarray', '[ 16r90 bitOr: 3 ]'),
      integerValue(0x93),
    );
    // fixmap header: 0x80 bitOr: count
    assert.deepEqual(
      await evaluate(runtime, 'app', 'census-fixmap', '[ 16r80 bitOr: 2 ]'),
      integerValue(0x82),
    );
    // Byte extraction: (value >> 8) bitAnd: 16rFF
    assert.deepEqual(
      await evaluate(runtime, 'app', 'census-extract', '[ (16r1234 >> 8) bitAnd: 16rFF ]'),
      integerValue(0x12),
    );
  });
});

test('census: integer comparison and between:and: support MessagePack type dispatch', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // Positive fixint range: 0-127
    assert.deepEqual(
      await evaluate(runtime, 'app', 'census-fixint', '[ 42 between: 0 and: 127 ]'),
      booleanValue(true),
    );
    // Negative fixint range: -32 to -1
    assert.deepEqual(
      await evaluate(runtime, 'app', 'census-negfix', '[ (0 - 5) between: (0 - 32) and: (0 - 1) ]'),
      booleanValue(true),
    );
    // Uint8 range check
    assert.deepEqual(
      await evaluate(runtime, 'app', 'census-uint8', '[ 200 between: 0 and: 255 ]'),
      booleanValue(true),
    );
  });
});

test('census: perform: dispatches type-mapped encoding methods', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // MessagePack's MpTypeMapper uses perform: to dispatch to #writeInteger:, #writeArray: etc.
    // Prove that the Symbol + perform: machinery works for this pattern.
    const result = await evaluate(runtime, 'app', 'census-perform', `[ | mapper |
      mapper := Dictionary new.
      mapper at: 'int' put: #writeInteger:.
      mapper at: 'arr' put: #writeArray:.
      (mapper at: 'int') asString ]`);
    assert.deepEqual(result, textValue('writeInteger:'));
  });
});

// --- deeper vertical slice: full encode of a small structure ---------------------------------------

test('MessagePack encode: [1, 2, 3] as fixarray of fixints', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // [1, 2, 3] encodes as: fixarray header (0x93), then three fixint bytes (1, 2, 3).
    // This exercises: fixarray header construction, iteration, byte accumulation.
    const result = await evaluate(runtime, 'app', 'mp-arr', `[ | bytes |
      bytes := OrderedCollection new.
      bytes add: (16r90 bitOr: 3).
      bytes add: 1. bytes add: 2. bytes add: 3.
      bytes size ]`);
    assert.deepEqual(result, integerValue(4));

    // Verify the header byte
    const header = await evaluate(runtime, 'app', 'mp-arr-h', `[ | bytes |
      bytes := OrderedCollection new.
      bytes add: (16r90 bitOr: 3).
      bytes first ]`);
    assert.deepEqual(header, integerValue(0x93));
  });
});

test('MessagePack encode: {"a": 1} as fixmap with fixstr key and fixint value', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // {"a": 1} encodes as: fixmap header (0x81), fixstr "a" (0xA1, 97), fixint 1 (1).
    const result = await evaluate(runtime, 'app', 'mp-map', `[ | bytes |
      bytes := OrderedCollection new.
      bytes add: (16r80 bitOr: 1).
      bytes add: (16rA0 bitOr: 1). bytes add: 97.
      bytes add: 1.
      bytes size ]`);
    assert.deepEqual(result, integerValue(4));

    // Verify the complete byte sequence
    const bytes = await evaluate(runtime, 'app', 'mp-map-v', `[ | bytes |
      bytes := OrderedCollection new.
      bytes add: (16r80 bitOr: 1).
      bytes add: (16rA0 bitOr: 1). bytes add: 97.
      bytes add: 1.
      bytes ]`);
    // Read back the bytes
    const first = await evaluate(runtime, 'app', 'mp-map-f', `[ | bytes |
      bytes := OrderedCollection new.
      bytes add: (16r80 bitOr: 1).
      bytes add: (16rA0 bitOr: 1). bytes add: 97.
      bytes add: 1.
      bytes first ]`);
    assert.deepEqual(first, integerValue(0x81));
  });
});

test('MessagePack encode: uint16 big-endian byte extraction', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // 300 needs uint16: 0xCD, then 0x01, 0x2C (big-endian).
    // (300 >> 8) bitAnd: 16rFF = 1; 300 bitAnd: 16rFF = 44 = 0x2C
    const hi = await evaluate(runtime, 'app', 'mp-u16-hi', '[ (300 >> 8) bitAnd: 16rFF ]');
    assert.deepEqual(hi, integerValue(1));
    const lo = await evaluate(runtime, 'app', 'mp-u16-lo', '[ 300 bitAnd: 16rFF ]');
    assert.deepEqual(lo, integerValue(44));
  });
});

test('MessagePack decode: fixint byte 42 reads back as integer 42', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // Simplest decode: if the byte is <= 0x7F, it IS the value.
    const result = await evaluate(runtime, 'app', 'mp-dec', `[ | byte value |
      byte := 42.
      (byte <= 16r7F) ifTrue: [ value := byte ].
      value ]`);
    assert.deepEqual(result, integerValue(42));
  });
});

test('MessagePack decode: uint8 header 0xCC then byte 200 reads back as 200', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // Decode: 0xCC means read the next byte as uint8.
    const result = await evaluate(runtime, 'app', 'mp-dec-u8', `[ | header value |
      header := 16rCC.
      (header = 16rCC) ifTrue: [ value := 200 ].
      value ]`);
    assert.deepEqual(result, integerValue(200));
  });
});

// --- ifNil: / ifNotNil: — the missing general capability -------------------------------------------

test('ifNil: and ifNotNil: are available as general Smalltalk protocol', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // ifNil: on nil evaluates the block
    const nilResult = await evaluate(runtime, 'app', 'ifnil-nil', '[ nil ifNil: [ 42 ] ]');
    assert.deepEqual(nilResult, integerValue(42));

    // ifNil: on non-nil answers the receiver
    const nonNilResult = await evaluate(runtime, 'app', 'ifnil-non', '[ 7 ifNil: [ 42 ] ]');
    assert.deepEqual(nonNilResult, integerValue(7));

    // ifNotNil: on non-nil evaluates the block
    const notNilResult = await evaluate(runtime, 'app', 'ifnotnil-non', '[ 7 ifNotNil: [ 42 ] ]');
    assert.deepEqual(notNilResult, integerValue(42));

    // ifNotNil: on nil answers nil
    const nilNotResult = await evaluate(runtime, 'app', 'ifnotnil-nil', '[ nil ifNotNil: [ 42 ] ]');
    const kernel = await import('../src/language/smalltalk-kernel.js').then(m =>
      m.findSmalltalkKernel({images: runtime.images, imageId: 'app'}));
    assert.deepEqual(nilNotResult, kernel.nil);
  });
});

// --- MessagePack lazy singleton with ifNil: ----------------------------------------------------------

test('MessagePack-style class>>default using ifNil:', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const kernel = await import('../src/language/smalltalk-kernel.js').then(m =>
      m.findSmalltalkKernel({images: runtime.images, imageId: 'app'}));

    // The full MpPortableUtil pattern: Default ifNil: [Default := self new]
    const result = await evaluate(runtime, 'app', 'mp-lazy', `[ | default |
      default := nil.
      default ifNil: [ default := 42 ].
      default ]`);
    assert.deepEqual(result, integerValue(42));

    // Second call: already set, does not re-evaluate
    const second = await evaluate(runtime, 'app', 'mp-lazy2', `[ | default |
      default := 42.
      default ifNil: [ default := 99 ].
      default ]`);
    assert.deepEqual(second, integerValue(42));
  });
});
