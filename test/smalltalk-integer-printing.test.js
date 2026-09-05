import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineMethodsFromSource,
  installSmalltalkAllocationProtocol,
  installSmalltalkControlFlow,
  installSmalltalkGlobalNamespace,
  installSmalltalkIndexedProtocol,
  installSmalltalkIntegerPrintingProtocol,
  installSmalltalkKernel,
  ensureNamedClass,
  ensureSmalltalkShape,
  findSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  methodBlockRef,
  objectRef,
  publishSmalltalkClassGlobals,
  resolveGlobal,
  textValue,
} from '../src/runtime.js';
import {SMALLTALK_KERNEL_PRIMITIVE_V1} from '../src/language/smalltalk-primitives.js';

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

// Within the declared 2..36 domain the digit-to-byte step needs the ordinary letter branch, since
// `48 + digit` alone produces nonsense above 9. Base 10 is the only base a consumer backs; this
// case exists so that branch does not ship unproven, and it is the real Cuis answer.
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
// already owns. Asserting that some invented primitive id is absent would prove nothing — it would
// pass on any HEAD. What actually constrains this is the METHOD'S OWN representation: a composed
// Smalltalk method compiles to an ordinary program, while a primitive would be a
// `smalltalk-kernel-primitive/v1` code artifact.
test('printing is a composed Smalltalk method, not a kernel primitive', async () => {
  const runtime = await image();
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
  const method = await methodBlockRef({
    images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'printOn:base:',
  });
  const block = await runtime.images.getBlock(method.imageId, method.objectId);
  const code = await runtime.images.getCodeArtifact(method.imageId, block.code.objectId);
  assert.notEqual(
    code.representation,
    SMALLTALK_KERNEL_PRIMITIVE_V1,
    'integer printing must be composed from existing protocol, never a new host primitive',
  );
  // Positively: it is an ordinary compiled method in the lane this image was installed with.
  assert.equal(code.representation, 'wasm-function/v2');
});

// The method answers its receiver, as the real protocol does. Nothing on the acceptance path reads
// that value, so without this assertion the method could return anything and stay green.
test('printOn:base: answers the receiver', async () => {
  assert.deepEqual(
    await evaluate('[ | s | s := PrintingSink new. 7 printOn: s base: 10 ]'),
    integerValue(7),
  );
});

// THE DECLARED DOMAIN. The digit recurrence is only meaningful for bases 2..36, and outside it the
// failures are the worst kind: `base: 1` never terminates, because `value // 1` is `value` forever
// and nothing in the executor imposes a step budget; a negative base silently answers punctuation,
// because `48 + digit` for a negative digit is still a legal byte. The method therefore refuses,
// visibly, by sending a selector nothing implements.
test('a base outside the declared 2..36 domain is refused rather than guessed', {timeout: 60_000}, async () => {
  for (const base of ['1', '0', '-10', '37', '100']) {
    await assert.rejects(
      printed('3', base),
      /message not understood: printBaseOutOfRange:/,
      `base ${base} must be refused`,
    );
  }
  // The boundaries themselves are inside the domain and still work.
  assert.deepEqual(await printed('5', 2), textValue('101'));
  assert.deepEqual(await printed('35', 36), textValue('Z'));
});

// The installer's restored prerequisite is a real guard, and it has to read the installed METHODS
// rather than the globals. `ByteArray` is a KERNEL class whose global the namespace installer
// publishes unconditionally, so an image can have both globals published and still lack the
// byte-sequence protocol the method calls — the method would install, compile cleanly and die on
// first use. This builds exactly that image.
test('installing without the byte-sequence protocol the method calls is refused', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'bare'});
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'bare', lane: 'wasm'};
    await installSmalltalkKernel({images: runtime.images, imageId: 'bare'});
    await installSmalltalkAllocationProtocol(options);
    await installSmalltalkControlFlow(options);
    await installSmalltalkIndexedProtocol(options);
    await installSmalltalkGlobalNamespace(options);
    await publishSmalltalkClassGlobals({images: runtime.images, imageId: 'bare', names: ['Array']});

    // Both globals resolve — `ByteArray`'s because it is a kernel class the namespace publishes —
    // so a global-only check would pass here. The protocol it needs is still absent.
    assert.ok(await resolveGlobal({images: runtime.images, imageId: 'bare', name: 'ByteArray'}));
    assert.equal(
      await methodBlockRef({
        images: runtime.images,
        imageId: 'bare',
        classRef: objectRef('bare', 'smalltalk/metaclass/ByteArray'),
        selector: 'fromArray:',
      }),
      null,
    );

    await assert.rejects(
      installSmalltalkIntegerPrintingProtocol(options),
      /has no smalltalk\/metaclass\/ByteArray fromArray: method; install its protocol first/,
    );
    // Refused before anything was written: no half-installed printing method is left behind.
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'bare'});
    assert.equal(
      await methodBlockRef({
        images: runtime.images, imageId: 'bare', classRef: kernel.integerClass, selector: 'printOn:base:',
      }),
      null,
    );
  } finally {
    await runtime.close();
  }
});
