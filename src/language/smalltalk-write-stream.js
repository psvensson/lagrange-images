import {ensureNamedClass, ensureSmalltalkShape, methodBlockRef} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
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
const WRITE_STREAM_SHAPE_ID = 'smalltalk/write-stream-instance-shape/v1';

// `on:` is two-sided here for the reason it is two-sided in Cuis (verified against the pinned
// image: the instance-side `on:` is implemented in `WriteStream` itself, the class-side one in
// `PositionableStream class`). The class-side entry point allocates through the ordinary
// `Class >> new` path and hands off to the instance-side initializer, which is the only writer of
// the instance variable. No third private selector is invented for it.
const WRITE_STREAM_CLASS_METHODS = [
  {selector: 'on:', source: '[ :aCollection | ^ self new on: aCollection ]'},
];

const WRITE_STREAM_METHODS = [
  {selector: 'on:', source: '[ :aCollection | collection := aCollection. ^ self ]'},
  // See the note above: an empty, species-preserving collection is the exact written prefix of a
  // stream that cannot have been written to. `species` is ordinary Collection protocol, so the
  // answer follows the backing rather than being fixed to one representation; a backing that does
  // not understand `species` fails visibly as a message-not-understood naming that selector,
  // which is this repository's usual way of refusing rather than guessing.
  {selector: 'contents', source: '[ ^ collection species new ]'},
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
  const collectionClass = objectRef(imageId, 'smalltalk/class/Collection');
  if (!await images.getObject(imageId, collectionClass.objectId)
    || !await methodBlockRef({images, imageId, classRef: collectionClass, selector: 'species'})) {
    throw new TypeError(`image ${imageId} has no Collection species method; install the library first`);
  }

  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: WRITE_STREAM_SHAPE_ID,
    slots: [{id: 'write-stream-collection', name: 'collection'}],
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
