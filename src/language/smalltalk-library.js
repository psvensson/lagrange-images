import {findSmalltalkBlockProtocol} from './smalltalk-block-protocol.js';
import {findSmalltalkBlockUnwindProtocol} from './smalltalk-conditions.js';
import {resolveGlobal} from './smalltalk-globals.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {ensureNamedClass, ensureSmalltalkShape, methodBlockRef} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {objectRef} from '../value/index.js';

// The first image-resident library: ordinary Smalltalk classes written with the facilities ADRs
// 0043-0050 built, and nothing else. No collection-specific primitive is added here, and none is
// used — every method below is source that the class-scoped compiler binds like any other.
//
// It is a substrate exercise as much as a library. Where an idiom is unavailable the code uses what
// exists rather than reaching for a host operation, and the awkwardness is left visible on purpose:
//
//   no conditions            a refusal is signalled by sending a selector nothing implements, so
//                            an out-of-range access fails as a message-not-understood naming the
//                            collection's own concept rather than raising anything
//
// Three of those gaps are now closed, and the awkwardness went with each. ADR 0051 gave Blocks
// `whileTrue:`/`whileFalse:`, so iteration is a loop rather than recursion under the 256-activation
// limit. ADR 0053 gave Integer `<=`, so a traversal states its bound instead of counting up to
// `tally + 1` and comparing with `=` — and `at:`, `first`, `last` and `removeLast` become possible,
// because each is a bounds check and a bounds check is an ordering question. ADR 0055 gave `^` a
// home, so `includes:` answers from inside its loop instead of carrying a `found` flag out.
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
  // message-not-understood rather than an answer of false.
  {
    selector: '=',
    source: `[ :other |
      (other class = self class)
        ifTrue: [ (key = other key) and: [ value = other value ] ]
        ifFalse: [ false ] ]`,
  },
  // Equal Associations must hash alike (ADR 0048 decision 4). Hashing the key alone satisfies that
  // and is what a Dictionary of Associations wants.
  {selector: 'hash', source: '[ key hash ]'},
];



const ORDERED_COLLECTION_METHODS = [
  {
    selector: 'initialize',
    source: '[ contents := Array new: 4. tally := 0. self ]',
  },
  {selector: 'size', source: '[ tally ]'},
  {selector: 'isEmpty', source: '[ tally = 0 ]'},

  // Growth is a policy of this class, not of storage — exactly as ADR 0047 decision 6 said it would
  // be: an OrderedCollection is an ordinary object holding an Array plus a size and a growth policy.
  {selector: 'add:', source: '[ :item | self ensureRoom. tally := tally + 1. contents at: tally put: item. item ]'},
  {selector: 'ensureRoom', source: '[ (tally = contents size) ifTrue: [ self grow ] ]'},
  {
    selector: 'grow',
    source: `[ | bigger |
      bigger := Array new: (contents size + contents size).
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
  // Answers from inside the loop (ADR 0055). The `found` temporary this used to carry existed only
  // because a Block could not return from its enclosing method; it went with the gap rather than
  // surviving as decoration.
  {
    selector: 'includes:',
    source: `[ :item | | index |
      index := 1.
      [ index <= tally ] whileTrue: [
        (item = (contents at: index)) ifTrue: [ ^ true ] ifFalse: [ false ].
        index := index + 1 ].
      false ]`,
  },
  // ADR 0053's point. Each of these is a bounds check, which is why none existed before an ordering
  // comparison did.
  //
  // The bound is the collection's own `tally`, never the backing Array's capacity: `contents at:`
  // succeeds for any index up to capacity, so a collection that deferred to it would cheerfully
  // answer whatever slack the growth policy left behind.
  //
  // A refusal is an ordinary signal (ADR 0054), so a caller can handle it — which is what makes
  // `at:ifAbsent:` writable in Smalltalk rather than needing a second primitive. Before that ADR
  // this sent `errorIndexOutOfBounds:`, which nothing implemented, so the failure arrived as a
  // message-not-understood that no one could catch.
  {
    selector: 'at:',
    source: `[ :index |
      (index < 1)
        ifTrue: [ (IndexOutOfRange new) signal ]
        ifFalse: [ (index <= tally)
          ifTrue: [ contents at: index ]
          ifFalse: [ (IndexOutOfRange new) signal ] ] ]`,
  },
  // Expressible only because the refusal is catchable: the alternative Block is evaluated by
  // handling the collection's own signal, with no new protocol underneath it.
  {
    selector: 'at:ifAbsent:',
    source: '[ :index :aBlock | [ self at: index ] on: IndexOutOfRange do: [ :e | aBlock value ] ]',
  },
  {selector: 'first', source: '[ self at: 1 ]'},
  {selector: 'last', source: '[ self at: tally ]'},
  // The vacated slot is cleared, not merely hidden. `at:` would refuse to answer it either way, but
  // the backing Array is a durable object: leaving the ref there keeps the removed element
  // graph-reachable, so a large collection drained to empty would retain every element it ever held.
  {
    selector: 'removeLast',
    source: `[ | item |
      (tally < 1)
        ifTrue: [ (EmptyCollection new) signal ]
        ifFalse: [
          item := contents at: tally.
          contents at: tally put: nil.
          tally := tally - 1.
          item ] ]`,
  },
  // Higher-order enumeration, built on `do:` rather than on four more indexed loops. That is the
  // point of the slice: there is now enough language for library protocol to compose library
  // protocol, so these say what they mean and none of them touches `contents` or `tally`.
  //
  // `self class new` is deliberately as far as this goes. Generalising the answer's class properly
  // is `species`, and inventing it here would be recreating the collection hierarchy ahead of
  // needing it.
  {
    selector: 'collect:',
    source: `[ :aBlock | | result |
      result := self class new.
      self do: [ :each | result add: (aBlock value: each) ].
      ^ result ]`,
  },
  {
    selector: 'select:',
    source: `[ :aBlock | | result |
      result := self class new.
      self do: [ :each | (aBlock value: each) ifTrue: [ result add: each ] ].
      ^ result ]`,
  },
  // The `^` originates in a Block that `do:` invokes, and returns from *this* activation through
  // `do:` and its loop — ADR 0055's owner rule doing ordinary library work rather than a contrived
  // test. It is also what makes the search stop: without it the predicate would run to the end.
  {
    selector: 'detect:ifNone:',
    source: `[ :aBlock :noneBlock |
      self do: [ :each | (aBlock value: each) ifTrue: [ ^ each ] ].
      ^ noneBlock value ]`,
  },
  {
    selector: 'inject:into:',
    source: `[ :initial :binaryBlock | | accumulator |
      accumulator := initial.
      self do: [ :each | accumulator := binaryBlock value: accumulator value: each ].
      ^ accumulator ]`,
  },
  {
    selector: 'asArray',
    source: `[ | result |
      result := Array new: tally.
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
  // Restored prerequisites. Every traversal loops, so an image without ADR 0051's Block protocol
  // would install methods that compile cleanly and fail with "Block does not understand:
  // whileFalse:" on first use. Refused here instead, where the cause is still visible.
  if (!await findSmalltalkBlockProtocol({images, imageId})) {
    throw new TypeError(`image ${imageId} has no Smalltalk Block protocol; install it first`);
  }
  // Checked as installed *methods*, not as the presence of the primitive Blocks: the Integer
  // installer publishes its primitives before its methods, so a Block-existence check would pass on
  // a half-installed protocol with `<`, `<=` and `-` still absent.
  for (const selector of ['<', '<=', '-']) {
    if (!await methodBlockRef({images, imageId, classRef: kernel.integerClass, selector})) {
      throw new TypeError(`image ${imageId} has no Integer ${selector} method; install the Integer protocol first`);
    }
  }
  // The unwind protocol object is published *before* the condition classes and their methods, so
  // checking only for it would pass on a half-installed protocol with `Exception >> signal` still
  // missing — the same partial-install hazard the Integer check already closes. Checked as an
  // installed method on a class this library actually signals.
  if (!await findSmalltalkBlockUnwindProtocol({images, imageId})) {
    throw new TypeError(`image ${imageId} has no Smalltalk condition protocol; install it first`);
  }
  const exceptionClass = objectRef(imageId, 'smalltalk/class/Exception');
  if (!await images.getObject(imageId, exceptionClass.objectId)
    || !await methodBlockRef({images, imageId, classRef: exceptionClass, selector: 'signal'})) {
    throw new TypeError(`image ${imageId} has no Exception signal method; install the condition protocol first`);
  }
  for (const name of ['IndexOutOfRange', 'EmptyCollection']) {
    if (!await images.getObject(imageId, `smalltalk/class/${name}`)) {
      throw new TypeError(`image ${imageId} has no ${name} class; install the condition protocol first`);
    }
  }
  // ADR 0057: this library's source names `Array`, `IndexOutOfRange` and `EmptyCollection`, so
  // those globals must have been published. Checked here, where the cause is visible, rather than
  // failing later as an unbound name inside a method body.
  for (const name of ['Array', 'IndexOutOfRange', 'EmptyCollection']) {
    if (!await resolveGlobal({images, imageId, name})) {
      throw new TypeError(`image ${imageId} has not published the global ${name}; publish it first`);
    }
  }

  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: orderedCollectionRef,
    // No captures at all: every class these methods name is resolved through the image's namespace
    // (ADR 0057), so the installer no longer has to know which classes each method mentions.
    methods: ORDERED_COLLECTION_METHODS,
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
