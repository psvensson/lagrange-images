import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {
  addProjectMember,
  captureCurrentGraphProjectRelease,
  createDeploymentProfile,
  createProject,
  createProjectId,
  createProjectInstallation,
  createProjectReleaseManifest,
  createRuntime,
  GRAPH_BUNDLE_V1,
  installProjectRelease,
  integerValue,
  objectRef,
  PROJECT_INSTALLATION_V1,
  PROJECT_RELEASE_MATERIAL_V1,
  textValue,
} from '../src/runtime.js';
import {exportGraphBundle, importGraphBundle, GraphBundleImportError} from '../src/graph/bundle.js';
import {ProjectGraphReleaseMaterializationError} from '../src/project/graph-release-materialization.js';
import {LagrangeBackend} from '../src/backend/index.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';
import {getDefaultCryptoProvider} from '../src/support/default-crypto.js';

// The FIRST Project installation coordinator (ADR 0075 Decision 8):
// release + material + existing target Image -> imported fresh graph +
// canonical ProjectInstallation/v1. Effectful, but NOT durable/idempotent
// managed-installation storage.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seedShapeAndObject(runtime, imageId, objectId, slots) {
  if (!await runtime.images.getShape(imageId, 'shape')) {
    await runtime.images.putShape(imageId, {id: 'shape', slots: [{id: 'v', name: 'v'}]});
  }
  await runtime.images.putObject(imageId, {id: objectId, shape: objectRef(imageId, 'shape'), slots});
  return objectRef(imageId, objectId);
}

async function seedProject(runtime, hostId, projectId, members) {
  await createProject({images: runtime.images, imageId: hostId, projectId, name: 'P'});
  for (const {key, role, target} of members) {
    await addProjectMember({images: runtime.images, imageId: hostId, projectId, key, role, target});
  }
  return {
    format: 'lagrange-project/v1', projectId, name: 'P', namespace: null,
    members: members.map(({key, role, target}) => ({key, role, target})),
  };
}

const deploy = (descriptor, keys) => createDeploymentProfile({project: descriptor, profileId: 'deploy', members: keys});

async function captureSimple(runtime, projectId = createProjectId(), imageId = 'img') {
  await runtime.images.createImage({id: imageId});
  const rec = await seedShapeAndObject(runtime, imageId, 'rec', {v: integerValue(7)});
  const descriptor = await seedProject(runtime, imageId, projectId, [{key: 'model/rec', role: 'source', target: rec}]);
  const captured = await captureCurrentGraphProjectRelease({
    images: runtime.images, projectImageId: imageId, projectId, profile: deploy(descriptor, ['model/rec']),
  });
  return {captured, rec};
}

async function freshTarget(runtime, id = 'target') {
  await runtime.images.createImage({id});
  return id;
}

const targetRecords = async (runtime, imageId) => await runtime.images.listRecords(imageId);
const targetEvents = async (runtime, imageId) =>
  (await runtime.images.history(imageId)).filter((e) => e.type !== 'image.created');

test('1. Simple end-to-end installation: canonical installation descriptor preserving member semantics', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    const installation = await installProjectRelease({
      images: runtime.images, targetImageId, release: captured.release, material: captured.material,
    });
    assert.equal(installation.format, PROJECT_INSTALLATION_V1);
    assert.equal(installation.projectId, captured.release.projectId);
    assert.equal(installation.releaseId, captured.release.releaseId);
    assert.equal(installation.targetImageId, targetImageId);
    assert.equal(installation.members.length, 1);
    const member = installation.members[0];
    assert.equal(member.key, 'model/rec');
    assert.equal(member.role, 'source', 'role preserved');
    assert.equal(member.representation, GRAPH_BUNDLE_V1);
    assert.equal(member.contentIdentity, captured.material.contentIdentity);
    assert.equal(member.target.imageId, targetImageId, 'every target ref belongs to the target Image');
    const rec = await runtime.images.getObject(targetImageId, member.target.objectId);
    assert.equal(rec.slots.v.value, '7', 'imported graph is actually there');
  });
});

test('2. Fresh target identities: no target ref equals source ObjectRef or bundle localId', async () => {
  await withRuntime(async (runtime) => {
    const {captured, rec} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    const installation = await installProjectRelease({
      images: runtime.images, targetImageId, release: captured.release, material: captured.material,
    });
    const target = installation.members[0].target;
    assert.notEqual(target.objectId, rec.objectId, 'not the source objectId');
    assert.notEqual(target.objectId, captured.material.bundle.roots['model/rec'], 'not the bundle localId');
    assert.equal(installation.members[0].key, 'model/rec', 'Project member identity stays the member key');
  });
});

test('3. Cross-member shared child: one release-wide import -> ONE shared fresh child', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const child = await seedShapeAndObject(runtime, 'img', 'child', {v: integerValue(1)});
    const pa = await seedShapeAndObject(runtime, 'img', 'pa', {v: child});
    const pb = await seedShapeAndObject(runtime, 'img', 'pb', {v: child});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [
      {key: 'a', role: 'source', target: pa},
      {key: 'b', role: 'source', target: pb},
    ]);
    const {release, material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['a', 'b']),
    });
    const targetImageId = await freshTarget(runtime);
    const installation = await installProjectRelease({images: runtime.images, targetImageId, release, material});
    const ta = installation.members.find(({key}) => key === 'a').target;
    const tb = installation.members.find(({key}) => key === 'b').target;
    const oa = await runtime.images.getObject(targetImageId, ta.objectId);
    const ob = await runtime.images.getObject(targetImageId, tb.objectId);
    assert.equal(oa.slots.v.objectId, ob.slots.v.objectId, 'ONE shared fresh child — not duplicated');
    assert.equal((await targetRecords(runtime, targetImageId)).length, 4, 'a + b + child + shape');
  });
});

test('4. Cross-member cycle survives installation', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putShape('img', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject('img', {id: 'a', shape: objectRef('img', 'shape'), slots: {v: integerValue(0)}});
    await runtime.images.putObject('img', {id: 'b', shape: objectRef('img', 'shape'), slots: {v: objectRef('img', 'a')}});
    await runtime.images.putObject('img', {id: 'a', shape: objectRef('img', 'shape'), slots: {v: objectRef('img', 'b')}}, {expectedVersion: 1});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [
      {key: 'a', role: 'source', target: objectRef('img', 'a')},
      {key: 'b', role: 'source', target: objectRef('img', 'b')},
    ]);
    const {release, material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['a', 'b']),
    });
    const targetImageId = await freshTarget(runtime);
    const installation = await installProjectRelease({images: runtime.images, targetImageId, release, material});
    const ta = installation.members.find(({key}) => key === 'a').target;
    const tb = installation.members.find(({key}) => key === 'b').target;
    const oa = await runtime.images.getObject(targetImageId, ta.objectId);
    const ob = await runtime.images.getObject(targetImageId, oa.slots.v.objectId);
    assert.equal(ob.slots.v.objectId, oa.id, 'cycle preserved in the installed graph');
    assert.equal(ob.id, tb.objectId,
      "member b's installation target IS the b inside member a's cycle — ONE release-wide import, not per-member copies");
  });
});

test('5+6. Material releaseId/projectId mismatch with the supplied release -> PRE-EFFECT refusal, target unchanged', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    // A DIFFERENT valid release (different project -> different projectId + releaseId).
    const {captured: other} = await captureSimple(runtime, createProjectId(), 'img-other');
    const targetImageId = await freshTarget(runtime);
    await assert.rejects(
      installProjectRelease({images: runtime.images, targetImageId, release: other.release, material: captured.material}),
      (error) => error instanceof ProjectGraphReleaseMaterializationError && /projectId/.test(error.message),
      'material projectId mismatch refuses',
    );
    // Same project, different release (releaseId mismatch): mutate content for a second capture.
    await runtime.images.putObject('img', {id: 'rec', shape: objectRef('img', 'shape'), slots: {v: integerValue(8)}}, {expectedVersion: 1});
    const projectId = captured.release.projectId;
    const rec = objectRef('img', 'rec');
    const descriptor = {format: 'lagrange-project/v1', projectId, name: 'P', namespace: null, members: [{key: 'model/rec', role: 'source', target: rec}]};
    const second = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['model/rec']),
    });
    await assert.rejects(
      installProjectRelease({images: runtime.images, targetImageId, release: second.release, material: captured.material}),
      (error) => error instanceof ProjectGraphReleaseMaterializationError && /releaseId/.test(error.message),
      'material releaseId mismatch refuses',
    );
    assert.deepEqual(await targetRecords(runtime, targetImageId), [], 'PRE-EFFECT: no target records');
    assert.deepEqual(await targetEvents(runtime, targetImageId), [], 'PRE-EFFECT: no target history');
  });
});

test('7. Bundle content tamper with retained declared contentIdentity -> PRE-EFFECT refusal', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    const tampered = structuredClone(captured.material);
    const rootLocal = tampered.bundle.roots['model/rec'];
    tampered.bundle.records[rootLocal].slots.v = integerValue(999); // content changed, declared identity kept
    await assert.rejects(
      installProjectRelease({images: runtime.images, targetImageId, release: captured.release, material: tampered}),
      /does not match its bundle/,
    );
    assert.deepEqual(await targetRecords(runtime, targetImageId), []);
  });
});

test('8. Member representation/contentIdentity mismatch with material -> PRE-EFFECT refusal', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    // A valid release whose member has DIFFERENT material identity (changed content).
    await runtime.images.putObject('img', {id: 'rec', shape: objectRef('img', 'shape'), slots: {v: integerValue(8)}}, {expectedVersion: 1});
    const descriptor = {
      format: 'lagrange-project/v1', projectId: captured.release.projectId, name: 'P', namespace: null,
      members: [{key: 'model/rec', role: 'source', target: objectRef('img', 'rec')}],
    };
    const second = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId: captured.release.projectId, profile: deploy(descriptor, ['model/rec']),
    });
    await assert.rejects(
      installProjectRelease({images: runtime.images, targetImageId, release: second.release, material: captured.material}),
      /releaseId|contentIdentity/,
    );
    assert.deepEqual(await targetRecords(runtime, targetImageId), []);
  });
});

test('9. Root/member mismatch (PR #171 collision case) -> PRE-EFFECT refusal; fix is load-bearing for installation', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const rec1 = await seedShapeAndObject(runtime, 'img', 'rec1', {v: integerValue(1)});
    const rec2 = await seedShapeAndObject(runtime, 'img', 'rec2', {v: integerValue(2)});
    const projectId = createProjectId();
    const {bundle, contentIdentity} = await exportGraphBundle({
      images: runtime.images, roots: {'a': rec1, 'bc': rec2}, referencePolicy: {classify: () => 'internal'},
    });
    const collidingRelease = createProjectReleaseManifest({
      project: {
        format: 'lagrange-project/v1', projectId, name: 'P', namespace: null,
        members: [{key: 'ab', role: 'source', target: rec1}, {key: 'c', role: 'source', target: rec2}],
      },
      profile: {format: 'lagrange-project-deployment-profile/v1', projectId, profileId: 'deploy', members: ['ab', 'c']},
      materializations: {
        ab: {representation: GRAPH_BUNDLE_V1, contentIdentity},
        c: {representation: GRAPH_BUNDLE_V1, contentIdentity},
      },
    });
    const material = {
      format: PROJECT_RELEASE_MATERIAL_V1, projectId, releaseId: collidingRelease.releaseId,
      representation: GRAPH_BUNDLE_V1, contentIdentity, bundle,
    };
    const targetImageId = await freshTarget(runtime);
    await assert.rejects(
      installProjectRelease({images: runtime.images, targetImageId, release: collidingRelease, material}),
      /exactly equal/,
      'collision roots ["a","bc"] vs members ["ab","c"] refuses at the INSTALLER boundary',
    );
    assert.deepEqual(await targetRecords(runtime, targetImageId), [], 'no orphan imported graph');
  });
});

test('10. Missing/extra root ordinary cases -> PRE-EFFECT refusal', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    // Extra root (bundle roots not covered by release members).
    const extra = structuredClone(captured.material);
    extra.bundle.roots.extra = captured.material.bundle.roots['model/rec'];
    await assert.rejects(
      installProjectRelease({images: runtime.images, targetImageId, release: captured.release, material: extra}),
      /does not match its bundle|exactly equal/,
    );
    assert.deepEqual(await targetRecords(runtime, targetImageId), []);
  });
});

test('11. Caller material mutation cannot race validation: the validated snapshot is isolated (coordinator property + validator isolation discriminator)', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    const callerMaterial = structuredClone(captured.material); // caller-owned, mutable

    // (a) Coordinator property: park at the one async boundary (publication),
    // mutate the caller-owned original, and the install still completes with the
    // originally validated material.
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let publications = 0;
    const probe = {
      ...runtime.images,
      frontier: (imageId) => runtime.images.frontier(imageId),
      getRecord: (imageId, objectId) => runtime.images.getRecord(imageId, objectId),
      createRecords: async (imageId, inputs) => {
        publications += 1;
        await gate;
        return runtime.images.createRecords(imageId, inputs);
      },
      getImage: (imageId) => runtime.images.getImage(imageId),
    };
    const installPromise = installProjectRelease({
      images: probe, targetImageId, release: captured.release, material: callerMaterial,
    });
    while (publications === 0) await new Promise((resolve) => setImmediate(resolve));
    const rootLocal = callerMaterial.bundle.roots['model/rec'];
    callerMaterial.bundle.records[rootLocal].slots.v = integerValue(999);
    callerMaterial.contentIdentity = 'sha256:mutated';
    releaseGate();
    const installation = await installPromise;
    const rec = await runtime.images.getObject(targetImageId, installation.members[0].target.objectId);
    assert.equal(rec.slots.v.value, '7', 'isolated snapshot used, not the mutated original');
    const reexported = await exportGraphBundle({
      images: runtime.images, roots: {'model/rec': installation.members[0].target},
    });
    assert.equal(reexported.contentIdentity, captured.material.contentIdentity);

    // (b) Validator isolation DISCRIMINATOR: the returned snapshot is a different
    // object than the caller's (already-mutated) original — importing the snapshot
    // succeeds, while importing the caller-owned mutated object fails the
    // importer's own identity gate.
    const {validateProjectReleaseMaterialForRelease} = await import('../src/project/graph-release-materialization.js');
    const caller2 = structuredClone(captured.material);
    const validated = validateProjectReleaseMaterialForRelease({release: captured.release, material: caller2});
    const root2 = caller2.bundle.roots['model/rec'];
    caller2.bundle.records[root2].slots.v = integerValue(999);
    caller2.contentIdentity = 'sha256:mutated';
    await runtime.images.createImage({id: 't-snap'});
    const ok = await importGraphBundle({
      images: runtime.images, targetImageId: 't-snap',
      bundle: validated.bundle, expectedContentIdentity: validated.contentIdentity,
    });
    assert.equal(ok.contentIdentity, captured.material.contentIdentity, 'snapshot import succeeds with original identity');
    await runtime.images.createImage({id: 't-caller'});
    await assert.rejects(
      importGraphBundle({
        images: runtime.images, targetImageId: 't-caller',
        bundle: caller2.bundle, expectedContentIdentity: caller2.contentIdentity,
      }),
      /content identity mismatch/,
      'the caller-owned mutated original is NOT what gets installed',
    );
  });
});

test('12. Caller release mutation cannot race validation: installation matches the normalized snapshot', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    const callerRelease = structuredClone(captured.release); // mutable original
    // Park at the publication boundary — BEFORE createProjectInstallation consumes
    // the release — then mutate the caller-owned original release.
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let publications = 0;
    const probe = {
      ...runtime.images,
      frontier: (imageId) => runtime.images.frontier(imageId),
      getRecord: (imageId, objectId) => runtime.images.getRecord(imageId, objectId),
      createRecords: async (imageId, inputs) => {
        publications += 1;
        await gate;
        return runtime.images.createRecords(imageId, inputs);
      },
      getImage: (imageId) => runtime.images.getImage(imageId),
    };
    const installPromise = installProjectRelease({
      images: probe, targetImageId, release: callerRelease, material: captured.material,
    });
    while (publications === 0) await new Promise((resolve) => setImmediate(resolve));
    callerRelease.members[0].role = 'MUTATED-ROLE';
    callerRelease.projectId = 'project:mutated';
    releaseGate();
    const installation = await installPromise;
    assert.equal(installation.members[0].role, 'source', 'normalized release snapshot used');
    assert.equal(installation.projectId, captured.release.projectId);
  });
});

test('13. expectedContentIdentity is actually passed to the importer (flaky-crypto discriminator)', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    // A conforming-but-flaky provider: the FIRST sha256 (preflight recomputation)
    // is real; the SECOND (the importer's identity gate) returns garbage. If the
    // coordinator passes expectedContentIdentity, the import MUST refuse.
    const real = getDefaultCryptoProvider();
    let hashes = 0;
    const flaky = {
      sha256: (bytes) => { hashes += 1; return hashes === 1 ? real.sha256(bytes) : new Uint8Array(32); },
      uuid: () => real.uuid(),
    };
    await assert.rejects(
      installProjectRelease({images: runtime.images, targetImageId, release: captured.release, material: captured.material, crypto: flaky}),
      (error) => error instanceof GraphBundleImportError && /content identity mismatch/.test(error.message),
      'the importer remains the FINAL identity gate immediately before materialization',
    );
    assert.ok(hashes >= 2, 'both preflight and import recomputed the identity');
    assert.deepEqual(await targetRecords(runtime, targetImageId), [], 'identity-gate refusal is pre-publication');
  });
});

test('14. Import publication failure -> no installation, no partial target graph/history, no cleanup path', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    const realTransaction = runtime.images.backend.transaction.bind(runtime.images.backend);
    let injected = false;
    runtime.images.backend.transaction = async (work) => await realTransaction(async (candidate) => {
      const wrapped = {
        ...candidate,
        put: candidate.put.bind(candidate),
        append: async (stream, event) => {
          if (!injected) { injected = true; throw new Error('injected install publication failure'); }
          return candidate.append(stream, event);
        },
      };
      return work(wrapped);
    });
    await assert.rejects(
      installProjectRelease({images: runtime.images, targetImageId, release: captured.release, material: captured.material}),
      GraphBundleImportError,
    );
    assert.ok(injected, 'the failure fired inside publication');
    assert.deepEqual(await targetRecords(runtime, targetImageId), [], 'no partial target graph');
    assert.deepEqual(await targetEvents(runtime, targetImageId), [], 'no partial history');
  });
});

test('15. Project model is the descriptor owner: canonicalization (member ordering) comes from createProjectInstallation', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const ra = await seedShapeAndObject(runtime, 'img', 'ra', {v: integerValue(1)});
    const rb = await seedShapeAndObject(runtime, 'img', 'rb', {v: integerValue(2)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [
      {key: 'z-last', role: 'source', target: ra},
      {key: 'a-first', role: 'runtime', target: rb},
    ]);
    const {release, material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['z-last', 'a-first']),
    });
    const targetImageId = await freshTarget(runtime);
    const installation = await installProjectRelease({images: runtime.images, targetImageId, release, material});
    assert.deepEqual(installation.members.map(({key}) => key), ['a-first', 'z-last'],
      'model-canonical member ordering — no hand-built coordinator descriptor');
    assert.equal(installation.members.find(({key}) => key === 'a-first').role, 'runtime');
    assert.equal(installation.format, PROJECT_INSTALLATION_V1);
    // Model-canonical shape AND immutability: the descriptor is exactly what
    // createProjectInstallation produces — deeply frozen, no coordinator-built
    // mutable stand-in.
    assert.ok(Object.isFrozen(installation), 'installation descriptor is frozen');
    assert.ok(Object.isFrozen(installation.members), 'members array is frozen');
    assert.ok(Object.isFrozen(installation.members[0]), 'member is frozen');
    assert.ok(Object.isFrozen(installation.members[0].target), 'member target ObjectRef is frozen');
    const independent = createProjectInstallation({
      release, targetImageId,
      targets: Object.fromEntries(installation.members.map((m) => [m.key, m.target])),
    });
    assert.deepEqual(installation, independent,
      'descriptor is structurally identical to an independently built model descriptor');
  });
});

test('16. Install same release twice: two fresh aliasing-preserved copies — deliberate fresh-copy, NOT hidden reconciliation', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    const first = await installProjectRelease({images: runtime.images, targetImageId, release: captured.release, material: captured.material});
    const second = await installProjectRelease({images: runtime.images, targetImageId, release: captured.release, material: captured.material});
    assert.equal(first.projectId, second.projectId);
    assert.equal(first.releaseId, second.releaseId);
    assert.equal(first.members[0].contentIdentity, second.members[0].contentIdentity);
    assert.notEqual(first.members[0].target.objectId, second.members[0].target.objectId,
      'two FRESH copies — no dedup by contentIdentity/releaseId');
    assert.equal((await targetRecords(runtime, targetImageId)).length, 4, 'two object+shape copies coexist');
  });
});

test('17. No durable installation-state record: target holds exactly the imported graph, nothing more', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    await installProjectRelease({images: runtime.images, targetImageId, release: captured.release, material: captured.material});
    const records = await targetRecords(runtime, targetImageId);
    assert.equal(records.length, Object.keys(captured.material.bundle.records).length,
      'exactly the bundle records — no ad-hoc ProjectInstallation record invented');
    const events = await targetEvents(runtime, targetImageId);
    assert.equal(events.length, records.length, 'exactly one history event per imported record');
    assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), ['object.put', 'shape.put']);
  });
});

test('18. No authority: coordinator issues/checks no grants and adds no authorized lane', async () => {
  await withRuntime(async (runtime) => {
    const {captured} = await captureSimple(runtime);
    const targetImageId = await freshTarget(runtime);
    // No require/authority parameter exists; host-level substrate only.
    assert.ok(installProjectRelease.length <= 1, 'single options object; no authority parameter');
    const installation = await installProjectRelease({
      images: runtime.images, targetImageId, release: captured.release, material: captured.material,
    });
    assert.ok(installation);
  });
});

test('19. Runtime/restart graph durability: imported graph survives a real Lagrange restart; caller-retained descriptor still resolves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-install-'));
  const filename = join(directory, 'image.sqlite');
  try {
    const firstBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await firstBackend.start();
    const first = new ImageService({backend: firstBackend, clock: () => new Date('2026-09-01T00:00:00.000Z')});
    // Build a source graph + Project + capture through the runtime-free services.
    await first.createImage({id: 'src'});
    await first.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await first.putObject('src', {id: 'child', shape: objectRef('src', 'shape'), slots: {v: integerValue(1)}});
    await first.putObject('src', {id: 'pa', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'child')}});
    await first.putObject('src', {id: 'pb', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'child')}});
    const {createProject: createProjectWs, addProjectMember: addMemberWs} = await import('../src/project/working-state.js');
    const projectId = createProjectId();
    await createProjectWs({images: first, imageId: 'src', projectId, name: 'P'});
    await addMemberWs({images: first, imageId: 'src', projectId, key: 'a', role: 'source', target: objectRef('src', 'pa')});
    await addMemberWs({images: first, imageId: 'src', projectId, key: 'b', role: 'source', target: objectRef('src', 'pb')});
    const descriptor = {
      format: 'lagrange-project/v1', projectId, name: 'P', namespace: null,
      members: [
        {key: 'a', role: 'source', target: objectRef('src', 'pa')},
        {key: 'b', role: 'source', target: objectRef('src', 'pb')},
      ],
    };
    const {release, material} = await captureCurrentGraphProjectRelease({
      images: first, projectImageId: 'src', projectId, profile: deploy(descriptor, ['a', 'b']),
    });
    await first.createImage({id: 'dst'});
    const installation = await installProjectRelease({images: first, targetImageId: 'dst', release, material});
    await firstBackend.stop();

    const secondBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await secondBackend.start();
    try {
      const second = new ImageService({backend: secondBackend});
      const ta = installation.members.find(({key}) => key === 'a').target;
      const tb = installation.members.find(({key}) => key === 'b').target;
      const oa = await second.getObject('dst', ta.objectId);
      const ob = await second.getObject('dst', tb.objectId);
      assert.ok(oa && ob, 'caller-RETAINED descriptor roots still resolve after restart');
      assert.equal(oa.slots.v.objectId, ob.slots.v.objectId, 'shared child survives restart');
      // The descriptor itself was NOT recovered from Images storage — the test
      // retained it externally; that distinction is the recorded crash-window point.
    } finally {
      await secondBackend.stop();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
