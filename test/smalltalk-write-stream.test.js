import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  findSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  methodBlockRef,
  objectRef,
  readBehavior,
  resolveGlobal,
} from '../src/runtime.js';

// The native `WriteStream` (bead lagrange-images-nv1.4). It exists because a real imported
// consumer named it — the pinned upstream Cuis JSON package writes `WriteStream on: String new`
// and the native compiler answered `unbound Symmetric Smalltalk name: WriteStream` — but what is
// under test here is an ORDINARY native Smalltalk class reached through the ORDINARY global
// namespace. Nothing in this file mentions Cuis, and nothing needs to: if this class were a Cuis
// compatibility shim rather than a native facility, these tests could not be written.
//
// Every behavioral expectation below is anchored to the REAL CUIS ORACLE recorded on the bead,
// measured against the pinned VM and image rather than recalled from Squeak/Pharo:
//
//   (WriteStream on: 'hello') contents   = ''       `on:` positions at the beginning and DISCARDS
//   (WriteStream with: 'hello') contents = 'hello'  existing content; append is `with:`.
//   contents preserves the backing species          String -> String, Array -> Array,
//                                                   OrderedCollection -> OrderedCollection.
//   contents answers a fresh copy each call         not identical to the backing, not identical
//                                                   across calls, equal across calls.
let shared = null;
async function image() {
  if (shared) return shared;
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'app'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm',
  });
  shared = runtime;
  return shared;
}

test.after(async () => {
  if (shared) await shared.close();
});

let counter = 0;
async function evaluate(source) {
  const runtime = await image();
  const id = `write-stream-eval-${counter += 1}`;
  const {block} = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId: 'app', id, source,
  });
  const activation = await runtime.invocations.invokeBlock(objectRef('app', block.id), []);
  return await runtime.executor.execute(activation);
}

// The gap this bead closes, stated as a proof rather than as prose: the name resolves through the
// ordinary namespace, which is what the compiler consults. A class that existed but was not
// published would still fail with the exact error the acceptance path hit.
test('WriteStream is an ordinary published global, so an ordinary method body can name it', async () => {
  const runtime = await image();
  const binding = await resolveGlobal({images: runtime.images, imageId: 'app', name: 'WriteStream'});
  assert.ok(binding, 'WriteStream must be published in the image global namespace');

  // Compiling a body that NAMES the global is the direct inverse of the recorded RED
  // (`unbound Symmetric Smalltalk name: WriteStream` was raised at compile time, by the same
  // name resolution this exercises), and the name resolves to the class its instances belong to.
  assert.deepEqual(
    await evaluate('[ (WriteStream on: OrderedCollection new) class == WriteStream ]'),
    await evaluate('[ true ]'),
  );
  assert.deepEqual(binding, objectRef('app', 'smalltalk/global-binding/WriteStream'), 'published through the ordinary global-binding machinery');
});

test('WriteStream is an ordinary native class, not a special representation', async () => {
  const runtime = await image();
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
  const classRef = objectRef('app', 'smalltalk/class/WriteStream');
  const behavior = await readBehavior(runtime.images, classRef);

  assert.equal(behavior.name.value, 'WriteStream');
  // A direct subclass of Object: the Cuis `PositionableStream` hierarchy is deliberately not
  // modelled, because nothing here has a position to be positionable about.
  assert.deepEqual(behavior.superclass, kernel.objectClass);

  // One instance variable, by name and in order — the backing collection, nothing else.
  const shape = await runtime.images.getShape(behavior.instanceShape.imageId, behavior.instanceShape.objectId);
  assert.deepEqual(shape.slots.map(({name}) => name), ['collection']);
});

// SCOPE. The whole point of this bead is that breadth the acceptance target does not exercise
// invalidates the repair, so the absence of the rest of the stream protocol is itself asserted.
test('WriteStream publishes exactly the two selectors the consumer exercises', async () => {
  const runtime = await image();
  const classRef = objectRef('app', 'smalltalk/class/WriteStream');
  const metaclassRef = objectRef('app', 'smalltalk/metaclass/WriteStream');

  assert.ok(await methodBlockRef({images: runtime.images, imageId: 'app', classRef: metaclassRef, selector: 'on:'}));
  assert.ok(await methodBlockRef({images: runtime.images, imageId: 'app', classRef, selector: 'contents'}));

  // Real Cuis protocol this consumer does not reach. Each is a legitimate future addition under
  // its own consumer pressure; none is present now, and `contents` must be revisited when the
  // first write selector lands, because an empty answer stops being the written prefix.
  for (const selector of ['nextPut:', 'nextPutAll:', 'with:', 'position', 'position:', 'reset', 'next', 'atEnd', 'size', 'isEmpty']) {
    assert.equal(
      await methodBlockRef({images: runtime.images, imageId: 'app', classRef, selector}),
      null,
      `${selector} is stream breadth this acceptance target does not exercise`,
    );
  }
});

// The acceptance path's own shape, with a native collection standing in for the `String` the
// source names (`String` is a separate, unsolved semantic question and its own bead).
test('WriteStream on: a native collection answers an empty collection from contents', async () => {
  assert.deepEqual(
    await evaluate('[ (WriteStream on: OrderedCollection new) contents size ]'),
    integerValue(0),
    'a fresh stream has written nothing, so its contents are empty',
  );
  assert.deepEqual(
    await evaluate('[ (WriteStream on: OrderedCollection new) contents isEmpty ]'),
    await evaluate('[ OrderedCollection new isEmpty ]'),
  );
});

// THE DISCRIMINATING ORACLE FACT. `on:` positions at the BEGINNING and discards what the argument
// already holds — it is not `with:`. A probe with an EMPTY argument cannot tell those apart, which
// is exactly why the oracle was rerun with a non-empty one. If `on:` were append, this answers 3.
test('on: discards the backing collection\'s existing content, exactly as the oracle records', async () => {
  assert.deepEqual(
    await evaluate(`[ | backing |
      backing := OrderedCollection new.
      backing add: 1. backing add: 2. backing add: 3.
      (WriteStream on: backing) contents size ]`),
    integerValue(0),
    'streaming over a 3-element collection answers an EMPTY one, so on: is not with:',
  );
  // ... and the argument really was non-empty, so the assertion above is not vacuous.
  assert.deepEqual(
    await evaluate(`[ | backing |
      backing := OrderedCollection new.
      backing add: 1. backing add: 2. backing add: 3.
      backing size ]`),
    integerValue(3),
  );
});

// `contents` answers through the backing's `species`, so the result follows the backing rather
// than being fixed to one representation — the oracle's String/Array/OrderedCollection result.
test('contents preserves the backing collection\'s species', async () => {
  assert.deepEqual(
    await evaluate('[ (WriteStream on: OrderedCollection new) contents class = OrderedCollection ]'),
    await evaluate('[ true ]'),
  );
});

// A fresh answer per call, not a view onto the stream's buffer and not the buffer itself.
test('contents answers a fresh collection each call rather than the backing itself', async () => {
  assert.deepEqual(
    await evaluate(`[ | backing stream |
      backing := OrderedCollection new.
      stream := WriteStream on: backing.
      stream contents == backing ]`),
    await evaluate('[ false ]'),
    'contents is not the backing collection',
  );
  assert.deepEqual(
    await evaluate(`[ | stream |
      stream := WriteStream on: OrderedCollection new.
      stream contents == stream contents ]`),
    await evaluate('[ false ]'),
    'two calls answer two collections',
  );
});

// The class is state-per-instance like any other, not a singleton or a shared buffer.
test('two streams over two collections are independent instances', async () => {
  assert.deepEqual(
    await evaluate(`[ | a b |
      a := WriteStream on: OrderedCollection new.
      b := WriteStream on: OrderedCollection new.
      a == b ]`),
    await evaluate('[ false ]'),
  );
});
