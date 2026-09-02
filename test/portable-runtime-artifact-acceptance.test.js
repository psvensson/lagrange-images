import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createNodeSourceReader} from '../src/portable-artifact/node-source-reader.js';
import {
  PORTABLE_RUNTIME_ARTIFACT_ENTRY,
  buildPortableRuntimeArtifact,
  canonicalPortableRuntimeArtifactJson,
} from '../src/portable-artifact/portable-runtime-artifact.js';

// B2 handoff proof (bead lagrange-images-z42): the SAME B1b acceptance assertions run
// under two loaders, changing ONLY where module source comes from.
//
//   checkout loader  -- an Images source tree (today's probe)
//   artifact loader  -- a lagrange-images-portable-runtime/v1 artifact, linked in-process
//
// The assertions themselves live in `portable-artifact-acceptance-assertions.mjs` and are
// NOT touched by this slice: if packaging had absorbed semantics, they would have had to
// change, so their being shared and unchanged is itself the proof.

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CHILD = join(HERE, 'portable-artifact-differential-child.mjs');
const NONEXISTENT_CHECKOUT = join(tmpdir(), 'lagrange-images-does-not-exist-b2-proof');

function buildArtifact(options = {}) {
  return buildPortableRuntimeArtifact({readSource: createNodeSourceReader(REPO), ...options});
}

async function runChild(args, {cwd = REPO, script = CHILD} = {}) {
  try {
    const {stdout} = await execFileAsync(
      process.execPath, ['--experimental-vm-modules', script, ...args], {cwd, maxBuffer: 64 * 1024 * 1024},
    );
    return JSON.parse(stdout);
  } catch (error) {
    // A failing child still reports structured JSON on stdout.
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch { /* fall through to the raw failure */ }
    }
    return {ok: false, error: String(error.stderr || error.message)};
  }
}

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lagrange-b2-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

// Materialize a SELF-CONTAINED consumer directory: the artifact plus the harness, and a
// byte-identical copy of the Images-owned resolution rule (copied, never reimplemented --
// a consumer host implements this same documented rule in its own language).
function materializeConsumer(dir, artifact) {
  writeFileSync(join(dir, 'artifact.json'), canonicalPortableRuntimeArtifactJson(artifact));
  copyFileSync(CHILD, join(dir, 'child.mjs'));
  copyFileSync(join(HERE, 'portable-artifact-acceptance-assertions.mjs'),
    join(dir, 'portable-artifact-acceptance-assertions.mjs'));
  const resolverSource = readFileSync(join(REPO, 'src/portable-artifact/module-closure.js'), 'utf8');
  writeFileSync(join(dir, 'module-closure.js'), resolverSource);
  writeFileSync(join(dir, 'portable-artifact-module-resolver.mjs'),
    "export {resolveLogicalPath, resolutionCandidates} from './module-closure.js';\n");
  // The copied rule must be byte-identical to the Images-owned owner.
  assert.equal(readFileSync(join(dir, 'module-closure.js'), 'utf8'), resolverSource);
  return join(dir, 'child.mjs');
}

test('B2 DIFFERENTIAL: checkout loader and artifact loader produce identical acceptance results', async () => {
  const artifact = buildArtifact();
  await withTempDir(async (dir) => {
    const artifactPath = join(dir, 'artifact.json');
    writeFileSync(artifactPath, canonicalPortableRuntimeArtifactJson(artifact));

    const checkout = await runChild(['--mode', 'checkout', '--images-source-root', REPO]);
    const fromArtifact = await runChild(['--mode', 'artifact', '--artifact', artifactPath]);

    assert.ok(checkout.ok, `checkout loader failed: ${checkout.error}`);
    assert.ok(fromArtifact.ok, `artifact loader failed: ${fromArtifact.error}`);

    // The whole B1b assertion set, identical across the module boundary.
    assert.deepEqual(fromArtifact.results, checkout.results,
      'artifact-loaded runtime must behave identically to checkout-loaded runtime');

    // Spot-check that the retained proofs really ran (not an empty record compared to itself).
    for (const key of ['refusesWithoutProvider', 'malformedProviderRejected', 'composed',
      'typeFingerprintDiscriminates', 'uuidPath', 'secureRandomness', 'aesTagFalsifier',
      'shaFalsifierDiscriminates']) {
      assert.equal(fromArtifact.results[key], true, `${key} must hold under the artifact loader`);
    }
    assert.equal(fromArtifact.results.cursorMintResume, 1, 'cursor mint/resume saw the one mutation');
    assert.equal(fromArtifact.results.rereadAfterObserve, 'a-v2');
    assert.equal(fromArtifact.results.typeFingerprintBytes, 32, 'real 32-byte SHA fingerprint');
  });
});

test('B2 PUBLIC SEAM: the artifact exposes the SAME portable crypto seam, with no support/* path', async () => {
  const artifact = buildArtifact();
  const paths = new Set(artifact.modules.map(({path}) => path));
  // The private module is SHIPPED (the runtime needs it) but the consumer never has to
  // NAME it: the entry re-exports the seam.
  assert.ok(paths.has('src/support/default-crypto.js'));

  const result = await withTempDir(async (dir) => {
    const script = materializeConsumer(dir, artifact);
    return runChild(['--mode', 'artifact', '--artifact', join(dir, 'artifact.json')], {cwd: dir, script});
  });
  assert.ok(result.ok, `artifact acceptance failed: ${result.error}`);
  assert.equal(result.results.hasCreatePortableRuntime, true);
  assert.equal(result.results.hasSetDefaultCryptoProvider, true);
  assert.equal(result.results.hasCreateRuntimeCore, true);
  assert.equal(result.results.hasCreatePortableCodeExecutorRegistry, true);
  assert.equal(result.results.malformedProviderRejected, true,
    'malformed providers still fail through the existing Images-owned validator');

  // The consumer harness never names a private Images module path.
  const consumerSource = readFileSync(CHILD, 'utf8')
    + readFileSync(join(HERE, 'portable-artifact-acceptance-assertions.mjs'), 'utf8');
  assert.ok(!consumerSource.includes('support/default-crypto.js'),
    'the consumer must not import the private crypto module path');
  assert.ok(!consumerSource.includes('support/crypto-provider.js'),
    'the consumer must not import the private provider-contract path');
});

test('B2 stx: the acceptance runs with NO Images checkout, and the no-checkout condition is non-vacuous', async () => {
  const artifact = buildArtifact();
  assert.ok(!existsSync(NONEXISTENT_CHECKOUT), 'the stand-in checkout path must genuinely not exist');

  const {fromArtifact, fromCheckout} = await withTempDir(async (dir) => {
    const script = materializeConsumer(dir, artifact);
    // Same self-contained directory, same process shape, same nonexistent source root.
    // Only the loader differs.
    return {
      fromArtifact: await runChild(
        ['--mode', 'artifact', '--artifact', join(dir, 'artifact.json'),
          '--images-source-root', NONEXISTENT_CHECKOUT],
        {cwd: dir, script},
      ),
      fromCheckout: await runChild(
        ['--mode', 'checkout', '--images-source-root', NONEXISTENT_CHECKOUT],
        {cwd: dir, script},
      ),
    };
  });

  // The artifact path works with no Images source tree anywhere.
  assert.ok(fromArtifact.ok, `artifact loader must work with no checkout: ${fromArtifact.error}`);
  assert.equal(fromArtifact.results.composed, true);
  assert.equal(fromArtifact.results.cursorMintResume, 1);

  // FALSIFIER: switching that SAME run back to sibling-checkout loading is red, which is
  // what makes the no-checkout claim non-vacuous -- the artifact run cannot have been
  // quietly satisfied by a checkout, because there is none to satisfy it.
  assert.equal(fromCheckout.ok, false, 'checkout loading must fail when no checkout exists');
});

test('B2 FALSIFIER: deleting a module from the artifact makes the artifact load red', async () => {
  const artifact = buildArtifact();
  const damaged = {
    ...artifact,
    modules: artifact.modules.filter(({path}) => path !== 'src/support/default-crypto.js'),
  };
  const result = await withTempDir(async (dir) => {
    const path = join(dir, 'artifact.json');
    writeFileSync(path, JSON.stringify(damaged));
    return runChild(['--mode', 'artifact', '--artifact', path]);
  });
  assert.equal(result.ok, false, 'a missing closure member must fail the load');
  assert.match(result.error, /not in the artifact/,
    'the loader must refuse rather than fall back to a checkout');
});

test('B2 FALSIFIER: a stale pre-#174 root without setDefaultCryptoProvider fails the public seam', async () => {
  // Simulate the portable root as it was BEFORE the crypto-seam re-export landed: the
  // module still imports the owner, but does not re-export the configuration seam.
  const reference = buildArtifact();
  const map = new Map(reference.modules.map(({path, source}) => [path, source]));
  const staleEntry = map.get(PORTABLE_RUNTIME_ARTIFACT_ENTRY)
    .replace(/\n\s*\/\/ Re-export, NOT a re-implementation[\s\S]*?\n\s*setDefaultCryptoProvider,\n/, '\n');
  assert.notEqual(staleEntry, map.get(PORTABLE_RUNTIME_ARTIFACT_ENTRY), 'the stale variant must differ');
  assert.ok(!/^\s*setDefaultCryptoProvider,$/m.test(staleEntry), 'the stale variant drops the re-export');
  map.set(PORTABLE_RUNTIME_ARTIFACT_ENTRY, staleEntry);

  const stale = buildPortableRuntimeArtifact({readSource: (path) => map.get(path)});
  const result = await withTempDir(async (dir) => {
    const path = join(dir, 'artifact.json');
    writeFileSync(path, canonicalPortableRuntimeArtifactJson(stale));
    return runChild(['--mode', 'artifact', '--artifact', path]);
  });
  assert.equal(result.ok, false, 'a pre-#174 root must fail the public-seam acceptance');
  assert.match(result.error, /setDefaultCryptoProvider/);
});
