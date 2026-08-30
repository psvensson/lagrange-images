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
