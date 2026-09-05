import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineMethodsFromSource,
  ensureNamedClass,
  ensureSmalltalkShape,
  findSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  methodBlockRef,
  objectRef,
  publishSmalltalkClassGlobals,
  textValue,
} from '../src/runtime.js';

// Native Integer PRINTING protocol (bead lagrange-images-nv1.6). It exists because a real imported
// consumer sends it — the pinned upstream Cuis JSON package's own extension is
// `jsonWriteOn: aWriteStream  ^ self printOn: aWriteStream base: 10` — but what is under test here
// is ORDINARY native Integer protocol. Nothing in this file mentions Cuis, imports a package or
// touches a JSON manifest: if this were a compatibility helper rather than native protocol, these
// tests could not be written.
//
// Every expectation is the RECORDED REAL-CUIS ORACLE, taken through the real
// `WriteStream on: String new` ... `printOn:base:` ... `contents` route on the pinned VM and image
// (full transcript on the bead):
//
//   3 -> '3'      0 -> '0'      1 -> '1'      9 -> '9'      10 -> '10'      100 -> '100'
//   -3 -> '-3'    -1 -> '-1'    -10 -> '-10'  1073741823 -> '1073741823'
//   123456789012345678901234567890  -> '123456789012345678901234567890'
//   -123456789012345678901234567890 -> '-123456789012345678901234567890'
//   255 base 16 -> 'FF'   -255 base 16 -> '-FF'
let shared = null;
async function image() {
  if (shared) return shared;
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'app'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm',
  });

  // A MINIMAL sink. It implements only the sends `printOn:base:` actually makes, plus read-back —
  // no `nextPut:`, no positioning, no `contents`. If the method reached for any other stream
  // protocol, every case below would fail as a message-not-understood naming that selector, which
  // is what makes "this is the write protocol it requires" a measurement rather than a claim.
  const instanceShapeRef = await ensureSmalltalkShape(runtime.images, 'app', {
    id: 'test/integer-printing-sink-shape',
    slots: [{id: 'sink-written', name: 'written'}, {id: 'sink-count', name: 'count'}],
  });
  const {classRef} = await ensureNamedClass({
    images: runtime.images, imageId: 'app', name: 'PrintingSink', instanceShapeRef,
  });
  await defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm', classRef,
    methods: [
      {
        selector: 'nextPutAll:',
        source: '[ :aText | written := aText. count := (count isNil ifTrue: [ 0 ] ifFalse: [ count ]) + 1. ^ self ]',
      },
      {selector: 'written', source: '[ ^ written ]'},
      {selector: 'writeCount', source: '[ ^ count ]'},
    ],
  });
  await publishSmalltalkClassGlobals({images: runtime.images, imageId: 'app', names: ['PrintingSink']});
  shared = runtime;
  return shared;
}

test.after(async () => {
  if (shared) await shared.close();
});

let counter = 0;
async function evaluate(source, args = []) {
  const runtime = await image();
  const {block} = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId: 'app', id: `integer-printing-${counter += 1}`, source,
  });
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(
    objectRef('app', block.id), args,
  ));
}

const printed = (value, base) => evaluate(
  '[ :v :b | | s | s := PrintingSink new. v printOn: s base: b. s written ]',
  [integerValue(value), integerValue(base)],
);

test('printOn:base: belongs to the native Integer class, not to a stream or an importer', async () => {
  const runtime = await image();
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
  assert.ok(
    await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'printOn:base:',
    }),
    'the native Integer class implements it',
  );
  // It is Integer protocol. The stream owner does not implement integer printing, and there is no
  // second implementation anywhere for a receiver to reach instead.
  for (const className of ['WriteStream', 'Object', 'Text']) {
    assert.equal(
      await methodBlockRef({
        images: runtime.images,
        imageId: 'app',
        classRef: objectRef('app', `smalltalk/class/${className}`),
        selector: 'printOn:base:',
      }),
      null,
      `${className} must not implement integer printing`,
    );
  }
});

// Ordinary native integers, with no Cuis import anywhere in sight.
test('base 10 agrees with real Cuis for positive, zero, negative and large integers', async () => {
  const oracle = [
    ['3', '3'], ['0', '0'], ['1', '1'], ['9', '9'], ['10', '10'], ['100', '100'],
    ['-3', '-3'], ['-1', '-1'], ['-10', '-10'],
    ['1073741823', '1073741823'],
    ['123456789012345678901234567890', '123456789012345678901234567890'],
    ['-123456789012345678901234567890', '-123456789012345678901234567890'],
  ];
  for (const [value, expected] of oracle) {
    assert.deepEqual(await printed(value, 10), textValue(expected), `${value} base 10`);
  }
});

// The four cases the M3 acceptance target itself is specified against, kept together so the
// milestone's own oracle is visible as one assertion rather than scattered through the table.
test('the M3 acceptance oracle prints exactly', async () => {
  assert.deepEqual(await printed('3', 10), textValue('3'));
  assert.deepEqual(await printed('0', 10), textValue('0'));
  assert.deepEqual(await printed('-3', 10), textValue('-3'));
  assert.deepEqual(
    await printed('123456789012345678901234567890', 10),
    textValue('123456789012345678901234567890'),
    'the 30-digit integer verbatim, with no precision loss',
  );
});

// The digit-to-byte step carries the ordinary letter branch, because emitting `48 + digit` for
// every digit would silently produce nonsense above base 10. Base 10 is the only base a consumer
// backs; this case exists so that branch does not ship unproven, and it is the real Cuis answer.
test('the digit letter branch matches real Cuis rather than shipping unproven', async () => {
  assert.deepEqual(await printed('255', 16), textValue('FF'));
  assert.deepEqual(await printed('-255', 16), textValue('-FF'));
});

// WHAT WRITE PROTOCOL THE METHOD ACTUALLY REQUIRES. The sink implements `nextPutAll:` and nothing
// else, so the cases above already prove nothing else is sent. This pins the count too: one write
// per print, so the method does not stream digit by digit.
test('the method requires exactly one nextPutAll: and no other stream protocol', async () => {
  assert.deepEqual(
    await evaluate('[ | s | s := PrintingSink new. 12345 printOn: s base: 10. s writeCount ]'),
    integerValue(1),
  );
});

// No new primitive was introduced: the digits come from Integer arithmetic already installed and
// the text from the existing Array -> ByteArray -> utf8Text conversion the byte-sequence protocol
// already owns. A regression that reached for a host operation would show up as a new primitive.
test('printing composes existing native protocol rather than adding a primitive', async () => {
  const runtime = await image();
  for (const id of ['smalltalk/primitive/integer-to-string', 'smalltalk/primitive/integer-print']) {
    assert.equal(
      await runtime.images.getObject('app', id),
      null,
      `${id} must not exist: printing is composed, not primitive`,
    );
  }
});
