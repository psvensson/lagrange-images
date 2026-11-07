// Native `Interval`, added because the real imported application names it: the pinned upstream
// Cuis Life code iterates with `(1 to: cells height) do:` — a `to:` answered by an Interval, then
// `do:` — which is a DIFFERENT message chain from the `to:do:` the Integer owner already serves.
// The native compiler otherwise answered `message not understood: to: sent to an integer Value`
// (bead lagrange-images-nfv1.3). This is an ordinary native Smalltalk class published as an
// ordinary global — NOT a Cuis compatibility class.
//
// RECORDED REAL-CUIS ORACLE (pinned Cuis7.8.sources, upstream's own bodies, minimized to the
// protocol the measured acceptance path sends):
//
//   ivars                 start, stop, count
//   class>>from:to:by:    from start to stop in increments of step, count computed up front
//   Number>>to:           ^Interval from: self to: stop by: 1
//   Interval>>do:         enumerate start..stop inclusive, answer self
//
// `by:` with negative or non-integer steps, `at:`, `collect:`, `select:`, `size`/`first`/`last`
// accessors and the rest of SequenceableCollection breadth remain absent. Execution pressure
// adds protocol one proven consumer at a time.
import {ensureNamedClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {objectRef} from '../value/index.js';

const INTERVAL_SHAPE_ID = 'smalltalk/interval-instance-shape/v1';

const INTERVAL_CLASS_METHODS = Object.freeze([
  // Measured Cuis computes the COUNT up front, never accumulating by adding the step.
  {
    selector: 'from:to:by:',
    source: `[ :aStart :aStop :aStep | | interval c actualStop |
      c := 0.
      aStep > 0 ifTrue: [
        aStop >= aStart ifTrue: [ c := ((aStop - aStart) // aStep) + 1 ] ].
      aStep < 0 ifTrue: [
        aStop <= aStart ifTrue: [ c := ((aStart - aStop) // (0 - aStep)) + 1 ] ].
      actualStop := c > 0
        ifTrue: [ aStart + ((c - 1) * aStep) ]
        ifFalse: [ aStart ].
      interval := self new.
      interval setStart: aStart stop: actualStop count: c.
      ^ interval ]`,
  },
]);

const INTERVAL_METHODS = Object.freeze([
  {selector: 'setStart:stop:count:', source: '[ :aStart :aStop :aCount | start := aStart. stop := aStop. count := aCount ]'},
  {selector: 'step', source: '[ ^ count > 1 ifTrue: [ (stop - start) // (count - 1) ] ifFalse: [ 1 ] ]'},
  {selector: 'size', source: '[ ^ count ]'},
  {selector: 'isEmpty', source: '[ ^ count = 0 ]'},
  {selector: 'first', source: '[ ^ start ]'},
  {selector: 'last', source: '[ ^ stop ]'},
  {selector: 'at:', source: '[ :anIndex | ^ start + ((anIndex - 1) * self step) ]'},
  {
    selector: 'do:',
    source: `[ :aBlock | | i n s |
      s := self step.
      i := start.
      n := 0.
      [ n < count ] whileTrue: [ aBlock value: i. i := i + s. n := n + 1 ].
      ^ self ]`,
  },
]);

// The measured constructor entry: Number>>to: and Number>>to:by:, plus collection enumeration
// methods on Interval that name `OrderedCollection`. A separate composition stage, after Interval
// is published through the namespace, because the bodies name globals.
const INTEGER_TO_METHOD = Object.freeze({
  selector: 'to:',
  source: '[ :aStop | ^ Interval from: self to: aStop by: 1 ]',
});

const INTEGER_TO_BY_METHOD = Object.freeze({
  selector: 'to:by:',
  source: '[ :aStop :aStep | ^ Interval from: self to: aStop by: aStep ]',
});

const INTERVAL_COLLECTION_METHODS = Object.freeze([
  {
    selector: 'collect:',
    source: `[ :aBlock | | result |
      result := OrderedCollection new.
      self do: [ :each | result add: (aBlock value: each) ].
      ^ result asArray ]`,
  },
  {
    selector: 'select:',
    source: `[ :aBlock | | result |
      result := OrderedCollection new.
      self do: [ :each |
        (aBlock value: each) ifTrue: [ result add: each ] ].
      ^ result asArray ]`,
  },
  {selector: 'asArray', source: '[ ^ self collect: [ :each | each ] ]'},
]);

async function installSmalltalkIntervalProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: INTERVAL_SHAPE_ID,
    slots: [{id: 'interval-start', name: 'start'}, {id: 'interval-stop', name: 'stop'}, {id: 'interval-count', name: 'count'}],
  });
  const {classRef, metaclassRef} = await ensureNamedClass({
    images, imageId, name: 'Interval', superclassRef: objectRef(imageId, 'smalltalk/class/Object'), instanceShapeRef,
  });
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef: metaclassRef, methods: INTERVAL_CLASS_METHODS});
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef, methods: INTERVAL_METHODS});
  return Object.freeze({classRef, metaclassRef});
}

async function installSmalltalkIntervalConstructionProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: objectRef(imageId, 'smalltalk/class/Integer'),
    methods: [INTEGER_TO_METHOD, INTEGER_TO_BY_METHOD],
  });
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: objectRef(imageId, 'smalltalk/class/Interval'),
    methods: INTERVAL_COLLECTION_METHODS,
  });
}

export {INTERVAL_SHAPE_ID, INTERVAL_CLASS_METHODS, INTERVAL_METHODS, INTEGER_TO_METHOD, INTEGER_TO_BY_METHOD, installSmalltalkIntervalProtocol, installSmalltalkIntervalConstructionProtocol};
