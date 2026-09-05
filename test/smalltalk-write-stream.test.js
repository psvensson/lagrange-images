import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  createRuntime,
  defineMethodsFromSource,
  ensureNamedClass,
  findSmalltalkKernel,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  installSmalltalkWriteStreamProtocol,
  integerValue,
  methodBindings,
  methodBlockRef,
  objectRef,
  publishSmalltalkClassGlobals,
  readBehavior,
  resolveGlobal,
  textValue,
  WRITE_STREAM_CONTENTS_CONDITION,
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
    booleanValue(true),
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

  // Two instance variables, by name and in order: the backing collection, and the PROVISIONAL
  // internal accumulation the write protocol needs. The accumulation is deliberately not exposed
  // by any selector, so bead lagrange-images-nv1.7 stays free to decide what `contents` answers.
  const shape = await runtime.images.getShape(behavior.instanceShape.imageId, behavior.instanceShape.objectId);
  assert.deepEqual(shape.slots.map(({name}) => name), ['collection', 'written']);
});

// SCOPE. The whole point of this bead is that breadth the acceptance target does not exercise
// invalidates the repair, so the absence of the rest of the stream protocol is asserted — and
// asserted by ENUMERATING both method dictionaries, not by listing selectors that happen to be
// absent. A hand-written absent-list cannot notice an eleventh selector; this can.
//
// Three selectors, not two: the two the consumer sends, plus the instance-side `on:` the
// class-side one delegates to. That split is upstream's own (measured: the instance-side `on:` is
// implemented in `WriteStream`, the class-side in `PositionableStream class`) and it is forced
// here too, because a metaclass method cannot assign an instance variable.
test('WriteStream implements exactly the consumer protocol plus its own initializer', async () => {
  const runtime = await image();
  const selectorsOf = async (objectId) => (await methodBindings({
    images: runtime.images, imageId: 'app', classRef: objectRef('app', objectId),
  })).map(({selector}) => selector).sort();

  // `nextPutAll:` is here because EXECUTION named it: native Integer printing sends exactly one
  // write per print and nothing else (bead lagrange-images-nv1.8). `nextPut:` is still absent —
  // no consumer sends it, and it earns its own repair if one ever does.
  assert.deepEqual(await selectorsOf('smalltalk/class/WriteStream'), ['contents', 'nextPutAll:', 'on:']);
  assert.deepEqual(await selectorsOf('smalltalk/metaclass/WriteStream'), ['on:']);
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
// than being fixed to its class. Asserting that against an OrderedCollection alone would be
// VACUOUS — a hard-coded `OrderedCollection new`, or `collection class new`, would pass it too.
// So this uses the discriminating technique the library's own species proof uses
// (test/smalltalk-library.test.js): a subclass that OVERRIDES `species` to answer something else.
// Only a real `species` send can satisfy it.
test('contents answers through the backing\'s species, not its class', async () => {
  const runtime = await image();
  // TWO ordinary OrderedCollection subclasses, both reusing their superclass's instance Shape so
  // each is a real allocatable collection. The probe's SPECIES is the target — a class that is
  // neither the probe's own class nor `OrderedCollection`. That is what makes the assertion
  // discriminating: `collection class new` answers the probe, a hard-coded `OrderedCollection new`
  // answers OrderedCollection, and only a real `species` send answers the target.
  const orderedCollection = objectRef('app', 'smalltalk/class/OrderedCollection');
  const {instanceShape} = await readBehavior(runtime.images, orderedCollection);
  for (const name of ['WriteStreamSpeciesTarget', 'WriteStreamSpeciesProbe']) {
    await ensureNamedClass({
      images: runtime.images, imageId: 'app', name, superclassRef: orderedCollection, instanceShapeRef: instanceShape,
    });
  }
  // Publication first: the override's source NAMES the target, and globals resolve at compile time.
  await publishSmalltalkClassGlobals({
    images: runtime.images, imageId: 'app', names: ['WriteStreamSpeciesTarget', 'WriteStreamSpeciesProbe'],
  });
  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'app',
    lane: 'wasm',
    classRef: objectRef('app', 'smalltalk/class/WriteStreamSpeciesProbe'),
    methods: [{selector: 'species', source: '[ WriteStreamSpeciesTarget ]'}],
  });

  assert.deepEqual(
    await evaluate('[ (WriteStream on: WriteStreamSpeciesProbe new) contents class == WriteStreamSpeciesTarget ]'),
    booleanValue(true),
    'contents follows species: neither the backing\'s class nor a hard-coded collection satisfies this',
  );
  // ... and the three candidate answers really are three different classes, so the assertion above
  // is not passing by coincidence.
  assert.deepEqual(
    await evaluate('[ WriteStreamSpeciesProbe new class == WriteStreamSpeciesTarget ]'),
    booleanValue(false),
  );
  assert.deepEqual(
    await evaluate('[ WriteStreamSpeciesTarget == OrderedCollection ]'),
    booleanValue(false),
  );
});

// THE HONEST BOUNDARY, asserted rather than only described in a comment. Upstream implements
// `species` on Object, so every backing answers it there. This image implements it only on
// Collection, so a non-Collection backing — Array, for one, an ordinary published native class —
// fails visibly instead of quietly answering something wrong. Closing that gap means adding
// `Object >> species`, which no consumer here has asked for.
test('a backing that does not understand species fails visibly rather than guessing', async () => {
  await assert.rejects(
    evaluate('[ (WriteStream on: (Array new: 3)) contents ]'),
    /message not understood: species/,
  );
});

// A fresh answer per call, not a view onto the stream's buffer and not the buffer itself.
test('contents answers a fresh collection each call rather than the backing itself', async () => {
  assert.deepEqual(
    await evaluate(`[ | backing stream |
      backing := OrderedCollection new.
      stream := WriteStream on: backing.
      stream contents == backing ]`),
    booleanValue(false),
    'contents is not the backing collection',
  );
  assert.deepEqual(
    await evaluate(`[ | stream |
      stream := WriteStream on: OrderedCollection new.
      stream contents == stream contents ]`),
    booleanValue(false),
    'two calls answer two collections',
  );
});

// The installer's restored prerequisite is a real guard, not decoration: `contents` answers
// through `Collection >> species`, so installing this class into an image that has no such method
// would produce a class that compiles and then fails on first use. Refused where the cause is
// still visible. Deleting the check makes this test go red.
test('installing without the library method contents depends on is refused', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'bare'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'bare'});
    await assert.rejects(
      installSmalltalkWriteStreamProtocol({
        images: runtime.images, compilation: runtime.compilation, imageId: 'bare', lane: 'wasm',
      }),
      /has no smalltalk\/class\/Collection species method; install the library first/,
    );
    // Refused before anything was written, so the bare image gains no half-installed class.
    assert.equal(await runtime.images.getObject('bare', 'smalltalk/class/WriteStream'), null);
  } finally {
    await runtime.close();
  }
});

// M3 blocker 6 (bead lagrange-images-nv1.8). Execution named exactly one write selector, and this
// is it. Every expectation is the recorded real-Cuis oracle for `nextPutAll:` (transcript on the
// bead), including the one that contradicts common recollection: it answers THE STREAM.
test('nextPutAll: answers the stream, as the oracle records and not the argument', async () => {
  assert.deepEqual(
    await evaluate(`[ | s | s := WriteStream on: OrderedCollection new. (s nextPutAll: 'ab') == s ]`),
    booleanValue(true),
  );
});

// THE SILENT WINDOW THIS SLICE HAD TO CLOSE. Before writes existed, `contents` answering an empty
// species-preserving collection was exactly right. The moment a write can happen it would be a
// SILENT WRONG ANSWER — an empty collection after data was written — and available to any native
// user of WriteStream, not only to the imported JSON path. So it refuses, visibly and by name.
//
// Producing the real answer is the species question bead lagrange-images-nv1.7 owns. This slice
// deliberately does not settle it: the refusal is what turns that gap into executable pressure.
test('contents refuses by name once anything has been written', async () => {
  for (const backing of ['OrderedCollection new', "''"]) {
    await assert.rejects(
      evaluate(`[ | s | s := WriteStream on: ${backing}. s nextPutAll: 'ab'. s contents ]`),
      /unhandled Smalltalk condition: \S*smalltalk\/class\/WriteStreamContentsNeedsSpeciesPreservingResult/,
      `a written ${backing}-backed stream must refuse rather than answer`,
    );
  }
});

// ... and the refusal is a named condition class, not an incidental message-not-understood, so the
// work that closes it has one obvious place to land.
test('the refusal is a distinct named condition class, an ordinary Error subclass', async () => {
  const runtime = await image();
  const conditionClass = objectRef('app', `smalltalk/class/${WRITE_STREAM_CONTENTS_CONDITION}`);
  const behavior = await readBehavior(runtime.images, conditionClass);
  assert.equal(behavior.name.value, WRITE_STREAM_CONTENTS_CONDITION);
  assert.deepEqual(behavior.superclass, objectRef('app', 'smalltalk/class/Error'));
  assert.ok(await resolveGlobal({images: runtime.images, imageId: 'app', name: WRITE_STREAM_CONTENTS_CONDITION}));
});

// REGRESSION GUARD for the case nv1.4 proved. An unwritten stream keeps its oracle-proven answer
// exactly: streaming over a NON-EMPTY collection still answers an EMPTY one of the same species,
// which is what distinguishes `on:` from `with:`. Adding write protocol must not disturb it.
test('an unwritten stream keeps the answer the previous slice proved', async () => {
  assert.deepEqual(
    await evaluate(`[ | backing |
      backing := OrderedCollection new.
      backing add: 1. backing add: 2. backing add: 3.
      (WriteStream on: backing) contents size ]`),
    integerValue(0),
  );
  // An empty write is still a write: this slice refuses rather than pretending it can answer.
  // Upstream answers '' here, and that divergence is deliberate while the species question is open.
  await assert.rejects(
    evaluate(`[ | s | s := WriteStream on: OrderedCollection new. s nextPutAll: OrderedCollection new. s contents ]`),
    /WriteStreamContentsNeedsSpeciesPreservingResult/,
  );
});

// THE ACCUMULATION IS REAL, and this is the only thing that says so. No SELECTOR answers it — the
// enumeration test above pins the protocol to exactly three, which is what keeps bead
// lagrange-images-nv1.7 free to decide what `contents` answers — so the proof reads the stored
// object directly. Without this, `nextPutAll:` could discard its argument entirely and every other
// test here would still pass, which is not a contract worth shipping.
test('nextPutAll: actually retains what it was given, in order', async () => {
  const runtime = await image();
  const {block} = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    imageId: 'app',
    id: `write-stream-retains-${counter += 1}`,
    source: `[ | s | s := WriteStream on: OrderedCollection new. s nextPutAll: 'ab'. s nextPutAll: 'cd'. s ]`,
  });
  const stream = await runtime.executor.execute(await runtime.invocations.invokeBlock(
    objectRef('app', block.id), [],
  ));
  const record = await runtime.images.getObject(stream.imageId, stream.objectId);
  const written = record.slots['write-stream-written'];
  assert.ok(written, 'the stream retains an accumulation slot');
  const accumulation = await runtime.images.getObject(written.imageId, written.objectId);
  // An OrderedCollection holds its elements in a backing Array behind its `contents` slot; the
  // Array is over-allocated, so the writes are the text values in it, in order.
  const backing = accumulation.slots['ordered-collection-contents'];
  const elements = await runtime.images.getObject(backing.imageId, backing.objectId);
  assert.deepEqual(
    Object.values(elements.indexed ?? {}).filter((value) => value?.kind === 'text'),
    [textValue('ab'), textValue('cd')],
  );
});

// Stream REUSE. `on:` resets the accumulation, so a stream written to and then re-`on:`'d answers
// the unwritten answer again rather than refusing — and, more importantly, never answers stale
// content. This is the one place where a mistake would produce the exact lie this slice exists to
// prevent, so it is asserted rather than reasoned about.
test('re-sending on: resets the stream, so it neither refuses nor answers stale content', async () => {
  assert.deepEqual(
    await evaluate(`[ | s |
      s := WriteStream on: OrderedCollection new.
      s nextPutAll: 'ab'.
      s on: OrderedCollection new.
      s contents size ]`),
    integerValue(0),
  );
});
