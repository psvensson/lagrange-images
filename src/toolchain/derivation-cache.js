import {createHash} from 'node:crypto';
import {normalizeDerivationKeyMaterial} from '../compilation/derivation-cache.js';

const TOOLCHAIN_DERIVATION_KEY_VERSION = 'lagrange-toolchain-derivation-key/v0';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function toolchainCacheContract(provider) {
  const cacheKey = provider?.cacheKey;
  if (cacheKey === undefined) return null;
  requiredText(provider?.identity, 'cacheable toolchain provider identity');
  if (typeof cacheKey !== 'function') {
    throw new TypeError('cacheable toolchain provider must implement cacheKey(request, context)');
  }
  return Object.freeze({identity: provider.identity, cacheKey});
}

function requestKeyMaterial(request) {
  return {
    protocol: request.protocol,
    providerId: request.providerId,
    toolchainIdentity: request.toolchainIdentity,
    roots: request.roots,
    artifacts: request.artifacts,
    target: request.target,
    options: request.options,
  };
}

async function createToolchainDerivationDescriptor(provider, request, context = {}) {
  const contract = toolchainCacheContract(provider);
  if (!contract) return null;
  const providerMaterial = await contract.cacheKey(request, context);
  const normalizedRequest = normalizeDerivationKeyMaterial(
    requestKeyMaterial(request),
    'toolchain derivation request',
  );
  const normalizedProviderMaterial = normalizeDerivationKeyMaterial(
    providerMaterial,
    'toolchain provider cache key material',
  );
  const payload = JSON.stringify([
    TOOLCHAIN_DERIVATION_KEY_VERSION,
    contract.identity,
    normalizedRequest,
    normalizedProviderMaterial,
  ]);
  const derivationKey = createHash('sha256').update(payload).digest('hex');
  return Object.freeze({
    toolchainIdentity: contract.identity,
    derivationKey,
  });
}

export {
  TOOLCHAIN_DERIVATION_KEY_VERSION,
  createToolchainDerivationDescriptor,
  toolchainCacheContract,
};
