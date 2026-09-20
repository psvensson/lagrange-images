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
  {selector: 'from:to:by:', source: `[ :aStart :aStop :aStep | | interval |
    interval := self new.
    interval setStart: aStart stop: aStop count: (aStop - aStart) abs + 1.
    ^ interval ]`},
]);

const INTERVAL_METHODS = Object.freeze([
  {selector: 'setStart:stop:count:', source: '[ :aStart :aStop :aCount | start := aStart. stop := aStop. count := aCount ]'},
  {
    selector: 'do:',
    source: `[ :aBlock | | i n |
      i := start.
      n := 0.
      [ n < count ] whileTrue: [ aBlock value: i. i := i + 1. n := n + 1 ].
      ^ self ]`,
  },
]);

// The measured constructor entry: Number>>to:. A separate composition stage, after Interval is
// published through the namespace, because the body names the `Interval` global.
const INTEGER_TO_METHOD = Object.freeze({
  selector: 'to:',
  source: '[ :aStop | ^ Interval from: self to: aStop by: 1 ]',
});

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
    methods: [INTEGER_TO_METHOD],
  });
}

export {INTERVAL_SHAPE_ID, INTERVAL_CLASS_METHODS, INTERVAL_METHODS, INTEGER_TO_METHOD, installSmalltalkIntervalProtocol, installSmalltalkIntervalConstructionProtocol};
