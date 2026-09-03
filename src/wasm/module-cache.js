import {TupleMap} from '../support/tuple-map.js';

// A tuple key, not a joined string: image and object ids are arbitrary non-empty text, so
// no separator is safe to join on. See src/support/tuple-map.js. The key is the module artifact's
// identity and is version-agnostic (v1 or v2) — the caller supplies the raw bytes to compile.
function moduleCacheKey(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact') throw new TypeError('module cache key requires a code-artifact');
  if (typeof artifact.imageId !== 'string' || typeof artifact.id !== 'string') throw new TypeError('module cache key requires imageId and id');
  return [artifact.imageId, artifact.id];
}

class WasmModuleCache {
  constructor({compile = (bytes) => WebAssembly.compile(bytes)} = {}) {
    if (typeof compile !== 'function') throw new TypeError('WASM module cache compile must be a function');
    this.compile = compile;
    this.entries = new TupleMap(2);
    this.hits = 0;
    this.misses = 0;
    this.compilations = 0;
    this.failures = 0;
  }

  async get(moduleArtifact, bytes) {
    const key = moduleCacheKey(moduleArtifact);
    const existing = this.entries.get(key);
    if (existing) {
      this.hits += 1;
      return await existing;
    }

    this.misses += 1;
    this.compilations += 1;
    const moduleBytes = bytes ?? Buffer.from(moduleArtifact.content.base64, 'base64');
    let pending;
    pending = Promise.resolve()
      .then(() => this.compile(moduleBytes))
      .then((module) => {
        if (!(module instanceof WebAssembly.Module)) {
          throw new TypeError('WASM module cache compiler must return a WebAssembly.Module');
        }
        return module;
      })
      .catch((error) => {
        this.failures += 1;
        if (this.entries.get(key) === pending) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, pending);
    return await pending;
  }

  clear() {
    this.entries.clear();
  }

  resetStats() {
    this.hits = 0;
    this.misses = 0;
    this.compilations = 0;
    this.failures = 0;
  }

  stats() {
    return Object.freeze({
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      compilations: this.compilations,
      failures: this.failures,
    });
  }
}

export {WasmModuleCache, moduleCacheKey};
