import {createRuntime} from '../src/index.js';

const runtime = await createRuntime({backend: {mode: 'mock'}});

const image = await runtime.images.createImage({
  id: 'playground',
  name: 'Playground',
});

const counter = await runtime.images.putObject(image.id, {
  id: 'counter',
  classId: 'Counter',
  slots: {value: 0},
  source: 'Counter >> increment [ value := value + 1 ]',
});

await runtime.images.setRoot(image.id, counter.id);

console.log(JSON.stringify({
  image: await runtime.images.getImage(image.id),
  objects: await runtime.images.listObjects(image.id),
  languages: runtime.languages.list(),
  history: await runtime.images.history(image.id),
}, null, 2));

await runtime.close();
