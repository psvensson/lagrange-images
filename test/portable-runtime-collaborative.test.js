import test from 'node:test';
import assert from 'node:assert/strict';
import {setDefaultCryptoProvider, resetDefaultCryptoProvider} from '../src/support/default-crypto.js';
import {createNodeCryptoProvider} from '../src/support/node-crypto-provider.js';
import * as portable from '../src/portable-runtime.js';
import * as nodeRuntime from '../src/runtime.js';
import {OBJECT_READ_OPERATION, OBJECT_WRITE_OPERATION} from '../src/authority/object-resource.js';

const {
  createPortableRuntime,
  installSymmetricSmalltalkStandardImage,
  installSymmetricSmalltalkBlock,
  objectRef,
  textValue,
  integerValue,
  objectResource,
  // Project & conventions
  createProject,
  addProjectMember,
  createProjectNote,
  readProjectNote,
  createProjectWorkItem,
  readProjectWorkItem,
  updateProjectWorkItem,
  listProjectWorkItems,
  createProjectTestCase,
  runProjectTests,
  authorizedRunProjectTests,
  // Branches & merge
  createBranch,
  advanceBranch,
  listBranches,
  diffBranches,
  mergeBranches,
  diffProjectBranches,
  mergeProjectBranches,
  authorizedMergeProjects,
  // Managed release install & upgrade
  createDeploymentProfile,
  createProjectReleaseManifest,
  createProjectReleaseMaterial,
  materializeProjectGraphRelease,
  selectProjectMembers,
  installManagedProjectRelease,
  upgradeManagedProjectRelease,
  authorizedUpgradeManagedProjectRelease,
  readManagedProjectInstallationState,
  listManagedProjectInstallations,
  // Shape migration & reachability / GC
  planImageShapeMigration,
  migrateImageObjectsToShape,
  planImageGarbageCollection,
  collectUnreachableImageRecords,
  // Package archive
  createPackageArchiveManifest,
  importPackageArchive,
  parsePackageArchiveArtifact,
} = portable;

test('portable-runtime exposes identical collaborative owner functions as runtime.js', () => {
  const expectedFunctions = [
    'mergeImageRecords',
    'mergeImageFrontiers',
    'applyImageMerge',
    'createBranch',
    'advanceBranch',
    'getBranch',
    'listBranches',
    'deleteBranch',
    'diffBranches',
    'mergeBranches',
    'forkImageFromFrontier',
    'forkImageFromBranch',
    'buildImageGraphIndex',
    'computeReachableImageClosure',
    'planImageGarbageCollection',
    'collectUnreachableImageRecords',
    'planImageShapeMigration',
    'migrateImageObjectsToShape',
    'mergeProjectDescriptors',
    'mergeProjectReleases',
    'mergeProjectAtFrontiers',
    'authorizedMergeProjects',
    'diffProjectBranches',
    'mergeProjectBranches',
    'authorizedCreateBranch',
    'authorizedAdvanceBranch',
    'authorizedMergeBranches',
    'createProjectNote',
    'readProjectNote',
    'createProjectWorkItem',
    'readProjectWorkItem',
    'updateProjectWorkItem',
    'listProjectWorkItems',
    'createProjectTestCase',
    'runProjectTests',
    'authorizedRunProjectTests',
    'resolveNestedProjectGraph',
    'upgradeManagedProjectRelease',
    'authorizedUpgradeManagedProjectRelease',
    'readManagedProjectInstallationState',
    'listManagedProjectInstallations',
    'createPackageArchiveManifest',
    'importPackageArchive',
    'parsePackageArchiveArtifact',
    'reusePrecompiledWasmArtifact',
  ];

  for (const fnName of expectedFunctions) {
    assert.equal(typeof portable[fnName], 'function', `${fnName} must be exported as a function`);
    assert.equal(
      portable[fnName],
      nodeRuntime[fnName],
      `${fnName} must be the exact same owner function on both roots`,
    );
  }
});

test('END-TO-END: portable runtime supports Project notes, work items, in-image tests, branching, three-way merging, release upgrades, shape migration, GC, and package archives', async () => {
  resetDefaultCryptoProvider();
  setDefaultCryptoProvider(createNodeCryptoProvider());
  const runtime = await createPortableRuntime({backend: {mode: 'mock'}});
  try {
    const {images, compilation, invocations, executor, authority} = runtime;
    const imageId = 'portable-collab';
    await images.createImage({id: imageId});
    await installSymmetricSmalltalkStandardImage({
      images,
      compilation,
      imageId,
      lane: 'wasm',
    });

    // 1. Project conventions: notes, work items, and in-image tests.
    await createProject({
      images,
      imageId,
      projectId: 'collab-app',
      name: 'Collaborative App',
    });
    const note = await createProjectNote({
      images,
      imageId,
      projectId: 'collab-app',
      noteId: 'arch-note',
      title: 'Architecture Note',
      body: 'Portable collaborative workflow note',
    });
    assert.equal(note.title, 'Architecture Note');
    const readNote = await readProjectNote({
      images,
      imageId,
      projectId: 'collab-app',
      noteId: 'arch-note',
    });
    assert.equal(readNote.body, 'Portable collaborative workflow note');

    await createProjectWorkItem({
      images,
      imageId,
      projectId: 'collab-app',
      workItemId: 'wi-1',
      title: 'Verify portable merge',
      description: 'Run 3-way merge on portable runtime',
      status: 'open',
      priority: 1,
    });
    const updatedWi = await updateProjectWorkItem({
      images,
      imageId,
      projectId: 'collab-app',
      workItemId: 'wi-1',
      status: 'completed',
    });
    assert.equal(updatedWi.status, 'completed');
    assert.equal((await listProjectWorkItems({images, imageId, projectId: 'collab-app'})).length, 1);

    const testBlock = await installSymmetricSmalltalkBlock({
      images,
      imageId,
      id: 'collab-app/test-block',
      source: '[20 + 22]',
    });
    await createProjectTestCase({
      images,
      imageId,
      projectId: 'collab-app',
      testId: 'math-check',
      title: '20 + 22 == 42',
      target: objectRef(imageId, testBlock.block.id),
      expectedValue: integerValue(42),
    });

    const readGrant = authority.issue({
      principal: 'tester',
      grants: [
        {
          operation: OBJECT_READ_OPERATION,
          resource: objectResource(imageId, portable.projectObjectId('collab-app')),
        },
      ],
    });
    const testReport = await authorizedRunProjectTests({
      authority,
      authorityContext: readGrant,
      runtime,
      imageId,
      projectId: 'collab-app',
    });
    assert.equal(testReport.passedCount, 1);
    assert.equal(testReport.failedCount, 0);

    // 2. Named branches and three-way merge.
    const baseBranch = await createBranch({
      images,
      imageId,
      name: 'main',
      description: 'Base branch',
    });
    const baseRevision = baseBranch.descriptor.frontier.revision;
    await createBranch({
      images,
      imageId,
      name: 'feature-a',
      frontier: baseRevision,
    });
    await createBranch({
      images,
      imageId,
      name: 'feature-b',
      frontier: baseRevision,
    });

    // Fork a base snapshot image and a feature-b image from main BEFORE advancing feature-a
    await portable.forkImageFromBranch({
      images,
      imageId,
      branchName: 'main',
      targetImageId: 'portable-collab-base',
    });
    const forked = await portable.forkImageFromFrontier({
      images,
      sourceImageId: imageId,
      frontier: baseRevision,
      targetImageId: 'portable-collab-b',
    });
    assert.equal(forked.targetImageId, 'portable-collab-b');

    // Advance feature-a with one Project member
    const docShape = await images.putShape(imageId, {
      id: 'collab/doc-shape/v1',
      slots: [{id: 'title', name: 'title'}],
    });
    await images.putObject(imageId, {
      id: 'collab/doc-a',
      shape: objectRef(imageId, docShape.id),
      slots: {title: textValue('Feature A Doc')},
    });
    await addProjectMember({
      images,
      imageId,
      projectId: 'collab-app',
      key: 'doc-a',
      role: 'data',
      target: objectRef(imageId, 'collab/doc-a'),
    });
    await advanceBranch({images, imageId, name: 'feature-a'});

    // Add doc-b on portable-collab-b
    await images.putShape('portable-collab-b', {
      id: 'collab/doc-shape/v1',
      slots: [{id: 'title', name: 'title'}],
    });
    await images.putObject('portable-collab-b', {
      id: 'collab/doc-b',
      shape: objectRef('portable-collab-b', 'collab/doc-shape/v1'),
      slots: {title: textValue('Feature B Doc')},
    });
    await addProjectMember({
      images,
      imageId: 'portable-collab-b',
      projectId: 'collab-app',
      key: 'doc-b',
      role: 'data',
      target: objectRef('portable-collab-b', 'collab/doc-b'),
    });

    const multiGrant = authority.issue({
      principal: 'merger',
      grants: [
        {
          operation: OBJECT_READ_OPERATION,
          resource: objectResource('portable-collab-base', portable.projectObjectId('collab-app')),
        },
        {
          operation: OBJECT_READ_OPERATION,
          resource: objectResource(imageId, portable.projectObjectId('collab-app')),
        },
        {
          operation: OBJECT_READ_OPERATION,
          resource: objectResource('portable-collab-b', portable.projectObjectId('collab-app')),
        },
      ],
    });
    const projectMerge = await authorizedMergeProjects({
      images,
      baseImageId: 'portable-collab-base',
      baseProjectId: 'collab-app',
      leftImageId: imageId,
      leftProjectId: 'collab-app',
      rightImageId: 'portable-collab-b',
      rightProjectId: 'collab-app',
      targetImageId: imageId,
      require: (demand) => authority.require(multiGrant, demand),
    });
    assert.equal(projectMerge.clean, true);
    const mergedKeys = projectMerge.mergedDescriptor.members.map((m) => m.key);
    assert.ok(mergedKeys.includes('doc-a'));
    assert.ok(mergedKeys.includes('doc-b'));

    const branchList = await listBranches({images, imageId});
    assert.equal(branchList.length, 3);
    const branchDiff = await diffBranches({
      images,
      imageId,
      baseBranch: 'main',
      targetBranch: 'feature-a',
    });
    assert.ok(branchDiff.added.length >= 1);

    const ffMerge = await mergeBranches({
      images,
      imageId,
      sourceBranch: 'feature-a',
      targetBranch: 'main',
    });
    assert.equal(ffMerge.clean, true);
    assert.equal(ffMerge.applied, true);

    const projBranchDiff = await diffProjectBranches({
      images,
      imageId,
      projectId: 'collab-app',
      leftBranch: 'feature-b',
      rightBranch: 'main',
    });
    assert.ok(projBranchDiff.addedMembers.some((m) => m.key === 'doc-a'));

    const projBranchMerge = await mergeProjectBranches({
      images,
      imageId,
      projectId: 'collab-app',
      leftBranch: 'feature-b',
      rightBranch: 'main',
      baseBranch: 'feature-b',
    });
    assert.equal(projBranchMerge.clean, true);

    // 3. Managed Project release install & upgrade with subgraph reuse.
    const targetImageId = 'portable-target';
    await images.createImage({id: targetImageId});

    const descV1 = await portable.authorizedReadProjectDescriptor({
      images,
      imageId,
      projectId: 'collab-app',
      require: (demand) => authority.require(readGrant, demand),
    });
    const profileV1 = createDeploymentProfile({
      project: descV1,
      profileId: 'default',
      members: ['doc-a'],
    });
    const matV1 = await materializeProjectGraphRelease({
      reader: images,
      members: selectProjectMembers(descV1, profileV1),
    });
    const releaseV1 = createProjectReleaseManifest({
      project: descV1,
      profile: profileV1,
      materializations: matV1.materializations,
    });
    const materialV1 = createProjectReleaseMaterial({
      release: releaseV1,
      bundle: matV1.bundle,
      contentIdentity: matV1.contentIdentity,
    });

    await installManagedProjectRelease({
      images,
      targetImageId,
      release: releaseV1,
      material: materialV1,
    });

    // Add a second data member and upgrade
    await images.putObject(imageId, {
      id: 'collab/doc-v2',
      shape: objectRef(imageId, docShape.id),
      slots: {title: textValue('V2 Doc')},
    });
    await addProjectMember({
      images,
      imageId,
      projectId: 'collab-app',
      key: 'doc-v2',
      role: 'data',
      target: objectRef(imageId, 'collab/doc-v2'),
    });
    const descV2 = await portable.authorizedReadProjectDescriptor({
      images,
      imageId,
      projectId: 'collab-app',
      require: (demand) => authority.require(readGrant, demand),
    });
    const profileV2 = createDeploymentProfile({
      project: descV2,
      profileId: 'default',
      members: ['doc-a', 'doc-v2'],
    });
    const matV2 = await materializeProjectGraphRelease({
      reader: images,
      members: selectProjectMembers(descV2, profileV2),
    });
    const releaseV2 = createProjectReleaseManifest({
      project: descV2,
      profile: profileV2,
      materializations: matV2.materializations,
    });
    const materialV2 = createProjectReleaseMaterial({
      release: releaseV2,
      bundle: matV2.bundle,
      contentIdentity: matV2.contentIdentity,
    });

    const upgradeGrant = authority.issue({
      principal: 'deployer',
      grants: [
        {
          operation: OBJECT_WRITE_OPERATION,
          resource: objectResource(
            targetImageId,
            portable.installationHeadObjectId('collab-app'),
          ),
        },
      ],
    });
    const upgradeResult = await authorizedUpgradeManagedProjectRelease({
      images,
      targetImageId,
      release: releaseV2,
      material: materialV2,
      authority,
      authorityContext: upgradeGrant,
    });
    assert.equal(upgradeResult.upgraded, true);
    assert.ok(upgradeResult.reusedMemberKeys.includes('doc-a'));
    assert.ok(upgradeResult.installedMemberKeys.includes('doc-v2'));

    const instState = await readManagedProjectInstallationState({
      images,
      targetImageId,
      projectId: 'collab-app',
    });
    assert.equal(instState.installation.releaseId, releaseV2.releaseId);
    assert.equal((await listManagedProjectInstallations({images, targetImageId})).length, 1);

    // 4. Immutable Shape migration and unreachable record GC.
    const docShapeV2 = await images.putShape(imageId, {
      id: 'collab/doc-shape/v2',
      slots: [
        {id: 'title', name: 'title'},
        {id: 'category', name: 'category'},
      ],
    });
    const migrationPlan = await planImageShapeMigration({
      images,
      imageId,
      fromShapeId: docShape.id,
      toShapeId: docShapeV2.id,
      defaultSlotValues: {category: textValue('general')},
    });
    assert.equal(migrationPlan.objectCount, 2);
    const migrationReceipt = await migrateImageObjectsToShape({
      images,
      imageId,
      fromShapeId: docShape.id,
      toShapeId: docShapeV2.id,
      defaultSlotValues: {category: textValue('general')},
    });
    assert.equal(migrationReceipt.migratedCount, 2);
    const migratedDoc = await images.getObject(imageId, 'collab/doc-a');
    assert.equal(migratedDoc.slots.category.value, 'general');

    // Create an unreachable orphan object and sweep it via GC
    await images.putObject(imageId, {
      id: 'collab/orphan-temp',
      shape: objectRef(imageId, docShapeV2.id),
      slots: {title: textValue('Orphan'), category: textValue('trash')},
    });
    const gcPlan = await planImageGarbageCollection({
      images,
      imageId,
    });
    assert.ok(gcPlan.sweptIds.includes('collab/orphan-temp'));
    const gcReceipt = await collectUnreachableImageRecords({
      images,
      imageId,
      reason: 'portable-collab-gc-test',
    });
    assert.ok(gcReceipt.sweptIds.includes('collab/orphan-temp'));
    assert.equal(await images.getObject(imageId, 'collab/orphan-temp'), null);

    // 5. Durable package archive creation and import.
    const archiveManifest = createPackageArchiveManifest({
      name: 'collab-pkg',
      version: '1.0.0',
      language: 'symmetric-smalltalk',
      files: [
        {
          logicalPath: 'src/Collab.st',
          representation: 'symmetric-smalltalk-source/v1',
          role: 'source',
          text: 'Object subclass: #Collab',
        },
      ],
    });
    const archiveReceipt = await importPackageArchive({
      images,
      imageId,
      archive: archiveManifest,
    });
    assert.equal(archiveReceipt.packageName, 'collab-pkg');
    const parsedArchive = parsePackageArchiveArtifact(archiveReceipt.archiveArtifact);
    assert.equal(parsedArchive.archiveDigest, archiveManifest.archiveDigest);
  } finally {
    await runtime.close();
    resetDefaultCryptoProvider();
  }
});
