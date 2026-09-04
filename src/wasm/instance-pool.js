import {TupleMap} from '../support/tuple-map.js';
import {isWasmModuleArtifact} from './module-contract.js';

const WASM_INSTANCE_REUSE_STATELESS_V0 = 'stateless-v0';

// A tuple key, not a joined string: image and object ids are arbitrary non-empty text, so
// no separator is safe to join on. See src/support/tuple-map.js.
// The pool keys and gates on identity and the instanceReuse PROVENANCE only; the contract itself
// was already decoded by the executor through the accessor, so nothing is re-parsed per acquire.
function modulePoolKey(artifact) {
  if (!isWasmModuleArtifact(artifact)) throw new TypeError(`not a WASM module artifact: ${artifact?.representation ?? 'missing'}`);
  return [artifact.imageId, artifact.id];
}

function requireReusableModule(artifact) {
  modulePoolKey(artifact);
  if (artifact.metadata?.instanceReuse !== WASM_INSTANCE_REUSE_STATELESS_V0) {
    throw new TypeError(`WASM module does not declare reusable instance contract: ${WASM_INSTANCE_REUSE_STATELESS_V0}`);
  }
  return artifact;
}

function shouldDropState(state) {
  return state.inUse === 0 && state.creating === 0 && state.idle.length === 0;
}

class WasmInstancePool {
  constructor({maxIdlePerModule = 1} = {}) {
    if (!Number.isInteger(maxIdlePerModule) || maxIdlePerModule < 0) {
      throw new TypeError('WASM instance pool maxIdlePerModule must be a non-negative integer');
    }
    this.maxIdlePerModule = maxIdlePerModule;
    this.modules = new TupleMap(2);
    this.hits = 0;
    this.misses = 0;
    this.created = 0;
    this.retired = 0;
    this.discarded = 0;
  }

  stateFor(moduleArtifact) {
    const key = modulePoolKey(moduleArtifact);
    let state = this.modules.get(key);
    if (!state) {
      state = {idle: [], inUse: 0, creating: 0};
      this.modules.set(key, state);
    }
    return {key, state};
  }

  async acquire(moduleArtifact, create) {
    requireReusableModule(moduleArtifact);
    if (typeof create !== 'function') throw new TypeError('WASM instance pool create must be a function');
    const {key, state} = this.stateFor(moduleArtifact);
    let slot = state.idle.pop();
    if (slot) {
      this.hits += 1;
    } else {
      this.misses += 1;
      state.creating += 1;
      try {
        slot = await create();
        if (!slot || typeof slot !== 'object' || !(slot.instance instanceof WebAssembly.Instance)) {
          throw new TypeError('WASM instance pool factory must return a slot containing a WebAssembly.Instance');
        }
        this.created += 1;
      } catch (error) {
        state.creating -= 1;
        if (shouldDropState(state) && this.modules.get(key) === state) this.modules.delete(key);
        throw error;
      }
      state.creating -= 1;
    }
    state.inUse += 1;
    let released = false;

    const release = ({retire = false} = {}) => {
      if (released) throw new TypeError('WASM instance pool lease already released');
      if (typeof retire !== 'boolean') throw new TypeError('WASM instance pool retire must be a boolean');
      released = true;
      state.inUse -= 1;
      if (retire) {
        this.retired += 1;
      } else if (state.idle.length < this.maxIdlePerModule) {
        state.idle.push(slot);
      } else {
        this.discarded += 1;
      }
      if (shouldDropState(state) && this.modules.get(key) === state) this.modules.delete(key);
    };

    return Object.freeze({slot, release});
  }

  clear() {
    for (const [key, state] of this.modules) {
      state.idle.length = 0;
      if (shouldDropState(state)) this.modules.delete(key);
    }
  }

  resetStats() {
    this.hits = 0;
    this.misses = 0;
    this.created = 0;
    this.retired = 0;
    this.discarded = 0;
  }

  stats() {
    let idle = 0;
    let inUse = 0;
    for (const state of this.modules.values()) {
      idle += state.idle.length;
      inUse += state.inUse;
    }
    return Object.freeze({
      modules: this.modules.size,
      idle,
      inUse,
      hits: this.hits,
      misses: this.misses,
      created: this.created,
      retired: this.retired,
      discarded: this.discarded,
    });
  }
}

export {
  WASM_INSTANCE_REUSE_STATELESS_V0,
  WasmInstancePool,
  modulePoolKey,
};
