import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {
  OBJECT_WRITE_OPERATION,
  PROJECT_INSTALLATION_PROVENANCE_V1,
  ManagedProjectInstallationConflictError,
  addProjectMember,
  authorizedUpgradeManagedProjectRelease,
  captureCurrentGraphProjectRelease,
  createDeploymentProfile,
  createProject,
  createProjectId,
  createRuntime,
  exportGraphBundleWithSourceMap,
  extractSubBundleFromBundle,
  installationHeadObjectId,
  installManagedProjectRelease,
  integerValue,
  listManagedProjectInstallations,
  objectRef,
  objectResource,
  readManagedProjectInstallation,
  readManagedProjectInstallationState,
  readProjectDescriptor,
  textValue,
  upgradeManagedProjectRelease,
} from '../src/runtime.js';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function createPolyglotMemberGraph(images, imageId, {
  counterInitial = 10,
  lispSourceText = '(defun compute (x) (+ x 1))',
  configLabel = 'v1-legacy',
} = {}) {
  await images.putShape(imageId, {
    id: 'st-class-shape',
    slots: [
      {id: 'name', name: 'name'},
      {id: 'initial', name: 'initial'},
      {id: 'helper', name: 'helper'},
    ],
  });
  await images.putShape(imageId, {
    id: 'st-helper-shape',
    slots: [{id: 'step', name: 'step'}],
  });
  await images.putObject(imageId, {
    id: 'counter-helper',
    shape: objectRef(imageId, 'st-helper-shape'),
    slots: {step: integerValue(1)},
  });
  await images.putObject(imageId, {
    id: 'counter-class',
    shape: objectRef(imageId, 'st-class-shape'),
    slots: {
      name: textValue('Counter'),
      initial: integerValue(counterInitial),
      helper: objectRef(imageId, 'counter-helper'),
    },
  });

  await images.putCodeArtifact(imageId, {
    id: 'cl-math-src',
    languageId: 'common-lisp',
    representation: 'common-lisp-source/v1',
    logicalPath: 'src/math.lisp',
    content: textValue(lispSourceText),
  });
  await images.putCodeArtifact(imageId, {
    id: 'cl-math-def',
    languageId: 'common-lisp',
    representation: 'common-lisp-runtime-definition/v1',
    dependencies: [{role: 'source', artifact: objectRef(imageId, 'cl-math-src')}],
    content: textValue(JSON.stringify({
      package: 'CL-USER',
      entrypoint: 'src/math.lisp',
      exports: [{operation: 'compute', symbol: 'COMPUTE', arity: 1}],
    })),
  });

  await images.putShape(imageId, {
    id: 'config-shape',
    slots: [{id: 'label', name: 'label'}],
  });
  await images.putObject(imageId, {
    id: 'config-obj',
    shape: objectRef(imageId, 'config-shape'),
    slots: {label: textValue(configLabel)},
  });
}

test('upgradeManagedProjectRelease upgrades a polyglot Project installation in place, reuses unchanged member subgraphs, detaches removed members without deleting target records, and records truthful provenance', async () => {
  await withRuntime(async (runtime) => {
    const projectId = createProjectId();
    await runtime.images.createImage({id: 'src-v1'});
    await createPolyglotMemberGraph(runtime.images, 'src-v1', {
      counterInitial: 10,
      lispSourceText: '(defun compute (x) (+ x 1))',
      configLabel: 'legacy-config',
    });
    await createProject({images: runtime.images, imageId: 'src-v1', projectId, name: 'PolyglotApp'});
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-v1',
      projectId,
      key: 'class/Counter',
      role: 'source',
      target: objectRef('src-v1', 'counter-class'),
    });
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-v1',
      projectId,
      key: 'foreign/math-def',
      role: 'runtime-definition',
      target: objectRef('src-v1', 'cl-math-def'),
    });
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-v1',
      projectId,
      key: 'config/legacy',
      role: 'configuration',
      target: objectRef('src-v1', 'config-obj'),
    });

    const descV1 = await readProjectDescriptor({images: runtime.images, imageId: 'src-v1', projectId});
    const profileV1 = createDeploymentProfile({
      project: descV1,
      profileId: 'default',
      members: ['class/Counter', 'config/legacy', 'foreign/math-def'],
    });
    const releaseV1 = await captureCurrentGraphProjectRelease({
      images: runtime.images,
      projectImageId: 'src-v1',
      projectId,
      profile: profileV1,
    });

    await runtime.images.createImage({id: 'target'});
    const installedV1 = await installManagedProjectRelease({
      images: runtime.images,
      targetImageId: 'target',
      release: releaseV1.release,
      material: releaseV1.material,
    });

    const v1CounterTarget = installedV1.members.find((m) => m.key === 'class/Counter').target;
    const v1MathTarget = installedV1.members.find((m) => m.key === 'foreign/math-def').target;
    const v1LegacyConfigTarget = installedV1.members.find((m) => m.key === 'config/legacy').target;

    // Now build Release V2 where:
    // - class/Counter subgraph is completely unchanged
    // - foreign/math-def has updated source payload
    // - config/legacy is removed (detached)
    // - config/v2 is newly added (installed)
    await runtime.images.createImage({id: 'src-v2'});
    await createPolyglotMemberGraph(runtime.images, 'src-v2', {
      counterInitial: 10, // identical to V1
      lispSourceText: '(defun compute (x) (* x 2))', // modified in V2
      configLabel: 'v2-active-config',
    });
    await createProject({images: runtime.images, imageId: 'src-v2', projectId, name: 'PolyglotApp'});
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-v2',
      projectId,
      key: 'class/Counter',
      role: 'source',
      target: objectRef('src-v2', 'counter-class'),
    });
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-v2',
      projectId,
      key: 'foreign/math-def',
      role: 'runtime-definition',
      target: objectRef('src-v2', 'cl-math-def'),
    });
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-v2',
      projectId,
      key: 'config/v2',
      role: 'configuration',
      target: objectRef('src-v2', 'config-obj'),
    });

    const descV2 = await readProjectDescriptor({images: runtime.images, imageId: 'src-v2', projectId});
    const profileV2 = createDeploymentProfile({
      project: descV2,
      profileId: 'default',
      members: ['class/Counter', 'config/v2', 'foreign/math-def'],
    });
    const releaseV2 = await captureCurrentGraphProjectRelease({
      images: runtime.images,
      projectImageId: 'src-v2',
      projectId,
      profile: profileV2,
    });

    const recordsBeforeUpgrade = await runtime.images.listRecords('target');
    const upgradeResult = await upgradeManagedProjectRelease({
      images: runtime.images,
      targetImageId: 'target',
      release: releaseV2.release,
      material: releaseV2.material,
      expectedReleaseId: releaseV1.release.releaseId,
    });

    assert.equal(upgradeResult.upgraded, true);
    assert.equal(upgradeResult.previousReleaseId, releaseV1.release.releaseId);
    assert.equal(upgradeResult.installation.releaseId, releaseV2.release.releaseId);

    // 1. Unchanged member `class/Counter` reused its exact target ObjectRef from V1!
    const v2CounterTarget = upgradeResult.installation.members.find((m) => m.key === 'class/Counter').target;
    assert.deepEqual(v2CounterTarget, v1CounterTarget, 'unchanged member subgraph must reuse existing target ObjectRef');

    // 2. Modified member `foreign/math-def` was replaced with a newly imported target ObjectRef
    const v2MathTarget = upgradeResult.installation.members.find((m) => m.key === 'foreign/math-def').target;
    assert.notDeepEqual(v2MathTarget, v1MathTarget, 'modified member must receive a new target ObjectRef');
    const v2MathDef = await runtime.images.getRecord('target', v2MathTarget.objectId);
    const v2MathSrc = await runtime.images.getRecord('target', v2MathDef.dependencies[0].artifact.objectId);
    assert.deepEqual(v2MathSrc.content, textValue('(defun compute (x) (* x 2))'));

    // 3. New member `config/v2` was installed
    const v2ConfigTarget = upgradeResult.installation.members.find((m) => m.key === 'config/v2').target;
    const v2ConfigObj = await runtime.images.getObject('target', v2ConfigTarget.objectId);
    assert.deepEqual(v2ConfigObj.slots.label, textValue('v2-active-config'));

    // 4. Detached member `config/legacy` is no longer in the installation, but its target record remains intact
    assert.equal(
      upgradeResult.installation.members.some((m) => m.key === 'config/legacy'),
      false,
    );
    const detachedRecordStillExists = await runtime.images.getObject('target', v1LegacyConfigTarget.objectId);
    assert.deepEqual(detachedRecordStillExists.slots.label, textValue('legacy-config'));

    // 5. Provenance is truthful and persisted in durable installation state
    assert.equal(upgradeResult.provenance.format, PROJECT_INSTALLATION_PROVENANCE_V1);
    assert.equal(upgradeResult.provenance.operation, 'upgrade');
    assert.equal(upgradeResult.provenance.previousReleaseId, releaseV1.release.releaseId);
    assert.deepEqual(upgradeResult.provenance.reusedMemberKeys, ['class/Counter']);
    assert.deepEqual(upgradeResult.provenance.importedMemberKeys, ['config/v2', 'foreign/math-def']);
    assert.deepEqual(upgradeResult.provenance.detachedMemberKeys, ['config/legacy']);
    assert.equal(upgradeResult.provenance.reusedRecordCount, 4); // st-class-shape, st-helper-shape, counter-helper, counter-class

    const durableState = await readManagedProjectInstallationState({
      images: runtime.images,
      targetImageId: 'target',
      projectId,
    });
    assert.equal(durableState.headVersion, 2);
    assert.deepEqual(durableState.descriptor, upgradeResult.installation);
    assert.deepEqual(durableState.provenance, upgradeResult.provenance);

    // Count records created: reusing 4 records from class/Counter avoided minting 4 duplicate records
    const recordsAfterUpgrade = await runtime.images.listRecords('target');
    const totalV2BundleRecords = Object.keys(releaseV2.material.bundle.records).length;
    const snapshotAndMemberRecords = 1 + releaseV2.release.members.length;
    assert.equal(
      recordsAfterUpgrade.length - recordsBeforeUpgrade.length,
      (totalV2BundleRecords - 4) + snapshotAndMemberRecords,
    );
  });
});

test('cross-install content-addressed reuse shares identical member subgraphs across distinct Projects in the same target image with truthful provenance', async () => {
  await withRuntime(async (runtime) => {
    const projectA = createProjectId();
    const projectB = createProjectId();

    await runtime.images.createImage({id: 'src-a'});
    await createPolyglotMemberGraph(runtime.images, 'src-a', {
      counterInitial: 42,
      lispSourceText: '(defun shared-kernel (n) (+ n 100))',
      configLabel: 'project-a-only',
    });
    await createProject({images: runtime.images, imageId: 'src-a', projectId: projectA, name: 'ProjectA'});
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-a',
      projectId: projectA,
      key: 'shared/lisp-kernel',
      role: 'runtime-definition',
      target: objectRef('src-a', 'cl-math-def'),
    });
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-a',
      projectId: projectA,
      key: 'app/config',
      role: 'configuration',
      target: objectRef('src-a', 'config-obj'),
    });
    const descA = await readProjectDescriptor({images: runtime.images, imageId: 'src-a', projectId: projectA});
    const releaseA = await captureCurrentGraphProjectRelease({
      images: runtime.images,
      projectImageId: 'src-a',
      projectId: projectA,
      profile: createDeploymentProfile({
        project: descA,
        profileId: 'default',
        members: ['app/config', 'shared/lisp-kernel'],
      }),
    });

    await runtime.images.createImage({id: 'src-b'});
    await createPolyglotMemberGraph(runtime.images, 'src-b', {
      counterInitial: 42,
      lispSourceText: '(defun shared-kernel (n) (+ n 100))', // identical closure to Project A!
      configLabel: 'project-b-only',
    });
    await createProject({images: runtime.images, imageId: 'src-b', projectId: projectB, name: 'ProjectB'});
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-b',
      projectId: projectB,
      key: 'kernel/common-lisp',
      role: 'runtime-definition',
      target: objectRef('src-b', 'cl-math-def'),
    });
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-b',
      projectId: projectB,
      key: 'app/config',
      role: 'configuration',
      target: objectRef('src-b', 'config-obj'),
    });
    const descB = await readProjectDescriptor({images: runtime.images, imageId: 'src-b', projectId: projectB});
    const releaseB = await captureCurrentGraphProjectRelease({
      images: runtime.images,
      projectImageId: 'src-b',
      projectId: projectB,
      profile: createDeploymentProfile({
        project: descB,
        profileId: 'default',
        members: ['app/config', 'kernel/common-lisp'],
      }),
    });

    await runtime.images.createImage({id: 'shared-target'});
    const installedA = await installManagedProjectRelease({
      images: runtime.images,
      targetImageId: 'shared-target',
      release: releaseA.release,
      material: releaseA.material,
    });
    const installedB = await installManagedProjectRelease({
      images: runtime.images,
      targetImageId: 'shared-target',
      release: releaseB.release,
      material: releaseB.material,
      reuseExistingInstallations: true,
    });

    const targetKernelA = installedA.members.find((m) => m.key === 'shared/lisp-kernel').target;
    const targetKernelB = installedB.members.find((m) => m.key === 'kernel/common-lisp').target;
    assert.deepEqual(
      targetKernelB,
      targetKernelA,
      'Project B must reuse Project A’s already-installed content-addressed member closure even under a different member key',
    );

    const targetConfigA = installedA.members.find((m) => m.key === 'app/config').target;
    const targetConfigB = installedB.members.find((m) => m.key === 'app/config').target;
    assert.notDeepEqual(targetConfigB, targetConfigA, 'distinct config member must still be imported freshly');

    const stateB = await readManagedProjectInstallationState({
      images: runtime.images,
      targetImageId: 'shared-target',
      projectId: projectB,
    });
    assert.equal(stateB.provenance.format, PROJECT_INSTALLATION_PROVENANCE_V1);
    assert.equal(stateB.provenance.operation, 'install');
    assert.deepEqual(stateB.provenance.reusedMemberKeys, ['kernel/common-lisp']);
    assert.deepEqual(stateB.provenance.importedMemberKeys, ['app/config']);
    assert.deepEqual(stateB.provenance.reusedInstallations, [
      {projectId: projectA, releaseId: releaseA.release.releaseId},
    ]);

    const allInstallations = await listManagedProjectInstallations({
      images: runtime.images,
      targetImageId: 'shared-target',
    });
    assert.equal(allInstallations.length, 2);
  });
});

test('idempotent upgrade replay is write-free; stale expectedReleaseId refuses with ManagedProjectInstallationConflictError; authorizedUpgradeManagedProjectRelease enforces authority', async () => {
  await withRuntime(async (runtime) => {
    const projectId = createProjectId();
    await runtime.images.createImage({id: 'src-1'});
    await createPolyglotMemberGraph(runtime.images, 'src-1', {configLabel: 'v1'});
    await createProject({images: runtime.images, imageId: 'src-1', projectId, name: 'App'});
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-1',
      projectId,
      key: 'config/main',
      role: 'configuration',
      target: objectRef('src-1', 'config-obj'),
    });
    const desc1 = await readProjectDescriptor({images: runtime.images, imageId: 'src-1', projectId});
    const rel1 = await captureCurrentGraphProjectRelease({
      images: runtime.images,
      projectImageId: 'src-1',
      projectId,
      profile: createDeploymentProfile({project: desc1, profileId: 'p', members: ['config/main']}),
    });

    await runtime.images.createImage({id: 'src-2'});
    await createPolyglotMemberGraph(runtime.images, 'src-2', {configLabel: 'v2'});
    await createProject({images: runtime.images, imageId: 'src-2', projectId, name: 'App'});
    await addProjectMember({
      images: runtime.images,
      imageId: 'src-2',
      projectId,
      key: 'config/main',
      role: 'configuration',
      target: objectRef('src-2', 'config-obj'),
    });
    const desc2 = await readProjectDescriptor({images: runtime.images, imageId: 'src-2', projectId});
    const rel2 = await captureCurrentGraphProjectRelease({
      images: runtime.images,
      projectImageId: 'src-2',
      projectId,
      profile: createDeploymentProfile({project: desc2, profileId: 'p', members: ['config/main']}),
    });

    await runtime.images.createImage({id: 'dst'});
    await installManagedProjectRelease({
      images: runtime.images,
      targetImageId: 'dst',
      release: rel1.release,
      material: rel1.material,
    });

    // Wrong expectedReleaseId refuses without mutating target
    await assert.rejects(
      upgradeManagedProjectRelease({
        images: runtime.images,
        targetImageId: 'dst',
        release: rel2.release,
        material: rel2.material,
        expectedReleaseId: 'wrong-release-id',
      }),
      (err) => err instanceof ManagedProjectInstallationConflictError
        && err.currentReleaseId === rel1.release.releaseId,
    );

    // Unpermitted authority refuses before reading or mutating
    const readOnlyCtx = runtime.authority.issue({
      principal: 'reader',
      grants: [{
        operation: 'read',
        resource: objectResource('dst', installationHeadObjectId(projectId)),
      }],
    });
    await assert.rejects(
      authorizedUpgradeManagedProjectRelease({
        authority: runtime.authority,
        authorityContext: readOnlyCtx,
        images: runtime.images,
        targetImageId: 'dst',
        release: rel2.release,
        material: rel2.material,
      }),
      /AuthorityError|not authorized/i,
    );

    // Permitted write authority on the deterministic installation head upgrades cleanly
    const writeCtx = runtime.authority.issue({
      principal: 'deployer',
      grants: [{
        operation: OBJECT_WRITE_OPERATION,
        resource: objectResource('dst', installationHeadObjectId(projectId)),
      }],
    });
    const upgraded = await authorizedUpgradeManagedProjectRelease({
      authority: runtime.authority,
      authorityContext: writeCtx,
      images: runtime.images,
      targetImageId: 'dst',
      release: rel2.release,
      material: rel2.material,
      expectedReleaseId: rel1.release.releaseId,
    });
    assert.equal(upgraded.upgraded, true);
    assert.equal(upgraded.installation.releaseId, rel2.release.releaseId);

    // Replaying the same V2 upgrade is idempotent and write-free
    const historyBeforeReplay = await runtime.images.history('dst');
    const replayed = await upgradeManagedProjectRelease({
      images: runtime.images,
      targetImageId: 'dst',
      release: rel2.release,
      material: rel2.material,
    });
    assert.equal(replayed.upgraded, false);
    assert.deepEqual(replayed.installation, upgraded.installation);
    assert.equal((await runtime.images.history('dst')).length, historyBeforeReplay.length);
  });
});

test('upgraded managed installation and provenance survive real SQLite backend restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-managed-upgrade-'));
  const filename = join(directory, 'image.sqlite');
  const projectId = createProjectId();
  try {
    const firstBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await firstBackend.start();
    const firstImages = new ImageService({backend: firstBackend});

    await firstImages.createImage({id: 'src-v1'});
    await createPolyglotMemberGraph(firstImages, 'src-v1', {configLabel: 'v1'});
    await createProject({images: firstImages, imageId: 'src-v1', projectId, name: 'App'});
    await addProjectMember({
      images: firstImages,
      imageId: 'src-v1',
      projectId,
      key: 'class/Counter',
      role: 'source',
      target: objectRef('src-v1', 'counter-class'),
    });
    const desc1 = await readProjectDescriptor({images: firstImages, imageId: 'src-v1', projectId});
    const rel1 = await captureCurrentGraphProjectRelease({
      images: firstImages,
      projectImageId: 'src-v1',
      projectId,
      profile: createDeploymentProfile({project: desc1, profileId: 'p', members: ['class/Counter']}),
    });

    await firstImages.createImage({id: 'src-v2'});
    await createPolyglotMemberGraph(firstImages, 'src-v2', {configLabel: 'v2'});
    await createProject({images: firstImages, imageId: 'src-v2', projectId, name: 'App'});
    await addProjectMember({
      images: firstImages,
      imageId: 'src-v2',
      projectId,
      key: 'class/Counter',
      role: 'source',
      target: objectRef('src-v2', 'counter-class'),
    });
    await addProjectMember({
      images: firstImages,
      imageId: 'src-v2',
      projectId,
      key: 'config/v2',
      role: 'configuration',
      target: objectRef('src-v2', 'config-obj'),
    });
    const desc2 = await readProjectDescriptor({images: firstImages, imageId: 'src-v2', projectId});
    const rel2 = await captureCurrentGraphProjectRelease({
      images: firstImages,
      projectImageId: 'src-v2',
      projectId,
      profile: createDeploymentProfile({project: desc2, profileId: 'p', members: ['class/Counter', 'config/v2']}),
    });

    await firstImages.createImage({id: 'dst'});
    await installManagedProjectRelease({
      images: firstImages,
      targetImageId: 'dst',
      release: rel1.release,
      material: rel1.material,
    });
    const upgraded = await upgradeManagedProjectRelease({
      images: firstImages,
      targetImageId: 'dst',
      release: rel2.release,
      material: rel2.material,
    });
    await firstBackend.stop();

    const secondBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await secondBackend.start();
    try {
      const secondImages = new ImageService({backend: secondBackend});
      const recovered = await readManagedProjectInstallation({
        images: secondImages,
        targetImageId: 'dst',
        projectId,
      });
      assert.deepEqual(recovered, upgraded.installation);
      const state = await readManagedProjectInstallationState({
        images: secondImages,
        targetImageId: 'dst',
        projectId,
      });
      assert.equal(state.headVersion, 2);
      assert.deepEqual(state.provenance, upgraded.provenance);

      // Also verify exportGraphBundleWithSourceMap and extractSubBundleFromBundle helpers
      const {contentIdentity, localToSourceRef} = await exportGraphBundleWithSourceMap({
        images: secondImages,
        roots: {root: recovered.members.find((m) => m.key === 'class/Counter').target},
        referencePolicy: {classify: () => 'internal'},
      });
      assert.equal(Object.keys(localToSourceRef).length, 4);
      const sub = await extractSubBundleFromBundle({
        bundle: rel2.material.bundle,
        rootLocalId: rel2.material.bundle.roots['class/Counter'],
        rootKey: 'root',
      });
      assert.equal(sub.contentIdentity, contentIdentity);
    } finally {
      await secondBackend.stop();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
