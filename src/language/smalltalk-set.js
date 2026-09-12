import {ensureNamedClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {objectRef} from '../value/index.js';

// Native equality-based membership composes Dictionary's hash/equality owner. Set has no
// host collection representation, and Array conversion never touches either backing storage.
const SET_SHAPE_ID = 'smalltalk/set-instance-shape/v1';
const SET_METHODS = Object.freeze([
  {selector: 'initialize', source: '[ members := Dictionary new. self ]'},
  {selector: 'size', source: '[ members size ]'},
  {selector: 'includes:', source: '[ :item | members includesKey: item ]'},
  {selector: 'add:', source: '[ :item | members at: item put: true. item ]'},
  {selector: 'do:', source: '[ :aBlock | members keysAndValuesDo: [:item :present | aBlock value: item]. self ]'},
]);
const ARRAY_AS_SET_METHOD = Object.freeze({
  selector: 'asSet',
  source: '[ | result | result := Set new. self do: [:each | result add: each]. result ]',
});

async function installSmalltalkSetProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: SET_SHAPE_ID, slots: [{id: 'set-members', name: 'members'}],
  });
  const {classRef, metaclassRef} = await ensureNamedClass({
    images, imageId, name: 'Set', superclassRef: objectRef(imageId, 'smalltalk/class/Collection'), instanceShapeRef,
  });
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef, methods: SET_METHODS});
  return Object.freeze({classRef, metaclassRef});
}

// A separate composition stage, after the namespace owner has published Set. Naming it in
// ordinary source preserves GlobalBinding dereference/rebind semantics at runtime.
async function installSmalltalkArraySetConversion({images, compilation, imageId, lane = 'neutral'} = {}) {
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: objectRef(imageId, 'smalltalk/class/Array'),
    methods: [ARRAY_AS_SET_METHOD],
  });
}

export {SET_SHAPE_ID, SET_METHODS, ARRAY_AS_SET_METHOD, installSmalltalkSetProtocol, installSmalltalkArraySetConversion};
