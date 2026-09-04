// The single canonical decoder for a compiled WASM module's executable contract (Bead
// lagrange-images-ygi, ADR pending). The four executors run execution separately, but they must
// NOT each re-interpret the representation schema — they read the contract through here.
//
// wasm-module/v2 (canonical): the executable semantics — abi, literals, function descriptors and
// send/closure/effect sites — live in the artifact's identity-bearing CONTENT as canonical JSON,
// and the raw compiled bytes are a SEPARATELY identity-bearing artifact referenced through one
// `role: implementation` dependency (the same pattern wasm-callable-interface/v1 uses). The
// implementation binding participates in module identity because contentIdentity follows the
// dependency edge into the closure (proven: identical contract + different bytes -> different
// identity), so there is one authority for the binding and no JSON-vs-edge conflict.
//
// wasm-module/v1 (FROZEN, ADR 0035 precedent — a named durable representation is versioned, not
// mutated): the same contract lives in stripped provenance `metadata` with the bytes as content.
// It still executes in-image through this accessor, but it does not survive a portable release —
// which is the defect v2 exists to fix. New compiler output is v2.
//
// `instanceReuse` is deliberately NOT part of the contract here: it is a non-semantic optimization
// (absent -> fresh instance per activation, which is always correct; `stateless-v0` only ever
// denotes the same observable result), so it stays in provenance metadata and may safely disappear
// on install, degrading only to fresh instantiation.
import {bytesValue, canonicalizeValue, isObjectRef, textValue} from '../value/index.js';
import {normalizeMetadata} from '../object/model.js';
import {base64Decode} from '../support/portable-bytes.js';
import {
  WASM_BINARY_V1,
  WASM_IMPLEMENTATION_DEPENDENCY_ROLE,
  assertWasmModuleArtifact as assertWasmModuleV1Artifact,
} from '../code/wasm-artifacts.js';

const WASM_MODULE_V1 = 'wasm-module/v1';
const WASM_MODULE_V2 = 'wasm-module/v2';
const CONTRACT_KEYS = Object.freeze(['abi', 'closureSites', 'effectSites', 'functions', 'literals', 'sendSites']);
// Single-function compilations used to mirror their sole descriptor's entry/parameters/captures/
// cellBindings at the top level of v1 metadata. They are SEMANTIC mirrors of functions[0], so they
// never enter v2 provenance metadata: a v2 module has exactly one authority for them (content).
const SEMANTIC_MIRROR_KEYS = Object.freeze(['entry', 'parameters', 'captures', 'cellBindings']);
const WASM_MODULE_CONTRACT_KEYS = CONTRACT_KEYS;
const WASM_MODULE_SEMANTIC_MIRROR_KEYS = SEMANTIC_MIRROR_KEYS;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

// Deterministic serialization: keys sorted at every level so the descriptor's content bytes — and
// therefore its identity — never drift with object construction order. Not ordinary
// JSON.stringify, whose key order follows insertion.
function canonicalJson(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new TypeError('module contract contains a non-canonical value');
}

// Validate + freeze the executable contract (order-independent). The function descriptors keep the
// shape the executors already require (executor.js normalizeModuleFunctions), so this owner defines
// the schema once and the executors consume it.
function normalizeModuleContract(contract, label = 'WASM module contract') {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw new TypeError(`${label} must be an object`);
  const keys = Object.keys(contract).sort();
  if (keys.length !== CONTRACT_KEYS.length || keys.some((k, i) => k !== CONTRACT_KEYS[i])) {
    throw new TypeError(`${label} must contain exactly ${CONTRACT_KEYS.join(', ')}`);
  }
  const functions = requiredArray(contract.functions, `${label}.functions`);
  if (functions.length === 0) throw new TypeError(`${label}.functions must be non-empty`);
  return Object.freeze({
    abi: requiredText(contract.abi, `${label}.abi`),
    literals: Object.freeze([...requiredArray(contract.literals, `${label}.literals`)]),
    functions: Object.freeze(functions.map((descriptor, index) => normalizeFunctionDescriptor(descriptor, `${label}.functions[${index}]`))),
    sendSites: Object.freeze([...requiredArray(contract.sendSites, `${label}.sendSites`)]),
    closureSites: Object.freeze([...requiredArray(contract.closureSites, `${label}.closureSites`)]),
    effectSites: Object.freeze([...requiredArray(contract.effectSites, `${label}.effectSites`)]),
  });
}

// `cellBindings` is ABI-specific: the lexical-cell ABIs (value-handle-abi/v1, resumable v2) require
// it on every descriptor and the v0 ABIs require its ABSENCE (both executor families check exact
// keys). It is therefore preserved exactly as the compiler emitted it — present or absent — never
// defaulted, so the executors' exact-key contracts hold for either ABI family.
function normalizeFunctionDescriptor(descriptor, label) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new TypeError(`${label} must be an object`);
  return Object.freeze({
    entry: requiredText(descriptor.entry, `${label}.entry`),
    memberIndex: descriptor.memberIndex,
    parameters: descriptor.parameters,
    captures: Object.freeze([...requiredArray(descriptor.captures, `${label}.captures`)]),
    ...(Object.hasOwn(descriptor, 'cellBindings')
      ? {cellBindings: Object.freeze([...requiredArray(descriptor.cellBindings, `${label}.cellBindings`)])}
      : {}),
    sendSiteIndices: Object.freeze([...requiredArray(descriptor.sendSiteIndices, `${label}.sendSiteIndices`)]),
    closureSiteIndices: Object.freeze([...requiredArray(descriptor.closureSiteIndices, `${label}.closureSiteIndices`)]),
  });
}

// The v2 descriptor's canonical content bytes, from a validated contract.
function encodeModuleContractContent(contract) {
  return canonicalJson(normalizeModuleContract(contract));
}

function implementationRef(artifact) {
  const deps = (artifact.dependencies ?? []).filter((d) => d.role === WASM_IMPLEMENTATION_DEPENDENCY_ROLE);
  if (deps.length !== 1) throw new TypeError(`${WASM_MODULE_V2} must have exactly one ${WASM_IMPLEMENTATION_DEPENDENCY_ROLE} dependency`);
  const ref = canonicalizeValue(deps[0].artifact);
  if (!isObjectRef(ref)) throw new TypeError(`${WASM_MODULE_V2} implementation must be an unpinned object ref`);
  return ref;
}

function assertWasmModuleV2Artifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_MODULE_V2) {
    throw new TypeError(`artifact is not ${WASM_MODULE_V2}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError(`${WASM_MODULE_V2} content must be a canonical-JSON text Value`);
  normalizeModuleContract(JSON.parse(artifact.content.value), `${WASM_MODULE_V2} content`);
  implementationRef(artifact);
  return artifact;
}

// Either durable version of a compiled module. v1 is validated by its frozen contract owner
// (src/code/wasm-artifacts.js), v2 by this module.
function assertWasmModuleArtifactAnyVersion(artifact) {
  if (artifact?.representation === WASM_MODULE_V2) return assertWasmModuleV2Artifact(artifact);
  if (artifact?.representation === WASM_MODULE_V1) return assertWasmModuleV1Artifact(artifact);
  throw new TypeError(`not a WASM module artifact: ${artifact?.representation ?? 'missing'}`);
}

// The executable contract WITHOUT the bytes — what a compile-side reader (function assembly, tree
// installation) needs. Synchronous: neither version requires resolving the implementation to know
// its abi, literals, sites or function table.
function readModuleDescriptor(artifact) {
  if (artifact?.representation === WASM_MODULE_V2) {
    assertWasmModuleV2Artifact(artifact);
    return normalizeModuleContract(JSON.parse(artifact.content.value), `${WASM_MODULE_V2} content`);
  }
  if (artifact?.representation === WASM_MODULE_V1) {
    // Frozen v1: contract in provenance metadata. Decoded leniently exactly as before (the v1
    // executors validate the schema themselves), never through the v2 normalizer.
    if (artifact.content?.kind !== 'bytes') throw new TypeError(`${WASM_MODULE_V1} content must be a bytes Value`);
    const md = artifact.metadata ?? {};
    return Object.freeze({
      abi: requiredText(md.abi, `${WASM_MODULE_V1} metadata.abi`),
      literals: Object.freeze([...(md.literals ?? [])]),
      functions: Object.freeze([...(md.functions ?? [])]),
      sendSites: Object.freeze([...(md.sendSites ?? [])]),
      closureSites: Object.freeze([...(md.closureSites ?? [])]),
      effectSites: Object.freeze([...(md.effectSites ?? [])]),
    });
  }
  throw new TypeError(`not a WASM module artifact: ${artifact?.representation ?? 'missing'}`);
}

// THE canonical accessor. Returns {bytes, abi, literals, functions, sendSites, closureSites,
// effectSites} for either version. `resolveImplementation(ref)` fetches the raw bytes artifact for
// v2 (an executor passes context.images.getCodeArtifact); it is never called for v1.
async function readModuleContract(artifact, {resolveImplementation} = {}) {
  const descriptor = readModuleDescriptor(artifact);
  if (artifact.representation === WASM_MODULE_V2) {
    if (typeof resolveImplementation !== 'function') {
      throw new TypeError(`${WASM_MODULE_V2} requires resolveImplementation(ref) to read its bytes`);
    }
    const ref = implementationRef(artifact);
    const impl = await resolveImplementation(ref);
    if (!impl || impl.content?.kind !== 'bytes') {
      throw new TypeError(`${WASM_MODULE_V2} implementation ${ref.imageId}/${ref.objectId} must be a bytes artifact`);
    }
    return Object.freeze({bytes: base64Decode(impl.content.base64), ...descriptor});
  }
  return Object.freeze({bytes: base64Decode(artifact.content.base64), ...descriptor});
}

// Select one function of a module's contract by entry name or member index. The ONE lookup every
// compile-side reader (function assembly, tree installation, class builder) uses.
function moduleFunctionOf(descriptor, {entry, memberIndex} = {}) {
  const functions = descriptor?.functions ?? [];
  const found = entry !== undefined
    ? functions.find((candidate) => candidate?.entry === entry)
    : functions.find((candidate) => candidate?.memberIndex === memberIndex);
  if (!found) {
    throw new TypeError(`WASM module function not found: ${entry !== undefined ? `entry ${entry}` : `member ${memberIndex}`}`);
  }
  return found;
}

// A single-source compilation exports exactly one function; that is the entry a function artifact
// derived from it selects. Replaces the old top-level metadata.entry mirror.
function soleModuleEntry(descriptor) {
  const functions = descriptor?.functions ?? [];
  if (functions.length !== 1) throw new TypeError(`WASM module exports ${functions.length} functions; expected exactly one`);
  return functions[0].entry;
}

// THE durable v2 graph for one compilation, described ONCE here (the representation owner) as a
// generic compilation RESULT GRAPH the CompilationService persists atomically:
//   'implementation'  wasm-binary/v1  — the exact compiled bytes, the neutral raw-byte owner
//   'module'          wasm-module/v2  — canonical-JSON contract + ONE role:implementation dependency
// Compilers hand in compilation FACTS {bytes, contract, metadata}; they never build artifacts.
// `metadata` is provenance only: a contract field or a semantic mirror there is refused, so the
// descriptor content stays the single authority for meaning.
function describeWasmModuleV2Result({languageId = null, bytes, contract, metadata = {}} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TypeError('WASM module bytes must be a non-empty Uint8Array');
  const normalized = normalizeModuleContract(contract);
  const provenance = normalizeMetadata(metadata, `${WASM_MODULE_V2} provenance metadata`);
  for (const key of [...CONTRACT_KEYS, ...SEMANTIC_MIRROR_KEYS]) {
    if (Object.hasOwn(provenance, key)) {
      throw new TypeError(`${WASM_MODULE_V2} provenance metadata must not carry the semantic field ${key}`);
    }
  }
  return Object.freeze({
    languageId,
    primary: 'module',
    artifacts: Object.freeze([
      Object.freeze({key: 'implementation', representation: WASM_BINARY_V1, content: bytesValue(bytes), dependencies: [], metadata: {}}),
      Object.freeze({
        key: 'module',
        representation: WASM_MODULE_V2,
        content: textValue(canonicalJson(normalized)),
        dependencies: [{role: WASM_IMPLEMENTATION_DEPENDENCY_ROLE, artifact: 'implementation'}],
        metadata: provenance,
      }),
    ]),
  });
}

export {
  WASM_IMPLEMENTATION_DEPENDENCY_ROLE,
  WASM_MODULE_CONTRACT_KEYS,
  WASM_MODULE_SEMANTIC_MIRROR_KEYS,
  WASM_MODULE_V1,
  WASM_MODULE_V2,
  assertWasmModuleArtifactAnyVersion,
  assertWasmModuleV2Artifact,
  canonicalJson,
  describeWasmModuleV2Result,
  encodeModuleContractContent,
  implementationRef,
  moduleFunctionOf,
  normalizeModuleContract,
  readModuleContract,
  readModuleDescriptor,
  soleModuleEntry,
};
