import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {bytesToHex, utf8Encode} from '../support/portable-bytes.js';

const DERIVATION_KEY_VERSION = 'lagrange-derivation-key/v0';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeKeyMaterial(value, path = 'cache key material') {
  if (value === null) return ['null'];
  switch (typeof value) {
    case 'boolean': return ['boolean', value];
    case 'string': return ['string', value];
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path} numbers must be finite`);
      return ['number', Object.is(value, -0) ? '-0' : String(value)];
    case 'bigint': return ['bigint', value.toString(10)];
    case 'object': {
      if (Array.isArray(value)) {
        return ['array', value.map((entry, index) => normalizeKeyMaterial(entry, `${path}[${index}]`))];
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} objects must be plain records`);
      }
      const entries = Object.keys(value).sort().map((key) => [key, normalizeKeyMaterial(value[key], `${path}.${key}`)]);
      return ['object', entries];
    }
    default:
      throw new TypeError(`${path} contains unsupported ${typeof value}`);
  }
}

function compilerCacheContract(compiler) {
  const identity = compiler?.identity;
  const cacheKey = compiler?.cacheKey;
  if (identity === undefined && cacheKey === undefined) return null;
  requiredText(identity, 'compiler identity');
  if (typeof cacheKey !== 'function') throw new TypeError('cacheable compiler must implement cacheKey(request, context)');
  return Object.freeze({identity, cacheKey});
}

async function createDerivationDescriptor(compiler, request, context = {}, artifactMetadata = {}) {
  const contract = compilerCacheContract(compiler);
  if (!contract) return null;
  const material = await contract.cacheKey(request, context);
  const normalized = normalizeKeyMaterial(material);
  const normalizedMetadata = normalizeKeyMaterial(artifactMetadata, 'compiled artifact metadata');
  const payload = JSON.stringify([
    DERIVATION_KEY_VERSION,
    contract.identity,
    request.targetRepresentation,
    normalized,
    normalizedMetadata,
  ]);
  const key = bytesToHex(getDefaultCryptoProvider().sha256(utf8Encode(payload)));
  return Object.freeze({compilerIdentity: contract.identity, derivationKey: key});
}

export {
  DERIVATION_KEY_VERSION,
  compilerCacheContract,
  createDerivationDescriptor,
  normalizeKeyMaterial as normalizeDerivationKeyMaterial,
};
