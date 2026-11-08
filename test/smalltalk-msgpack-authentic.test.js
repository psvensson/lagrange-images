import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  OBJECT_READ_OPERATION,
  SMALLTALK_METHOD_READ_OPERATION,
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  createRuntime,
  installSymmetricSmalltalkStandardImage,
  installSymmetricSmalltalkBlock,
  integerValue,
  booleanValue,
  bytesValue,
  textValue,
  objectRef,
  objectResource,
  smalltalkMethodPositionResource,
} from '../src/runtime.js';
import {
  installMessagePackFromFixture,
  assertMessagePackMethodInstalled,
} from '../src/language/smalltalk-msgpack-fixture.js';

// WS3: authentic upstream msgpack-smalltalk through Symmetric Smalltalk.
//
// The pinned FileTree closure in fixtures/msgpack-smalltalk is compiled through
// the normal defineMethodsFromSource pipeline and executed. These tests are the
// acceptance proof that the *executed* methods derive from upstream material,
// not a hand-written slice: every behavior below is reached only because the
// loader compiled the vendored upstream methods onto the vendored classes.
//
// The dynamic-self integration proof is `MpDecodeTypeMapper` reading its
// per-class actionMap companion (PR #149) on every non-fixnum decode.

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'msgpack-smalltalk', 'MessagePack-Core.package',
);

// One shared install across the whole file: the standard image plus the full
// upstream install is expensive (~18s), and sharing it is itself a durability
// proof — every case runs against the same durable class/method/companion state.
let shared = null;
async function context() {
  if (shared) return shared;
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const imageId = 'mp';
  await runtime.images.createImage({id: imageId});
  await installSymmetricSmalltalkStandardImage({images: runtime.images, compilation: runtime.compilation, imageId});
  const installed = await installMessagePackFromFixture({
    images: runtime.images, compilation: runtime.compilation, imageId, fixtureRoot: FIXTURE_ROOT,
  });
  const evaluate = async (id, source, args = []) => {
    const block = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
    const activation = await runtime.invocations.invokeBlock(objectRef(imageId, block.block.id), args);
    return await runtime.executor.execute(activation);
  };
  shared = {runtime, imageId, installed, evaluate};
  return shared;
}

test.after(async () => {
  if (shared) await shared.runtime.close();
  shared = null;
});

async function withMessagePack(body) {
  return body(await context());
}

// The executed methods are installed from the vendored upstream source.
test('upstream MessagePack methods are compiled and installed from the fixture', async () => {
  await withMessagePack(async ({runtime, imageId}) => {
    for (const [className, side, selector] of [
      ['MpMessagePack', 'class', 'pack:'],
      ['MpMessagePack', 'class', 'unpack:'],
      ['MpMessagePack', 'class', 'packUnpack:'],
      ['MpEncoder', 'instance', 'writeInteger:'],
      ['MpEncoder', 'instance', 'writeObject:ifNotApplied:'],
      ['MpDecoder', 'instance', 'readObjectOf:ifNotApplied:'],
      ['MpTypeMapper', 'class', 'actionMap'],
      ['Integer', 'instance', 'mpWriteSelector'],
    ]) {
      await assertMessagePackMethodInstalled({images: runtime.images, imageId, className, side, selector});
    }
  });
});

// Dialect adaptations are explicit and reviewable: every altered/dropped method
// is recorded, and no upstream body is silently rewritten.
test('the loader records every dialect adaptation', async () => {
  await withMessagePack(async ({installed}) => {
    assert.ok(installed.adaptations.length > 0, 'adaptations are recorded');
    for (const entry of installed.adaptations) {
      assert.ok(entry.className && entry.selector && entry.action, `adaptation is reviewable: ${JSON.stringify(entry)}`);
    }
    // The class-instance-state hooks upstream writes as subclassResponsibility
    // are NOT adapted: they run unchanged on the SymPortableUtil dialect adapter.
    assert.equal(installed.dialectAdapter.objectId, 'smalltalk/class/SymPortableUtil');
  });
});

// Scalar round-trips through the real upstream encode/decode dispatch.
test('fixnum and negative-fixint round-trip through authentic upstream source', async () => {
  await withMessagePack(async ({evaluate}) => {
    for (const value of [0, 1, 42, 127, -1, -32]) {
      assert.deepEqual(await evaluate(`f${value}`, `[ MpMessagePack packUnpack: ${value} ]`), integerValue(value));
    }
  });
});

test('uint8/int8 round-trip, exercising the decode type-mapper companion', async () => {
  await withMessagePack(async ({evaluate}) => {
    for (const value of [128, 200, 255, -33, -100, -128]) {
      assert.deepEqual(await evaluate(`e${value}`, `[ MpMessagePack packUnpack: ${value} ]`), integerValue(value));
    }
  });
});

test('uint16/32/64 and int16/32/64 round-trip across the full integer range', async () => {
  await withMessagePack(async ({evaluate}) => {
    for (const value of [256, 1000, 65535, -129, -32768, 65536, 4294967295, -32769, -2147483648]) {
      assert.deepEqual(await evaluate(`w${value}`, `[ MpMessagePack packUnpack: ${value} ]`), integerValue(value));
    }
    // int64 min via 0 - 2^63 (literal magnitude exceeds the source integer literal range used above).
    assert.deepEqual(
      await evaluate('w64min', '[ MpMessagePack packUnpack: (0 - 9223372036854775808) ]'),
      integerValue('-9223372036854775808'),
    );
  });
});

test('booleans and nil round-trip', async () => {
  await withMessagePack(async ({evaluate}) => {
    assert.deepEqual(await evaluate('bt', '[ MpMessagePack packUnpack: true ]'), booleanValue(true));
    assert.deepEqual(await evaluate('bf', '[ MpMessagePack packUnpack: false ]'), booleanValue(false));
    assert.deepEqual(await evaluate('bn', '[ (MpMessagePack unpack: (MpMessagePack pack: nil)) isNil ]'), booleanValue(true));
  });
});

// The encoded bytes are spec-exact, not just self-consistent.
test('the encoded byte stream matches the MessagePack spec', async () => {
  await withMessagePack(async ({evaluate}) => {
    // 1000 -> uint16 = 0xCD 0x03 0xE8
    assert.deepEqual(await evaluate('s1', '[ (MpMessagePack pack: 1000) at: 1 ]'), integerValue(205));
    assert.deepEqual(await evaluate('s2', '[ (MpMessagePack pack: 1000) at: 2 ]'), integerValue(3));
    assert.deepEqual(await evaluate('s3', '[ (MpMessagePack pack: 1000) at: 3 ]'), integerValue(232));
    // -100 -> int8 = 0xD0 0x9C; true -> 0xC3; nil -> 0xC0
    assert.deepEqual(await evaluate('s4', '[ (MpMessagePack pack: -100) at: 1 ]'), integerValue(208));
    assert.deepEqual(await evaluate('s5', '[ (MpMessagePack pack: -100) at: 2 ]'), integerValue(156));
    assert.deepEqual(await evaluate('s6', '[ (MpMessagePack pack: true) at: 1 ]'), integerValue(195));
    assert.deepEqual(await evaluate('s7', '[ (MpMessagePack pack: nil) at: 1 ]'), integerValue(192));
    // A positive fixint encodes as itself in a single byte.
    assert.deepEqual(await evaluate('s8', '[ (MpMessagePack pack: 42) size ]'), integerValue(1));
    assert.deepEqual(await evaluate('s9', '[ (MpMessagePack pack: 42) at: 1 ]'), integerValue(42));
  });
});

// --- authentic Array round-trip ------------------------------------------------------------------
//
// The Array path exercises `writeArray:`/`writeArraySize:` (encode) and
// `readFixArray:`/`readArraySized:`/`createArray:` (decode), with element dispatch through the
// real perform-based type mapper. It depends on the general facilities this workstream added:
// `Array do:` (enumeration), the `#()` empty literal (lowered to `Array new: 0`), and Behavior
// `allSubclasses` (which builds the encode action map).

test('encode a non-empty Array produces the spec bytes (fixarray header + fixints)', async () => {
  await withMessagePack(async ({evaluate}) => {
    // Build the Array into a variable, then pack it. (Packing the literal Block
    // `[ ... ]` would encode the Block, not its value — `pack:` does not evaluate.)
    const src = (tail) => `[ | a | a := Array new: 3. a at: 1 put: 1. a at: 2 put: 2. a at: 3 put: 3. ${tail} ]`;
    // [1 2 3] -> 0x93 0x01 0x02 0x03
    assert.deepEqual(await evaluate('ae-size', src('(MpMessagePack pack: a) size')), integerValue(4));
    assert.deepEqual(await evaluate('ae-h', src('(MpMessagePack pack: a) at: 1')), integerValue(147));
    assert.deepEqual(await evaluate('ae-1', src('(MpMessagePack pack: a) at: 2')), integerValue(1));
    assert.deepEqual(await evaluate('ae-2', src('(MpMessagePack pack: a) at: 3')), integerValue(2));
    assert.deepEqual(await evaluate('ae-3', src('(MpMessagePack pack: a) at: 4')), integerValue(3));
  });
});

test('decode fixarray bytes produces a real image Array observable via size/at:', async () => {
  await withMessagePack(async ({evaluate}) => {
    const src = (tail) => `[ | b | b := Array new: 4. b at: 1 put: 147. b at: 2 put: 1. b at: 3 put: 2. b at: 4 put: 3. ${tail} ]`;
    assert.deepEqual(
      await evaluate('ad-class', src('(MpMessagePack unpack: b) class == Array')), booleanValue(true),
    );
    assert.deepEqual(await evaluate('ad-size', src('(MpMessagePack unpack: b) size')), integerValue(3));
    assert.deepEqual(await evaluate('ad-1', src('(MpMessagePack unpack: b) at: 1')), integerValue(1));
    assert.deepEqual(await evaluate('ad-2', src('(MpMessagePack unpack: b) at: 2')), integerValue(2));
    assert.deepEqual(await evaluate('ad-3', src('(MpMessagePack unpack: b) at: 3')), integerValue(3));
  });
});

test('encode(decode(bytes)) == bytes and decode(encode(array)) == array', async () => {
  await withMessagePack(async ({evaluate}) => {
    assert.deepEqual(
      await evaluate(
        'rt-ed',
        '[ | b s | b := Array new: 4. b at: 1 put: 147. b at: 2 put: 1. b at: 3 put: 2. b at: 4 put: 3. '
        + 's := MpMessagePack pack: (MpMessagePack unpack: b). '
        + '(s size = 4) and: [ (s at: 1) = 147 and: [ (s at: 2) = 1 and: [ (s at: 3) = 2 and: [ (s at: 4) = 3 ] ] ] ] ]',
      ),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(
        'rt-de',
        `[ | a d | a := Array new: 3. a at: 1 put: 1. a at: 2 put: 2. a at: 3 put: 3. `
        + 'd := MpMessagePack unpack: (MpMessagePack pack: a). '
        + '(d size = 3) and: [ (d at: 1) = 1 and: [ (d at: 2) = 2 and: [ (d at: 3) = 3 ] ] ] ]',
      ),
      booleanValue(true),
    );
  });
});

test('the empty Array round-trips both ways (#() in createArray:; fixarray-0 header)', async () => {
  await withMessagePack(async ({evaluate}) => {
    // Decode 0x90 (fixarray of length 0) -> an empty image Array via `createArray:` = `^#()`.
    assert.deepEqual(
      await evaluate(
        'ar-empty-dec',
        '[ | b a | b := Array new: 1. b at: 1 put: 144. a := MpMessagePack unpack: b. '
        + '(a size = 0) and: [ a class == Array ] ]',
      ),
      booleanValue(true),
    );
    // Encode an empty Array -> the single fixarray-0 header byte 0x90.
    assert.deepEqual(
      await evaluate(
        'ar-empty-enc',
        '[ | s | s := MpMessagePack pack: (Array new: 0). (s size = 1) and: [ (s at: 1) = 144 ] ]',
      ),
      booleanValue(true),
    );
  });
});

// A Symbol element inside an Array dispatches to `writeString:`/the str read path — the
// String/Text slice, proven below. The Array slice proves recursive dispatch through the
// real type mapper with the integer elements above.

// --- authentic String/Text round-trip -----------------------------------------------------------
//
// The String path exercises `writeString:`/`writeStrBytesSize:` (encode, via the dialect's
// `Text -> #writeString:` adaptation — the image's Text is not byte-oriented, so it routes
// through the UTF-8 conversion upstream's Pharo portable util uses) and
// `readFixStr:`/`readFixString:`/`readStr8`/`readString8`/`readStr16`/`readStr32` (decode), with
// `SymPortableUtil bytesFromString:`/`stringFromBytes:` overriding the dialect seam with
// `utf8Bytes`/`utf8Text`. No MessagePack-specific encoding primitive.

test('encode an ASCII string produces spec-exact fixstr bytes', async () => {
  await withMessagePack(async ({evaluate}) => {
    // "hi" -> fixstr len 2 = 0xA2, then 'h'(0x68) 'i'(0x69)
    assert.deepEqual(await evaluate('se-size', `[ (MpMessagePack pack: 'hi') size ]`), integerValue(3));
    assert.deepEqual(await evaluate('se-h', `[ (MpMessagePack pack: 'hi') at: 1 ]`), integerValue(162));
    assert.deepEqual(await evaluate('se-1', `[ (MpMessagePack pack: 'hi') at: 2 ]`), integerValue(104));
    assert.deepEqual(await evaluate('se-2', `[ (MpMessagePack pack: 'hi') at: 3 ]`), integerValue(105));
  });
});

test('the empty string round-trips (fixstr-0 header 0xA0)', async () => {
  await withMessagePack(async ({evaluate}) => {
    assert.deepEqual(await evaluate('se-empty-h', `[ (MpMessagePack pack: '') at: 1 ]`), integerValue(160));
    assert.deepEqual(await evaluate('se-empty-size', `[ (MpMessagePack pack: '') size ]`), integerValue(1));
    assert.deepEqual(await evaluate('se-empty-rt', `[ MpMessagePack packUnpack: '' ]`), textValue(''));
  });
});

test('non-ASCII 2/3/4-byte UTF-8 strings produce spec-exact headers and lengths', async () => {
  await withMessagePack(async ({evaluate}) => {
    // é (U+00E9) -> 2 UTF-8 bytes C3 A9 -> fixstr len 2 = 0xA2
    assert.deepEqual(await evaluate('se-2b-h', `[ (MpMessagePack pack: 'é') at: 1 ]`), integerValue(162));
    assert.deepEqual(await evaluate('se-2b-size', `[ (MpMessagePack pack: 'é') size ]`), integerValue(3));
    assert.deepEqual(await evaluate('se-2b-b1', `[ (MpMessagePack pack: 'é') at: 2 ]`), integerValue(195));
    // € (U+20AC) -> 3 UTF-8 bytes -> fixstr len 3 = 0xA3
    assert.deepEqual(await evaluate('se-3b-h', `[ (MpMessagePack pack: '€') at: 1 ]`), integerValue(163));
    assert.deepEqual(await evaluate('se-3b-size', `[ (MpMessagePack pack: '€') size ]`), integerValue(4));
    // 😀 (U+1F600) -> 4 UTF-8 bytes -> fixstr len 4 = 0xA4
    assert.deepEqual(await evaluate('se-4b-h', `[ (MpMessagePack pack: '😀') at: 1 ]`), integerValue(164));
    assert.deepEqual(await evaluate('se-4b-size', `[ (MpMessagePack pack: '😀') size ]`), integerValue(5));
  });
});

test('encode -> decode equals the original Text, and decode -> encode reproduces the bytes', async () => {
  await withMessagePack(async ({evaluate}) => {
    const source = 'aé€😀z'; // ASCII + 2/3/4-byte code points
    assert.deepEqual(
      await evaluate('st-rt', `[ :t | MpMessagePack packUnpack: t ]`, [textValue(source)]),
      textValue(source),
    );
    // decode(encode(t)) == t AND encode(decode(bytes)) == bytes
    assert.deepEqual(
      await evaluate(
        'st-rt-bytes',
        `[ | b d re | b := MpMessagePack pack: 'héllo'. d := MpMessagePack unpack: b. re := MpMessagePack pack: d. `
        + '(re size = b size) and: [ (re at: 1) = (b at: 1) and: [ (re at: 2) = (b at: 2) and: [ (re at: b size) = (b at: b size) ] ] ] ]',
      ),
      booleanValue(true),
    );
  });
});

test('a String nested inside an Array round-trips', async () => {
  await withMessagePack(async ({evaluate}) => {
    assert.deepEqual(
      await evaluate(
        'st-arr',
        `[ | a d | a := Array new: 1. a at: 1 put: 'hi'. d := MpMessagePack unpack: (MpMessagePack pack: a). `
        + '(d size = 1) and: [ (d at: 1) = ' + "'hi'" + ' ] ]',
      ),
      booleanValue(true),
    );
  });
});

test('a Symbol nested inside an Array encodes through its String conversion', async () => {
  await withMessagePack(async ({evaluate}) => {
    // Symbol -> writeString: -> bytesFromString: -> asString utf8Bytes; decodes to the Text form.
    assert.deepEqual(
      await evaluate(
        'st-sym-arr',
        `[ | a d | a := Array new: 1. a at: 1 put: #name. d := MpMessagePack unpack: (MpMessagePack pack: a). `
        + '(d size = 1) and: [ (d at: 1) = ' + "'name'" + ' ] ]',
      ),
      booleanValue(true),
    );
    assert.deepEqual(await evaluate('st-sym-alone', `[ MpMessagePack packUnpack: #name ]`), textValue('name'));
  });
});

test('malformed UTF-8 in a str payload refuses rather than producing corrupted Text', async () => {
  await withMessagePack(async ({evaluate}) => {
    // fixstr len 1 (0xA1) followed by 0xFF — 0xFF is never valid UTF-8.
    await assert.rejects(
      evaluate(
        'st-bad',
        '[ | b | b := Array new: 2. b at: 1 put: 161. b at: 2 put: 255. MpMessagePack unpack: b ]',
      ),
      /malformed UTF-8|UTF-8/,
    );
  });
});

// --- authentic Map/Dictionary round-trip ---------------------------------------------------------
//
// The closing WS3 compound-type proof. `writeMap:` enumerates with the representation-owned
// `keysAndValuesDo:`; `readMapSized:` builds with `timesRepeat:` + `at:put:`; `createDictionary:`
// = `Dictionary new: size` via the existing `new:` shim. No new Dictionary machinery.
//
// Map order: MessagePack does not order map entries, and `keysAndValuesDo:` promises no order
// (ADR 0048). So the proofs assert the *mapping* and spec bytes, never Dictionary iteration
// order. `encode(decode(bytes))` is checked by decoding the re-encoded bytes back to the same
// mapping (order-invariant), not by byte-equality of two enumerations.

test('encode an empty map produces the fixmap-0 header 0x80', async () => {
  await withMessagePack(async ({evaluate}) => {
    assert.deepEqual(await evaluate('me-h', `[ (MpMessagePack pack: (Dictionary new)) at: 1 ]`), integerValue(128));
    assert.deepEqual(await evaluate('me-size', `[ (MpMessagePack pack: (Dictionary new)) size ]`), integerValue(1));
  });
});

test('encode a one-entry map produces spec-exact small-map bytes', async () => {
  await withMessagePack(async ({evaluate}) => {
    // Build the Dictionary into a variable, then pack it (packing the literal Block
    // `[ ... ]` would encode the Block, not its value — pack: does not evaluate).
    const src = (tail) => `[ | d | d := Dictionary new. d at: 'a' put: 1. ${tail} ]`;
    // {'a': 1} -> fixmap len 1 = 0x81, fixstr 'a' = 0xA1 0x61, fixint 1 = 0x01
    assert.deepEqual(await evaluate('mm-h', src('(MpMessagePack pack: d) at: 1')), integerValue(129));
    assert.deepEqual(await evaluate('mm-k1', src('(MpMessagePack pack: d) at: 2')), integerValue(161));
    assert.deepEqual(await evaluate('mm-k2', src('(MpMessagePack pack: d) at: 3')), integerValue(97));
    assert.deepEqual(await evaluate('mm-v', src('(MpMessagePack pack: d) at: 4')), integerValue(1));
    assert.deepEqual(await evaluate('mm-size', src('(MpMessagePack pack: d) size')), integerValue(4));
  });
});

test('decode fixmap bytes returns a real image Dictionary observable via ordinary protocol', async () => {
  await withMessagePack(async ({evaluate}) => {
    // bytes: 0x81 0xA1 'a' 0x01  ->  {'a': 1}. Build the byte Array into a variable.
    const src = (tail) => `[ | b | b := Array new: 4. b at: 1 put: 129. b at: 2 put: 161. b at: 3 put: 97. b at: 4 put: 1. ${tail} ]`;
    assert.deepEqual(
      await evaluate('md-class', src('(MpMessagePack unpack: b) class == Dictionary')), booleanValue(true),
    );
    assert.deepEqual(await evaluate('md-size', src('(MpMessagePack unpack: b) size')), integerValue(1));
    assert.deepEqual(await evaluate('md-at', src('(MpMessagePack unpack: b) at: ' + "'a'")), integerValue(1));
    // A Text key is the decode result of a fixstr key — ordinary protocol sees it as Text.
    assert.deepEqual(
      await evaluate('md-key', src('(MpMessagePack unpack: b) includesKey: ' + "'a'")), booleanValue(true),
    );
  });
});

test('decode(encode(dictionary)) has the same mapping for multiple entries', async () => {
  await withMessagePack(async ({evaluate}) => {
    assert.deepEqual(
      await evaluate(
        'mm-rt',
        `[ | d r | d := Dictionary new. d at: 'a' put: 1. d at: 'b' put: 2. d at: 'c' put: 3. `
        + 'r := MpMessagePack unpack: (MpMessagePack pack: d). '
        + '(r size = 3) and: [ (r at: ' + "'a') = 1 and: [ (r at: 'b') = 2 and: [ (r at: 'c') = 3 ] ] ] ]",
      ),
      booleanValue(true),
    );
  });
});

test('nested Array and Dictionary values round-trip through the map', async () => {
  await withMessagePack(async ({evaluate}) => {
    assert.deepEqual(
      await evaluate(
        'mm-nested',
        `[ | d inner arr r | d := Dictionary new. inner := Dictionary new. inner at: 'x' put: 9. `
        + 'arr := Array new: 2. arr at: 1 put: 1. arr at: 2 put: 2. '
        + 'd at: ' + "'list' put: arr. d at: 'sub' put: inner. "
        + 'r := MpMessagePack unpack: (MpMessagePack pack: d). '
        + '((r at: ' + "'list') size = 2) and: [ ((r at: 'sub') at: 'x') = 9 and: [ ((r at: 'list') at: 2) = 2 ] ] ]",
      ),
      booleanValue(true),
    );
  });
});

test('encode(decode(bytes)) reproduces the same mapping (order-invariant)', async () => {
  await withMessagePack(async ({evaluate}) => {
    // bytes for {'a': 1, 'b': 2}. MessagePack map order is not contractual, and
    // keysAndValuesDo: promises none, so we assert the re-encoded bytes decode back
    // to the identical mapping rather than asserting byte-equality of two enumerations.
    assert.deepEqual(
      await evaluate(
        'mm-rt-bytes',
        `[ | b d re | b := Array new: 7. b at: 1 put: 130. b at: 2 put: 161. b at: 3 put: 97. b at: 4 put: 1. `
        + 'b at: 5 put: 161. b at: 6 put: 98. b at: 7 put: 2. '
        + 'd := MpMessagePack unpack: b. re := MpMessagePack pack: d. d := MpMessagePack unpack: re. '
        + '(d size = 2) and: [ (d at: ' + "'a') = 1 and: [ (d at: 'b') = 2 ] ] ]",
      ),
      booleanValue(true),
    );
  });
});

test('the empty map round-trips decode(encode) to an empty Dictionary', async () => {
  await withMessagePack(async ({evaluate}) => {
    assert.deepEqual(
      await evaluate(
        'me-rt',
        '[ | r | r := MpMessagePack unpack: (MpMessagePack pack: (Dictionary new)). '
        + '(r class == Dictionary) and: [ r size = 0 ] ]',
      ),
      booleanValue(true),
    );
  });
});

// Binary (ByteArray bin8/bin16/bin32, readFixRaw:, and external ReadStream/WriteStream entry points).
test('upstream binary and external stream methods are compiled and installed from the fixture', async () => {
  await withMessagePack(async ({runtime, imageId}) => {
    for (const [className, side, selector] of [
      ['MpEncoder', 'instance', 'writeBinBytes:'],
      ['MpEncoder', 'instance', 'writeBinBytesSize:'],
      ['MpEncoder', 'instance', 'writeRawBytes:'],
      ['MpEncoder', 'instance', 'nextPutAll:'],
      ['MpEncoder', 'class', 'on:'],
      ['MpEncoder', 'class', 'onBytes:'],
      ['MpEncoder', 'class', 'encode:on:'],
      ['MpEncoder', 'class', 'encode:on:setting:'],
      ['MpDecoder', 'instance', 'readBin8'],
      ['MpDecoder', 'instance', 'readBin16'],
      ['MpDecoder', 'instance', 'readBin32'],
      ['MpDecoder', 'instance', 'readFixRaw:'],
      ['MpDecoder', 'instance', 'readRaw16'],
      ['MpDecoder', 'instance', 'readRaw32'],
      ['MpDecoder', 'instance', 'decodeFrom:'],
      ['MpDecoder', 'instance', 'decodeFrom:setting:'],
      ['MpDecoder', 'class', 'on:'],
      ['MpDecoder', 'class', 'onBytes:'],
      ['MpDecoder', 'class', 'decodeFrom:'],
      ['MpDecoder', 'class', 'decodeFrom:setting:'],
      ['MpEncodeTypeMapper', 'instance', 'bytesAsRaw'],
      ['MpDecodeTypeMapper', 'instance', 'bytesAsRaw'],
    ]) {
      await assertMessagePackMethodInstalled({images: runtime.images, imageId, className, side, selector});
    }
  });
});

test('ByteArray values encode to spec bin8/bin16 and round-trip through MpMessagePack pack:/unpack:', async () => {
  await withMessagePack(async ({evaluate}) => {
    // Empty ByteArray #[] -> bin8 header 0xC4 (196), size 0
    assert.deepEqual(
      await evaluate('bin-empty-h', '[ (MpMessagePack pack: #[]) at: 1 ]'),
      integerValue(196),
    );
    assert.deepEqual(
      await evaluate('bin-empty-len', '[ (MpMessagePack pack: #[]) at: 2 ]'),
      integerValue(0),
    );
    assert.deepEqual(
      await evaluate('bin-empty-rt', '[ MpMessagePack unpack: (MpMessagePack pack: #[]) ]'),
      bytesValue(new Uint8Array([])),
    );

    // 4-byte ByteArray #[0 42 128 255] -> bin8 (0xC4, 4, 0, 42, 128, 255)
    assert.deepEqual(
      await evaluate('bin8-h', '[ (MpMessagePack pack: #[0 42 128 255]) at: 1 ]'),
      integerValue(196),
    );
    assert.deepEqual(
      await evaluate('bin8-sz', '[ (MpMessagePack pack: #[0 42 128 255]) at: 2 ]'),
      integerValue(4),
    );
    assert.deepEqual(
      await evaluate('bin8-rt', '[ MpMessagePack unpack: (MpMessagePack pack: #[0 42 128 255]) ]'),
      bytesValue(new Uint8Array([0, 42, 128, 255])),
    );

    // 20-byte ByteArray -> upstream writeBinBytesSize: selects bin16 (0xC5 = 197, 0x00, 0x14) for size >= 16
    assert.deepEqual(
      await evaluate(
        'bin16-rt',
        `[ | raw packed unpacked |
          raw := #[1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20].
          packed := MpMessagePack pack: raw.
          unpacked := MpMessagePack unpack: packed.
          ((packed at: 1) = 197) and: [ ((packed at: 2) = 0) and: [ ((packed at: 3) = 20) and: [ unpacked = raw ] ] ] ]`,
      ),
      booleanValue(true),
    );

    // Decode bin32 header (0xC6 = 198, 0, 0, 0, 3, 9, 8, 7) -> #[9 8 7]
    assert.deepEqual(
      await evaluate('bin32-dec', '[ MpMessagePack unpack: #[198 0 0 0 3 9 8 7] ]'),
      bytesValue(new Uint8Array([9, 8, 7])),
    );

    // Nested ByteArray inside Dictionary and Array round-trips cleanly
    assert.deepEqual(
      await evaluate(
        'bin-nested',
        `[ | d r |
          d := Dictionary new.
          d at: 'payload' put: #[10 20 30].
          r := MpMessagePack unpack: (MpMessagePack pack: d).
          r at: 'payload' ]`,
      ),
      bytesValue(new Uint8Array([10, 20, 30])),
    );
  });
});

test('readFixRaw: and external WriteStream/ReadStream entry points round-trip over standard-image streams', async () => {
  await withMessagePack(async ({evaluate}) => {
    // External stream entry points: MpEncoder encode:on: (WriteStream on: #[]) and MpDecoder decodeFrom: (ReadStream on: bytes)
    assert.deepEqual(
      await evaluate(
        'ext-stream-rt',
        `[ | ws bytes decoded |
          ws := WriteStream on: #[].
          MpEncoder encode: #[7 8 9] on: ws.
          bytes := ws contents.
          decoded := MpDecoder decodeFrom: (ReadStream on: bytes).
          decoded ]`,
      ),
      bytesValue(new Uint8Array([7, 8, 9])),
    );

    // MpEncoder class>>onBytes: and MpDecoder class>>onBytes:
    assert.deepEqual(
      await evaluate(
        'ext-onbytes-rt',
        `[ | enc encoded dec |
          enc := MpEncoder onBytes: #[].
          enc writeObject: 'hello'.
          encoded := enc contents.
          dec := MpDecoder onBytes: encoded.
          dec decode ]`,
      ),
      textValue('hello'),
    );

    // readFixRaw: and 2008 legacy bytesAsRaw / readRaw16 mode:
    // 0xA0 (160) is empty fixraw -> returns #[] via the verbatim `#[]` literal in MpDecoder>>readFixRaw:
    assert.deepEqual(
      await evaluate(
        'fixraw-empty',
        `[ (MpDecoder onBytes: #[]) readFixRaw: 160 ]`,
      ),
      bytesValue(new Uint8Array([])),
    );
    assert.deepEqual(
      await evaluate(
        'fixraw-nonempty',
        `[ (MpDecoder onBytes: #[65 66 67]) readFixRaw: 163 ]`,
      ),
      bytesValue(new Uint8Array([65, 66, 67])),
    );
    // 2008 formatVersion triggers buildTypeMapper: -> bytesAsRaw -> readRaw16 (0xDA = 218, 0, 3, 65, 66, 67)
    assert.deepEqual(
      await evaluate(
        'raw16-setting',
        `[ MpDecoder decodeFrom: (ReadStream on: #[218 0 3 65 66 67]) setting: [ :s | s at: #formatVersion put: 2008 ] ]`,
      ),
      bytesValue(new Uint8Array([65, 66, 67])),
    );
  });
});

test('installMessagePackFromFixture with retainSource and retainProvenance persists browsable FileTree category and package metadata', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const imageId = 'mp-prov';
    await runtime.images.createImage({id: imageId});
    await installSymmetricSmalltalkStandardImage({images: runtime.images, compilation: runtime.compilation, imageId});
    await installMessagePackFromFixture({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId,
      fixtureRoot: FIXTURE_ROOT,
      retainSource: true,
      retainProvenance: true,
    });

    const encoderClassRef = objectRef(imageId, 'smalltalk/class/MpEncoder');
    const decoderClassRef = objectRef(imageId, 'smalltalk/class/MpDecoder');
    const grants = [
      {operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, encoderClassRef.objectId)},
      {operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, decoderClassRef.objectId)},
      {
        operation: SMALLTALK_METHOD_READ_OPERATION,
        resource: smalltalkMethodPositionResource(imageId, encoderClassRef, 'writeBinBytes:'),
      },
      {
        operation: SMALLTALK_METHOD_READ_OPERATION,
        resource: smalltalkMethodPositionResource(imageId, decoderClassRef, 'readFixRaw:'),
      },
    ];
    const context = runtime.authority.issue({principal: 'inspector', grants});
    const require = (demand) => runtime.authority.require(context, demand);

    const encoderClassDesc = await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId,
      classRef: encoderClassRef,
      require,
    });
    assert.deepEqual(encoderClassDesc.provenance, {
      package: 'MessagePack-Core',
      category: 'MessagePack-Core',
    });

    const writeBinMethodDesc = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId,
      classRef: encoderClassRef,
      selector: 'writeBinBytes:',
      require,
    });
    assert.deepEqual(writeBinMethodDesc.provenance, {
      package: 'MessagePack-Core',
      category: 'writing',
      file: 'MpEncoder.class/instance/writeBinBytes..st',
    });
    assert.ok(writeBinMethodDesc.source.includes('self writeBinBytesSize: size'));

    const readFixRawDesc = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId,
      classRef: decoderClassRef,
      selector: 'readFixRaw:',
      require,
    });
    assert.deepEqual(readFixRawDesc.provenance, {
      package: 'MessagePack-Core',
      category: 'reading',
      file: 'MpDecoder.class/instance/readFixRaw..st',
    });
    assert.ok(readFixRawDesc.source.includes('#[]'));
  } finally {
    await runtime.close();
  }
});
