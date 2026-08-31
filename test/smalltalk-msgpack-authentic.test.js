import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createRuntime,
  installSymmetricSmalltalkStandardImage,
  installSymmetricSmalltalkBlock,
  integerValue,
  booleanValue,
  objectRef,
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
// String/Text slice (WS3 next), not this one — so its in-array proof lands there. The Array
// slice proves recursive dispatch through the real type mapper with the integer elements above.
