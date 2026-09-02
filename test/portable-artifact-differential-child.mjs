// The differential loader harness (bead lagrange-images-z42, slice B2).
//
// Runs the SAME B1b acceptance assertions under two loaders, changing ONLY where
// module source comes from:
//
//   --mode checkout   modules resolved from an Images source tree (the B1b probe shape)
//   --mode artifact   modules resolved ONLY from a lagrange-images-portable-runtime/v1
//                     artifact, linked in-process with vm.SourceTextModule
//
// The artifact loader has NO filesystem fallback: its link callback consults the
// artifact's module map and throws otherwise, so a module that is not in the artifact
// cannot be silently supplied by a checkout. That is what makes "delete a module from the
// artifact -> red" a real falsifier rather than a formality.
//
// Requires --experimental-vm-modules, which is why this runs as a child process of the
// ordinary `node --test` suite.

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {resolveLogicalPath, resolutionCandidates} from './portable-artifact-module-resolver.mjs';
import {runPortableAcceptance} from './portable-artifact-acceptance-assertions.mjs';

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const mode = argValue('--mode', 'artifact');

// Loader A: an Images source tree (what B1b's path-preserving probe does today).
function createCheckoutLoader(sourceRoot) {
  return async function load(logicalPath) {
    return import(pathToFileURL(resolve(sourceRoot, logicalPath)).href);
  };
}

// Loader B: the artifact, and nothing else.
function createArtifactLoader(artifact) {
  const map = new Map(artifact.modules.map(({path, source}) => [path, source]));
  const cache = new Map();

  function resolveFromArtifact(specifier, referencingPath) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      throw new Error(`artifact loader: refusing non-relative specifier '${specifier}' from ${referencingPath}`);
    }
    const base = resolveLogicalPath(referencingPath, specifier);
    if (base === null) {
      throw new Error(`artifact loader: specifier '${specifier}' escapes the artifact root`);
    }
    for (const candidate of resolutionCandidates(base)) {
      if (map.has(candidate)) return candidate;
    }
    throw new Error(`artifact loader: '${specifier}' from ${referencingPath} is not in the artifact`);
  }

  function moduleFor(logicalPath) {
    const cached = cache.get(logicalPath);
    if (cached !== undefined) return cached;
    const source = map.get(logicalPath);
    if (source === undefined) {
      throw new Error(`artifact loader: '${logicalPath}' is not in the artifact`);
    }
    const module = new vm.SourceTextModule(source, {
      identifier: logicalPath,
      importModuleDynamically() {
        throw new Error(`artifact loader: dynamic import is not part of the static portable closure`);
      },
    });
    cache.set(logicalPath, module);
    return module;
  }

  async function link(specifier, referencingModule) {
    return moduleFor(resolveFromArtifact(specifier, referencingModule.identifier));
  }

  return async function load(logicalPath) {
    const module = moduleFor(logicalPath);
    if (module.status === 'unlinked') await module.link(link);
    if (module.status !== 'evaluated') await module.evaluate();
    return module.namespace;
  };
}

async function main() {
  let load;
  if (mode === 'checkout') {
    load = createCheckoutLoader(argValue('--images-source-root', resolve(import.meta.dirname, '..')));
  } else {
    const artifact = JSON.parse(readFileSync(argValue('--artifact'), 'utf8'));
    load = createArtifactLoader(artifact);
  }
  const results = await runPortableAcceptance(load);
  process.stdout.write(JSON.stringify({ok: true, mode, results}));
}

// This file is a HARNESS, not a test. It lives under test/ next to the assertions it
// serves, so `node --test` collects it; without an explicit --mode it must therefore do
// nothing rather than run (and fail) with no arguments.
if (process.argv.includes('--mode')) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ok: false, mode, error: String(error && error.message || error)}));
    process.exitCode = 1;
  });
}
