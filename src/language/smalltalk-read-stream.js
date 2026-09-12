import {ensureNamedClass, ensureSmalltalkShape, methodBlockRef} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {resolveGlobal} from './smalltalk-globals.js';
import {objectRef} from '../value/index.js';

// Construction forced by the M4 parser input. Cursor/read protocols are added only when
// native execution reaches them. Instances and initialization are ordinary image objects/code.
const READ_STREAM_SHAPE_ID = 'smalltalk/read-stream-instance-shape/v1';
const READ_STREAM_METHODS = Object.freeze([
  {selector: 'on:', source: '[ :aCollection | collection := aCollection. readLimit := aCollection size. position := 0. ^ self ]'},
]);
const READ_STREAM_CLASS_METHODS = Object.freeze([
  {selector: 'on:', source: '[ :aCollection | ^ self basicNew on: aCollection ]'},
]);

async function installSmalltalkReadStreamProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  if (!images || typeof images.getObject !== 'function') throw new TypeError('images service is required');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  for (const [classRef, selector] of [[kernel.classClass, 'basicNew'], [kernel.textClass, 'size']]) {
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

export {READ_STREAM_SHAPE_ID, installSmalltalkReadStreamProtocol, installSmalltalkTextReadStreamProtocol};
