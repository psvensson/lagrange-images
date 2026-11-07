import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import './ensure-node-crypto.test-helper.js';
import {
  LAGRANGE_CODE_V1,
  MUTABLE_DOMAIN_CLOSURE_V1,
  NEUTRAL_EXPRESSION_V1,
  PARTITION_BENCHMARK_REPORT_V1,
  PlacementPolicy,
  WORKLOAD_BENCHMARK_REPORT_V1,
  addProjectMember,
  booleanValue,
  captureCurrentGraphProjectRelease,
  classifyProjectMembers,
  createDeploymentProfile,
  createProject,
  createProjectNote,
  createProjectTestCase,
  createProjectWorkItem,
  createRuntime,
  discoverMutableDomainClosure,
  evaluateImagePartitioningAndIndexing,
  importCuisNativePackage,
  installManagedProjectRelease,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  measureComputeNearObjectWorkload,
  objectRef,
  readManagedProjectInstallation,
  readProjectDescriptor,
  readProjectNote,
  readProjectWorkItem,
  runProjectTests,
  textValue,
} from '../src/index.js';
import {
  CUIS_LIFE_BLOB,
  FROZEN_STATES,
  GAMES_COMMIT,
  LIFE_METHOD_SCOPE,
  LIFE_SCOPE,
  buildBlinkerModel,
  nativeGlobalsFor,
  senderFor,
} from './support/life-m5-witness.js';

test('Complete M5 Project release closure packages Cuis Life code, notes, work items, and in-image tests into one portable release and executes natively after install', {timeout: 300_000}, async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/life-m5-release.json', import.meta.url), 'utf8'),
  );
  assert.equal(fixture.recorded.upstream, `Cuis-Smalltalk/Games@${GAMES_COMMIT}`);
  assert.equal(fixture.recorded.packageBlob, CUIS_LIFE_BLOB);

  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const STUDIO = 'life-m5-studio';
    const PROD = 'life-m5-prod';
    const PROJECT_ID = 'project:cuis-life-m5-complete';

    await runtime.images.createImage({id: STUDIO, name: 'Studio'});
    await runtime.images.createImage({id: PROD, name: 'Prod'});

    // 1. Install base fixture release into studio to obtain the sealed package & semantic export artifacts
    const baseInstalled = await installManagedProjectRelease({
      images: runtime.images,
      targetImageId: STUDIO,
      release: fixture.release,
      material: fixture.material,
    });
    const baseByKey = new Map(baseInstalled.members.map((m) => [m.key, m.target]));
    const pkgRef = baseByKey.get('life/package');
    const expRef = baseByKey.get('life/export');

    // 2. Author a complete Project closure in STUDIO: code + note + work-item + executable in-image test
    await createProject({
      images: runtime.images,
      imageId: STUDIO,
      projectId: PROJECT_ID,
      name: 'Cuis Life M5 Complete Closure',
    });

    await addProjectMember({
      images: runtime.images,
      imageId: STUDIO,
      projectId: PROJECT_ID,
      key: 'life/package',
      role: 'code',
      target: pkgRef,
    });
    await addProjectMember({
      images: runtime.images,
      imageId: STUDIO,
      projectId: PROJECT_ID,
      key: 'life/export',
      role: 'code',
      target: expRef,
    });

    await createProjectNote({
      images: runtime.images,
      imageId: STUDIO,
      projectId: PROJECT_ID,
      noteId: 'architecture',
      memberKey: 'life/note/architecture',
      title: 'M5 Life Model Architecture',
      body: 'Headless Conway Life blinker model (4x5 grid) imported from Cuis-Smalltalk/Games.',
      tags: ['m5', 'cuis', 'life'],
    });

    await createProjectWorkItem({
      images: runtime.images,
      imageId: STUDIO,
      projectId: PROJECT_ID,
      workItemId: 'blinker-oracle',
      memberKey: 'life/work-item/blinker-oracle',
      title: 'Verify 4x5 blinker S0 -> S1 -> S0 oscillation',
      description: 'Ensure recovered release imports natively and passes blinker state transitions.',
      status: 'in_progress',
      priority: 1,
    });

    // Store a self-contained callable Block test case verifying grid dimensions (4 + 5 == 9)
    const compiledTest = await runtime.images.putCodeArtifact(STUDIO, {
      id: 'life/test/grid-check-code',
      languageId: 'lagrange-neutral',
      representation: NEUTRAL_EXPRESSION_V1,
      content: textValue(
        JSON.stringify({
          parameters: 0,
          temporaries: [],
          body: {
            op: 'equals',
            left: {
              op: 'integer-add',
              left: {op: 'literal', value: integerValue(4)},
              right: {op: 'literal', value: integerValue(5)},
            },
            right: {op: 'literal', value: integerValue(9)},
          },
        }),
      ),
    });
    const testEnv = await runtime.images.putLexicalEnvironment(STUDIO, {
      id: 'life/test/grid-check-env',
      parent: null,
      bindings: {},
    });
    const testBlock = await runtime.images.putBlock(STUDIO, {
      id: 'life/test/grid-check-block',
      code: objectRef(STUDIO, compiledTest.id),
      environment: objectRef(STUDIO, testEnv.id),
    });

    await createProjectTestCase({
      images: runtime.images,
      imageId: STUDIO,
      projectId: PROJECT_ID,
      testId: 'grid-dimensions',
      memberKey: 'life/test/grid-dimensions',
      name: 'verify-4x5-grid-dimensions',
      languageId: 'lagrange-neutral',
      target: objectRef(STUDIO, testBlock.id),
      expected: booleanValue(true),
    });

    // 3. Capture the complete M5 Project release closure
    const studioProject = await readProjectDescriptor({
      images: runtime.images,
      imageId: STUDIO,
      projectId: PROJECT_ID,
    });
    const profile = createDeploymentProfile({
      project: studioProject,
      profileId: 'full-closure',
      members: studioProject.members.map((m) => m.key),
    });
    const captured = await captureCurrentGraphProjectRelease({
      images: runtime.images,
      projectImageId: STUDIO,
      projectId: PROJECT_ID,
      profile,
    });

    // 4. Install the complete closure into a blank PROD image
    const prodInstallation = await installManagedProjectRelease({
      images: runtime.images,
      targetImageId: PROD,
      release: captured.release,
      material: captured.material,
    });
    assert.equal(prodInstallation.projectId, PROJECT_ID);
    assert.equal(prodInstallation.members.length, 5);

    const recoveredInstall = await readManagedProjectInstallation({
      images: runtime.images,
      targetImageId: PROD,
      projectId: PROJECT_ID,
    });
    assert.equal(recoveredInstall.releaseId, prodInstallation.releaseId);

    // Build a working Project in PROD pointing to the installed members so Project conventions/tests can run directly in PROD
    await createProject({
      images: runtime.images,
      imageId: PROD,
      projectId: PROJECT_ID,
      name: 'Installed Cuis Life M5 Complete Closure',
    });
    const roleByKey = new Map(captured.release.members.map((m) => [m.key, m.role]));
    for (const member of recoveredInstall.members) {
      // eslint-disable-next-line no-await-in-loop
      await addProjectMember({
        images: runtime.images,
        imageId: PROD,
        projectId: PROJECT_ID,
        key: member.key,
        role: roleByKey.get(member.key),
        target: member.target,
      });
    }

    const prodDescriptor = await readProjectDescriptor({
      images: runtime.images,
      imageId: PROD,
      projectId: PROJECT_ID,
    });
    const classified = classifyProjectMembers(prodDescriptor);
    assert.equal(classified.code.length, 2);
    assert.equal(classified.notes.length, 1);
    assert.equal(classified.workItems.length, 1);
    assert.equal(classified.tests.length, 1);

    const prodNote = await readProjectNote({
      images: runtime.images,
      imageId: PROD,
      objectId: classified.notes[0].target.objectId,
    });
    assert.equal(prodNote.title, 'M5 Life Model Architecture');

    const prodWorkItem = await readProjectWorkItem({
      images: runtime.images,
      imageId: PROD,
      objectId: classified.workItems[0].target.objectId,
    });
    assert.equal(prodWorkItem.status, 'in_progress');

    const testReport = await runProjectTests({
      runtime,
      imageId: PROD,
      projectId: PROJECT_ID,
    });
    assert.equal(testReport.totalCount, 1);
    assert.equal(testReport.passedCount, 1);
    assert.equal(testReport.failedCount, 0);

    // 5. Import Life natively in PROD from the recovered closure's life/export member and run the blinker oracle
    const prodByKey = new Map(recoveredInstall.members.map((m) => [m.key, m.target]));
    const prodExportArtifact = await runtime.images.getCodeArtifact(
      PROD,
      prodByKey.get('life/export').objectId,
    );
    const manifest = JSON.parse(prodExportArtifact.content.value);

    await installSymmetricSmalltalkStandardImage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: PROD,
      lane: 'wasm',
    });
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: PROD,
      manifest,
      scope: {classes: [...LIFE_SCOPE], methods: [...LIFE_METHOD_SCOPE]},
    });
    const lifeModelClass = imported.classes.find(
      ({identity}) => identity === 'cuis-class/Life/LifeModel',
    ).classRef;
    const sendProd = senderFor(runtime, PROD);
    const nativeGlobals = await nativeGlobalsFor(runtime.images, PROD);
    const {model, stateString} = await buildBlinkerModel(sendProd, lifeModelClass, nativeGlobals);

    assert.equal(await stateString(), FROZEN_STATES[0]);
    await sendProd(model, 'nextState');
    assert.equal(await stateString(), FROZEN_STATES[1]);
    await sendProd(model, 'nextState');
    assert.equal(await stateString(), FROZEN_STATES[2]);

    // 6. Evaluate partitioning and indexing on the populated PROD application image
    const partitionReport = await evaluateImagePartitioningAndIndexing({
      images: runtime.images,
      imageId: PROD,
      domainRoots: [model],
    });
    assert.equal(partitionReport.format, PARTITION_BENCHMARK_REPORT_V1);
    assert.ok(partitionReport.totalRecords > 100);
    assert.equal(partitionReport.domainClosures.length, 1);
    assert.equal(partitionReport.domainClosures[0].format, MUTABLE_DOMAIN_CLOSURE_V1);
    // The blinker mutable domain closure includes model, shape (Point), cells (LifeArray), and elements (Array)
    assert.equal(partitionReport.domainClosures[0].objectIds.length, 4);
    assert.ok(partitionReport.partitionAnalysis.mutableDomainInternalObjectEdges >= 3);
    assert.equal(
      partitionReport.partitionAnalysis.mutableDomainCrossCutEdges,
      0,
      '100% of mutable domain object-to-object edges stay inside mutable-domain',
    );
    assert.ok(partitionReport.indexVsScan.speedupFactor > 50);
  } finally {
    await runtime.close();
  }
});

test('discoverMutableDomainClosure and measureComputeNearObjectWorkload prove zero per-object remote round-trips for M5 Life across nodes', {timeout: 300_000}, async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/life-m5-release.json', import.meta.url), 'utf8'),
  );

  const nodeB = await createRuntime({backend: {mode: 'mock'}});
  const nodeA = await createRuntime({backend: {mode: 'mock'}});
  try {
    const IMAGE_ID = 'life-bench-img';
    await nodeB.images.createImage({id: IMAGE_ID, name: 'LifeBench'});

    const installed = await installManagedProjectRelease({
      images: nodeB.images,
      targetImageId: IMAGE_ID,
      release: fixture.release,
      material: fixture.material,
    });
    const byKey = new Map(installed.members.map((m) => [m.key, m.target]));
    const exportArtifact = await nodeB.images.getCodeArtifact(
      IMAGE_ID,
      byKey.get('life/export').objectId,
    );
    const manifest = JSON.parse(exportArtifact.content.value);

    await installSymmetricSmalltalkStandardImage({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId: IMAGE_ID,
      lane: 'wasm',
    });
    const imported = await importCuisNativePackage({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId: IMAGE_ID,
      manifest,
      scope: {classes: [...LIFE_SCOPE], methods: [...LIFE_METHOD_SCOPE]},
    });
    const lifeModelClass = imported.classes.find(
      ({identity}) => identity === 'cuis-class/Life/LifeModel',
    ).classRef;
    const sendB = senderFor(nodeB, IMAGE_ID);
    const nativeGlobals = await nativeGlobalsFor(nodeB.images, IMAGE_ID);
    const {model, stateString} = await buildBlinkerModel(sendB, lifeModelClass, nativeGlobals);
    assert.equal(await stateString(), FROZEN_STATES[0]);

    // Automatically discover the cohesive mutable domain object closure starting from `model`
    const closure = await discoverMutableDomainClosure({
      images: nodeB.images,
      imageId: IMAGE_ID,
      rootRef: model,
    });
    assert.equal(closure.format, MUTABLE_DOMAIN_CLOSURE_V1);
    assert.equal(closure.refs.length, 4);

    // Relocate the discovered mutable domain closure to node-a
    const placement = new PlacementPolicy({
      nodes: {
        'node-b': nodeB,
        'node-a': nodeA,
      },
    });
    await placement.relocateObjects({
      refs: closure.refs,
      fromNode: 'node-b',
      toNode: 'node-a',
    });

    // Measure 2 steps (S0 -> S1 -> S0) in both remote-receiver and compute-near-object modes
    const benchmark = await measureComputeNearObjectWorkload({
      placement,
      fromNode: 'node-b',
      receiver: model,
      message: 'nextState',
      steps: 2,
      inspectState: stateString,
    });

    assert.equal(benchmark.format, WORKLOAD_BENCHMARK_REPORT_V1);
    assert.equal(benchmark.comparison.eliminatedAllPerObjectRoundTrips, true);
    assert.ok(benchmark.remoteReceiverMode.perObjectRecordReads > 0);
    assert.ok(benchmark.remoteReceiverMode.perObjectRecordWrites > 0);
    assert.equal(benchmark.computeNearObjectMode.perObjectRecordReads, 0);
    assert.equal(benchmark.computeNearObjectMode.perObjectRecordWrites, 0);
    assert.equal(benchmark.computeNearObjectMode.targetNode, 'node-a');
    assert.ok(benchmark.comparison.perObjectReadReduction > 0);
    assert.ok(benchmark.comparison.perObjectWriteReduction > 0);
    assert.equal(benchmark.comparison.statesMatch, true);
    assert.deepEqual(benchmark.computeNearObjectMode.states, [
      FROZEN_STATES[0],
      FROZEN_STATES[2],
    ]);
  } finally {
    await nodeA.close();
    await nodeB.close();
  }
});
