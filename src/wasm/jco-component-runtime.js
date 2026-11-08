// Executes WASM Components through the Component Model canonical ABI.
//
// Lagrange deliberately implements none of the canonical ABI itself: jco transpiles the
// Component to JS plus core modules, and the generated glue performs all lifting and
// lowering. That keeps canonical ABI evolution upstream's problem, and it is the reason
// this file contains no linear-memory code, no realloc and no pointer/length convention.
//
// Lifetime, per ADR 0036: immutable compilation machinery is cached; a Component *instance*
// is created fresh for every activation. Reusing an instance would let guest-resident state
// — and, once host imports exist, authority — cross from one activation to the next. Reuse
// requires an explicit reset/reuse contract, which this runtime does not implement and must
// not be mistaken for.
//
// jco is an optional peer dependency. Without it a Component binding still validates and
// still reports a clear error; it just cannot execute.

const TRANSPILE_OPTIONS = Object.freeze({instantiation: 'async'});
const WASM_COMPONENT_INSTANCE_REUSE_NONE = 'fresh-per-activation';
const WASM_COMPONENT_INSTANCE_REUSE_RESET_V1 = 'stateless-reset-v1';
const WASM_COMPONENT_INSTANCE_REUSE_MODES = Object.freeze([
  WASM_COMPONENT_INSTANCE_REUSE_NONE,
  WASM_COMPONENT_INSTANCE_REUSE_RESET_V1,
]);

class ComponentInstanceResetContractError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ComponentInstanceResetContractError';
  }
}

function componentBytes(component) {
  if (component?.content?.kind !== 'bytes') {
    throw new TypeError('WASM Component artifact content must be a bytes Value');
  }
  return Buffer.from(component.content.base64, 'base64');
}

function componentCacheKey(component) {
  return `${component.imageId} ${component.id} ${component.content.base64.length} ${component.content.base64.slice(0, 64)}`;
}

async function loadJco() {
  try {
    return await import('@bytecodealliance/jco');
  } catch (error) {
    throw new TypeError(
      'the jco Component runtime requires the optional @bytecodealliance/jco dependency; install it to execute WASM Component bindings',
      {cause: error},
    );
  }
}

// WIT identifiers are kebab-case and jco emits camelCase JavaScript exports, so
// `echo-f32` in the interface becomes `echoF32` on the instance. This mapping is a jco
// detail and stays here rather than in the callable interface, which must not know that
// one of its lanes is JavaScript. The exact name is tried first so a Component whose
// export really is hyphenated still resolves.
function componentExport(instance, functionName) {
  if (typeof instance[functionName] === 'function') return instance[functionName];
  const camel = functionName.replace(/-+([a-z0-9])/g, (_, character) => character.toUpperCase());
  return instance[camel];
}

// Everything produced here is immutable and derived from immutable artifact bytes: the
// generated factory module, and compiled core `WebAssembly.Module` objects. None of it holds
// activation state, so caching it is safe in exactly the way caching an instance is not.
async function prepareComponent(component) {
  const {transpile} = await loadJco();
  const {files, imports} = await transpile(componentBytes(component), {...TRANSPILE_OPTIONS, name: 'component'});

  const cores = new Map();
  let entry = null;
  const decoder = new TextDecoder();
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('.wasm')) cores.set(name, await WebAssembly.compile(bytes));
    else if (name.endsWith('.js')) entry = decoder.decode(bytes);
  }
  if (entry === null) throw new TypeError('jco produced no JavaScript entry module for the Component');

  // Imported from memory rather than written to disk: an image-resident Component should
  // not have to touch the filesystem to run.
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(entry, 'utf8').toString('base64')}`;
  return Object.freeze({
    generated: await import(moduleUrl),
    cores,
    // The import specifiers this Component requires in order to instantiate at all. Purely a
    // linking fact; this runtime knows nothing about whether any of them is permitted.
    requiredImports: Object.freeze([...(imports ?? [])]),
  });
}

function createImportProxyHolder(requiredSpecifiers = [], initialImports = {}) {
  const holder = {currentImports: null};
  const namespaceProxy = (specifier) => new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      const active = holder.currentImports?.[specifier];
      if (!active) {
        throw new TypeError(`WASM Component host import ${specifier}.${String(prop)} accessed outside an active invocation`);
      }
      const value = active[prop];
      if (typeof value === 'function' && !/^class\s/.test(Function.prototype.toString.call(value))) {
        return (...args) => {
          const current = holder.currentImports?.[specifier];
          if (!current || typeof current[prop] !== 'function') {
            throw new TypeError(`WASM Component host import ${specifier}.${String(prop)} accessed outside an active invocation`);
          }
          return current[prop](...args);
        };
      }
      return value;
    },
  });
  const specifiers = new Set([...requiredSpecifiers, ...Object.keys(initialImports)]);
  const rootTarget = {};
  for (const specifier of specifiers) {
    rootTarget[specifier] = namespaceProxy(specifier);
  }
  const proxy = new Proxy(rootTarget, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      if (!Object.hasOwn(target, prop)) {
        target[prop] = namespaceProxy(String(prop));
      }
      return target[prop];
    },
  });
  return {holder, proxy};
}

function normalizeReuseMode(mode, label = 'WASM Component instanceReuse') {
  if (mode === false || mode === null || mode === undefined) return WASM_COMPONENT_INSTANCE_REUSE_NONE;
  if (!WASM_COMPONENT_INSTANCE_REUSE_MODES.includes(mode)) {
    throw new TypeError(`${label} must be one of ${WASM_COMPONENT_INSTANCE_REUSE_MODES.join(', ')}`);
  }
  return mode;
}

function createJcoComponentRuntime({
  moduleCache = true,
  instanceReuse = WASM_COMPONENT_INSTANCE_REUSE_NONE,
  resetExport = 'lagrange-reset',
} = {}) {
  const defaultReuseMode = normalizeReuseMode(instanceReuse);
  // Keyed by immutable artifact identity, runtime-local, never persisted.
  const prepared = moduleCache ? new Map() : null;
  const idlePools = new Map();
  const statsByComponent = new Map();

  function statsFor(key) {
    let record = statsByComponent.get(key);
    if (!record) {
      record = {instantiations: 0, reuses: 0, resets: 0, evictions: 0};
      statsByComponent.set(key, record);
    }
    return record;
  }

  async function preparedComponent(component) {
    if (!prepared) return await prepareComponent(component);
    const key = componentCacheKey(component);
    let pending = prepared.get(key);
    if (!pending) {
      pending = prepareComponent(component).catch((error) => {
        // A failed preparation must not be cached, so a later activation can retry.
        prepared.delete(key);
        throw error;
      });
      prepared.set(key, pending);
    }
    return await pending;
  }

  return Object.freeze({
    // What this Component must be given to instantiate. The binding executor uses it to
    // decide policy; deciding policy is not this layer's job.
    async requiredImports(component) {
      if (!component || component.kind !== 'code-artifact') {
        throw new TypeError('jco Component runtime requires a code-artifact Component');
      }
      return (await preparedComponent(component)).requiredImports;
    },

    poolStats(component) {
      if (!component || component.kind !== 'code-artifact') {
        throw new TypeError('jco Component runtime requires a code-artifact Component');
      }
      const key = componentCacheKey(component);
      const record = statsFor(key);
      const pool = idlePools.get(key) ?? [];
      return Object.freeze({
        instantiations: record.instantiations,
        reuses: record.reuses,
        resets: record.resets,
        evictions: record.evictions,
        idleCount: pool.length,
      });
    },

    async invoke(component, functionName, args, imports = {}, options = {}) {
      if (!component || component.kind !== 'code-artifact') {
        throw new TypeError('jco Component runtime requires a code-artifact Component');
      }
      if (!imports || typeof imports !== 'object') throw new TypeError('Component imports must be an object');
      const reuseMode = normalizeReuseMode(
        options?.instanceReuse !== undefined ? options.instanceReuse : defaultReuseMode,
      );
      const key = componentCacheKey(component);
      const stats = statsFor(key);
      const {generated, cores, requiredImports} = await preparedComponent(component);
      const resolveCoreModule = async (path) => {
        const module = cores.get(path);
        if (!module) throw new TypeError(`jco requested an unknown core module: ${path}`);
        return module;
      };

      if (reuseMode === WASM_COMPONENT_INSTANCE_REUSE_NONE) {
        // Fresh instance per activation, per ADR 0036, now with whatever host implementations
        // the binding executor assembled. This runtime is deliberately authority-agnostic: it
        // sees import functions, never grants, contexts or principals.
        stats.instantiations += 1;
        const instance = await generated.instantiate(resolveCoreModule, imports);
        const exported = componentExport(instance, functionName);
        if (typeof exported !== 'function') {
          throw new TypeError(`WASM Component does not export a function named ${functionName}`);
        }
        return await exported(...args);
      }

      // Reusable Component instance under explicit stateless-reset-v1 contract.
      let pool = idlePools.get(key);
      if (!pool) {
        pool = [];
        idlePools.set(key, pool);
      }
      let entry = pool.pop() ?? null;
      if (entry) {
        stats.reuses += 1;
      } else {
        const {holder, proxy} = createImportProxyHolder(requiredImports, imports);
        holder.currentImports = imports;
        let instance;
        try {
          stats.instantiations += 1;
          instance = await generated.instantiate(resolveCoreModule, proxy);
        } finally {
          holder.currentImports = null;
        }
        entry = {instance, holder};
      }

      const {instance, holder} = entry;
      const effectiveResetExport = options?.resetExport ?? resetExport;
      const resetFn = componentExport(instance, effectiveResetExport) ?? componentExport(instance, 'reset');
      if (typeof resetFn !== 'function') {
        stats.evictions += 1;
        holder.currentImports = null;
        throw new ComponentInstanceResetContractError(
          `WASM Component opted into ${WASM_COMPONENT_INSTANCE_REUSE_RESET_V1} must export a reset function (${effectiveResetExport} or reset)`,
        );
      }

      const exported = componentExport(instance, functionName);
      if (typeof exported !== 'function') {
        stats.evictions += 1;
        holder.currentImports = null;
        throw new TypeError(`WASM Component does not export a function named ${functionName}`);
      }

      holder.currentImports = imports;
      let succeeded = false;
      try {
        const callResult = await exported(...args);
        await resetFn();
        stats.resets += 1;
        succeeded = true;
        return callResult;
      } finally {
        holder.currentImports = null;
        if (succeeded) {
          pool.push(entry);
        } else {
          stats.evictions += 1;
        }
      }
    },
  });
}

export {
  ComponentInstanceResetContractError,
  WASM_COMPONENT_INSTANCE_REUSE_MODES,
  WASM_COMPONENT_INSTANCE_REUSE_NONE,
  WASM_COMPONENT_INSTANCE_REUSE_RESET_V1,
  createJcoComponentRuntime,
};
