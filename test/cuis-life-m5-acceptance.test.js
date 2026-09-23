// The M5.2 acceptance witness (bead lagrange-images-nfv1.3).
//
// THE CLAIM UNDER TEST: a Life package captured once from the single pinned external source
// (Cuis-Smalltalk/Games @ 52aad9c5..., blob f9180bba..., sealed in bead lagrange-images-nfv1.1)
// can be recovered from Lagrange's durable release state, imported natively into a fresh image
// WITHOUT its source/toolchain environment, execute the frozen real blinker semantics, survive a
// complete runtime restart, and execute those same semantics again.
//
// DESIGN ENFORCEMENT BEYOND THE ASSERTIONS:
//
// - This file runs in the ORDINARY test lane. It reads NO integration environment, NO Games
//   checkout, NO .integration/ path, and composes every runtime WITHOUT a toolchain or
//   foreign-runtime provider (asserted before import and again after restart), so a hidden
//   "ask Cuis again" fallback could only fail, never silently succeed. The committed fixture
//   test/fixtures/life-m5-release.json — captured once by the real capture boundary
//   (scripts/capture-life-m5-fixture.mjs, proven by the nfv1.2 real-lane vertical) — is the
//   recovered-release input.
// - The fixture's package bytes are re-hashed here in node (the same Git blob identity upstream
//   publishes), and the manifest is re-answered from the recovered release record, so a stale or
//   hand-edited fixture cannot quietly pass.
// - The acceptance exercises the REAL imported implementation twice across a restart
//   (S0 -> S1 -> S0, the frozen oracle states of bead lagrange-images-nfv1.1): no
//   method-existence probes, no synthetic rule reimplementation, no precomputed answers, and no
//   LifeView construction — the acceptance is model-only and headless by construction.
// - Artifact metadata is ADR 0074 non-portable provenance: nothing in the recovery/restart path
//   reads it.
// - The installation sequence, the frozen fixture and the state reader are the ONE shared path in
//   test/support/life-m5-witness.js, which the M6 two-node witness composes unchanged: the M6
//   epic's prohibition ledger forbids a "distributed Life" variant of anything, so there is
//   exactly one spelling of how Life is installed and exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {readManagedProjectInstallation} from '../src/runtime.js';
import {
  CUIS_LIFE_BLOB,
  FROZEN_STATES,
  GAMES_COMMIT,
  assertProviderAbsence,
  composeFreshRuntime,
  installRecoveredLife,
  nativeGlobalsFor,
  resolveImportedClass,
  runBlinkerWitness,
  senderFor,
} from './support/life-m5-witness.js';

test('the recovered Life release installs, imports natively with no source environment, runs the frozen blinker oracle, and repeats it after a real restart', {timeout: 600_000}, async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/life-m5-release.json', import.meta.url), 'utf8'));
  assert.equal(fixture.recorded.upstream, `Cuis-Smalltalk/Games@${GAMES_COMMIT}`);
  assert.equal(fixture.recorded.packageBlob, CUIS_LIFE_BLOB);

  const directory = await mkdtemp(join(tmpdir(), 'lagrange-life-m5-'));
  const filename = join(directory, 'image.sqlite');
  const PROD = 'life-native';
  let releaseId = null;
  try {
    // --- Recovered-release side only. A fresh backend, a fresh image, the committed release.
    const witnessA = await composeFreshRuntime(filename);
    try {
      const installed = await installRecoveredLife({runtime: witnessA, imageId: PROD, fixture});
      releaseId = installed.releaseId;
      const send = senderFor(witnessA, PROD);
      const nativeGlobals = await nativeGlobalsFor(witnessA.images, PROD);
      const states = await runBlinkerWitness(send, PROD, installed.lifeModelClass, nativeGlobals);
      assert.deepEqual(states, FROZEN_STATES, 'the frozen blinker oracle, before restart, executed by the real imported Life');
    } finally {
      await witnessA.close();
    }

    // --- Real restart. A genuinely fresh runtime over the same durable store, still no providers.
    const witnessB = await composeFreshRuntime(filename);
    try {
      assertProviderAbsence(witnessB, 'after restart');
      assert.equal((await readManagedProjectInstallation({
        images: witnessB.images, targetImageId: PROD, projectId: fixture.release.projectId,
      })).releaseId, releaseId);

      // The native Life installation survives as ordinary image structures: the same durable
      // LifeModel class resolves through the native namespace alone (no re-import, no replay of
      // any capture pipeline), and the same frozen oracle runs against it again.
      const lifeModelClass = await resolveImportedClass(witnessB.images, PROD, 'LifeModel');
      const send = senderFor(witnessB, PROD);
      const nativeGlobals = await nativeGlobalsFor(witnessB.images, PROD);
      const states = await runBlinkerWitness(send, PROD, lifeModelClass, nativeGlobals);
      assert.deepEqual(states, FROZEN_STATES, 'the frozen blinker oracle, after a real restart, executed by the same durable Life installation');
    } finally {
      await witnessB.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
