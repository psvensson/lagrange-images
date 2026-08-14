import {assertWasmModuleArtifact} from '../code/wasm-artifacts.js';

function moduleCacheKey(artifact) {
  assertWasmModuleArtifact(artifact);
  return `${artifact.imageId}\u0000${artifact.id}`;
}

class WasmModuleCache {
  constructor({compile = (bytes) => WebAssembly.compile(bytes)} = {}) {
    if (typeof compile !== 'function') throw new TypeError('WASM module cache compile must be a function');
    this.compile = compile;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.compilations = 0;
    this.failures = 0;
  }

  async get(moduleArtifact) {
    const key = moduleCacheKey(moduleArtifact);
    const existing = this.entries.get(key);
    if (existing) {
      this.hits += 1;
      return await existing;
    }

    this.misses += 1;
    this.compilations += 1;
    const bytes = Buffer.from(moduleArtifact.content.base64, 'base64');
    let pending;
    pending = Promise.resolve()
      .then(() => this.compile(bytes))
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
