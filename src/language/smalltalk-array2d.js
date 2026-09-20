// Native `Array2D`, required by the frozen M5.2 measurement (bead lagrange-images-nfv1.1/
// nfv1.3): `LifeArray extends Array2D`, and the imported, unchanged Life code builds grids with
// `LifeArray height: width:`, fills them with `fillWithArrayOfArrays:`, iterates with
// `i:j:` / `i:j:put:` / `at:` / `at:put:`, and copies with `copy` (`LifeModel>>nextState`).
// The Cuis import adapter's correspondence seam maps `cuis-class/Cuis-Base/Array2D` to THIS
// class; nothing else creates or guesses the correspondence.
//
// This is an ordinary native Smalltalk class published as an ordinary global — NOT a Cuis
// compatibility class. The Cuis import adapter knows nothing about the name beyond the sealed
// correspondence entry.
//
// RECORDED REAL-CUIS ORACLE (pinned Cuis7.8.sources, read out of the pinned image — the whole
// protocol below is upstream's own wording, minimized to the protocol the measured acceptance
// path sends):
//
//   ivar order            width, height, elements
//   height:width: (class) ^self basicNew initHeight: h width: w
//                         (this image has no `basicNew` class-protocol divergence to
//                          preserve: `new` = basicNew + initialize, and Array2D carries no
//                          other initializer state, so `new initHeight:width:` is equivalent)
//   initHeight:width:     height := h. width := w. self initializeElements
//   initializeElements    elements := Array new: height * width
//   elementsIndexForI:j:  (j between: 1 and: width) ifFalse: [self errorSubscriptBounds...].
//                         ^ i-1*width+j     (this image has no measured `errorSubscriptBounds:`
//                          protocol; the measured BOUNDS behavior is preserved by signalling
//                          the existing Error condition — an out-of-bounds column is refused,
//                          never a silent wrap)
//   i:j: / i:j:put:       elements at: (self elementsIndexForI: i j: j) [put: anObject]
//   elements / elements:  the one flattened backing
//   at: / at:put:         the Point form, decomposing through `isPoint`
//   fillWithArrayOfArrays rows 1..height, columns 1..width
//   copy / postCopy       Object copy = shallowCopy postCopy; postCopy COPIES the elements
//                         array, so a copy is independent of its original. This image has no
//                         measured `shallowCopy` primitive protocol, so the measured COPY
//                         SEMANTIC (independent elements, same layout) is the method's contract.
//
// The rest of upstream's matrix protocol (`wrapI:j:`, `with:otherImageDo:`, `replaceValues:`,
// printing, `=`, `hash`) remains absent. Execution pressure adds protocol one proven consumer
// at a time.
import {ensureNamedClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {objectRef} from '../value/index.js';

const ARRAY_2D_SHAPE_ID = 'smalltalk/point-agnostic-array2d-instance-shape/v1';

const ARRAY_2D_CLASS_METHODS = Object.freeze([
  {selector: 'height:width:', source: '[ :h :w | | a | a := self new. a initHeight: h width: w. ^ a ]'},
]);

// Bodies in measured upstream order. The bounds check keeps the measured REFUSAL behavior: an
// out-of-bounds column refuses, it never silently wraps to another cell.
const ARRAY_2D_METHODS = Object.freeze([
  {selector: 'initHeight:width:', source: '[ :h :w | width := w. height := h. self initializeElements ]'},
  {selector: 'initializeElements', source: '[ elements := Array new: height * width ]'},
  {selector: 'width', source: '[ ^width ]'},
  {selector: 'height', source: '[ ^height ]'},
  {selector: 'elements', source: '[ ^elements ]'},
  {selector: 'elements:', source: '[ :anArray | elements := anArray ]'},
  {selector: 'elementsIndexForI:j:', source: '[ :i :j | (j between: 1 and: width) ifTrue: [ ^ i-1*width+j ]. Error signal ]'},
  {selector: 'i:j:', source: '[ :i :j | ^ elements at: (self elementsIndexForI: i j: j) ]'},
  {selector: 'i:j:put:', source: '[ :i :j :anObject | elements at: (self elementsIndexForI: i j: j) put: anObject ]'},
  {selector: 'at:', source: '[ :aPoint | aPoint isPoint ifTrue: [ ^ self i: aPoint x j: aPoint y ]. width = 1 ifTrue: [ ^ self i: aPoint j: 1 ]. height = 1 ifTrue: [ ^ self i: 1 j: aPoint ] ]'},
  {selector: 'at:put:', source: '[ :aPoint :anObject | aPoint isPoint ifTrue: [ self i: aPoint x j: aPoint y put: anObject ] ifFalse: [ width = 1 ifTrue: [ self i: aPoint j: 1 put: anObject ] ifFalse: [ self i: 1 j: aPoint put: anObject ] ] ]'},
  {selector: 'fillWithArrayOfArrays:', source: '[ :anArray | 1 to: height do: [ :i | 1 to: width do: [ :j | self i: i j: j put: ((anArray at: i) at: j) ] ] ]'},
]);

// The measured COPY SEMANTIC (a copy has its OWN elements array, identical contents), as its
// own composition stage because the body names the published `Array2D` and `Array` globals.
const ARRAY_2D_COPY_METHOD = Object.freeze({
  selector: 'copy',
  source: `[ | c newElements |
    c := Array2D height: height width: width.
    newElements := Array new: elements size.
    1 to: elements size do: [ :idx | newElements at: idx put: (elements at: idx) ].
    c elements: newElements.
    ^ c ]`,
});

async function installSmalltalkArray2DProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: ARRAY_2D_SHAPE_ID,
    slots: [{id: 'array2d-width', name: 'width'}, {id: 'array2d-height', name: 'height'}, {id: 'array2d-elements', name: 'elements'}],
  });
  const {classRef, metaclassRef} = await ensureNamedClass({
    images, imageId, name: 'Array2D', superclassRef: objectRef(imageId, 'smalltalk/class/Object'), instanceShapeRef,
  });
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef: metaclassRef, methods: ARRAY_2D_CLASS_METHODS});
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef, methods: ARRAY_2D_METHODS});
  return Object.freeze({classRef, metaclassRef});
}

// Composition stage, after Array2D is published through the namespace: naming it in ordinary
// source preserves GlobalBinding dereference semantics at runtime.
async function installSmalltalkArray2DCopyProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  const {resolveGlobal} = await import('./smalltalk-globals.js');
  const binding = await resolveGlobal({images, imageId, name: 'Array2D'});
  const classRecord = await images.getObject(imageId, binding.objectId);
  await defineMethodsFromSource({
    images, compilation, imageId, lane,
    classRef: classRecord.slots['global-binding-value'],
    methods: [ARRAY_2D_COPY_METHOD],
  });
}

export {ARRAY_2D_SHAPE_ID, ARRAY_2D_CLASS_METHODS, ARRAY_2D_METHODS, ARRAY_2D_COPY_METHOD, installSmalltalkArray2DProtocol, installSmalltalkArray2DCopyProtocol};
