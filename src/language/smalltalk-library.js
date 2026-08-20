import {findSmalltalkBlockProtocol} from './smalltalk-block-protocol.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {ensureNamedClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {objectRef} from '../value/index.js';

// The first image-resident library: ordinary Smalltalk classes written with the facilities ADRs
// 0043-0050 built, and nothing else. No collection-specific primitive is added here, and none is
// used — every method below is source that the class-scoped compiler binds like any other.
//
// It is a substrate exercise as much as a library. Where an idiom is unavailable the code uses what
// exists rather than reaching for a host operation, and the awkwardness is left visible on purpose:
//
//   no false literal         `1 = 2` is how a Boolean false is spelled
//   no `or:` / `not`         a two-part bounds test is written as nested `ifTrue:ifFalse:`
//   no non-local return      a search carries its answer out in a `found` temporary
//   no conditions            a refusal is signalled by sending a selector nothing implements, so
//                            an out-of-range access fails as a message-not-understood naming the
//                            collection's own concept rather than raising anything
//
// Two of those gaps are now closed, and the awkwardness went with them. ADR 0051 gave Blocks
// `whileTrue:`/`whileFalse:`, so iteration is a loop rather than recursion under the 256-activation
// limit. ADR 0053 gave Integer `<=`, so a traversal states its bound instead of counting up to
// `tally + 1` and comparing with `=` — and `at:`, `first`, `last` and `removeLast` become possible,
// because each is a bounds check and a bounds check is an ordering question.
//
// Each of those is a general language gap rather than a collection concern, and each is recorded in
// `docs/roadmap.md` rather than papered over here.

const ASSOCIATION_SHAPE_ID = 'smalltalk/association-instance-shape/v1';
const ORDERED_COLLECTION_SHAPE_ID = 'smalltalk/ordered-collection-instance-shape/v1';

const ASSOCIATION_METHODS = [
  {selector: 'key', source: '[ key ]'},
  {selector: 'value', source: '[ value ]'},
  {selector: 'key:value:', source: '[ :aKey :aValue | key := aKey. value := aValue. self ]'},
  {selector: 'value:', source: '[ :aValue | value := aValue. self ]'},
  // A same-class guard first, because sending `key` to an arbitrary object would be
  // message-not-understood rather than an answer of false. `1 = 2` is a false literal spelled the
  // only way the language currently offers.
  {
    selector: '=',
    source: `[ :other |
      (other class = self class)
        ifTrue: [ (key = other key) ifTrue: [ value = other value ] ifFalse: [ 1 = 2 ] ]
        ifFalse: [ 1 = 2 ] ]`,
  },
  // Equal Associations must hash alike (ADR 0048 decision 4). Hashing the key alone satisfies that
  // and is what a Dictionary of Associations wants.
  {selector: 'hash', source: '[ key hash ]'},
];

// Source has no global namespace, so a class a method needs is an explicit captured ref, declared
// per method that uses it. That is a language gap rather than a collection concern: `Array` is not a
// name the compiler could resolve. A declaration is a binding whether or not the source mentions it,
// so only the methods that need the class declare it.
const ARRAY_CLASS_CAPTURE = Object.freeze({name: 'ArrayClass', id: 'smalltalk/library/array-class'});

const ORDERED_COLLECTION_METHODS = [
  {
    selector: 'initialize',
    source: '[ contents := ArrayClass new: 4. tally := 0. self ]',
    captures: [ARRAY_CLASS_CAPTURE],
  },
  {selector: 'size', source: '[ tally ]'},
  {selector: 'isEmpty', source: '[ tally = 0 ]'},

  // Growth is a policy of this class, not of storage — exactly as ADR 0047 decision 6 said it would
  // be: an OrderedCollection is an ordinary object holding an Array plus a size and a growth policy.
  {selector: 'add:', source: '[ :item | self ensureRoom. tally := tally + 1. contents at: tally put: item. item ]'},
  {selector: 'ensureRoom', source: '[ (tally = contents size) ifTrue: [ self grow ] ]'},
  {
    captures: [ARRAY_CLASS_CAPTURE],
    selector: 'grow',
    source: `[ | bigger |
      bigger := ArrayClass new: (contents size + contents size).
      self copyInto: bigger.
      contents := bigger.
      self ]`,
  },

  // Iteration is a loop (ADR 0051) that states its bound with `<=` (ADR 0053), rather than
  // recursion counting up to `tally + 1` to avoid an ordering comparison that did not exist.
  {
    selector: 'copyInto:',
    source: `[ :target | | index |
      index := 1.
      [ index <= tally ] whileTrue: [
        target at: index put: (contents at: index).
        index := index + 1 ] ]`,
  },
  {
    selector: 'do:',
    source: `[ :aBlock | | index |
      index := 1.
      [ index <= tally ] whileTrue: [
        aBlock value: (contents at: index).
        index := index + 1 ] ]`,
  },
  // `found` still carries the answer out of the loop, because a Block has no non-local return. That
  // gap is unchanged by ADR 0053 and remains the next one this style of code runs into.
  {
    selector: 'includes:',
    source: `[ :item | | index found |
      index := 1. found := 1 = 2.
      [ found ifTrue: [ 1 = 2 ] ifFalse: [ index <= tally ] ]
        whileTrue: [
          (item = (contents at: index)) ifTrue: [ found := 1 = 1 ] ifFalse: [ 1 = 2 ].
          index := index + 1 ].
      found ]`,
  },
  // ADR 0053's point. Each of these is a bounds check, which is why none existed before an ordering
  // comparison did.
  //
  // The bound is the collection's own `tally`, never the backing Array's capacity: `contents at:`
  // succeeds for any index up to capacity, so a collection that deferred to it would cheerfully
  // answer whatever slack the growth policy left behind.
  //
  // Refusal is where the language is still missing something. There is no way to raise a condition,
  // so an out-of-range access sends a selector nothing implements: the failure is a
  // message-not-understood naming `errorIndexOutOfBounds:`, which at least names the collection's
  // own concept rather than surfacing an Array error about a different object. Recorded in
  // `docs/roadmap.md` rather than papered over with a collection-shaped primitive.
  {
    selector: 'at:',
    source: `[ :index |
      (index < 1)
        ifTrue: [ self errorIndexOutOfBounds: index ]
        ifFalse: [ (index <= tally)
          ifTrue: [ contents at: index ]
          ifFalse: [ self errorIndexOutOfBounds: index ] ] ]`,
  },
  {selector: 'first', source: '[ self at: 1 ]'},
  {selector: 'last', source: '[ self at: tally ]'},
  {
    selector: 'removeLast',
    source: `[ | item |
      (tally < 1)
        ifTrue: [ self errorEmptyCollection ]
        ifFalse: [ item := contents at: tally. tally := tally - 1. item ] ]`,
  },
  {
    captures: [ARRAY_CLASS_CAPTURE],
    selector: 'asArray',
    source: `[ | result |
      result := ArrayClass new: tally.
      self copyInto: result.
      result ]`,
  },
];

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

// Both go through the shared ensure-exact-or-create helpers. Accepting *any* record at a
// deterministic id would adopt an unrelated object as this class or its layout — the rule the
// repository applies to every derived id, and the reason `defineClass` alone is not enough for
// rediscovery once methods exist.
async function ensureLibraryClass({images, imageId, name, shapeId, slots}) {
  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {id: shapeId, slots});
  return (await ensureNamedClass({images, imageId, name, instanceShapeRef})).classRef;
}

// Installed after the kernel protocols this library is written against: allocation (ADR 0046),
// conditionals (0045), Array (0047), equality (0048) and instance variables (0050).
async function installSmalltalkLibrary({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  const associationRef = await ensureLibraryClass({
    images,
    imageId,
    name: 'Association',
    shapeId: ASSOCIATION_SHAPE_ID,
    slots: [{id: 'association-key', name: 'key'}, {id: 'association-value', name: 'value'}],
  });
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: associationRef, methods: ASSOCIATION_METHODS,
  });

  const orderedCollectionRef = await ensureLibraryClass({
    images,
    imageId,
    name: 'OrderedCollection',
    shapeId: ORDERED_COLLECTION_SHAPE_ID,
    slots: [
      {id: 'ordered-collection-contents', name: 'contents'},
      {id: 'ordered-collection-tally', name: 'tally'},
    ],
  });
  const arrayClassRef = objectRef(imageId, 'smalltalk/class/Array');
  if (!await images.getObject(imageId, arrayClassRef.objectId)) {
    throw new TypeError(`image ${imageId} has no Array class; install the indexed protocol first`);
  }
  // Every traversal below loops, so an image without ADR 0051's Block protocol would install
  // methods that compile cleanly and then fail with "Block does not understand: whileFalse:" on
  // first use. Refused here instead, where the cause is still visible.
  if (!await findSmalltalkBlockProtocol({images, imageId})) {
    throw new TypeError(`image ${imageId} has no Smalltalk Block protocol; install it first`);
  }
  // Every traversal states its bound with `<=` and every bounds check uses `<`, so an image without
  // ADR 0053's Integer protocol would install methods that compile cleanly and fail on first use.
  if (!await images.getBlock(imageId, 'smalltalk/primitive/integer-less-than')) {
    throw new TypeError(`image ${imageId} has no Integer ordering protocol; install it first`);
  }
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: orderedCollectionRef,
    methods: ORDERED_COLLECTION_METHODS.map((method) => (method.captures
      ? {...method, captures: method.captures.map((capture) => ({...capture, value: arrayClassRef}))}
      : method)),
  });

  return Object.freeze({association: associationRef, orderedCollection: orderedCollectionRef});
}

export {
  ASSOCIATION_METHODS,
  ASSOCIATION_SHAPE_ID,
  ORDERED_COLLECTION_METHODS,
  ORDERED_COLLECTION_SHAPE_ID,
  installSmalltalkLibrary,
};
