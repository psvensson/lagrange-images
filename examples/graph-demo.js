import {
  NEUTRAL_EXPRESSION_V0,
  createRuntime,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

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

const code = await runtime.images.putCodeArtifact(image.id, {
  id: 'add-code',
  representation: NEUTRAL_EXPRESSION_V0,
  content: textValue(JSON.stringify({
    parameters: 2,
    body: {
      op: 'integer-add',
      left: {op: 'argument', index: 0},
      right: {op: 'argument', index: 1},
    },
  })),
});
const block = await runtime.images.putBlock(image.id, {
  id: 'add-block',
  code: objectRef(image.id, code.id),
});
const activation = await runtime.invocations.invokeBlock(
  objectRef(image.id, block.id),
  [integerValue(20), integerValue(22)],
);
const executionResult = await runtime.executor.execute(activation);

console.log(JSON.stringify({
  image: await runtime.images.getImage(image.id),
  shapes: await runtime.images.listShapes(image.id),
  objects: await runtime.images.listObjects(image.id),
  executionResult,
  history: await runtime.images.history(image.id),
}, null, 2));
await runtime.close();
