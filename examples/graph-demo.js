import {createRuntime, integerValue, objectRef} from '../src/runtime.js';

const runtime = await createRuntime({backend: {mode: 'mock'}});
const image = await runtime.images.createImage({id: 'playground', name: 'Playground'});
const shape = await runtime.images.putShape(image.id, {
  id: 'counter-shape-v1',
  slots: [{id: 'slot-value', name: 'value'}],
});
const counter = await runtime.images.putObject(image.id, {
  id: 'counter',
  shape: objectRef(image.id, shape.id),
  slots: {'slot-value': integerValue(0)},
});
await runtime.images.setRoot(image.id, counter.id);
console.log(JSON.stringify({
  image: await runtime.images.getImage(image.id),
  shapes: await runtime.images.listShapes(image.id),
  objects: await runtime.images.listObjects(image.id),
  history: await runtime.images.history(image.id),
}, null, 2));
await runtime.close();
