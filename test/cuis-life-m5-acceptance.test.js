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
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import './ensure-node-crypto.test-helper.js';
import {
  CUIS_SEMANTIC_EXPORT_V2,
  CUIS_PACKAGE_V1,
  findSmalltalkGlobalNamespace,
  importCuisNativePackage,
  installManagedProjectRelease,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  readManagedProjectInstallation,
  resolveGlobal,
  textValue,
  createRuntime,
} from '../src/runtime.js';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

const GAMES_COMMIT = '52aad9c547fb54ad0e3bbc427aff3f601a75d54c';
const CUIS_LIFE_BLOB = 'f9180bba8cf9e7aa47aedc4699ca5043af93c9b5';
const GLOBAL_BINDING_VALUE_SLOT = 'global-binding-value';

// The sealed nfv1.1 measurement authorizes exactly these superclass correspondences; the M5
// witness imports nothing whose superclass is outside them.
const LIFE_SCOPE = Object.freeze([
  'cuis-class/Life/LifeArray',
  'cuis-class/Life/LifeModel',
]);

// The frozen oracle (bead lagrange-images-nfv1.1, recorded from the real pinned Cuis):
const FROZEN_STATES = Object.freeze([
  '|00000|01110|00000|00000|', // S0: row 2, columns 2-4 alive
  '|00100|00100|00100|00000|', // S1: column 3, rows 1-3 alive
  '|00000|01110|00000|00000|', // S2 == S0
]);

function gitBlobIdentity(bytes) {
  return `gitblob:${createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}`;
}

function assertProviderAbsence(runtime, label) {
  assert.deepEqual(runtime.toolchainProviders.list(), [], `${label}: no toolchain providers exist to fall back to`);
  assert.deepEqual(runtime.foreignRuntimeProviders.list(), [], `${label}: no foreign-runtime providers exist to fall back to`);
}

// Every interaction enters ordinary native dispatch (the M4 precedent). The dispatch image is
// the witness's own image; no host Life implementation exists in this file.
function senderFor(runtime, imageId) {
  return async (receiver, selector, args = []) => runtime.executor.execute(await runtime.invocations.sendMessage({
    languageId: 'symmetric-smalltalk', receiver, message: textValue(selector), arguments: args,
  }, {dispatchImage: imageId}));
}

async function composeFreshRuntime(filename) {
  const runtime = await createRuntime({
    backend: {instance: new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)})},
  });
  assertProviderAbsence(runtime, 'a newly composed witness runtime');
  return runtime;
}

async function readRecoveredClosure(images, imageId, projectId) {
  const installation = await readManagedProjectInstallation({images, targetImageId: imageId, projectId});
  assert.ok(installation, 'the managed installation must be recoverable');
  const byKey = new Map(installation.members.map((member) => [member.key, member]));
  const packageRecord = await images.getCodeArtifact(imageId, byKey.get('life/package').target.objectId);
  assert.equal(packageRecord.representation, CUIS_PACKAGE_V1);
  assert.equal(gitBlobIdentity(Buffer.from(packageRecord.content.value, 'utf8')), `gitblob:${CUIS_LIFE_BLOB}`,
    'the recovered package is the sealed pinned upstream bytes');
  const exportRecord = await images.getCodeArtifact(imageId, byKey.get('life/export').target.objectId);
  assert.equal(exportRecord.representation, CUIS_SEMANTIC_EXPORT_V2);
  const manifest = JSON.parse(exportRecord.content.value);
  assert.equal(manifest.format, CUIS_SEMANTIC_EXPORT_V2);
  assert.deepEqual(manifest.packages, [{name: 'Life', requires: []}]);
  return {installation, packageRecord, manifest};
}

// The Blinker witness as REAL protocol: build the frozen fixture through ordinary native
// constructors, run the model, read every state through the model's own accessors.
async function runBlinkerWitness(send, imageId, lifeModelClass, nativeGlobals) {
  const arrayClass = nativeGlobals.get('Array');
  const pointClass = nativeGlobals.get('Point');
  assert.ok(arrayClass, 'native Array must be nameable to load the fixture');
  assert.ok(pointClass, 'native Point must be nameable to load the fixture');
  const pointAt = (x, y) => send(pointClass, 'x:y:', [integerValue(x), integerValue(y)]);
  const pattern = await send(arrayClass, 'new:', [integerValue(1)]);
  const row = await send(arrayClass, 'new:', [integerValue(3)]);
  await send(row, 'at:put:', [integerValue(1), integerValue(1)]);
  await send(row, 'at:put:', [integerValue(2), integerValue(1)]);
  await send(row, 'at:put:', [integerValue(3), integerValue(1)]);
  await send(pattern, 'at:put:', [integerValue(1), row]);

  const model = await send(lifeModelClass, 'new');
  await send(model, 'shape:', [await pointAt(4, 5)]);
  await send(model, 'set:at:', [pattern, await pointAt(2, 2)]);

  const shape = await send(model, 'shape');
  const rows = Number((await send(shape, 'x')).value);
  const cols = Number((await send(shape, 'y')).value);
  assert.equal(rows, 4, 'the model adopted the frozen grid');
  assert.equal(cols, 5, 'the model adopted the frozen grid');

  const stateString = async () => {
    const cells = await send(model, 'cells');
    let parts = '';
    for (let r = 1; r <= 4; r += 1) {
      for (let c = 1; c <= 5; c += 1) {
        const v = await send(cells, 'at:', [await pointAt(r, c)]);
        parts += v.value === '1' ? '1' : '0';
      }
    }
    return `|${parts.slice(0, 5)}|${parts.slice(5, 10)}|${parts.slice(10, 15)}|${parts.slice(15, 20)}|`;
  };

  const states = [await stateString()];
  await send(model, 'nextState');
  states.push(await stateString());
  await send(model, 'nextState');
  states.push(await stateString());
  return states;
}

async function resolveImportedClass(images, imageId, name) {
  const binding = await resolveGlobal({images, imageId, name});
  assert.ok(binding, `${name} must be resolvable through the native global namespace`);
  const record = await images.getObject(imageId, binding.objectId);
  return record.slots[GLOBAL_BINDING_VALUE_SLOT];
}

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
      const images = witnessA.images;
      await images.createImage({id: PROD});
      const installed = await installManagedProjectRelease({
        images, targetImageId: PROD, release: fixture.release, material: fixture.material,
      });
      releaseId = installed.releaseId;
      const recovered = await readRecoveredClosure(images, PROD, fixture.release.projectId);
      assert.equal(recovered.installation.releaseId, releaseId);
      assert.deepEqual(recovered.installation.members.map(({key}) => key), ['life/export', 'life/package']);

      // Provider absence is EXPLICIT before any native import.
      assertProviderAbsence(witnessA, 'before native import');

      await installSymmetricSmalltalkStandardImage({images, compilation: witnessA.compilation, imageId: PROD, lane: 'wasm'});
      const imported = await importCuisNativePackage({
        images, compilation: witnessA.compilation, imageId: PROD,
        manifest: recovered.manifest,
        // The acceptance needs the model path only: the two model classes and exactly the
        // reached upstream methods (their real spellings from the pinned package). The views and
        // morph cells (GridCell, LifeView) are NOT in scope.
        scope: {
          classes: [...LIFE_SCOPE],
          methods: [
            'cuis-method/Life/LifeArray/instance/at:',
            'cuis-method/Life/LifeArray/instance/at:put:',
            'cuis-method/Life/LifeArray/instance/elements',
            'cuis-method/Life/LifeArray/instance/elements:',
            'cuis-method/Life/LifeModel/instance/cellIndex',
            'cuis-method/Life/LifeModel/instance/cellIndex:',
            'cuis-method/Life/LifeModel/instance/cells',
            'cuis-method/Life/LifeModel/instance/cells:',
            'cuis-method/Life/LifeModel/instance/clearGrid',
            'cuis-method/Life/LifeModel/instance/nextState',
            'cuis-method/Life/LifeModel/instance/shape',
            'cuis-method/Life/LifeModel/instance/shape:',
            'cuis-method/Life/LifeModel/instance/set:at:',
            'cuis-method/Life/LifeModel/instance/surrounding:',
          ],
        },
      });
      const lifeModelClass = imported.classes.find(({identity}) => identity === 'cuis-class/Life/LifeModel').classRef;
      const send = senderFor(witnessA, PROD);
      const nativeGlobals = new Map();
      for (const name of ['Array', 'Point']) {
        nativeGlobals.set(name, await resolveImportedClass(images, PROD, name));
      }
      const states = await runBlinkerWitness(send, PROD, lifeModelClass, nativeGlobals);
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
      const nativeGlobals = new Map();
      for (const name of ['Array', 'Point']) {
        nativeGlobals.set(name, await resolveImportedClass(witnessB.images, PROD, name));
      }
      const states = await runBlinkerWitness(send, PROD, lifeModelClass, nativeGlobals);
      assert.deepEqual(states, FROZEN_STATES, 'the frozen blinker oracle, after a real restart, executed by the same durable Life installation');
    } finally {
      await witnessB.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
