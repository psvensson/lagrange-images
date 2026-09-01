import test from 'node:test';
import assert from 'node:assert/strict';
import './ensure-node-crypto.test-helper.js';
import {
  addProjectMember,
  captureCurrentGraphProjectRelease,
  captureCurrentProjectRelease,
  createDeploymentProfile,
  createProject,
  createProjectId,
  createProjectInstallation,
  createProjectReleaseManifest,
  createRuntime,
  GRAPH_BUNDLE_V1,
  integerValue,
  materializeProjectGraphRelease,
  normalizeProjectReleaseMaterial,
  createProjectReleaseMaterial,
  objectRef,
  pinnedRef,
  planProjectUpgrade,
  ProjectCaptureConflictError,
  ProjectGraphReleaseMaterializationError,
  PROJECT_RELEASE_MATERIAL_V1,
  textValue,
} from '../src/runtime.js';

// ADR 0075 first materialization slice: durable working Project + DeploymentProfile
// + truthful stable-current graph reads -> {release, provenance, material}, where
// material is ONE fully-closed multi-root graph bundle for the entire selection.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seedShapeAndObject(runtime, imageId, objectId, slots, shapeSlots = [{id: 'v', name: 'v'}]) {
  if (!await runtime.images.getShape(imageId, 'shape')) {
    await runtime.images.putShape(imageId, {id: 'shape', slots: shapeSlots});
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

test('1. Simple portable Project release: member representation/identity == material identity; bundle roots keyed by member; externals empty', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const rec = await seedShapeAndObject(runtime, 'img', 'rec', {v: integerValue(7)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'model/rec', role: 'source', target: rec}]);
    const {release, material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['model/rec']),
    });
    assert.equal(release.members.length, 1);
    assert.equal(release.members[0].representation, GRAPH_BUNDLE_V1);
    assert.equal(release.members[0].contentIdentity, material.contentIdentity);
    assert.equal(material.format, PROJECT_RELEASE_MATERIAL_V1);
    assert.deepEqual(Object.keys(material.bundle.roots), ['model/rec']);
    assert.deepEqual(material.bundle.externals, {});
    assert.equal(Object.keys(material.bundle.records).length, 2, 'object + shape');
  });
});

test('2. Shared child across members: ONE bundle contains ONE child localId', async () => {
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
    const {material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['a', 'b']),
    });
    const {records, roots} = material.bundle;
    const childLocal = records[roots.a].slots.v.localId;
    assert.equal(records[roots.b].slots.v.localId, childLocal, 'ONE shared child localId across members');
    assert.equal(Object.keys(records).length, 4, 'a + b + child + shape; no per-member duplication');
  });
});

test('3. Cross-member cycle: member roots A and B in one cycle survive in the bundle', async () => {
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
    const {material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['a', 'b']),
    });
    const {records, roots} = material.bundle;
    const a = records[roots.a];
    assert.equal(a.slots.v.localId, roots.b, 'a -> b');
    assert.equal(records[roots.b].slots.v.localId, roots.a, 'b -> a: cycle preserved');
  });
});

test('4. Different source Images: roots from two Images internalize into one bundle; provenance covers both + host', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'a'});
    await runtime.images.createImage({id: 'b'});
    const ra = await seedShapeAndObject(runtime, 'a', 'rec', {v: integerValue(1)});
    const rb = await seedShapeAndObject(runtime, 'b', 'rec', {v: integerValue(2)});
    await runtime.images.createImage({id: 'host'});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'host', projectId, [
      {key: 'm/a', role: 'source', target: ra},
      {key: 'm/b', role: 'source', target: rb},
    ]);
    const {material, provenance} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'host', projectId, profile: deploy(descriptor, ['m/a', 'm/b']),
    });
    assert.deepEqual(material.bundle.externals, {});
    assert.deepEqual(Object.keys(provenance.sourceFrontiers).sort(), ['a', 'b', 'host']);
    assert.equal(Object.keys(material.bundle.records).length, 4, 'both objects + both shapes internalized');
  });
});

test('5. Dynamically discovered third Image: frontier(C) precedes first C read; C in provenance; C is internal material', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'a'});
    await runtime.images.createImage({id: 'c'});
    const rc = await seedShapeAndObject(runtime, 'c', 'deep', {v: integerValue(3)});
    // a's root references Image C (not named by any direct member)
    const ra = await seedShapeAndObject(runtime, 'a', 'root', {v: rc});
    await runtime.images.createImage({id: 'host'});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'host', projectId, [{key: 'm', role: 'source', target: ra}]);

    const calls = [];
    const probe = {
      ...runtime.images,
      frontier: async (imageId) => { calls.push(['frontier', imageId]); return runtime.images.frontier(imageId); },
      getRecord: async (imageId, objectId) => { calls.push(['getRecord', imageId, objectId]); return runtime.images.getRecord(imageId, objectId); },
      getObject: (imageId, objectId) => runtime.images.getObject(imageId, objectId),
    };
    const {material, provenance} = await captureCurrentGraphProjectRelease({
      images: probe, projectImageId: 'host', projectId, profile: deploy(descriptor, ['m']),
    });
    const firstCRead = calls.findIndex(([op, id]) => op === 'getRecord' && id === 'c');
    const firstCFrontier = calls.findIndex(([op, id]) => op === 'frontier' && id === 'c');
    assert.ok(firstCRead > 0, 'Image C was read transitively');
    assert.ok(firstCFrontier >= 0 && firstCFrontier < firstCRead, 'frontier(C) precedes the first C record read');
    assert.ok('c' in provenance.sourceFrontiers, 'dynamically discovered C is in provenance');
    assert.deepEqual(material.bundle.externals, {}, 'C is internal material, not external');
  });
});

test('6. Dynamic third-Image mutation during materialization -> conflict(C); no release/material', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'a'});
    await runtime.images.createImage({id: 'c'});
    const rc = await seedShapeAndObject(runtime, 'c', 'deep', {v: integerValue(3)});
    const ra = await seedShapeAndObject(runtime, 'a', 'root', {v: rc});
    await runtime.images.createImage({id: 'host'});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'host', projectId, [{key: 'm', role: 'source', target: ra}]);

    // Mutate C AFTER its first read but BEFORE assertStable, via a getRecord hook.
    // (Class methods live on the prototype, so the facade delegates explicitly.)
    let bumped = false;
    const probe = {
      ...runtime.images,
      frontier: (imageId) => runtime.images.frontier(imageId),
      getRecord: async (imageId, objectId) => {
        const record = await runtime.images.getRecord(imageId, objectId);
        if (imageId === 'c' && !bumped) {
          bumped = true;
          await runtime.images.putObject('c', {id: 'deep', shape: objectRef('c', 'shape'), slots: {v: integerValue(9)}}, {expectedVersion: 1});
        }
        return record;
      },
    };
    await assert.rejects(
      captureCurrentGraphProjectRelease({images: probe, projectImageId: 'host', projectId, profile: deploy(descriptor, ['m'])}),
      (error) => error instanceof ProjectCaptureConflictError && error.imageId === 'c',
    );
  });
});

test('7. Source-independent release: SAME Project assembled from different source Images/ids -> same material identity + releaseId, different provenance', async () => {
  // One portable projectId; the same semantic working Project is realized in two
  // different development setups (different host Image, source Image, object ids).
  const capture = async (runtime, projectId, hostId, srcId, prefix) => {
    await runtime.images.createImage({id: srcId});
    const root = await seedShapeAndObject(runtime, srcId, `${prefix}-root`, {v: integerValue(42)});
    await runtime.images.createImage({id: hostId});
    const descriptor = await seedProject(runtime, hostId, projectId, [{key: 'm', role: 'source', target: root}]);
    return await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: hostId, projectId, profile: deploy(descriptor, ['m']),
    });
  };
  await withRuntime(async (runtime) => {
    const projectId = createProjectId();
    const first = await capture(runtime, projectId, 'host-one', 'src-one', 'alpha');
    const second = await capture(runtime, projectId, 'host-two', 'src-two', 'beta');
    assert.equal(first.material.contentIdentity, second.material.contentIdentity, 'source identity does not enter material identity');
    assert.equal(first.release.releaseId, second.release.releaseId, 'same deployable content -> same releaseId (ADR 0073)');
    assert.notDeepEqual(
      Object.keys(first.provenance.sourceFrontiers).sort(),
      Object.keys(second.provenance.sourceFrontiers).sort(),
      'provenance differs (different source Images)',
    );
  });
});

test('8. HEADLINE SHARING FALSIFIER: shared-C vs duplicated-equal-C -> different material identity AND releaseId', async () => {
  const build = async (runtime, imageId, shared) => {
    await runtime.images.createImage({id: imageId});
    const c1 = await seedShapeAndObject(runtime, imageId, 'c1', {v: integerValue(5)});
    const c2 = shared ? c1 : await seedShapeAndObject(runtime, imageId, 'c2', {v: integerValue(5)});
    const a = await seedShapeAndObject(runtime, imageId, 'a', {v: c1});
    const b = await seedShapeAndObject(runtime, imageId, 'b', {v: c2});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, imageId, projectId, [
      {key: 'a', role: 'source', target: a},
      {key: 'b', role: 'source', target: b},
    ]);
    return await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: imageId, projectId, profile: deploy(descriptor, ['a', 'b']),
    });
  };
  await withRuntime(async (runtime) => {
    const releaseA = await build(runtime, 'img-a', true);
    const releaseB = await build(runtime, 'img-b', false);
    assert.notEqual(releaseA.material.contentIdentity, releaseB.material.contentIdentity,
      'sharing topology is material identity');
    assert.notEqual(releaseA.release.releaseId, releaseB.release.releaseId,
      'sharing topology is release identity');
  });
});

test('9. Pinned reachable ref: capture REFUSED; no historical read, no release/material', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const rec = await seedShapeAndObject(runtime, 'img', 'rec', {v: pinnedRef('img', 'rec', '1')});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: rec}]);
    await assert.rejects(
      captureCurrentGraphProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['m'])}),
      (error) => error instanceof ProjectGraphReleaseMaterializationError && /not fully closed/.test(error.message),
    );
  });
});

test('10. Cross-Image unpinned ref: internalized (externals empty, target in bundle.records)', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.createImage({id: 'other'});
    const ro = await seedShapeAndObject(runtime, 'other', 'target', {v: integerValue(1)});
    const rec = await seedShapeAndObject(runtime, 'img', 'rec', {v: ro});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: rec}]);
    const {material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['m']),
    });
    assert.deepEqual(material.bundle.externals, {}, 'the cross-Image ref is internal material');
    assert.equal(Object.keys(material.bundle.records).length, 4, 'rec + shape + other-target + other-shape');
  });
});

test('11. Well-known Shape/behavior: v1 internalizes it — no kernel special case', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    // A "well-known" record in a separate image that just LOOKS canonical.
    await runtime.images.createImage({id: 'well-known'});
    const wk = await seedShapeAndObject(runtime, 'well-known', 'canonical-shape-holder', {v: integerValue(0)});
    const rec = await seedShapeAndObject(runtime, 'img', 'rec', {v: wk});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: rec}]);
    const {material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['m']),
    });
    assert.deepEqual(material.bundle.externals, {}, 'well-known material is internalized like everything else');
    assert.equal(Object.keys(material.bundle.records).length, 4);
  });
});

test('12. One selected member changes: bundle hash changes BOTH members\' identity; upgrade marks both replace', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const a1 = await seedShapeAndObject(runtime, 'img', 'a', {v: integerValue(1)});
    const b = await seedShapeAndObject(runtime, 'img', 'b', {v: integerValue(2)});
    const projectId = createProjectId();
    const members = [
      {key: 'a', role: 'source', target: a1},
      {key: 'b', role: 'source', target: b},
    ];
    const descriptor = await seedProject(runtime, 'img', projectId, members);
    const first = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['a', 'b']),
    });
    // Change material reachable ONLY from member a.
    await runtime.images.putObject('img', {id: 'a', shape: objectRef('img', 'shape'), slots: {v: integerValue(99)}}, {expectedVersion: 1});
    const second = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['a', 'b']),
    });
    assert.notEqual(first.material.contentIdentity, second.material.contentIdentity);
    const memberB1 = first.release.members.find(({key}) => key === 'b');
    const memberB2 = second.release.members.find(({key}) => key === 'b');
    assert.notEqual(memberB1.contentIdentity, memberB2.contentIdentity,
      'v1 coarseness: unchanged member B identity still changes (whole-bundle hash)');
    // planProjectUpgrade therefore marks BOTH replace against an installation of the earlier release.
    const installation = createProjectInstallation({
      release: first.release, targetImageId: 'target',
      targets: {a: objectRef('target', 'ta'), b: objectRef('target', 'tb')},
    });
    const plan = planProjectUpgrade({installation, nextRelease: second.release});
    assert.deepEqual(plan.actions.map(({key, kind}) => [key, kind]), [['a', 'replace'], ['b', 'replace']]);
  });
});

test('13. Profile subset: only selected member is a root/member; transitive reach of an unselected target is material, not membership', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const bTarget = await seedShapeAndObject(runtime, 'img', 'b-target', {v: integerValue(2)});
    const aTarget = await seedShapeAndObject(runtime, 'img', 'a-target', {v: bTarget});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [
      {key: 'a', role: 'source', target: aTarget},
      {key: 'b', role: 'source', target: bTarget},
    ]);
    const {release, material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['a']),
    });
    assert.deepEqual(Object.keys(material.bundle.roots), ['a'], 'only the selected member is a root');
    assert.deepEqual(release.members.map(({key}) => key), ['a'], 'B is not a manifest member');
    // A's graph reaches B's target: it appears as TRANSITIVE material, still not member B.
    const aRoot = material.bundle.records[material.bundle.roots.a];
    assert.equal(aRoot.slots.v.kind, 'local-ref', "B's target is transitive material inside A's closure");
  });
});

test('14. Same material, later unrelated frontier: same bundle identity + releaseId, different provenance', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const rec = await seedShapeAndObject(runtime, 'img', 'rec', {v: integerValue(7)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: rec}]);
    const profile = deploy(descriptor, ['m']);
    const first = await captureCurrentGraphProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile});
    // Unrelated write in the participating Image — selected graph material unchanged.
    await seedShapeAndObject(runtime, 'img', 'unrelated', {v: integerValue(0)});
    const second = await captureCurrentGraphProjectRelease({images: runtime.images, projectImageId: 'img', projectId, profile});
    assert.equal(second.material.contentIdentity, first.material.contentIdentity);
    assert.equal(second.release.releaseId, first.release.releaseId);
    assert.notEqual(second.provenance.sourceFrontiers.img, first.provenance.sourceFrontiers.img,
      'frontier moved; provenance records the new position');
  });
});

test('15. Material package linkage: wrong projectId/releaseId/identity, missing/extra root, wrong member representation/identity — each refused', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const rec = await seedShapeAndObject(runtime, 'img', 'rec', {v: integerValue(7)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: rec}]);
    const {release, material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['m']),
    });
    const good = {
      format: PROJECT_RELEASE_MATERIAL_V1,
      projectId: release.projectId,
      releaseId: release.releaseId,
      representation: GRAPH_BUNDLE_V1,
      contentIdentity: material.contentIdentity,
      bundle: structuredClone(material.bundle),
    };
    // intrinsic validation passes on the genuine package shape
    assert.equal(normalizeProjectReleaseMaterial(good), good);

    const reject = (mutate, pattern, label) => {
      const candidate = structuredClone(good);
      mutate(candidate);
      assert.throws(() => normalizeProjectReleaseMaterial(candidate), pattern, label);
    };
    // (A wrong projectId/releaseId is a LINKAGE failure, not an intrinsic one —
    // intrinsically they are just non-empty identity texts; the constructor below
    // refuses them against the release.)
    reject((c) => { c.contentIdentity = 'sha256:wrong'; }, /does not match its bundle/, 'wrong contentIdentity refused');
    reject((c) => { c.bundle.externals.e0 = {pinned: false, imageId: 'x', objectId: 'y'}; }, /fully closed|unused external/, 'non-empty externals refused');

    // release-linkage refusals. The model guards releaseId/body integrity, so a
    // naively tampered manifest is rejected by normalizeProjectReleaseManifest
    // itself; linkage mismatches are exercised with VALID but DIFFERENT releases.
    const tamperedRelease = (mutate) => {
      const r = structuredClone(release);
      mutate(r);
      return r;
    };
    assert.throws(
      () => createProjectReleaseMaterial({
        release: tamperedRelease((r) => { r.releaseId = 'sha256:other'; }),
        bundle: material.bundle, contentIdentity: material.contentIdentity,
      }),
      /releaseId/,
      'release linkage: wrong releaseId refused',
    );
    assert.throws(
      () => createProjectReleaseMaterial({
        release, bundle: {...structuredClone(material.bundle), roots: {}}, contentIdentity: material.contentIdentity,
      }),
      /root|invalid|at least one root/,
      'release linkage: missing root refused',
    );
    assert.throws(
      () => createProjectReleaseMaterial({
        release,
        bundle: {...structuredClone(material.bundle), roots: {...material.bundle.roots, extra: material.bundle.roots.m}},
        contentIdentity: material.contentIdentity,
      }),
      /exactly equal|does not match its bundle/,
      'release linkage: extra root refused',
    );

    // A DIFFERENT valid release (different content -> different valid releaseId):
    // member contentIdentity no longer matches the first material.
    await runtime.images.putObject('img', {id: 'rec', shape: objectRef('img', 'shape'), slots: {v: integerValue(8)}}, {expectedVersion: 1});
    const {release: otherRelease} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['m']),
    });
    assert.throws(
      () => createProjectReleaseMaterial({
        release: otherRelease, bundle: material.bundle, contentIdentity: material.contentIdentity,
      }),
      /contentIdentity/,
      'release linkage: member contentIdentity mismatch refused (valid but different release)',
    );

    // A valid release with a DIFFERENT representation (direct-record path):
    // member representation no longer matches the graph-bundle material.
    const {release: directRelease} = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['m']),
      materializeRecord: ({record}) => ({representation: 'lagrange-test-record/v1', contentIdentity: `record:${record.id}:${record._version}`}),
    });
    assert.throws(
      () => createProjectReleaseMaterial({
        release: directRelease, bundle: material.bundle, contentIdentity: material.contentIdentity,
      }),
      /representation/,
      'release linkage: member representation mismatch refused',
    );

    // The root-set check's UNIQUE job: a VALID two-member manifest whose members
    // BOTH carry this material's exact representation+identity (so every other
    // linkage check passes), but the bundle names only ONE root. Only the
    // root-keys === member-keys check can refuse it.
    const rec2 = await seedShapeAndObject(runtime, 'img', 'rec2', {v: integerValue(11)});
    const descriptor2 = await seedProject(runtime, 'img', projectId, [
      {key: 'm', role: 'source', target: rec},
      {key: 'm2', role: 'source', target: rec2},
    ]);
    const validTwoMemberRelease = createProjectReleaseManifest({
      project: descriptor2,
      profile: deploy(descriptor2, ['m', 'm2']),
      materializations: {
        m: {representation: GRAPH_BUNDLE_V1, contentIdentity: material.contentIdentity},
        m2: {representation: GRAPH_BUNDLE_V1, contentIdentity: material.contentIdentity},
      },
    });
    assert.throws(
      () => createProjectReleaseMaterial({
        release: validTwoMemberRelease, bundle: structuredClone(material.bundle), contentIdentity: material.contentIdentity,
      }),
      /exactly equal/,
      'release linkage: bundle roots must cover every release member (root-set check is the only guard)',
    );
  });
});

test('16. Material immutability: package, nested records, roots/externals cannot be mutated', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const rec = await seedShapeAndObject(runtime, 'img', 'rec', {v: integerValue(7)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: rec}]);
    const {material} = await captureCurrentGraphProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['m']),
    });
    assert.ok(Object.isFrozen(material));
    assert.ok(Object.isFrozen(material.bundle));
    assert.ok(Object.isFrozen(material.bundle.records));
    assert.ok(Object.isFrozen(material.bundle.roots));
    assert.ok(Object.isFrozen(material.bundle.externals));
    const rootRecord = material.bundle.records[material.bundle.roots.m];
    assert.ok(Object.isFrozen(rootRecord), 'records are deeply frozen');
    assert.throws(() => { material.contentIdentity = 'sha256:hacked'; }, TypeError);
    assert.throws(() => { material.bundle.roots.m = 'r99'; }, TypeError);
    assert.throws(() => { rootRecord.kind = 'hacked'; }, TypeError);
  });
});

test('17. Existing direct capture unchanged: returns {release, provenance} only — no material on the direct path', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const rec = await seedShapeAndObject(runtime, 'img', 'rec', {v: integerValue(7)});
    const projectId = createProjectId();
    const descriptor = await seedProject(runtime, 'img', projectId, [{key: 'm', role: 'source', target: rec}]);
    const result = await captureCurrentProjectRelease({
      images: runtime.images, projectImageId: 'img', projectId, profile: deploy(descriptor, ['m']),
      materializeRecord: ({record}) => ({representation: 'lagrange-test-record/v1', contentIdentity: `record:${record.id}:${record._version}`}),
    });
    assert.deepEqual(Object.keys(result).sort(), ['provenance', 'release']);
    assert.ok(!('material' in result), 'the direct path gains NO material field');
    assert.equal(result.release.members[0].representation, 'lagrange-test-record/v1');
  });
});

test('18. Reader capability narrowness: the materializer uses ONLY getRecord, even from a richer object', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const rec = await seedShapeAndObject(runtime, 'img', 'rec', {v: integerValue(7)});
    const members = [{key: 'm', role: 'source', target: rec}];
    // A hostile rich reader: every capability BESIDES getRecord throws if touched.
    const booby = (name) => () => { throw new Error(`materializer touched forbidden capability: ${name}`); };
    const reader = {
      getRecord: (imageId, objectId) => runtime.images.getRecord(imageId, objectId),
      frontier: booby('frontier'),
      assertStable: booby('assertStable'),
      frontierMap: booby('frontierMap'),
      createRecords: booby('createRecords'),
      putObject: booby('putObject'),
      backend: booby('backend'),
      require: booby('require'),
    };
    const {bundle, contentIdentity, materializations} = await materializeProjectGraphRelease({reader, members});
    assert.equal(contentIdentity, (await import('../src/graph/bundle.js')).contentIdentityForBundle(bundle));
    assert.deepEqual(materializations.m, {representation: GRAPH_BUNDLE_V1, contentIdentity});
    // and the exact {getRecord}-only shape works too
    const narrow = await materializeProjectGraphRelease({
      reader: {getRecord: (imageId, objectId) => runtime.images.getRecord(imageId, objectId)},
      members,
    });
    assert.equal(narrow.contentIdentity, contentIdentity);
  });
});
