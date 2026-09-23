import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  CUIS_SEMANTIC_EXPORT_V2,
  CUIS_PACKAGE_V1,
  importCuisNativePackage,
  installManagedProjectRelease,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  readManagedProjectInstallation,
  resolveGlobal,
  textValue,
  createRuntime,
} from '../../src/runtime.js';
import {LagrangeBackend} from '../../src/backend/lagrange-backend.js';
import {createSqliteApplicationRuntime} from './sqlite-application-runtime.js';

// The M5 Life witness, as ONE shared path (beads lagrange-images-nfv1.3 and 0pxf.3).
//
// The M5.2 acceptance (test/cuis-life-m5-acceptance.test.js) and the M6 two-node witness
// (test/cuis-life-m6-two-node-red.test.js) must install and exercise the SAME recovered release
// through the SAME owners — the M6 epic's prohibition ledger forbids a "distributed Life" variant
// of anything. So the recovered-release installation, the frozen blinker fixture and the state
// reader live here once, and each witness composes them; neither file may re-spell them.

const GAMES_COMMIT = '52aad9c547fb54ad0e3bbc427aff3f601a75d54c';
const CUIS_LIFE_BLOB = 'f9180bba8cf9e7aa47aedc4699ca5043af93c9b5';
const GLOBAL_BINDING_VALUE_SLOT = 'global-binding-value';

// The sealed nfv1.1 measurement authorizes exactly these superclass correspondences; the M5
// witness imports nothing whose superclass is outside them.
const LIFE_SCOPE = Object.freeze([
  'cuis-class/Life/LifeArray',
  'cuis-class/Life/LifeModel',
]);

// The acceptance needs the model path only: the two model classes and exactly the reached
// upstream methods (their real spellings from the pinned package). The views and morph cells
// (GridCell, LifeView) are NOT in scope.
const LIFE_METHOD_SCOPE = Object.freeze([
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

// One Images node: a fresh runtime over its own durable sqlite-backed Lagrange adapter, composed
// with no toolchain or foreign-runtime provider at all.
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

// The recovered-release side, exactly as M5.2 established it: a fresh image, the committed
// release installed as a managed installation, the closure recovered and re-verified, provider
// absence asserted BEFORE any native import, the standard image in the WASM lane, and the scoped
// native import of the sealed Life scope. Answers the imported LifeModel class.
async function installRecoveredLife({runtime, imageId, fixture}) {
  const images = runtime.images;
  await images.createImage({id: imageId});
  const installed = await installManagedProjectRelease({
    images, targetImageId: imageId, release: fixture.release, material: fixture.material,
  });
  const recovered = await readRecoveredClosure(images, imageId, fixture.release.projectId);
  assert.equal(recovered.installation.releaseId, installed.releaseId);
  assert.deepEqual(recovered.installation.members.map(({key}) => key), ['life/export', 'life/package']);

  // Provider absence is EXPLICIT before any native import.
  assertProviderAbsence(runtime, 'before native import');

  await installSymmetricSmalltalkStandardImage({images, compilation: runtime.compilation, imageId, lane: 'wasm'});
  const imported = await importCuisNativePackage({
    images, compilation: runtime.compilation, imageId,
    manifest: recovered.manifest,
    scope: {classes: [...LIFE_SCOPE], methods: [...LIFE_METHOD_SCOPE]},
  });
  const lifeModelClass = imported.classes.find(({identity}) => identity === 'cuis-class/Life/LifeModel').classRef;
  return {releaseId: installed.releaseId, recovered, imported, lifeModelClass};
}

async function resolveImportedClass(images, imageId, name) {
  const binding = await resolveGlobal({images, imageId, name});
  assert.ok(binding, `${name} must be resolvable through the native global namespace`);
  const record = await images.getObject(imageId, binding.objectId);
  return record.slots[GLOBAL_BINDING_VALUE_SLOT];
}

async function nativeGlobalsFor(images, imageId) {
  const nativeGlobals = new Map();
  for (const name of ['Array', 'Point']) {
    nativeGlobals.set(name, await resolveImportedClass(images, imageId, name));
  }
  return nativeGlobals;
}

// The frozen 4x5 blinker fixture built through ordinary native constructors, plus the reader
// that renders the model's state through the model's own accessors. Answers the model ref and
// the reader, so a witness can inspect the graph between steps.
async function buildBlinkerModel(send, lifeModelClass, nativeGlobals) {
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
  return {model, pointAt, stateString};
}

// The Blinker witness as REAL protocol: build the frozen fixture, run the model twice, read every
// state through the model's own accessors.
async function runBlinkerWitness(send, imageId, lifeModelClass, nativeGlobals) {
  const {model, stateString} = await buildBlinkerModel(send, lifeModelClass, nativeGlobals);
  const states = [await stateString()];
  await send(model, 'nextState');
  states.push(await stateString());
  await send(model, 'nextState');
  states.push(await stateString());
  return states;
}

export {
  CUIS_LIFE_BLOB,
  FROZEN_STATES,
  GAMES_COMMIT,
  LIFE_METHOD_SCOPE,
  LIFE_SCOPE,
  assertProviderAbsence,
  buildBlinkerModel,
  composeFreshRuntime,
  gitBlobIdentity,
  installRecoveredLife,
  nativeGlobalsFor,
  readRecoveredClosure,
  resolveImportedClass,
  runBlinkerWitness,
  senderFor,
};
