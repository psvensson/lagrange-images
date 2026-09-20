// Native event-model base, required by the frozen M5.2 measurement (bead lagrange-images-nfv1.1):
// `LifeModel extends TextModel`, and the imported, unchanged `LifeModel>>nextState` sends
// `self triggerEvent: #stateChanged.` and `self triggerEvent: #period` after replacing its cell
// state. The Cuis import adapter's correspondence seam maps `cuis-class/Cuis-Base/TextModel` to
// THIS class; nothing else creates or guesses the correspondence.
//
// RECORDED REAL-CUIS ORACLE (bead lagrange-images-nfv1.1, running the real pinned Cuis 7.9 image
// headlessly through the LIFE model itself): `LifeModel>>nextState` completes — twice, through
// event fires with ZERO subscribers — and the measured behavior is a SILENT SKIP, not an error
// and not a nil dispatch. `TextModel < ActiveModel` in Cuis, but ActiveModel is imported here
// as one flattened base because the M5 acceptance path (LifeModel `new`, plus `triggerEvent:`
// with no subscribers) exercises exactly that measured surface. ActiveModel's real action-map
// protocol (`when:send:to:`, `updateableActionMap`, `removeAllActions`) remains ABSENT: the
// acceptance scope imports no views, so no subscriber protocol is yet load-bearing. Execution
// pressure adds protocol one proven consumer at a time.
import {ensureNamedClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {objectRef} from '../value/index.js';

const ACTIVE_MODEL_SHAPE_ID = 'smalltalk/active-model-instance-shape/v1';

// Measured: a `triggerEvent:` with no registered actions is silent and completes. Returning the
// receiver is the safe identity answer for the unchanged callers that chain off it.
const ACTIVE_MODEL_METHODS = Object.freeze([
  {selector: 'triggerEvent:', source: '[ :aSymbol | ^ self ]'},
]);

async function installSmalltalkActiveModelProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: ACTIVE_MODEL_SHAPE_ID, slots: [],
  });
  const {classRef, metaclassRef} = await ensureNamedClass({
    images, imageId, name: 'TextModel', superclassRef: objectRef(imageId, 'smalltalk/class/Object'), instanceShapeRef,
  });
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef, methods: ACTIVE_MODEL_METHODS});
  return Object.freeze({classRef, metaclassRef});
}

export {ACTIVE_MODEL_SHAPE_ID, ACTIVE_MODEL_METHODS, installSmalltalkActiveModelProtocol};
