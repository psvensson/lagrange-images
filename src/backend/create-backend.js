import {assertBackend} from './backend-contract.js';
import {LagrangeBackend} from './lagrange-backend.js';
import {MockBackend} from './mock-backend.js';

const DEFAULT_LAGRANGE_SPECIFIER = 'lagrange-server';

class LagrangeIntegrationError extends Error {
  constructor(message, {cause} = {}) {
    super(message, {cause});
    this.name = 'LagrangeIntegrationError';
  }
}

async function tryImportLagrange(specifier = DEFAULT_LAGRANGE_SPECIFIER) {
  try {
    const module = await import(specifier);
    return {
      available: true,
      module,
      version: module.VERSION ?? null,
      error: null,
    };
  } catch (error) {
    const packageMissing =
      error?.code === 'ERR_MODULE_NOT_FOUND' &&
      String(error.message).includes(specifier);

    if (!packageMissing) throw error;

    return {
      available: false,
      module: null,
      version: null,
      error,
    };
  }
}

async function createLagrangeBackend({loaded, lagrangeFactory, options}) {
  if (typeof lagrangeFactory === 'function') {
    const backend = await lagrangeFactory({
      namespace: options.namespace ?? 'lagrange-images',
      module: loaded.module,
    });
    assertBackend(backend);
    if (!backend.kind) backend.kind = 'lagrange';
    return backend;
  }

  if (typeof loaded.module.createEmbeddedLagrange === 'function') {
    return new LagrangeBackend({
      createEmbeddedLagrange: loaded.module.createEmbeddedLagrange,
      configuration: options.configuration ?? {},
      namespace: options.namespace ?? 'lagrange-images',
    });
  }

  const legacyFactory = loaded.module.createImageBackend;
  if (typeof legacyFactory !== 'function') return null;
  const backend = await legacyFactory({
    namespace: options.namespace ?? 'lagrange-images',
    module: loaded.module,
  });
  assertBackend(backend);
  if (!backend.kind) backend.kind = 'lagrange';
  return backend;
}

async function createBackend(options = {}) {
  // A pre-built backend instance passes straight through: the caller owns its lifecycle up to
  // here, and `createRuntime` starts and stops it exactly as one built from a mode. This is how a
  // forked MockBackend gets a runtime wrapped around it.
  if (options.instance) {
    assertBackend(options.instance);
    return options.instance;
  }

  const mode = options.mode ?? process.env.LAGRANGE_BACKEND ?? 'auto';

  if (!['auto', 'mock', 'lagrange'].includes(mode)) {
    throw new Error(`unknown backend mode: ${mode}`);
  }

  if (mode === 'mock') {
    return new MockBackend({
      integration: {selectedBy: 'explicit'},
    });
  }

  const loaded = await tryImportLagrange(
    options.lagrangeSpecifier ?? DEFAULT_LAGRANGE_SPECIFIER,
  );

  if (loaded.available) {
    const backend = await createLagrangeBackend({
      loaded,
      lagrangeFactory: options.lagrangeFactory,
      options,
    });

    if (backend) return backend;

    if (mode === 'lagrange') {
      throw new LagrangeIntegrationError(
        'lagrange-server was imported, but it exposes neither createEmbeddedLagrange nor an image backend factory',
      );
    }

    return new MockBackend({
      integration: {
        selectedBy: 'auto-fallback',
        lagrangeLoaded: true,
        lagrangeVersion: loaded.version,
        reason: 'image-backend-adapter-not-available',
      },
    });
  }

  if (mode === 'lagrange') {
    throw new LagrangeIntegrationError(
      `cannot import ${options.lagrangeSpecifier ?? DEFAULT_LAGRANGE_SPECIFIER}`,
      {cause: loaded.error},
    );
  }

  return new MockBackend({
    integration: {
      selectedBy: 'auto-fallback',
      lagrangeLoaded: false,
      reason: 'lagrange-package-not-installed',
    },
  });
}

export {
  DEFAULT_LAGRANGE_SPECIFIER,
  LagrangeIntegrationError,
  createBackend,
  tryImportLagrange,
};
