import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// PUBLIC COMPOSITION SEAM proof (Object Environment 3zb-B1b).
//
// A portable host must be able to compose the portable runtime through ONE public
// entrypoint. `src/portable-runtime.js` documents that the host installs its sync
// crypto provider via `setDefaultCryptoProvider` before composing — so that
// configuration operation must be reachable from that same entrypoint, never from a
// private `src/support/*` module path.
//
// Everything the portable host does here goes through `../src/portable-runtime.js`.
// The one deep import below is a HARNESS assertion (function identity), not a
// composition step.
import {createPortableRuntime, setDefaultCryptoProvider} from '../src/portable-runtime.js';
import {setDefaultCryptoProvider as ownedSetDefaultCryptoProvider} from '../src/support/default-crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(HERE, '..', 'src', 'portable-runtime.js');

// A minimal valid provider: the narrow synchronous contract only, no node:crypto.
// Deterministic on purpose — this proves the SEAM, not crypto quality.
function createTestCryptoProvider() {
  let counter = 0;
  return {
    secureRandomBytes: (length) => Uint8Array.from({length}, (_, i) => (i + 7) & 0xff),
    sha256: (bytes) => Uint8Array.from({length: 32}, (_, i) => (bytes.length + i) & 0xff),
    aes256gcmEncrypt: ({plaintext}) => ({
      ciphertext: Uint8Array.from(plaintext),
      tag: new Uint8Array(16),
    }),
    aes256gcmDecrypt: ({ciphertext}) => Uint8Array.from(ciphertext),
    uuid: () => `test-uuid-${counter += 1}`,
  };
}

// This file runs in its own process, so NOTHING is installed yet. That is exactly
// the state a fresh portable host starts in — no reset hook needed to reach it.
test('1. createPortableRuntime() with no installed provider refuses with the explicit error', async () => {
  await assert.rejects(
    createPortableRuntime({backend: {mode: 'mock'}}),
    /no crypto provider installed/,
    'the existing explicit refusal, unchanged',
  );
});

test('2+3. installing a provider through the portable-runtime export lets composition succeed', async () => {
  // The whole point: the host reaches this from the public entrypoint.
  setDefaultCryptoProvider(createTestCryptoProvider());
  const runtime = await createPortableRuntime({backend: {mode: 'mock'}});
  try {
    assert.ok(runtime.images, 'composed runtime exposes the image service');
    assert.ok(runtime.authority, 'composed runtime exposes the authority service');
    assert.ok(runtime.executor, 'composed runtime exposes the activation executor');
  } finally {
    await runtime.close();
  }
});

test('4. a malformed provider still fails through the existing Images-owned validator', () => {
  assert.throws(() => setDefaultCryptoProvider({}), /crypto provider must supply secureRandomBytes\(\)/);
  assert.throws(() => setDefaultCryptoProvider(null), /crypto provider must be an object/);
  const missingUuid = createTestCryptoProvider();
  delete missingUuid.uuid;
  assert.throws(() => setDefaultCryptoProvider(missingUuid), /crypto provider must supply uuid\(\)/);
});

test('the export is the SAME function default-crypto.js owns — a re-export, not a wrapper', () => {
  assert.equal(
    setDefaultCryptoProvider,
    ownedSetDefaultCryptoProvider,
    'portable-runtime.js must re-export the owning function itself, never re-implement or wrap it',
  );
});

test('5. the seam adds no node:* import to the portable entrypoint', () => {
  // The full transitive closure walk lives in `portable-runtime.test.js`; this guards
  // the file the repair touched.
  const source = readFileSync(ENTRYPOINT, 'utf8');
  const specs = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specs.length > 15, 'the entrypoint really does import the portable subsystems');
  assert.deepEqual(specs.filter((spec) => spec.startsWith('node:')), []);
});
