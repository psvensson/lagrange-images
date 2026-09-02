// The ONE owner of "which source modules constitute the portable runtime" (bead
// lagrange-images-z42). PORTABLE — no Node imports, no filesystem knowledge.
//
// This module owns the STATIC ESM closure rule and nothing else. It is the single
// definition of what a static import MEANS for portability purposes, so the
// structural portability proof (`test/portable-runtime.test.js`) and the shipped
// artifact (`portable-runtime-artifact.js`) can never disagree about which modules
// are portable: the thing proven and the thing shipped are computed here, once.
//
// It never reads a file. The caller supplies `readSource(logicalPath)`, which
// returns the exact UTF-8 source or `null`/`undefined` when the path does not
// exist. Logical paths are repo-relative POSIX paths (`src/portable-runtime.js`);
// no absolute checkout path, mtime, inode or enumeration order can reach the
// closure, which is what makes artifact construction deterministic.
//
// STATIC MEANING (unchanged from the structural proof PR #163 established):
//   import ... from 'x' | export ... from 'x' | import 'x'   -> static, followed
//   import('x')                                              -> DYNAMIC, reported,
//                                                               never followed
// A dynamic specifier is deliberately NOT part of the closure. `create-backend.js`
// reaches an optional host integration through `await import(specifier)` on a
// VARIABLE — gated by the backend mode and catching ERR_MODULE_NOT_FOUND — so it is
// invisible to static analysis by construction and is a host capability boundary,
// not a portable dependency. Widening the closure to chase it would ship modules
// the portability proof never proved.
//
// Traversal REPORTS violations rather than throwing, because the structural proof
// must be able to walk a deliberately NON-portable root (`src/runtime.js`) and see
// its node:* offenders. The artifact owner is what refuses to build when the
// violation list is non-empty.

// Static forms: `import ... from 'x'`, `export ... from 'x'`, and the side-effect
// form `import 'x'`. Dynamic literal `import('x')` is captured separately so it can
// be reported without being followed.
const STATIC_FROM_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
const STATIC_BARE_RE = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Resolution candidates, in the order Node would try them for a relative ESM
// specifier in this repo's layout.
function resolutionCandidates(base) {
  return [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`];
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

// POSIX logical-path join + normalize. Returns null when the result escapes above
// the repo root (a `..` escape), which the artifact owner treats as a violation
// rather than silently clamping.
function resolveLogicalPath(fromPath, specifier) {
  const segments = fromPath.split('/').slice(0, -1).concat(specifier.split('/'));
  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? null : out.join('/');
}

function scanModuleSpecifiers(source) {
  const staticSpecifiers = [];
  const dynamicSpecifiers = [];
  for (const match of source.matchAll(STATIC_FROM_RE)) staticSpecifiers.push(match[1]);
  for (const match of source.matchAll(STATIC_BARE_RE)) staticSpecifiers.push(match[1]);
  for (const match of source.matchAll(DYNAMIC_RE)) dynamicSpecifiers.push(match[1]);
  return {staticSpecifiers, dynamicSpecifiers};
}

// Walk the complete static transitive closure from `entry`.
//
// Returns:
//   modules   [{path, source}] in CANONICAL order (logical path, code-unit sort)
//   entry     the normalized entry path
//   dynamic   [{path, specifier}] reported, never followed
//   violations[{path, specifier, reason}] with reason in:
//               'node-builtin'  a `node:*` static import
//               'bare'          a bare (npm/builtin) static import
//               'unresolved'    a relative static import that resolves to nothing
//               'escape'        a relative static import leaving the source root
//
// `sourceRoot`, when given, is the logical prefix every closure member must stay under
// (the artifact passes 'src/'). A dependency that resolves outside it is an 'escape'
// violation in its own right, not something a later path check happens to catch.
function collectStaticModuleClosure({entry, readSource, sourceRoot} = {}) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new TypeError('entry must be a non-empty logical path');
  }
  if (typeof readSource !== 'function') {
    throw new TypeError('readSource(logicalPath) must be a function');
  }

  const sources = new Map();
  const dynamic = [];
  const violations = [];
  const queue = [entry];
  const seen = new Set([entry]);

  while (queue.length > 0) {
    const path = queue.shift();
    const source = readSource(path);
    if (typeof source !== 'string') {
      violations.push({path, specifier: path, reason: 'unresolved'});
      continue;
    }
    sources.set(path, source);

    const {staticSpecifiers, dynamicSpecifiers} = scanModuleSpecifiers(source);
    for (const specifier of dynamicSpecifiers) dynamic.push({path, specifier});

    for (const specifier of staticSpecifiers) {
      if (specifier.startsWith('node:')) {
        violations.push({path, specifier, reason: 'node-builtin'});
        continue;
      }
      if (!isRelativeSpecifier(specifier)) {
        violations.push({path, specifier, reason: 'bare'});
        continue;
      }
      const base = resolveLogicalPath(path, specifier);
      if (base === null) {
        violations.push({path, specifier, reason: 'escape'});
        continue;
      }
      if (typeof sourceRoot === 'string' && !base.startsWith(sourceRoot)) {
        violations.push({path, specifier, reason: 'escape'});
        continue;
      }
      let resolved = null;
      for (const candidate of resolutionCandidates(base)) {
        if (typeof readSource(candidate) === 'string') {
          resolved = candidate;
          break;
        }
      }
      if (resolved === null) {
        violations.push({path, specifier, reason: 'unresolved'});
        continue;
      }
      if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }

  const modules = [...sources.keys()]
    .sort()
    .map((path) => ({path, source: sources.get(path)}));
  return {entry, modules, dynamic, violations};
}

export {
  collectStaticModuleClosure,
  resolveLogicalPath,
  resolutionCandidates,
  scanModuleSpecifiers,
};
