import {assertMethodLane, ensureNamedClass, ensureSmalltalkShape, methodBlockRef} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {resolveGlobal} from './smalltalk-globals.js';
import {objectRef} from '../value/index.js';

// Construction forced by the M4 parser input. Cursor/read protocols are added only when
// native execution reaches them. Instances and initialization are ordinary image objects/code.
const READ_STREAM_SHAPE_ID = 'smalltalk/read-stream-instance-shape/v1';
const READ_STREAM_METHODS = Object.freeze([
  {selector: 'on:', source: '[ :aCollection | collection := aCollection. readLimit := aCollection size. position := 0. ^ self ]'},
  {selector: 'atEnd', source: '[ ^ position >= readLimit ]'},
  {selector: 'next', source: '[ ^ position >= readLimit ifFalse: [collection at: (position := position + 1)] ]'},
]);
const READ_STREAM_CLASS_METHODS = Object.freeze([
  {selector: 'on:', source: '[ :aCollection | ^ self basicNew on: aCollection ]'},
]);

async function installSmalltalkReadStreamProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  if (!images || typeof images.getObject !== 'function') throw new TypeError('images service is required');
  assertMethodLane(lane);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  for (const [classRef, selector] of [
    [kernel.classClass, 'basicNew'], [kernel.textClass, 'size'], [kernel.textClass, 'at:'],
    [kernel.integerClass, '>='], [kernel.integerClass, '+'],
    [objectRef(imageId, 'smalltalk/class/True'), 'ifFalse:'],
    [objectRef(imageId, 'smalltalk/class/False'), 'ifFalse:'],
  ]) {
    if (!await methodBlockRef({images, imageId, classRef, selector})) {
      throw new TypeError(`image ${imageId} has no ${classRef.objectId} ${selector} method`);
    }
  }
  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: READ_STREAM_SHAPE_ID,
    slots: [
      {id: 'read-stream-collection', name: 'collection'},
      {id: 'read-stream-position', name: 'position'},
      {id: 'read-stream-limit', name: 'readLimit'},
    ],
  });
  const {classRef, metaclassRef} = await ensureNamedClass({
    images, imageId, name: 'ReadStream', superclassRef: kernel.objectClass, instanceShapeRef,
  });
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef, methods: READ_STREAM_METHODS});
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef: metaclassRef, methods: READ_STREAM_CLASS_METHODS});
  return Object.freeze({classRef, metaclassRef});
}

// Namespace publication precedes this source: resolve ReadStream through its GlobalBinding,
// preserving the namespace owner's rebinding semantics rather than capturing a Class object.
async function installSmalltalkTextReadStreamProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  if (!await resolveGlobal({images, imageId, name: 'ReadStream'})) {
    throw new TypeError(`image ${imageId} has not published the global ReadStream`);
  }
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: objectRef(imageId, 'smalltalk/class/Text'),
    methods: [{selector: 'readStream', source: '[ ^ ReadStream on: self ]'}],
  });
}

const READ_STREAM_BREADTH_METHODS = Object.freeze([
  {selector: 'peek', source: '[ ^ position >= readLimit ifFalse: [ collection at: position + 1 ] ]'},
  {selector: 'position', source: '[ ^ position ]'},
  {selector: 'position:', source: '[ :anInteger | position := anInteger. ^ self ]'},
  {selector: 'reset', source: '[ position := 0. ^ self ]'},
  {selector: 'size', source: '[ ^ readLimit ]'},
  {selector: 'contents', source: '[ ^ collection ]'},
  {
    selector: 'next:',
    source: `[ :anInteger | | count out bytes |
      collection class == Text ifTrue: [
        out := WriteStream on: ''.
        count := 0.
        [ count < anInteger and: [ position < readLimit ] ] whileTrue: [
          out nextPut: self next.
          count := count + 1 ].
        ^ out contents ].
      bytes := OrderedCollection new.
      count := 0.
      [ count < anInteger and: [ position < readLimit ] ] whileTrue: [
        bytes add: self next.
        count := count + 1 ].
      collection class == ByteArray ifTrue: [ ^ ByteArray fromArray: bytes asArray ].
      collection class == Array ifTrue: [ ^ bytes asArray ].
      ^ bytes ]`,
  },
  {selector: 'upToEnd', source: '[ ^ self next: readLimit - position ]'},
  {
    selector: 'upTo:',
    source: `[ :anObject | | out bytes elem done |
      collection class == Text ifTrue: [
        out := WriteStream on: ''.
        done := false.
        [ done not and: [ position < readLimit ] ] whileTrue: [
          elem := self next.
          elem = anObject ifTrue: [ done := true ] ifFalse: [ out nextPut: elem ] ].
        ^ out contents ].
      bytes := OrderedCollection new.
      done := false.
      [ done not and: [ position < readLimit ] ] whileTrue: [
        elem := self next.
        elem = anObject ifTrue: [ done := true ] ifFalse: [ bytes add: elem ] ].
      collection class == ByteArray ifTrue: [ ^ ByteArray fromArray: bytes asArray ].
      collection class == Array ifTrue: [ ^ bytes asArray ].
      ^ bytes ]`,
  },
]);

const BYTE_ARRAY_STREAM_METHODS = Object.freeze([
  {selector: 'readStream', source: '[ ^ ReadStream on: self ]'},
  {selector: 'writeStream', source: '[ ^ WriteStream on: self ]'},
  {selector: 'asByteArray', source: '[ ^ self ]'},
  {selector: 'isEmpty', source: '[ ^ self size = 0 ]'},
  {
    selector: 'asArray',
    source: `[ | result index |
      result := Array new: self size.
      index := 1.
      [ index <= self size ] whileTrue: [
        result at: index put: (self at: index).
        index := index + 1 ].
      ^ result ]`,
  },
  {
    selector: 'do:',
    source: `[ :aBlock | | index |
      index := 1.
      [ index <= self size ] whileTrue: [
        aBlock value: (self at: index).
        index := index + 1 ].
      ^ self ]`,
  },
  {
    selector: 'collect:',
    source: `[ :aBlock | | result index |
      result := Array new: self size.
      index := 1.
      [ index <= self size ] whileTrue: [
        result at: index put: (aBlock value: (self at: index)).
        index := index + 1 ].
      ^ ByteArray fromArray: result ]`,
  },
]);

const BYTE_ARRAY_CLASS_STREAM_METHODS = Object.freeze([
  {selector: 'new', source: '[ ^ #[] ]'},
  {
    selector: 'streamContents:',
    source: `[ :aBlock | | stream |
      stream := WriteStream on: #[].
      aBlock value: stream.
      ^ stream contents ]`,
  },
]);

async function installSmalltalkStreamBreadthProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  if (!images || typeof images.getObject !== 'function') throw new TypeError('images service is required');
  assertMethodLane(lane);
  for (const name of ['ReadStream', 'WriteStream', 'ByteArray', 'Text', 'Array', 'OrderedCollection']) {
    if (!await resolveGlobal({images, imageId, name})) {
      throw new TypeError(`image ${imageId} has not published the global ${name}`);
    }
  }
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/class/ReadStream'),
    methods: READ_STREAM_BREADTH_METHODS,
  });
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/class/ByteArray'),
    methods: BYTE_ARRAY_STREAM_METHODS,
  });
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/metaclass/ByteArray'),
    methods: BYTE_ARRAY_CLASS_STREAM_METHODS,
  });
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/class/Text'),
    methods: [
      {selector: 'writeStream', source: "[ ^ WriteStream on: '' ]"},
      {selector: 'asByteArray', source: '[ ^ self utf8Bytes ]'},
    ],
  });
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/class/Array'),
    methods: [
      {selector: 'readStream', source: '[ ^ ReadStream on: self ]'},
      {selector: 'asByteArray', source: '[ ^ ByteArray fromArray: self ]'},
    ],
  });
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/class/OrderedCollection'),
    methods: [
      {selector: 'readStream', source: '[ ^ ReadStream on: self ]'},
      {selector: 'asByteArray', source: '[ ^ ByteArray fromArray: self asArray ]'},
    ],
  });
}

export {
  READ_STREAM_SHAPE_ID,
  installSmalltalkReadStreamProtocol,
  installSmalltalkTextReadStreamProtocol,
  installSmalltalkStreamBreadthProtocol,
};
