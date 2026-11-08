import assert from 'node:assert/strict';
import '../ensure-node-crypto.test-helper.js';
import {LagrangeBackend} from '../../src/backend/lagrange-backend.js';
import {
  SWEPT_RECORD_KIND,
  addProjectMember,
  captureCurrentGraphProjectRelease,
  collectUnreachableImageRecords,
  commonLispFunctionBlockId,
  createBranch,
  createDeploymentProfile,
  createProject,
  createProjectNote,
  createProjectTestCase,
  createProjectWorkItem,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  evolveSmalltalkClassShape,
  getBranch,
  installCommonLispProgram,
  installCommonLispRuntime,
  installManagedProjectRelease,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  listBranches,
  listProjectWorkItems,
  objectRef,
  publishSmalltalkClassGlobals,
  readManagedProjectInstallation,
  readProjectDescriptor,
  readProjectNote,
  reconstructImageRecordsAtFrontier,
  runProjectTests,
  textValue,
} from '../../src/runtime.js';
import {createSqliteApplicationRuntime} from './sqlite-application-runtime.js';

const [phase, sqlitePath] = process.argv.slice(2);
const IMAGE_ID = 'durable-process-restart-img';
const TARGET_IMAGE_ID = 'durable-process-installed-img';
const PROJECT_ID = 'durable-polyglot-proj';

async function openRuntime(dbFile) {
  return await createRuntime({
    backend: {
      instance: new LagrangeBackend({
        runtime: createSqliteApplicationRuntime(dbFile),
      }),
    },
  });
}

async function runPopulate(dbFile) {
  const runtime = await openRuntime(dbFile);
  try {
    await runtime.images.createImage({id: IMAGE_ID, name: 'Durable Process Image'});
    await installSymmetricSmalltalkStandardImage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: IMAGE_ID,
    });
    await installCommonLispRuntime({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: IMAGE_ID,
    });
    await installCommonLispProgram({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: IMAGE_ID,
      source: `
        (defun durable-step (n)
          (+ n 100))
      `,
    });

    const {classRef} = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: IMAGE_ID,
      name: 'DurableCounter',
      superclassRef: objectRef(IMAGE_ID, 'smalltalk/class/Object'),
      instanceVariables: ['count'],
    });
    const classRecord = await runtime.images.getObject(IMAGE_ID, classRef.objectId);
    const instanceShapeRef = classRecord.slots['behavior-instance-shape'];
    await publishSmalltalkClassGlobals({
      images: runtime.images,
      imageId: IMAGE_ID,
      names: ['DurableCounter'],
    });
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: IMAGE_ID,
      classRef,
      methods: [
        {selector: 'count', source: '[ ^ count ]'},
        {selector: 'count:', source: '[ :v | count := v. ^ self ]'},
        {selector: 'incrementBy:', source: '[ :d | count := count + d. ^ count ]'},
      ],
    });

    const shapeV1 = await runtime.images.getShape(IMAGE_ID, instanceShapeRef.objectId);
    const countSlotId = shapeV1.slots.find((slot) => slot.name === 'count').id;

    await runtime.images.putObject(IMAGE_ID, {
      id: 'durable-entity-1',
      shape: instanceShapeRef,
      behavior: classRef,
      slots: {[countSlotId]: integerValue(15n)},
    });

    // Record named branch v1-baseline before Shape evolution and GC
    const branchV1 = await createBranch({
      images: runtime.images,
      imageId: IMAGE_ID,
      name: 'v1-baseline',
      description: 'Baseline before shape migration',
    });

    // Evolve DurableCounter shape to add `label` slot
    const migration = await evolveSmalltalkClassShape({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: IMAGE_ID,
      classRef,
      instanceVariables: ['count', 'label'],
      defaultSlotValues: {label: textValue('migrated-v2')},
    });
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: IMAGE_ID,
      classRef,
      allowRedefinition: true,
      methods: [
        {selector: 'label', source: '[ ^ label ]'},
      ],
    });

    // Create an unreachable orphan object and sweep it with history-safe GC
    await runtime.images.putShape(IMAGE_ID, {
      id: 'orphan-shape-v1',
      slots: [{id: 'slot-x', name: 'x'}],
    });
    await runtime.images.putObject(IMAGE_ID, {
      id: 'orphan-temp-1',
      shape: objectRef(IMAGE_ID, 'orphan-shape-v1'),
      slots: {'slot-x': integerValue(404n)},
    });

    const gcReceipt = await collectUnreachableImageRecords({
      images: runtime.images,
      imageId: IMAGE_ID,
      preserveNamedBranches: true,
      roots: [objectRef(IMAGE_ID, 'durable-entity-1')],
    });
    assert.ok(gcReceipt.sweptIds.includes('orphan-temp-1'));

    // Create Project with code, note, work item, and in-image test case, and install managed release
    await createProject({
      images: runtime.images,
      imageId: IMAGE_ID,
      projectId: PROJECT_ID,
      name: 'Durable Polyglot Project',
    });
    await addProjectMember({
      images: runtime.images,
      imageId: IMAGE_ID,
      projectId: PROJECT_ID,
      key: 'entity/counter',
      role: 'data',
      target: objectRef(IMAGE_ID, 'durable-entity-1'),
    });
    await createProjectNote({
      images: runtime.images,
      imageId: IMAGE_ID,
      projectId: PROJECT_ID,
      noteId: 'arch-note',
      title: 'Durability Note',
      body: 'Survives full OS process restart',
    });
    await createProjectWorkItem({
      images: runtime.images,
      imageId: IMAGE_ID,
      projectId: PROJECT_ID,
      workItemId: 'wi-restart',
      title: 'Verify process restart',
      status: 'in_progress',
      priority: 1,
    });
    const testBlock = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: IMAGE_ID,
      blockId: 'durable-test-block',
      source: '[ 40 + 2 ]',
    });
    await createProjectTestCase({
      images: runtime.images,
      imageId: IMAGE_ID,
      projectId: PROJECT_ID,
      testId: 'math-check',
      name: '40 + 2 = 42',
      target: objectRef(IMAGE_ID, testBlock.block.id),
      expected: integerValue(42n),
    });

    const projectDesc = await readProjectDescriptor({
      images: runtime.images,
      imageId: IMAGE_ID,
      projectId: PROJECT_ID,
    });
    const profile = createDeploymentProfile({
      project: projectDesc,
      profileId: 'default-profile',
      members: projectDesc.members.map((m) => m.key),
    });
    const captured = await captureCurrentGraphProjectRelease({
      images: runtime.images,
      projectImageId: IMAGE_ID,
      projectId: PROJECT_ID,
      profile,
      releaseId: 'rel-durable-v1',
    });

    await runtime.images.createImage({id: TARGET_IMAGE_ID, name: 'Durable Target Image'});
    await installManagedProjectRelease({
      images: runtime.images,
      targetImageId: TARGET_IMAGE_ID,
      release: captured.release,
      material: captured.material,
    });

    process.stdout.write(JSON.stringify({
      phase: 'populate',
      ok: true,
      branchRevision: branchV1.descriptor.frontier.revision,
      migratedCount: migration.migrationReceipt.migratedCount,
      sweptIds: gcReceipt.sweptIds,
      releaseId: captured.release.releaseId,
    }) + '\n');
  } finally {
    await runtime.close();
  }
}

async function runVerifyAndAdvance(dbFile) {
  const runtime = await openRuntime(dbFile);
  try {
    // 1. Verify migrated Smalltalk object and methods execute without recompilation
    const entityRef = objectRef(IMAGE_ID, 'durable-entity-1');
    const stepSend = await runtime.invocations.sendMessage(
      {
        languageId: 'symmetric-smalltalk',
        receiver: entityRef,
        message: textValue('incrementBy:'),
        arguments: [integerValue(5n)],
      },
      {dispatchImage: IMAGE_ID},
    );
    const updatedCount = await runtime.executor.execute(stepSend);
    assert.deepEqual(updatedCount, integerValue(20n));

    const labelSend = await runtime.invocations.sendMessage(
      {
        languageId: 'symmetric-smalltalk',
        receiver: entityRef,
        message: textValue('label'),
        arguments: [],
      },
      {dispatchImage: IMAGE_ID},
    );
    const labelVal = await runtime.executor.execute(labelSend);
    assert.deepEqual(labelVal, textValue('migrated-v2'));

    // 2. Verify in-image Common Lisp function executes without recompilation
    const clAct = await runtime.invocations.prepareActivation({
      block: objectRef(IMAGE_ID, commonLispFunctionBlockId('DURABLE-STEP')),
      arguments: [updatedCount],
    });
    const clResult = await runtime.executor.execute(clAct);
    assert.deepEqual(clResult, integerValue(120n));

    // 3. Verify named branch v1-baseline and historical frontier reconstruction
    const branches = await listBranches({images: runtime.images, imageId: IMAGE_ID});
    assert.equal(branches.length, 1);
    const branchV1 = await getBranch({
      images: runtime.images,
      imageId: IMAGE_ID,
      name: 'v1-baseline',
    });
    assert.ok(branchV1);
    const historicalRecords = await reconstructImageRecordsAtFrontier({
      images: runtime.images,
      imageId: IMAGE_ID,
      frontier: branchV1.descriptor.frontier.revision,
    });
    const historicalEntity = historicalRecords.find((r) => r.id === 'durable-entity-1');
    assert.ok(historicalEntity);
    assert.equal(Object.keys(historicalEntity.slots).length, 1);

    // 4. Verify swept record tombstone persisted across process restart
    const sweptRecord = await runtime.images.getRecord(IMAGE_ID, 'orphan-temp-1');
    assert.equal(sweptRecord, null);
    const rawTombstone = await runtime.backend.get(`image:${IMAGE_ID}:objects`, 'orphan-temp-1');
    assert.equal(rawTombstone?.kind, SWEPT_RECORD_KIND);

    // 5. Verify Project note, work items, in-image test runner, and managed installation
    const note = await readProjectNote({
      images: runtime.images,
      imageId: IMAGE_ID,
      projectId: PROJECT_ID,
      noteId: 'arch-note',
    });
    assert.equal(note.title, 'Durability Note');

    const workItems = await listProjectWorkItems({
      images: runtime.images,
      imageId: IMAGE_ID,
      projectId: PROJECT_ID,
    });
    assert.equal(workItems.length, 1);
    assert.equal(workItems[0].workItemId, 'wi-restart');

    const testReport = await runProjectTests({
      runtime,
      imageId: IMAGE_ID,
      projectId: PROJECT_ID,
    });
    assert.equal(testReport.passed, true);
    assert.equal(testReport.passedCount, 1);
    assert.equal(testReport.failedCount, 0);

    const recoveredInstall = await readManagedProjectInstallation({
      images: runtime.images,
      targetImageId: TARGET_IMAGE_ID,
      projectId: PROJECT_ID,
    });
    assert.ok(recoveredInstall);
    assert.match(recoveredInstall.releaseId, /^sha256:/);

    process.stdout.write(JSON.stringify({
      phase: 'verify-and-advance',
      ok: true,
      updatedCount: Number(updatedCount.value),
      clResult: Number(clResult.value),
      branchRevision: branchV1.descriptor.frontier.revision,
      passedTests: testReport.passedCount,
      installedReleaseId: recoveredInstall.releaseId,
    }) + '\n');
  } finally {
    await runtime.close();
  }
}

if (phase === 'populate') {
  await runPopulate(sqlitePath);
} else if (phase === 'verify-and-advance') {
  await runVerifyAndAdvance(sqlitePath);
} else if (phase === 'verify-post-restart-mutation') {
  const runtime = await openRuntime(sqlitePath);
  try {
    const entityRef = objectRef(IMAGE_ID, 'durable-entity-1');
    const getCountSend = await runtime.invocations.sendMessage(
      {
        languageId: 'symmetric-smalltalk',
        receiver: entityRef,
        message: textValue('count'),
        arguments: [],
      },
      {dispatchImage: IMAGE_ID},
    );
    const persistedCount = await runtime.executor.execute(getCountSend);
    assert.deepEqual(persistedCount, integerValue(20n));

    const incSend = await runtime.invocations.sendMessage(
      {
        languageId: 'symmetric-smalltalk',
        receiver: entityRef,
        message: textValue('incrementBy:'),
        arguments: [integerValue(10n)],
      },
      {dispatchImage: IMAGE_ID},
    );
    const nextCount = await runtime.executor.execute(incSend);
    assert.deepEqual(nextCount, integerValue(30n));

    process.stdout.write(JSON.stringify({
      phase: 'verify-post-restart-mutation',
      ok: true,
      persistedCount: Number(persistedCount.value),
      nextCount: Number(nextCount.value),
    }) + '\n');
  } finally {
    await runtime.close();
  }
} else {
  throw new Error(`Unknown worker phase: ${phase}`);
}
