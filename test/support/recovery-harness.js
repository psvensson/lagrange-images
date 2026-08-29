import {createRuntime} from '../../src/runtime.js';

// The shared harness for the `exhaustive-recovery:` sweeps. It exists to cut the *fixed* cost of a
// sweep iteration, never its coverage: every write is still enumerated in both failure modes, in
// both lanes. What changes is that the base image each iteration starts from — kernel, allocation
// protocol, whatever else the sweep's `prepare` installs — is built once and forked per iteration
// through `MockBackend.fork()`, instead of being reinstalled (and, in the WASM lane, recompiled)
// total-writes × 2 times.
//
// The superset of ImageService write methods any installer uses today. Counting a method a given
// installer never calls is harmless — the sweep enumerates whatever writes actually happen — so
// sharing one list is strictly more exhaustive than the per-file subsets it replaces. A sweep with
// a genuinely different surface can pass its own `writeMethods`.
const WRITE_METHODS = Object.freeze([
  'putCodeArtifact',
  'putBlock',
  'putShape',
  'putObject',
  'putLexicalEnvironment',
]);

// Wraps an images service so the failAt-th write either throws before committing, or commits and
// then throws — the lost-acknowledgement shape. Everything else passes through untouched.
function faultingImages(images, {failAt = null, commitThenThrow = false, writeMethods = WRITE_METHODS} = {}) {
  let writes = 0;
  const wrapped = Object.create(Object.getPrototypeOf(images));
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(images))) {
    if (typeof images[key] !== 'function' || key === 'constructor') continue;
    wrapped[key] = (...args) => images[key](...args);
  }
  for (const [key, value] of Object.entries(images)) {
    if (typeof value === 'function') wrapped[key] = (...args) => images[key](...args);
    else wrapped[key] = value;
  }
  for (const method of writeMethods) {
    wrapped[method] = async (imageId, input, options) => {
      writes += 1;
      const index = writes;
      if (index === failAt && !commitThenThrow) {
        throw new Error(`injected failure at write ${index} (${method} ${input?.id})`);
      }
      const result = await images[method](imageId, input, options);
      if (index === failAt && commitThenThrow) {
        throw new Error(`injected post-commit failure at write ${index} (${method} ${input?.id})`);
      }
      return result;
    };
  }
  return {images: wrapped, writeCount: () => writes};
}

// Builds a template runtime, runs `prepare` on it once, and hands out per-iteration runtimes whose
// backend is a fork of the prepared state. `withFork` passes the prepared value through, so a
// sweep's per-iteration body gets whatever refs `prepare` answered — but note those refs point at
// records the fork *copied*, so they stay valid in every fork.
async function forkableRuntime(prepare = async () => null) {
  const template = await createRuntime({backend: {mode: 'mock'}});
  if (typeof template.backend.fork !== 'function') {
    await template.close();
    throw new TypeError('forkableRuntime requires a backend with fork(); only the mock backend has one');
  }
  let prepared;
  try {
    prepared = await prepare(template);
  } catch (error) {
    await template.close();
    throw error;
  }
  return {
    template,
    prepared,
    async withFork(body) {
      const runtime = await createRuntime({backend: {instance: template.backend.fork()}});
      try {
        return await body(runtime, prepared);
      } finally {
        await runtime.close();
      }
    },
    async close() {
      await template.close();
    },
  };
}

export {WRITE_METHODS, faultingImages, forkableRuntime};
