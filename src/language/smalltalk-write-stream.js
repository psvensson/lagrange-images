import {ensureNamedClass, ensureSmalltalkShape, methodBlockRef} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {publishSmalltalkClassGlobals, resolveGlobal} from './smalltalk-globals.js';
import {objectRef} from '../value/index.js';

// A native `WriteStream`, added because a real imported consumer names it: the pinned upstream
// Cuis JSON package opens `Json class>>render:` with `WriteStream on: String new` and closes it
// with `contents`, and the native compiler answered `unbound Symmetric Smalltalk name: WriteStream`
// (bead lagrange-images-nv1.4). This is an ordinary native Smalltalk class published as an
// ordinary global, usable by any native code — NOT a Cuis compatibility class. The Cuis import
// adapter knows nothing about the name: it resolves here the same way `Array` or `Dictionary`
// does, through the image's global namespace at compile time.
//
// SCOPE. Exactly the protocol the acceptance path sends, and nothing else:
//
//   WriteStream class >> on:          the stream the source constructs
//   WriteStream       >> nextPutAll:  the one write EXECUTION named (bead lagrange-images-nv1.8)
//   WriteStream       >> contents     the answer it takes back out
//
// `nextPut:`, `with:`, positioning, resets, read streams and byte-stream breadth are all real Cuis
// protocol that this consumer does not exercise, and are deliberately absent. Execution pressure
// adds them, one proven consumer at a time — `nextPutAll:` is here because it did exactly that.
//
// RECORDED REAL-CUIS ORACLE (pinned VM + Cuis7.9-8090 image, probed directly; the full transcript
// is on bead lagrange-images-nv1.4). These are measurements, not Squeak/Pharo recollection:
//
//   (WriteStream on: 'hello') contents  =  ''        `on:` positions at the BEGINNING and
//   (WriteStream with: 'hello') contents = 'hello'   DISCARDS existing content. It is not append;
//                                                    append is `with:`, a selector nothing here
//                                                    needs. A probe using an EMPTY argument cannot
//                                                    tell the two apart, which is why the oracle
//                                                    was rerun with a non-empty one.
//   contents preserves the backing SPECIES           String -> String, Array -> Array,
//                                                    OrderedCollection -> OrderedCollection.
//   contents answers a FRESH COPY every call         not identical to the backing, not identical
//                                                    across two calls, equal across two calls.
//   contents is the WRITTEN PREFIX only              after one write over a 5-element backing it
//                                                    answers 1 element.
//
// and the upstream source itself, read out of the pinned image rather than paraphrased:
//
//   contents   readLimit := readLimit max: position.
//              ^ (collection copyFrom: 1 to: position) asStreamResult.
//   on: arg1   super on: arg1 thatCanBeModified. readLimit := 0. writeLimit := arg1 size.
//
// WHY `contents` IS WHAT IT IS. Upstream answers a PREFIX COPY, and its species preservation is a
// consequence of `copyFrom:to:` being class-preserving rather than of any explicit species send.
// The written prefix of a stream with no write protocol is empty, always — so on the whole domain
// this class can currently reach, `copyFrom: 1 to: 0` and `collection species new` agree exactly.
// This is not an approximation that happens to pass; it is the same answer.
//
// That handoff has since been taken: write protocol exists, so `contents` no longer answers that
// unconditionally. Unwritten it still does, exactly as above; written it REFUSES, because an empty
// answer after data was written would be wrong. See `contents` below.
//
// KNOWN DIVERGENCE, asserted by a test rather than only described here. Cuis implements `species`
// on OBJECT, so upstream every backing answers it and an Array-backed stream answers an Array.
// This image implements `species` only on COLLECTION: Array and Dictionary are direct Object
// subclasses, and Text/ByteArray/Symbol are Values dispatching through kernel classes, so none of
// them answers it. `contents` therefore works for a Collection backing and fails visibly — a
// message-not-understood naming `species` — for anything else. Adding `Object >> species` would
// close that gap and would match upstream, but no consumer here streams over a non-Collection
// backing, and pre-adding kernel protocol for a case nothing exercises is the breadth this
// milestone forbids. It becomes legitimate when a real consumer needs it.
//
// NOT MODELLED. Cuis puts WriteStream under `PositionableStream`, and its `on:` also resets a
// position and a read limit. This class is a direct subclass of Object and models no position.
// Writes exist now, so the earlier justification ("nothing here can move a position") has expired
// and is replaced by a narrower one: nothing READS a position. No selector exposes one, `contents`
// refuses rather than computing a prefix, and the accumulation below is append-only. A position
// becomes necessary when something needs the written prefix — which is bead lagrange-images-nv1.7.

// v2: the write protocol added an instance variable, and a Shape record is immutable, so the
// structural change gets a new Shape identity rather than a rewrite (ADR 0047). An image that
// already holds the v1 class gets an explicit definition conflict from the class owner, which is
// the designed outcome — never a silent adoption of a differently-shaped class.
const WRITE_STREAM_SHAPE_ID = 'smalltalk/write-stream-instance-shape/v2';

// RETIRED: `WriteStreamContentsNeedsSpeciesPreservingResult`. The previous slice signalled that
// named condition once anything had been written, because `contents` could not then produce a
// result and answering an empty collection would have been a silent wrong answer. `contents` now
// produces the result, so the condition is unreachable and is gone rather than left as a class
// nothing can raise. Its NAME was never a decision about the repair, and the repair it named is
// not the one that was taken.

// `on:` is two-sided here for the reason it is two-sided in Cuis (verified against the pinned
// image: the instance-side `on:` is implemented in `WriteStream` itself, the class-side one in
// `PositionableStream class`). The class-side entry point allocates through the ordinary
// `Class >> new` path and hands off to the instance-side initializer, which is the only writer of
// the instance variable. No third private selector is invented for it.
const WRITE_STREAM_CLASS_METHODS = [
  {selector: 'on:', source: '[ :aCollection | ^ self new on: aCollection ]'},
];

const WRITE_STREAM_METHODS = [
  {selector: 'on:', source: '[ :aCollection | collection := aCollection. written := nil. ^ self ]'},
  // The one write selector execution actually named. It answers the STREAM, which is what upstream
  // does — measured, because the widespread Squeak/Pharo recollection is that `nextPutAll:` answers
  // its argument, and the pinned image shows otherwise (`answerIsStream=true`).
  //
  // THE ACCUMULATION. Upstream accumulates by mutating an indexed backing in place
  // (`collection replaceFrom: position + 1 to: ... with: ... startingAt: 1`). The native path has
  // no equivalent: the acceptance path's backing is an empty native Text, which is an immutable
  // VALUE, and this image has no text concatenation, no `replaceFrom:to:with:startingAt:` and no
  // mutable String. So the stream owns what it was given, in order, and `contents` builds the
  // answer from it. Still exposed by no selector — the accumulation is how the stream works, not
  // part of what it promises.
  {
    selector: 'nextPutAll:',
    source: `[ :aCollection |
      written isNil ifTrue: [ written := OrderedCollection new ].
      written add: aCollection.
      ^ self ]`,
  },
  // THE ANSWER, built here rather than asked of the backing (bead lagrange-images-nv1.7).
  //
  // This REMOVES AN INCORRECT MECHANISM rather than working around a missing one, and that is the
  // part worth reading. Upstream `contents` is
  //
  //     ^ (collection copyFrom: 1 to: position) asStreamResult
  //
  // measured out of the pinned image — a CLASS-PRESERVING COPY of the written prefix. It never
  // sends `species` at all. The earlier `collection species new` was a stand-in that was never a
  // transcription of upstream: it happened to work only because `Collection >> species` exists,
  // and it could never have worked for the acceptance path, because `Text new` raises
  // SmalltalkNotInstantiableError — a Text is a Value, not an allocatable object. Adding
  // `Object >> species` would not have fixed that; it would have turned one visible failure into
  // another. So the stream constructs the result itself, preserving the backing's CLASS exactly as
  // the upstream copy does.
  //
  // Two constructions, because this image has two kinds of backing and they are built differently:
  //   a text backing   the accumulated chunks' bytes, through the existing
  //                    `utf8Bytes` -> `ByteArray class >> fromArray:` -> `ByteArray >> utf8Text`
  //                    conversion that `Integer >> printOn:base:` already uses. Nothing is added to
  //                    Text, which stays an immutable Value with exactly the protocol it had.
  //   a collection     `species new` filled from the chunks' elements. That is the ordinary
  //                    Collection rule, already installed, and it is correct here because a
  //                    Collection IS allocatable.
  // Any other backing fails visibly on `species`, as before.
  //
  // ON SEED SPECIES, stated rather than papered over: upstream distinguishes a String-seeded from a
  // UnicodeString-seeded stream, and the result follows the seed (measured:
  // `unicodeSeedResultClass=UnicodeString` with the same textual value). This image has exactly ONE
  // textual class — `Text` IS the text Value — so that distinction has no native counterpart to
  // lose. What the native rule preserves is the only textual class there is, and a text-backed
  // stream answers a Text. If a second native textual representation ever exists, this method is
  // where the distinction has to be made, and it will need more than `class == Text`.
  //
  // An EMPTY accumulation is not a special case: zero chunks contribute zero elements, so an
  // unwritten stream answers an empty result of the backing's class, which is what nv1.4 proved.
  // An EMPTY WRITE contributes nothing either, so it answers empty too — which is exactly
  // upstream, where `nextPutAll: ''` leaves `position` at 0 and `contents` answers ''. The
  // call-based divergence the previous slice knowingly carried is gone.
  {
    selector: 'contents',
    source: `[ | bytes result |
      collection class == Text ifTrue: [
        bytes := OrderedCollection new.
        written isNil ifFalse: [
          written do: [ :chunk | | chunkBytes index |
            chunkBytes := chunk utf8Bytes.
            index := 1.
            [ index <= chunkBytes size ] whileTrue: [
              bytes add: (chunkBytes at: index).
              index := index + 1 ] ] ].
        ^ (ByteArray fromArray: bytes asArray) utf8Text ].
      result := collection species new.
      written isNil ifFalse: [
        written do: [ :chunk | chunk do: [ :each | result add: each ] ] ].
      ^ result ]`,
  },
];

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

async function installSmalltalkWriteStreamProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  // Restored prerequisite, checked where the cause is still visible rather than as a
  // doesNotUnderstand inside a method body later. `contents` answers through `species`, which this
  // image installs on Collection, so what must exist is that installed METHOD — not the Collection
  // global. Checking the global would be both too weak and too strong: a Collection class whose
  // methods are not yet defined would pass it, and an image with the library fully installed but
  // Collection unpublished would fail it although `species` works there perfectly well. This is
  // the same read-the-installed-method rule `smalltalk-library.js` applies to its own
  // prerequisites, and for the same stated reason.
  // Existence first, then the method: `methodBlockRef` reads a Behavior, so asking it about a
  // class that was never defined raises `behavior not found` rather than answering "absent".
  // This is the exact two-step `smalltalk-library.js` uses for its own `Exception >> signal` check.
  // Every method this class's source calls, in the class that must implement it. Checked as
  // installed METHODS rather than as class or global existence, because publication says nothing
  // about protocol and a half-installed image would otherwise compile cleanly and fail on first
  // use. `isNil` needs BOTH halves: with only the `Object` one, `written isNil` answers false on a
  // fresh stream and `contents` would refuse a stream nothing had written to.
  const required = [
    ['smalltalk/class/Collection', 'species'],
    ['smalltalk/class/OrderedCollection', 'add:'],
    ['smalltalk/class/Text', 'utf8Bytes'],
    ['smalltalk/class/ByteArray', 'utf8Text'],
    ['smalltalk/class/ByteArray', 'size'],
    ['smalltalk/class/ByteArray', 'at:'],
    ['smalltalk/metaclass/ByteArray', 'fromArray:'],
    ['smalltalk/class/OrderedCollection', 'do:'],
    ['smalltalk/class/OrderedCollection', 'asArray'],
    ['smalltalk/class/Object', 'isNil'],
    ['smalltalk/class/UndefinedObject', 'isNil'],
    ['smalltalk/class/True', 'ifTrue:'],
    ['smalltalk/class/False', 'ifTrue:'],
    ['smalltalk/class/Class', 'new'],
  ];
  for (const [objectId, selector] of required) {
    const classRef = objectRef(imageId, objectId);
    if (!await images.getObject(imageId, objectId)
      || !await methodBlockRef({images, imageId, classRef, selector})) {
      throw new TypeError(`image ${imageId} has no ${objectId} ${selector} method; install the library first`);
    }
  }
  // The source also NAMES these globals, which is a compile-time requirement distinct from the
  // protocol above.
  for (const name of ['OrderedCollection', 'Text', 'ByteArray']) {
    if (!await resolveGlobal({images, imageId, name})) {
      throw new TypeError(`image ${imageId} has not published the global ${name}; publish it first`);
    }
  }

  // The named refusal condition, an ordinary Error subclass. It carries no state and no protocol of
  // its own: its NAME is the whole point, so an unhandled signal reads as the gap it stands for.
  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: WRITE_STREAM_SHAPE_ID,
    slots: [
      {id: 'write-stream-collection', name: 'collection'},
      // Provisional, internal, unobservable: see the note on `nextPutAll:`.
      {id: 'write-stream-written', name: 'written'},
    ],
  });
  const {classRef, metaclassRef} = await ensureNamedClass({
    images, imageId, name: 'WriteStream', superclassRef: null, instanceShapeRef,
  });


  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef, methods: WRITE_STREAM_METHODS,
  });
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: metaclassRef, methods: WRITE_STREAM_CLASS_METHODS,
  });

  return Object.freeze({classRef, metaclassRef});
}

export {
  WRITE_STREAM_CLASS_METHODS,
  WRITE_STREAM_METHODS,
  WRITE_STREAM_SHAPE_ID,
  installSmalltalkWriteStreamProtocol,
};
