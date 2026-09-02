// Node-side source reader for artifact construction (bead lagrange-images-z42).
//
// The ONLY Node-dependent piece of the artifact producer, and deliberately the
// dumbest: it maps a repo-relative POSIX logical path to bytes under a source root.
// It is NEVER imported by the portable closure — `portable-runtime.js` does not
// reach it — so `node:fs` stays out of the shipped artifact.
//
// IT NEVER ENUMERATES A DIRECTORY. Only paths the closure walker asks for are read,
// so filesystem ordering, inodes and mtimes cannot influence the artifact. The
// absolute source root is used to open files and is never recorded anywhere in the
// artifact, so two checkouts at different absolute paths produce identical bytes.

import {readFileSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

function createNodeSourceReader(sourceRoot) {
  if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) {
    throw new TypeError('sourceRoot must be a non-empty path');
  }
  return function readSource(logicalPath) {
    if (typeof logicalPath !== 'string' || logicalPath.length === 0) return undefined;
    // Refuse anything that is not a repo-relative POSIX logical path, so a malformed
    // specifier can never reach outside the source root through this reader.
    if (isAbsolute(logicalPath) || logicalPath.includes('\\')) return undefined;
    const segments = logicalPath.split('/');
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
      return undefined;
    }
    try {
      return readFileSync(join(sourceRoot, ...segments), 'utf8');
    } catch {
      return undefined;
    }
  };
}

export {createNodeSourceReader};
