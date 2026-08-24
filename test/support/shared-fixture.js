import {createRuntime} from '../../src/runtime.js';

// Shared per-file test fixtures.
//
// The dominant cost in the language test files is not the assertions — it is that each test
// re-runs a full durable install (kernel + protocols + library), often twice for both lanes. On a
// 20-core box node:test parallelizes across files, so wall-clock is the slowest file, and the
// slowest files are the ones doing dozens of installs.
//
// This helper installs ONCE per (fixtureKey, lane) into a single memoized runtime+image and hands
// each test cheap isolation inside it via `unique(prefix)`, which mints collision-free ids/names.
//
// The safety invariant a caller must honor: share only tests that ADD their own uniquely-named
// objects (classes, blocks, globals) and do not mutate shared durable state another test observes
// (kernel/library class method dictionaries, the root namespace, protocol metadata). A test that
// corrupts state, counts records globally, measures WASM pool stats, needs a pristine/custom image,
// or needs its own runtime config must keep its own runtime and NOT use this helper.
const fixtures = new Map();
let counter = 0;

// Mint a collision-free id/name within the shared image. Prefix keeps it readable in failures.
function unique(prefix) {
  counter += 1;
  return `${prefix}-s${counter}`;
}

// `seed(runtime, imageId, lane)` is the file's own expensive install; it runs once per (key, lane)
// and its result is memoized. `key` should identify the file/fixture so two files never share a
// runtime (each file must still pass standalone).
async function sharedFixture(key, lane, seed) {
  const mapKey = `${key}${lane}`;
  if (!fixtures.has(mapKey)) {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    const imageId = `${key}-${lane}`;
    await runtime.images.createImage({id: imageId});
    const seeded = await seed(runtime, imageId, lane);
    fixtures.set(mapKey, {runtime, imageId, seeded});
  }
  const {runtime, imageId, seeded} = fixtures.get(mapKey);
  return {runtime, imageId, ...seeded, unique};
}

export {sharedFixture};
