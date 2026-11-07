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
  parseSymmetricSmalltalkBlock,
  textValue,
} from '../src/runtime.js';

let sharedRuntime = null;
async function getSharedRuntime() {
  if (sharedRuntime) return sharedRuntime;
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'breadth'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'breadth',
    lane: 'wasm',
  });
  sharedRuntime = runtime;
  return sharedRuntime;
}

test.after(async () => {
  if (sharedRuntime) await sharedRuntime.close();
});

let evalCounter = 0;
async function evaluate(source, {lane = 'wasm'} = {}) {
  const runtime = await getSharedRuntime();
  const id = `breadth-eval-${++evalCounter}`;
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'breadth',
    id,
    source,
  });
  const targetBlock =
    lane === 'neutral'
      ? installed.block
      : (
          await installWasmBlockTree({
            images: runtime.images,
            compilation: runtime.compilation,
            semanticRef: objectRef('breadth', installed.semanticArtifact.id),
            id: `${id}:wasm`,
            environment: installed.block.environment,
          })
        ).block;
  const activation = await runtime.invocations.invokeBlock(
    objectRef('breadth', targetBlock.id),
    [],
  );
  return await runtime.executor.execute(activation);
}

test('ByteArray literal #[...] parses valid 0..255 integers and rejects out-of-range or non-integer elements', () => {
  assert.deepEqual(parseSymmetricSmalltalkBlock('[ #[] ]').body, {
    kind: 'byteArrayLiteral',
    bytes: [],
  });
  assert.deepEqual(
    parseSymmetricSmalltalkBlock('[ #[0 1 127 16rFF 2r1010 "comment" 42] ]').body,
    {
      kind: 'byteArrayLiteral',
      bytes: [0, 1, 127, 255, 10, 42],
    },
  );
  assert.deepEqual(
    parseSymmetricSmalltalkBlock('[ #(1 #[10 20] #ok) ]').body,
    {
      kind: 'arrayLiteral',
      elements: [
        {kind: 'integer', value: '1'},
        {kind: 'byteArrayLiteral', bytes: [10, 20]},
        {kind: 'symbol', value: 'ok'},
      ],
    },
  );

  for (const invalid of [
    '[ #[-1] ]',
    '[ #[256] ]',
    '[ #[16r100] ]',
    "[ #['text'] ]",
    '[ #[$a] ]',
    '[ #[#sym] ]',
    '[ #[true] ]',
  ]) {
    assert.throws(
      () => parseSymmetricSmalltalkBlock(invalid),
      /byte-array literal elements must be integers in 0\.\.255/,
      `should reject ${invalid}`,
    );
  }
  assert.throws(
    () => parseSymmetricSmalltalkBlock('[ #[1 2 '),
    /expected \] to close a literal ByteArray/,
  );
});

for (const lane of ['neutral', 'wasm']) {
  test(`ByteArray literals and ByteArray collection/stream protocol execute in ${lane} lane`, async () => {
    assert.deepEqual(await evaluate('[ #[] ]', {lane}), bytesValue(new Uint8Array([])));
    assert.deepEqual(
      await evaluate('[ #[0 65 66 16rFF] ]', {lane}),
      bytesValue(new Uint8Array([0, 65, 66, 255])),
    );
    assert.deepEqual(
      await evaluate('[ #[10 20 30] class == ByteArray ]', {lane}),
      booleanValue(true),
    );
    assert.deepEqual(await evaluate('[ #[] isEmpty ]', {lane}), booleanValue(true));
    assert.deepEqual(await evaluate('[ #[1] isEmpty ]', {lane}), booleanValue(false));
    assert.deepEqual(await evaluate('[ ByteArray new ]', {lane}), bytesValue(new Uint8Array([])));
    assert.deepEqual(
      await evaluate('[ #[10 20 30] size ]', {lane}),
      integerValue(3),
    );
    assert.deepEqual(
      await evaluate('[ #[10 20 30] at: 2 ]', {lane}),
      integerValue(20),
    );
    assert.deepEqual(
      await evaluate('[ (#(1 #[7 8 9] 3) at: 2) at: 3 ]', {lane}),
      integerValue(9),
    );
    assert.deepEqual(
      await evaluate('[ #[1 2 3] collect: [ :b | b * 10 ] ]', {lane}),
      bytesValue(new Uint8Array([10, 20, 30])),
    );
    assert.deepEqual(
      await evaluate(
        `[ | sum |
          sum := 0.
          #[4 5 6] do: [ :b | sum := sum + b ].
          sum ]`,
        {lane},
      ),
      integerValue(15),
    );
    assert.deepEqual(
      await evaluate('[ #[7 8 9] asArray at: 2 ]', {lane}),
      integerValue(8),
    );
    assert.deepEqual(
      await evaluate('[ #(11 22 33) asByteArray ]', {lane}),
      bytesValue(new Uint8Array([11, 22, 33])),
    );
    assert.deepEqual(
      await evaluate("[ 'Hi' asByteArray ]", {lane}),
      bytesValue(new Uint8Array([72, 105])),
    );
  });

  test(`ReadStream and WriteStream support bulk, positionable, and binary ByteArray operations in ${lane} lane`, async () => {
    // Binary WriteStream & ByteArray class >> streamContents:
    assert.deepEqual(
      await evaluate(
        `[ ByteArray streamContents: [ :out |
            out nextPut: 16r93.
            out nextPutAll: #[1 2].
            out nextPut: 3 ] ]`,
        {lane},
      ),
      bytesValue(new Uint8Array([0x93, 1, 2, 3])),
    );

    // Binary ReadStream: peek, next, next:, position, position:, reset, upTo:, upToEnd
    assert.deepEqual(
      await evaluate(
        `[ | s header payload rest |
          s := #[16r93 10 20 30 40 50] readStream.
          header := s peek.
          s next.
          payload := s next: 2.
          rest := s upToEnd.
          (header = 16r93) and: [
            (payload = #[10 20]) and: [
              (rest = #[30 40 50]) and: [ s atEnd ] ] ] ]`,
        {lane},
      ),
      booleanValue(true),
    );

    assert.deepEqual(
      await evaluate(
        `[ | s firstChunk secondChunk |
          s := #[1 2 0 3 4] readStream.
          firstChunk := s upTo: 0.
          secondChunk := s upToEnd.
          s reset.
          s position: 3.
          (firstChunk = #[1 2]) and: [
            (secondChunk = #[3 4]) and: [
              (s position = 3) and: [ s next = 3 ] ] ] ]`,
        {lane},
      ),
      booleanValue(true),
    );

    // Text ReadStream bulk operations: peek, next:, upTo:, upToEnd, reset, position:
    assert.deepEqual(
      await evaluate(
        `[ | s prefix suffix |
          s := 'hello:world' readStream.
          prefix := s upTo: $:.
          suffix := s upToEnd.
          s reset.
          (prefix = 'hello') and: [
            (suffix = 'world') and: [
              (s peek == $h) and: [ (s next: 5) = 'hello' ] ] ] ]`,
        {lane},
      ),
      booleanValue(true),
    );

    // Collection-backed WriteStream supports both nextPut: and nextPutAll:
    assert.deepEqual(
      await evaluate(
        `[ | s result |
          s := WriteStream on: OrderedCollection new.
          s nextPut: 10.
          s nextPutAll: #(20 30).
          s nextPut: 40.
          result := s contents.
          (result size = 4) and: [ (result first = 10) and: [ result last = 40 ] ] ]`,
        {lane},
      ),
      booleanValue(true),
    );
  });

  test(`Interval supports positive and negative by: steps, indexing, and collection enumeration in ${lane} lane`, async () => {
    assert.deepEqual(
      await evaluate('[ (1 to: 5) asArray at: 4 ]', {lane}),
      integerValue(4),
    );
    assert.deepEqual(
      await evaluate(
        `[ | iv arr |
          iv := 1 to: 9 by: 3.
          arr := iv collect: [ :x | x * 10 ].
          (iv size = 3) and: [
            (iv first = 1) and: [
              (iv last = 7) and: [
                ((iv at: 2) = 4) and: [
                  ((arr at: 1) = 10) and: [
                    ((arr at: 2) = 40) and: [ (arr at: 3) = 70 ] ] ] ] ] ] ]`,
        {lane},
      ),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(
        `[ | iv arr |
          iv := 10 to: 2 by: -3.
          arr := iv asArray.
          (iv size = 3) and: [
            (iv step = -3) and: [
              ((arr at: 1) = 10) and: [
                ((arr at: 2) = 7) and: [ (arr at: 3) = 4 ] ] ] ] ]`,
        {lane},
      ),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(
        `[ | empty |
          empty := 5 to: 1.
          empty isEmpty and: [ empty size = 0 ] ]`,
        {lane},
      ),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(
        `[ | evens |
          evens := (1 to: 6) select: [ :n | (n \\\\ 2) = 0 ].
          (evens size = 3) and: [ (evens at: 2) = 4 ] ]`,
        {lane},
      ),
      booleanValue(true),
    );
  });
}
