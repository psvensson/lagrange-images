import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  bytesValue,
  createRuntime,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  installWasmBlockTree,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

// WS3 Text/ByteArray slice: the general Text/ByteArray + UTF-8 protocol over the
// native immutable Value representations.
//
//   Text       >> utf8Bytes        -> native bytes Value
//   ByteArray  >> utf8Text         -> Text Value
//   ByteArray  >> size             -> integer byte count
//   ByteArray  >> at:              -> integer byte, 1-based
//   ByteArray class >> fromArray:  -> native bytes Value from an integer Array buffer
//
// UTF-8 is the only codec, matching the upstream Pharo portable-util precedent:
// `asByteArray`/`asString` are deliberately NOT defined as UTF-8 (encoding is
// dialect policy, not a default). ByteArray is the native immutable bytes Value
// — no second indexed ByteArray, no `at:put:`, and the ADR 0047 indexed
// primitives are not widened to bytes Values.
//
// Acceptance (directives): empty; ASCII; 2/3/4-byte code points; mixed
// round-trip; exact UTF-8 bytes; malformed UTF-8 decode refused; lone-surrogate
// Text refused; size + 1-based at:; fromArray: validates every element 0..255;
// neutral/WASM agreement; no concrete image ref in the Text/bytes data and no
// new generic Value kind.

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
  return await installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId, lane,
  });
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// --- utf8Bytes: Text -> bytes ------------------------------------------------------------------

test('empty Text encodes to an empty ByteArray', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    assert.deepEqual(await evaluate(runtime, 'tb', 'e-size', `[ '' utf8Bytes size ]`), integerValue(0));
  });
});

test('ASCII Text encodes to exact UTF-8 bytes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    // "hi" -> 0x68 0x69
    assert.deepEqual(await evaluate(runtime, 'tb', 'a-size', `[ 'hi' utf8Bytes size ]`), integerValue(2));
    assert.deepEqual(await evaluate(runtime, 'tb', 'a-1', `[ ('hi' utf8Bytes) at: 1 ]`), integerValue(104));
    assert.deepEqual(await evaluate(runtime, 'tb', 'a-2', `[ ('hi' utf8Bytes) at: 2 ]`), integerValue(105));
  });
});

test('a 2-byte code point encodes to exact UTF-8 bytes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    // U+00E9 "é" -> 0xC3 0xA9
    assert.deepEqual(await evaluate(runtime, 'tb', 'b-size', `[ 'é' utf8Bytes size ]`), integerValue(2));
    assert.deepEqual(await evaluate(runtime, 'tb', 'b-1', `[ ('é' utf8Bytes) at: 1 ]`), integerValue(195));
    assert.deepEqual(await evaluate(runtime, 'tb', 'b-2', `[ ('é' utf8Bytes) at: 2 ]`), integerValue(169));
  });
});

test('a 3-byte code point encodes to exact UTF-8 bytes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    // U+20AC "€" -> 0xE2 0x82 0xAC
    assert.deepEqual(await evaluate(runtime, 'tb', 'c-size', `[ '€' utf8Bytes size ]`), integerValue(3));
    assert.deepEqual(await evaluate(runtime, 'tb', 'c-1', `[ ('€' utf8Bytes) at: 1 ]`), integerValue(226));
    assert.deepEqual(await evaluate(runtime, 'tb', 'c-2', `[ ('€' utf8Bytes) at: 2 ]`), integerValue(130));
    assert.deepEqual(await evaluate(runtime, 'tb', 'c-3', `[ ('€' utf8Bytes) at: 3 ]`), integerValue(172));
  });
});

test('a 4-byte code point encodes to exact UTF-8 bytes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    // U+1F600 "😀" -> 0xF0 0x9F 0x98 0x80
    assert.deepEqual(await evaluate(runtime, 'tb', 'd-size', `[ '😀' utf8Bytes size ]`), integerValue(4));
    assert.deepEqual(await evaluate(runtime, 'tb', 'd-1', `[ ('😀' utf8Bytes) at: 1 ]`), integerValue(240));
    assert.deepEqual(await evaluate(runtime, 'tb', 'd-4', `[ ('😀' utf8Bytes) at: 4 ]`), integerValue(128));
  });
});

test('utf8Bytes answers the exact native bytes Value, with no image ref', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    // The result IS a native bytes Value — not a ref into the image, not an Array.
    const encoded = await evaluate(runtime, 'tb', 'raw', `[ 'hi' utf8Bytes ]`);
    assert.deepEqual(encoded, bytesValue(new Uint8Array([104, 105])));
    assert.equal(encoded.kind, 'bytes');
  });
});

// --- utf8Text: bytes -> Text -------------------------------------------------------------------

test('utf8Text decodes a ByteArray back to the original Text (mixed round-trip)', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    const source = 'aé€😀z'; // ASCII + 2/3/4-byte code points
    assert.deepEqual(
      await evaluate(runtime, 'tb', 'rt', `[ :t | (t utf8Bytes) utf8Text = t ]`, [textValue(source)]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'tb', 'rt2', `[ :t | (t utf8Bytes) utf8Text ]`, [textValue(source)]),
      textValue(source),
    );
  });
});

test('malformed UTF-8 decode is explicitly refused', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    // 0xC3 alone is a truncated 2-byte lead; 0xFF is never valid UTF-8. Both must
    // be refused, never lossy-decoded to U+FFFD.
    await assert.rejects(
      evaluate(runtime, 'tb', 'bad1', `[ :b | b utf8Text ]`, [bytesValue(new Uint8Array([195]))]),
      /malformed UTF-8/,
    );
    await assert.rejects(
      evaluate(runtime, 'tb', 'bad2', `[ :b | b utf8Text ]`, [bytesValue(new Uint8Array([255]))]),
      /malformed UTF-8/,
    );
    // An overlong encoding of '/' (0xC0 0xAF) is malformed, not an alias for 0x2F.
    await assert.rejects(
      evaluate(runtime, 'tb', 'bad3', `[ :b | b utf8Text ]`, [bytesValue(new Uint8Array([192, 175]))]),
      /malformed UTF-8/,
    );
  });
});

test('a Text Value containing a lone surrogate is refused, not silently replaced', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    // A lone high surrogate is ill-formed Unicode scalar data: no valid UTF-8
    // exists, so encode refuses rather than emitting a replacement char.
    const lone = textValue(`lone${String.fromCharCode(0xd800)}surrogate`);
    await assert.rejects(
      evaluate(runtime, 'tb', 'sur', `[ :t | t utf8Bytes ]`, [lone]),
      /lone surrogate/,
    );
  });
});

// --- ByteArray>>size / at: ----------------------------------------------------------------------

test('ByteArray>>size answers the byte count and at: is 1-based', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    const bytes = bytesValue(new Uint8Array([10, 20, 30]));
    assert.deepEqual(await evaluate(runtime, 'tb', 's-size', `[ :b | b size ]`, [bytes]), integerValue(3));
    assert.deepEqual(await evaluate(runtime, 'tb', 's-1', `[ :b | b at: 1 ]`, [bytes]), integerValue(10));
    assert.deepEqual(await evaluate(runtime, 'tb', 's-3', `[ :b | b at: 3 ]`, [bytes]), integerValue(30));
    // 1-based: index 0 and index size+1 are out of range.
    await assert.rejects(evaluate(runtime, 'tb', 's-0', `[ :b | b at: 0 ]`, [bytes]), /outside the 1\.\.3 range/);
    await assert.rejects(evaluate(runtime, 'tb', 's-4', `[ :b | b at: 4 ]`, [bytes]), /outside the 1\.\.3 range/);
  });
});

// --- ByteArray class>>fromArray: -----------------------------------------------------------------

test('fromArray: converts an integer Array buffer, validating every element 0..255', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb');
    const build = (tail) => `[ | a | a := Array new: 3. a at: 1 put: 104. a at: 2 put: 105. a at: 3 put: 33. ${tail} ]`;
    assert.deepEqual(
      await evaluate(runtime, 'tb', 'fa-bytes', build('ByteArray fromArray: a')),
      bytesValue(new Uint8Array([104, 105, 33])),
    );
    assert.deepEqual(
      await evaluate(runtime, 'tb', 'fa-text', build('(ByteArray fromArray: a) utf8Text = \'hi!\'')),
      booleanValue(true),
    );
    // An out-of-range element is refused.
    await assert.rejects(
      evaluate(runtime, 'tb', 'fa-range', `[ | a | a := Array new: 1. a at: 1 put: 256. ByteArray fromArray: a ]`),
      /not in 0\.\.255/,
    );
    // A negative element is refused.
    await assert.rejects(
      evaluate(runtime, 'tb', 'fa-neg', `[ | a | a := Array new: 1. a at: 1 put: -1. ByteArray fromArray: a ]`),
      /not in 0\.\.255/,
    );
    // A non-integer element is refused.
    await assert.rejects(
      evaluate(runtime, 'tb', 'fa-nonint', `[ | a | a := Array new: 1. a at: 1 put: 'x'. ByteArray fromArray: a ]`),
      /not an integer byte/,
    );
  });
});

// --- lanes agree -----------------------------------------------------------------------------------

test('Text/ByteArray UTF-8 agrees across neutral and WASM lanes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'tb-w', {lane: 'wasm'});
    const run = async (id, source, args) => {
      const installed = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'tb-w', id, source,
      });
      const tree = await installWasmBlockTree({
        images: runtime.images, compilation: runtime.compilation,
        semanticRef: objectRef('tb-w', installed.semanticArtifact.id),
        id: `${id}:tree`, environment: installed.block.environment,
      });
      const activation = await runtime.invocations.invokeBlock(objectRef('tb-w', tree.block.id), args);
      return await runtime.executor.execute(activation);
    };
    const wasmEncoded = await run('w-enc', `[ 'héllo' utf8Bytes ]`, []);
    const neutralEncoded = await evaluate(runtime, 'tb-w', 'n-enc', `[ 'héllo' utf8Bytes ]`, []);
    assert.deepEqual(wasmEncoded, neutralEncoded);
    assert.deepEqual(wasmEncoded, bytesValue(new Uint8Array([104, 195, 169, 108, 108, 111])));
    const wasmRound = await run('w-rt', `[ :t | (t utf8Bytes) utf8Text = t ]`, [textValue('xé€😀')]);
    assert.deepEqual(wasmRound, booleanValue(true));
  });
});
