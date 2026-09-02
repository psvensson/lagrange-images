// The producer entrypoint for `lagrange-images-portable-runtime/v1` (bead
// lagrange-images-z42).
//
// This is a thin shell over the library producer — `buildPortableRuntimeArtifact` +
// `canonicalPortableRuntimeArtifactJson` — and deliberately NOT packaging or publishing
// infrastructure. It exists because the consumer's actual use case is "give me the
// artifact bytes": Images generates them from its own source tree, the consumer embeds
// them and evaluates the artifact's `entry`. Nothing here decides format, closure or
// validity; the artifact owner does.
//
//   node scripts/build-portable-runtime-artifact.mjs > portable-runtime.v1.json
//   node scripts/build-portable-runtime-artifact.mjs --identity
//   node scripts/build-portable-runtime-artifact.mjs --source-revision "$(git rev-parse HEAD)"
//
// Default output is the CANONICAL material bytes, so two runs from any two checkouts are
// byte-identical. `--source-revision` switches to an envelope that additionally records
// build provenance; provenance stays OUTSIDE the canonical material and therefore outside
// contentIdentity, so identical source material keeps one identity across commits.

import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNodeSourceReader} from '../src/portable-artifact/node-source-reader.js';
import {
  buildPortableRuntimeArtifact,
  canonicalPortableRuntimeArtifactJson,
  portableRuntimeArtifactIdentity,
} from '../src/portable-artifact/portable-runtime-artifact.js';
import {setDefaultCryptoProvider} from '../src/portable-runtime.js';
import {createNodeCryptoProvider} from '../src/support/node-crypto-provider.js';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const sourceRoot = argValue('--source-root')
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRevision = argValue('--source-revision');

setDefaultCryptoProvider(createNodeCryptoProvider());

const artifact = buildPortableRuntimeArtifact({
  readSource: createNodeSourceReader(sourceRoot),
  provenance: sourceRevision === undefined ? undefined : {sourceRevision},
});

if (process.argv.includes('--identity')) {
  process.stdout.write(`${portableRuntimeArtifactIdentity(artifact)}\n`);
} else if (sourceRevision !== undefined) {
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
} else {
  process.stdout.write(canonicalPortableRuntimeArtifactJson(artifact));
}
