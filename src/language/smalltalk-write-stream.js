import {ensureNamedClass, ensureSmalltalkShape, methodBlockRef} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel, readBehavior} from './smalltalk-kernel.js';
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
//   WriteStream class >> on:      the stream the source constructs
//   WriteStream       >> contents the answer it takes back out
//
// `nextPut:`, `nextPutAll:`, `with:`, positioning, resets, read streams and byte-stream breadth
// are all real Cuis protocol that this consumer does not exercise here, and are deliberately
// absent. Execution pressure adds them, one proven consumer at a time.
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
// Adding write protocol later MUST revisit this method: the moment a position can be non-zero the
// two stop agreeing, an empty answer becomes wrong, and a real prefix copy is needed along with
// whatever collection protocol that requires. This comment is the handoff.
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
// position and a read limit. This class is a direct subclass of Object with no position, because
// nothing here can move one. That divergence is deliberate and stays true only while the write
// protocol is absent.
// v2: the write protocol added an instance variable, and a Shape record is immutable, so the
// structural change gets a new Shape identity rather than a rewrite (ADR 0047). An image that
// already holds the v1 class gets an explicit definition conflict from the class owner, which is
// the designed outcome — never a silent adoption of a differently-shaped class.
const WRITE_STREAM_SHAPE_ID = 'smalltalk/write-stream-instance-shape/v2';

// The named refusal `contents` raises once something has been written. It exists so the gap is a
// DISTINCT, greppable condition rather than an incidental message-not-understood, and so the work
// that closes it (bead lagrange-images-nv1.7) has one obvious place to land.
const WRITE_STREAM_CONTENTS_CONDITION = 'WriteStreamContentsNeedsSpeciesPreservingResult';

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
  // PROVISIONAL ACCUMULATION, owned by bead lagrange-images-nv1.7's outcome. Upstream accumulates
  // by mutating an indexed backing in place (`collection replaceFrom: position + 1 to: ... with:
  // ... startingAt: 1`). The native path has no equivalent and cannot get one here: the acceptance
  // path's backing is an empty native Text, which is an immutable VALUE, and this image has no text
  // concatenation at all, no `replaceFrom:to:with:startingAt:`, and no mutable String. So the
  // stream must own its accumulation, and the representation below is deliberately INTERNAL and
  // unobservable through any selector this slice adds: nothing answers it, and `contents` refuses
  // rather than exposing it. nv1.7 stays free to decide what `contents` answers and how species is
  // preserved without being boxed in by this choice.
  {
    selector: 'nextPutAll:',
    source: `[ :aCollection |
      written isNil ifTrue: [ written := OrderedCollection new ].
      written add: aCollection.
      ^ self ]`,
  },
  // Unwritten, this is unchanged from the slice that introduced it, and its oracle-proven
  // behaviour must not regress: an empty, species-preserving collection is the exact written prefix
  // of a stream nothing has written to. `species` is ordinary Collection protocol, so the answer
  // follows the backing rather than being fixed to one representation; a backing that does not
  // understand `species` fails visibly, which is this repository's usual way of refusing.
  //
  // WRITTEN, it REFUSES. It must not answer `collection species new` any more, because that would
  // be an EMPTY collection after data had been written — a silent wrong answer available to any
  // native user of WriteStream, not only to the JSON path. Producing the real answer is the
  // species question bead lagrange-images-nv1.7 owns and this slice deliberately does not settle,
  // so the honest behaviour in between is a named, visible refusal.
  {
    selector: 'contents',
    source: `[
      written isNil ifTrue: [ ^ collection species new ].
      ^ ${WRITE_STREAM_CONTENTS_CONDITION} new signal ]`,
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
  // Every method this class's source calls, in the class that must implement it. `species` for the
  // unwritten answer, `add:` for the accumulation, `signal` for the refusal.
  const required = [
    ['smalltalk/class/Collection', 'species'],
    ['smalltalk/class/OrderedCollection', 'add:'],
    ['smalltalk/class/Exception', 'signal'],
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
  for (const name of ['OrderedCollection']) {
    if (!await resolveGlobal({images, imageId, name})) {
      throw new TypeError(`image ${imageId} has not published the global ${name}; publish it first`);
    }
  }

  // The named refusal condition, an ordinary Error subclass. It carries no state and no protocol of
  // its own: its NAME is the whole point, so an unhandled signal reads as the gap it stands for.
  // It reuses its superclass's instance Shape: a condition subclass declares no state of its own,
  // and the class owner's complete-layout rule means it must still carry the inherited one, which
  // is also what makes it instantiable.
  const errorClassRef = objectRef(imageId, 'smalltalk/class/Error');
  const conditionClassRef = (await ensureNamedClass({
    images,
    imageId,
    name: WRITE_STREAM_CONTENTS_CONDITION,
    superclassRef: errorClassRef,
    instanceShapeRef: (await readBehavior(images, errorClassRef)).instanceShape,
  })).classRef;
  await publishSmalltalkClassGlobals({images, imageId, names: [WRITE_STREAM_CONTENTS_CONDITION]});

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

  return Object.freeze({classRef, metaclassRef, contentsConditionClassRef: conditionClassRef});
}

export {
  WRITE_STREAM_CONTENTS_CONDITION,
  WRITE_STREAM_CLASS_METHODS,
  WRITE_STREAM_METHODS,
  WRITE_STREAM_SHAPE_ID,
  installSmalltalkWriteStreamProtocol,
};
