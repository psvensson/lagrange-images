// The ONE owner of the `lagrange-images-portable-runtime/v1` artifact format,
// deterministic construction, canonical identity and validation (bead
// lagrange-images-z42). PORTABLE — no Node imports, no filesystem access.
//
// PACKAGING/PROVENANCE ONLY. This module owns no runtime semantics whatsoever. It
// ships the EXACT source of the modules Images already proves portable; the
// semantic owners are unchanged (`src/portable-runtime.js` is THE portable
// composition root, `support/default-crypto.js` owns active-provider installation,
// `support/crypto-provider.js` owns provider validation).
//
// THE ENTRY IS THE REAL MODULE. `entry` is `src/portable-runtime.js` itself — the
// actual composition root source, not a generated wrapper. The artifact therefore
// exposes exactly what the portable root exposes (currently
// `createPortableRuntime`, `createRuntimeCore`, `createPortableCodeExecutorRegistry`,
// `setDefaultCryptoProvider`), and a consumer needs no `src/support/*` path.
//
// THE ESM GRAPH IS PRESERVED EXACTLY. One entry per closure module, each carrying
// byte-exact UTF-8 source with its relative import specifiers untouched. No
// concatenation, bundling, tree-shaking, transpilation or specifier rewriting: the
// module structure and its cycles are semantically load-bearing (a consumer-side
// module-linker defect in that exact area is what motivated this artifact), so the
// graph that runs must be the graph Images tests. A consumer resolves the preserved
// specifiers against the artifact's own logical paths.
//
// DETERMINISM. The canonical material is `{format, entry, modules}` with modules in
// logical-path order, encoded as canonical JSON. Nothing else can enter it: no
// absolute checkout path, mtime, inode, enumeration order, generation time or
// consumer-specific loader data. The same source tree therefore yields byte-identical
// output from any checkout path, temp directory or filesystem ordering.
//
// PROVENANCE IS NOT MATERIAL IDENTITY. An optional `provenance` field may record the
// source revision an artifact was generated from, but it is EXCLUDED from the
// canonical material and therefore from `contentIdentity`. Identical source material
// must not become different portable-runtime material merely because it was
// committed under another SHA.

import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {bytesToHex, utf8Encode} from '../support/portable-bytes.js';
import {collectStaticModuleClosure} from './module-closure.js';

const PORTABLE_RUNTIME_ARTIFACT_FORMAT = 'lagrange-images-portable-runtime/v1';
const PORTABLE_RUNTIME_ARTIFACT_ENTRY = 'src/portable-runtime.js';
// Every artifact module must live under this logical source root; a closure member
// outside it is an escape, not a portable dependency.
const PORTABLE_RUNTIME_ARTIFACT_SOURCE_ROOT = 'src/';

class PortableRuntimeArtifactError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PortableRuntimeArtifactError';
    Object.assign(this, details);
  }
}

function fail(message, details) {
  throw new PortableRuntimeArtifactError(message, details);
}

// Canonical JSON, identical in meaning to the graph bundle's: object keys in
// code-unit order, arrays in semantic order. ONE encoding, so producer and any
// verifier hash the same bytes.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// A canonical logical path: repo-relative POSIX, under the source root, with no
// absolute form, no `.`/`..` segment, no empty segment, no backslash.
function isCanonicalLogicalPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes('\\')) return false;
  if (!path.startsWith(PORTABLE_RUNTIME_ARTIFACT_SOURCE_ROOT)) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

// The canonical MATERIAL: exactly what identity is computed over. Provenance and any
// other envelope field is excluded here, by construction.
function portableRuntimeArtifactMaterial(artifact) {
  return {
    format: artifact.format,
    entry: artifact.entry,
    modules: artifact.modules.map(({path, source}) => ({path, source})),
  };
}

function canonicalPortableRuntimeArtifactJson(artifact) {
  return canonicalJson(portableRuntimeArtifactMaterial(artifact));
}

function portableRuntimeArtifactBytes(artifact) {
  return utf8Encode(canonicalPortableRuntimeArtifactJson(artifact));
}

// contentIdentity: SHA-256 over the canonical material bytes, via the active crypto
// provider — the same `sha256:<hex>` shape the graph bundle uses.
function portableRuntimeArtifactIdentity(artifact, {crypto} = {}) {
  const activeCrypto = crypto ?? getDefaultCryptoProvider();
  return `sha256:${bytesToHex(activeCrypto.sha256(portableRuntimeArtifactBytes(artifact)))}`;
}

// A loader-friendly view: logical path -> exact source. This is the shape a consumer
// host feeds its embedded module loader.
function portableRuntimeArtifactModuleMap(artifact) {
  return new Map(artifact.modules.map(({path, source}) => [path, source]));
}

// THE validator/parser for v1. A malformed artifact must be rejected HERE, by Images,
// never discovered by a consumer's loader during evaluation.
function assertPortableRuntimeArtifactV1(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    fail('artifact must be an object');
  }
  if (artifact.format !== PORTABLE_RUNTIME_ARTIFACT_FORMAT) {
    fail('artifact format must be ' + PORTABLE_RUNTIME_ARTIFACT_FORMAT, {format: artifact.format});
  }
  if (!Array.isArray(artifact.modules) || artifact.modules.length === 0) {
    fail('artifact modules must be a non-empty array');
  }
  if (artifact.provenance !== undefined
      && (!artifact.provenance || typeof artifact.provenance !== 'object' || Array.isArray(artifact.provenance))) {
    fail('artifact provenance, when present, must be an object');
  }

  const seen = new Set();
  let previous = null;
  for (const module of artifact.modules) {
    if (!module || typeof module !== 'object' || Array.isArray(module)) {
      fail('every artifact module must be an object');
    }
    if (!isCanonicalLogicalPath(module.path)) {
      fail('artifact module path is not a canonical logical path under ' + PORTABLE_RUNTIME_ARTIFACT_SOURCE_ROOT,
        {path: module.path});
    }
    if (typeof module.source !== 'string') {
      fail('artifact module source must be a string', {path: module.path});
    }
    if (seen.has(module.path)) {
      fail('duplicate artifact module path', {path: module.path});
    }
    seen.add(module.path);
    if (previous !== null && module.path <= previous) {
      fail('artifact modules must be in canonical logical-path order', {path: module.path, previous});
    }
    previous = module.path;
  }

  if (!isCanonicalLogicalPath(artifact.entry)) {
    fail('artifact entry is not a canonical logical path', {entry: artifact.entry});
  }
  if (!seen.has(artifact.entry)) {
    fail('artifact entry is not present in artifact modules', {entry: artifact.entry});
  }

  // The declared closure must MATCH the shipped modules exactly: walking the
  // artifact's own sources from its own entry, using only the artifact as the source
  // of truth, must reach every shipped module and nothing else, with no violation.
  const map = portableRuntimeArtifactModuleMap(artifact);
  const {modules: reached, violations} = collectStaticModuleClosure({
    entry: artifact.entry,
    readSource: (path) => map.get(path),
    sourceRoot: PORTABLE_RUNTIME_ARTIFACT_SOURCE_ROOT,
  });
  if (violations.length > 0) {
    const [first] = violations;
    fail(`artifact closure violation (${first.reason}): ${first.specifier} in ${first.path}`, {violations});
  }
  const reachedPaths = reached.map(({path}) => path);
  for (const path of reachedPaths) {
    if (!seen.has(path)) fail('artifact closure reaches a module the artifact does not contain', {path});
  }
  if (reachedPaths.length !== artifact.modules.length) {
    const extra = artifact.modules.map(({path}) => path).filter((path) => !reachedPaths.includes(path));
    fail('artifact contains modules outside the declared closure', {extra});
  }
  return artifact;
}

// Build the artifact from a source tree, deterministically. `readSource(logicalPath)`
// returns exact UTF-8 source or undefined; the builder reads ONLY what the closure
// demands, so no directory enumeration can influence the result. The built artifact
// is validated before it is returned — an artifact that would not survive validation
// is never produced.
function buildPortableRuntimeArtifact({readSource, entry = PORTABLE_RUNTIME_ARTIFACT_ENTRY, provenance} = {}) {
  if (typeof readSource !== 'function') {
    throw new TypeError('readSource(logicalPath) must be a function');
  }
  const {modules, violations} = collectStaticModuleClosure({
    entry, readSource, sourceRoot: PORTABLE_RUNTIME_ARTIFACT_SOURCE_ROOT,
  });
  if (violations.length > 0) {
    const [first] = violations;
    fail(`portable closure violation (${first.reason}): ${first.specifier} in ${first.path}`, {violations});
  }
  const artifact = {
    format: PORTABLE_RUNTIME_ARTIFACT_FORMAT,
    entry,
    modules,
  };
  if (provenance !== undefined) artifact.provenance = provenance;
  return assertPortableRuntimeArtifactV1(artifact);
}

export {
  PORTABLE_RUNTIME_ARTIFACT_ENTRY,
  PORTABLE_RUNTIME_ARTIFACT_FORMAT,
  PORTABLE_RUNTIME_ARTIFACT_SOURCE_ROOT,
  PortableRuntimeArtifactError,
  assertPortableRuntimeArtifactV1,
  buildPortableRuntimeArtifact,
  canonicalPortableRuntimeArtifactJson,
  portableRuntimeArtifactBytes,
  portableRuntimeArtifactIdentity,
  portableRuntimeArtifactMaterial,
  portableRuntimeArtifactModuleMap,
};
