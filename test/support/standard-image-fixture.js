import {createRuntime} from '../../src/runtime.js';
import {installSymmetricSmalltalkStandardImage} from '../../src/language/smalltalk-standard-image.js';

// The shared standard-image fixture for the ordinary lane.
//
// Installing the standard image is the dominant fixed cost in the language test files: every
// native protocol makes it longer, and a file that installs it once per test pays that cost
// test-count times, twice when it covers both lanes. Measured on the reference workstation at one
// worker (Sept 23 2026) one install is roughly 13-14 s, and `test/cuis-native-import.test.js`
// alone made 32 of them.
//
// This helper installs ONCE per (lane, imageId) per test process and hands every test a runtime
// over a `MockBackend.fork()` copy of that prepared state — the same mechanism the exhaustive
// recovery sweeps already use through `forkableRuntime`. A fork copies records, versions and
// streams, so from the test's point of view the image is exactly what a fresh install would have
// produced: same ids, same frontier, same history, and no state shared with any other test.
// That is the difference from `sharedFixture`: a test here may mutate the standard image freely,
// because it holds its own copy.
//
// What a test must NOT do with this helper: assume the template runtime's caches (WASM module
// cache, dispatcher validation cache) are warm — each fork gets a fresh runtime — or measure
// install-time behaviour of the standard image itself (installation preflight, replay, or an
// interrupted install), which needs its own runtime and a real install.
const templates = new Map();

async function standardImageTemplate({lane, imageId}) {
  const key = `${lane}\u0000${imageId}`;
  if (!templates.has(key)) {
    templates.set(key, (async () => {
      const template = await createRuntime({backend: {mode: 'mock'}});
      try {
        await template.images.createImage({id: imageId});
        const installed = await installSymmetricSmalltalkStandardImage({
          images: template.images, compilation: template.compilation, imageId, lane,
        });
        return {template, installed};
      } catch (error) {
        await template.close();
        throw error;
      }
    })());
  }
  return await templates.get(key);
}

// Runs `body(runtime, {imageId, lane, installed})` over a fresh fork of the prepared standard
// image and closes that runtime afterwards. `installed` is the value
// `installSymmetricSmalltalkStandardImage` answered when the template was built; its refs name
// records the fork copied, so they are valid in every fork.
async function withStandardImage({lane = 'wasm', imageId = 'app'} = {}, body) {
  if (typeof body !== 'function') throw new TypeError('withStandardImage requires a body function');
  const {template, installed} = await standardImageTemplate({lane, imageId});
  const runtime = await createRuntime({backend: {instance: template.backend.fork()}});
  try {
    return await body(runtime, {imageId, lane, installed});
  } finally {
    await runtime.close();
  }
}

export {withStandardImage};
