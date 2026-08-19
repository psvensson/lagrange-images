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
//   no ordering comparison   loops count *up* and stop on `=`, never `<=`
//   no false literal         `1 = 2` is how a Boolean false is spelled
//   no `whileTrue:`          iteration is ordinary recursion through a helper selector
//   no conditions            operations that would raise a range error are omitted, not faked
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
      self copyInto: bigger index: 1.
      contents := bigger.
      self ]`,
  },

  // Iteration is recursion because there is no loop construct: a Block cannot answer `whileTrue:`,
  // since ADR 0044 decision 11 gives Blocks only `value`. Counting *up* and stopping on `=` avoids
  // the ordering comparison Integer does not have.
  {
    selector: 'copyInto:index:',
    source: `[ :target :index |
      (index = (tally + 1))
        ifFalse: [ target at: index put: (contents at: index). self copyInto: target index: (index + 1) ] ]`,
  },
  {selector: 'do:', source: '[ :aBlock | self do: aBlock index: 1 ]'},
  {
    selector: 'do:index:',
    source: `[ :aBlock :index |
      (index = (tally + 1))
        ifFalse: [ aBlock value: (contents at: index). self do: aBlock index: (index + 1) ] ]`,
  },
  {selector: 'includes:', source: '[ :item | self includes: item index: 1 ]'},
  {
    selector: 'includes:index:',
    source: `[ :item :index |
      (index = (tally + 1))
        ifTrue: [ 1 = 2 ]
        ifFalse: [ (item = (contents at: index))
          ifTrue: [ 1 = 1 ]
          ifFalse: [ self includes: item index: (index + 1) ] ] ]`,
  },
  {
    captures: [ARRAY_CLASS_CAPTURE],
    selector: 'asArray',
    source: `[ | result |
      result := ArrayClass new: tally.
      self copyInto: result index: 1.
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
