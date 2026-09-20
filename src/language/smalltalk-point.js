// Native `Point`, added because a real imported consumer names it: the pinned upstream Cuis Life
// package constructs and decomposes grid positions in its own unchanged code (`LifeModel>>
// surrounding:` sends `Point x: y:` and `x@`-adjacent arithmetic, and `LifeArray>>at:` reads
// `x`/`y`). The native compiler otherwise answered `unbound Symmetric Smalltalk name: Point`.
// This is an ordinary native Smalltalk class published as an ordinary global — NOT a Cuis
// compatibility class; the Cuis import adapter resolves the name through the image's global
// namespace exactly as it resolves `Array`.
//
// SCOPE. Exactly the protocol the acceptance path sends, and nothing more:
//
//   Point class >> x:y:          the position constructor the source builds
//   Point       >> x / y         the coordinate readers the source reads
//   Point       >> isPoint       measured Cuis type query (Object>>isPoint answers false)
//   Point       >> initializePvtX:y:  the measured private Cuis initializer
//
// RECORDED REAL-CUIS ORACLE (pinned Cuis7.8.sources / 7.9 image, read out of the pinned sources,
// not recollected):
//
//   Point class>>x:y:   ^self new initializePvtX: anX y: anY
//   Point>>x            ^x        (direct ivar accessors)
//   Point>>y            ^y
//   Point>>isPoint      ^ true
//   Object>>isPoint     ^ false
//   Integer>>@          <primitive 18> fallback ^Point x: self y: y
//
// `* +` and the full Cuis point-arithmetic table remain absent. Execution pressure adds
// protocol one proven consumer at a time. `Integer>>@` is installed here (as the measured
// construction entry, the same ownership lane as `Array>>asSet` living with the Set owner) in a
// separate composition stage AFTER `Point` is published, because its body names the `Point` global.
import {ensureNamedClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {objectRef} from '../value/index.js';

const POINT_SHAPE_ID = 'smalltalk/point-instance-shape/v1';

const POINT_CLASS_METHODS = Object.freeze([
  {selector: 'x:y:', source: '[ :anX :anY | | p | p := self new. p initializePvtX: anX y: anY. ^ p ]'},
]);

const POINT_METHODS = Object.freeze([
  {selector: 'initializePvtX:y:', source: '[ :xValue :yValue | x := xValue. y := yValue ]'},
  {selector: 'x', source: '[ ^x ]'},
  {selector: 'y', source: '[ ^y ]'},
  {selector: 'isPoint', source: '[ ^ true ]'},
]);

const INTEGER_AT_METHOD = Object.freeze({
  selector: '@',
  source: '[ :y | ^ Point x: self y: y ]',
});

const OBJECT_IS_POINT_METHOD = Object.freeze({
  selector: 'isPoint',
  source: '[ ^ false ]',
});

async function installSmalltalkPointProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: POINT_SHAPE_ID, slots: [{id: 'point-x', name: 'x'}, {id: 'point-y', name: 'y'}],
  });
  const {classRef, metaclassRef} = await ensureNamedClass({
    images, imageId, name: 'Point', superclassRef: objectRef(imageId, 'smalltalk/class/Object'), instanceShapeRef,
  });
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef: metaclassRef, methods: POINT_CLASS_METHODS});
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef, methods: POINT_METHODS});
  return Object.freeze({classRef, metaclassRef});
}

// Composition stage, after Point is published through the namespace: naming it in ordinary
// source preserves GlobalBinding dereference semantics at runtime.
async function installSmalltalkPointConstructionProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: objectRef(imageId, 'smalltalk/class/Object'),
    methods: [OBJECT_IS_POINT_METHOD],
  });
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: objectRef(imageId, 'smalltalk/class/Integer'),
    methods: [INTEGER_AT_METHOD],
  });
}

export {POINT_SHAPE_ID, POINT_CLASS_METHODS, POINT_METHODS, INTEGER_AT_METHOD, OBJECT_IS_POINT_METHOD, installSmalltalkPointProtocol, installSmalltalkPointConstructionProtocol};
