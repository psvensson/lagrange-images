import {ensureNamedClass, ensureSmalltalkShape, methodBlockRef} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {resolveGlobal} from './smalltalk-globals.js';
import {objectRef} from '../value/index.js';
import {SMALLTALK_PRIMITIVE} from './smalltalk-primitives.js';
import {SMALLTALK_TEXT_CODEC_PRIMITIVE_BLOCK_ID} from './smalltalk-text-bytearray.js';

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
//   WriteStream       >> nextPutAll:  chunk write (bead lagrange-images-nv1.8)
//   WriteStream       >> nextPut:     Character element write (bead lagrange-images-xxm.14)
//   WriteStream       >> reset        reuse the same stream for a new written prefix (p6u)
//   WriteStream       >> contents     the answer it takes back out
//   Text class        >> streamContents:  evaluate one producer Block through that stream owner
//
// `with:`, arbitrary positioning and byte-stream breadth remain absent. Execution
// pressure adds protocol one proven consumer at a time. `nextPut:` is now earned by unchanged YAXO
// XMLTokenizer>>nextWhitespace after its preceding Character classification became executable.
// `Text class >> streamContents:` is ordinary native Text protocol: the Cuis importer owns only
// the exact foreign receiver-name adaptation that reaches it.
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
// WHY `contents` IS WHAT IT IS. Upstream answers a PREFIX COPY, and its class preservation is a
// consequence of `copyFrom:to:` being class-preserving rather than of any explicit species send.
// That is the shape this class now follows: build the answer, preserving the backing's class.
//
// That handoff has since been taken, and taken further than the note expected: `contents` no longer
// asks the backing to build anything. It constructs the answer itself, preserving the backing's
// class, which is what upstream's copy does. See `contents` below.
//
// KNOWN DIVERGENCE, asserted by a test rather than only described here. Cuis implements `species`
// on OBJECT, so upstream every backing answers it. This image implements `species` only on
// COLLECTION. That no longer limits the two backings that matter — a text backing is built without
// `species` at all, and a Collection answers it — but any OTHER backing (Array, Dictionary, Symbol,
// ByteArray) still fails visibly with a message-not-understood naming `species`. Adding
// `Object >> species` would close that, and would match upstream, but it would not have made a
// text backing work (`Text new` is not instantiable) and no consumer streams over the others, so
// it stays out as breadth this milestone forbids.
//
// NOT MODELLED. Cuis puts WriteStream under `PositionableStream`, and its `on:` also resets a
// position and a read limit. This class is a direct subclass of Object and models no position:
// writes append and `contents` consumes the current accumulation. The measured `reset` operation
// starts a new written prefix by clearing that accumulation, preserving the stream and backing.
// Arbitrary positioning or reading this stream would require a broader state model; neither is
// part of the currently forced protocol.

// v2: the chunk-write protocol added an instance variable, and a Shape record is immutable, so the
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

// The class is captured directly because this method is installed in the same transaction-shaped
// owner that first creates WriteStream, before the standard-image composition root publishes the
// class as a global. This is dependency injection, not a second stream implementation: every bit
// of allocation, accumulation and result construction is still sent to the one WriteStream owner.
const TEXT_STREAM_WRITE_STREAM_CAPTURE = Object.freeze({
  name: 'NativeWriteStream',
  id: 'smalltalk/text-stream/write-stream-class',
});

const WRITE_STREAM_SCALAR_CODEC_CAPTURE = Object.freeze({
  name: 'UnicodeScalarUtf8Bytes',
  id: SMALLTALK_TEXT_CODEC_PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.UNICODE_SCALAR_UTF8_BYTES],
});

const TEXT_STREAM_CLASS_METHODS = Object.freeze([Object.freeze({
  selector: 'streamContents:',
  source: `[ :aBlock | | stream |
    stream := NativeWriteStream on: ''.
    aBlock value: stream.
    ^ stream contents ]`,
})]);

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
  // part of what it promises. Each entry carries a private Boolean tag so the one state retains
  // whether the caller wrote a collection chunk or one stream element; it is not a second channel.
  {
    selector: 'nextPutAll:',
    source: `[ :aCollection |
      written isNil ifTrue: [ written := OrderedCollection new ].
      written add: (Association new key: false value: aCollection).
      ^ self ]`,
  },
  // The pinned UnicodeString stream is Utf8EncodedWriteStream and its nextPut: implicitly answers
  // self. Keep the Character itself in the SAME ordered accumulation as chunk writes; conversion
  // belongs to the one contents constructor below, not to a second channel or nextPutAll: alias.
  {
    selector: 'nextPut:',
    source: `[ :anObject |
      written isNil ifTrue: [ written := OrderedCollection new ].
      written add: (Association new key: true value: anObject).
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
  //   a text backing   the accumulated chunks/elements' bytes, through the existing
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
          written do: [ :entry | | chunkBytes index |
            entry key ifTrue: [
              chunkBytes := UnicodeScalarUtf8Bytes value: entry value codePoint ].
            entry key ifFalse: [ chunkBytes := entry value utf8Bytes ].
            index := 1.
            [ index <= chunkBytes size ] whileTrue: [
              bytes add: (chunkBytes at: index).
              index := index + 1 ] ] ].
        ^ (ByteArray fromArray: bytes asArray) utf8Text ].
      result := collection species new.
      written isNil ifFalse: [
        written do: [ :entry | entry value do: [ :each | result add: each ] ] ].
      ^ result ]`,
    captures: [WRITE_STREAM_SCALAR_CODEC_CAPTURE],
  },
  // Pinned UnicodeString writeStream reset answers self and empty contents. With only append,
  // contents and reset exposed, forgetting the written prefix preserves that exact behavior.
  {selector: 'reset', source: '[ written := nil. ^ self ]'},
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
  // use — `ByteArray` in particular is a KERNEL class whose global the namespace publishes
  // unconditionally, so a global check alone passes on an image that never ran the byte-sequence
  // protocol. `isNil`, `ifTrue:` and `ifFalse:` each need BOTH halves, since the receiver may be
  // either.
  const required = [
    ['smalltalk/class/Collection', 'species'],
    ['smalltalk/class/OrderedCollection', 'add:'],
    ['smalltalk/class/Association', 'key'],
    ['smalltalk/class/Association', 'value'],
    ['smalltalk/class/Association', 'key:value:'],
    ['smalltalk/class/Text', 'utf8Bytes'],
    ['smalltalk/class/Character', 'codePoint'],
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
    ['smalltalk/class/True', 'ifFalse:'],
    ['smalltalk/class/False', 'ifFalse:'],
    ['smalltalk/class/Object', 'class'],
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
  for (const name of ['Association', 'OrderedCollection', 'Text', 'ByteArray']) {
    if (!await resolveGlobal({images, imageId, name})) {
      throw new TypeError(`image ${imageId} has not published the global ${name}; publish it first`);
    }
  }

  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: WRITE_STREAM_SHAPE_ID,
    slots: [
      {id: 'write-stream-collection', name: 'collection'},
      // Internal, and exposed by no selector: see the note on `nextPutAll:`.
      {id: 'write-stream-written', name: 'written'},
    ],
  });
  const {classRef, metaclassRef} = await ensureNamedClass({
    images, imageId, name: 'WriteStream', superclassRef: null, instanceShapeRef,
  });


  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef,
    methods: WRITE_STREAM_METHODS.map((method) => ({
      ...method,
      captures: method.captures?.map((capture) => ({
        ...capture,
        value: objectRef(imageId, capture.id),
      })),
    })),
  });
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: metaclassRef, methods: WRITE_STREAM_CLASS_METHODS,
  });
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/metaclass/Text'),
    methods: TEXT_STREAM_CLASS_METHODS.map((method) => ({
      ...method,
      captures: [{...TEXT_STREAM_WRITE_STREAM_CAPTURE, value: classRef}],
    })),
  });

  return Object.freeze({classRef, metaclassRef});
}

export {
  WRITE_STREAM_CLASS_METHODS,
  WRITE_STREAM_METHODS,
  WRITE_STREAM_SHAPE_ID,
  installSmalltalkWriteStreamProtocol,
};
