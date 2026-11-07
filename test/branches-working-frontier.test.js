import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BranchConflictError,
  IMAGE_BRANCH_DESCRIPTOR_V1,
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  ObjectMutationConflictError,
  addProjectMember,
  advanceBranch,
  authorizedAdvanceBranch,
  authorizedCreateBranch,
  authorizedDiffBranches,
  authorizedDiffProjectBranches,
  authorizedMergeBranches,
  authorizedReadBranch,
  branchObjectId,
  collectUnreachableImageRecords,
  createBranch,
  createProject,
  createRuntime,
  defineMethodsFromSource,
  deleteBranch,
  diffBranches,
  diffProjectBranches,
  ensureClassFromDeclaration,
  evaluateCommonLispSource,
  forkImageFromBranch,
  getBranch,
  installCommonLispProgram,
  installCommonLispRuntime,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  listBranches,
  mergeBranches,
  mergeProjectBranches,
  objectRef,
  objectResource,
  projectObjectId,
  publishSmalltalkClassGlobals,
  reconcileMethodsFromSource,
  textValue,
} from '../src/runtime.js';

test('named branches track working frontiers, enforce fast-forward and CAS preconditions, and protect historical branch closures during GC', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const IMAGE_ID = 'branch-lifecycle-img';
  await runtime.images.createImage({id: IMAGE_ID, name: 'Branch Lifecycle Image'});

  const shape = await runtime.images.putShape(IMAGE_ID, {
    id: 'shape/doc/v1',
    slots: [{id: 'slot-body', name: 'body'}],
  });
  const shapeRef = objectRef(IMAGE_ID, shape.id);

  // Create root object and historical object at early frontier
  const rootObj = await runtime.images.putObject(IMAGE_ID, {
    id: 'doc/root',
    shape: shapeRef,
    slots: {'slot-body': textValue('root-v1')},
  });
  const ephemeralEarlyObj = await runtime.images.putObject(IMAGE_ID, {
    id: 'doc/ephemeral-release-v1',
    shape: shapeRef,
    slots: {'slot-body': textValue('pinned-by-branch')},
  });

  // Create `release/v1` branch at current frontier (where `doc/ephemeral-release-v1` is pointed to by `doc/root`)
  await runtime.images.putObject(IMAGE_ID, {
    id: rootObj.id,
    shape: shapeRef,
    slots: {'slot-body': objectRef(IMAGE_ID, ephemeralEarlyObj.id)},
  });

  const releaseBranch = await createBranch({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'release/v1',
    description: 'Release v1 snapshot',
  });
  assert.equal(releaseBranch.descriptor.format, IMAGE_BRANCH_DESCRIPTOR_V1);
  assert.equal(releaseBranch.descriptor.name, 'release/v1');
  const releaseRev = releaseBranch.descriptor.frontier.revision;

  // Duplicate createBranch at same frontier converges idempotently; different frontier without overwrite throws BranchConflictError
  const idempotent = await createBranch({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'release/v1',
    frontier: releaseBranch.descriptor.frontier,
  });
  assert.equal(idempotent.descriptor.frontier.revision, releaseRev);

  // Advance image state: `doc/root` drops reference to `doc/ephemeral-release-v1`
  await runtime.images.putObject(IMAGE_ID, {
    id: rootObj.id,
    shape: shapeRef,
    slots: {'slot-body': textValue('root-v2-unlinked')},
  });

  await assert.rejects(
    () =>
      createBranch({
        images: runtime.images,
        imageId: IMAGE_ID,
        name: 'release/v1',
      }),
    (err) => err instanceof BranchConflictError && err.branchName === 'release/v1',
  );

  const mainBranch = await createBranch({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'main',
    description: 'Main working frontier',
  });
  const allBranches = await listBranches({images: runtime.images, imageId: IMAGE_ID});
  assert.deepEqual(
    allBranches.map((b) => b.name),
    ['main', 'release/v1'],
  );

  // Non-fast-forward advance of `main` backwards to `releaseRev` is refused without `allowNonFastForward: true`
  await assert.rejects(
    () =>
      advanceBranch({
        images: runtime.images,
        imageId: IMAGE_ID,
        name: 'main',
        toFrontier: releaseBranch.descriptor.frontier,
      }),
    (err) => err instanceof BranchConflictError && err.branchName === 'main',
  );

  // Advancing `release/v1` with a stale `expectedRevision` or stale `expectedVersionToken` fails
  await assert.rejects(
    () =>
      advanceBranch({
        images: runtime.images,
        imageId: IMAGE_ID,
        name: 'release/v1',
        expectedRevision: 0,
      }),
    (err) => err instanceof BranchConflictError,
  );

  // Because `release/v1` still points to `releaseRev`, GC with `roots: ['doc/root']` preserves `doc/ephemeral-release-v1`!
  const gcWhileBranchExists = await collectUnreachableImageRecords({
    images: runtime.images,
    imageId: IMAGE_ID,
    roots: [rootObj.id],
    includeDefaultRoots: true,
    preserveNamedBranches: true,
  });
  assert.ok(!gcWhileBranchExists.sweptIds.includes(ephemeralEarlyObj.id));
  assert.notEqual(await runtime.images.getObject(IMAGE_ID, ephemeralEarlyObj.id), null);

  // Fast-forward `release/v1` to `main`'s frontier using CAS `expectedVersionToken`
  const advancedRelease = await advanceBranch({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'release/v1',
    toFrontier: mainBranch.descriptor.frontier,
    expectedVersionToken: releaseBranch.versionToken,
  });
  assert.equal(advancedRelease.fastForward, true);
  assert.equal(advancedRelease.descriptor.parentRevision, releaseRev);
  assert.equal(advancedRelease.descriptor.frontier.revision, mainBranch.descriptor.frontier.revision);

  // Reusing the old `releaseBranch.versionToken` now fails with `ObjectMutationConflictError`
  await assert.rejects(
    () =>
      advanceBranch({
        images: runtime.images,
        imageId: IMAGE_ID,
        name: 'release/v1',
        expectedVersionToken: releaseBranch.versionToken,
      }),
    (err) => err instanceof ObjectMutationConflictError,
  );

  // Delete `release/v1` and verify GC now sweeps `doc/ephemeral-release-v1`
  const deleted = await deleteBranch({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'release/v1',
  });
  assert.equal(deleted.deleted, true);
  assert.equal(await getBranch({images: runtime.images, imageId: IMAGE_ID, name: 'release/v1'}), null);

  const gcAfterAdvance = await collectUnreachableImageRecords({
    images: runtime.images,
    imageId: IMAGE_ID,
    roots: [rootObj.id],
    includeDefaultRoots: true,
    preserveNamedBranches: true,
  });
  assert.ok(gcAfterAdvance.sweptIds.includes(ephemeralEarlyObj.id));
  assert.equal(await runtime.images.getObject(IMAGE_ID, ephemeralEarlyObj.id), null);
});

test('forkImageFromBranch, diffBranches, diffProjectBranches, mergeBranches, and mergeProjectBranches support polyglot Smalltalk + Common Lisp collaborative workflows', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const MAIN_IMAGE = 'collab-main-img';
  const FEATURE_IMAGE = 'collab-feature-img';
  const PROJECT_ID = 'billing-suite';

  await runtime.images.createImage({id: MAIN_IMAGE, name: 'Collaborative Main Image'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: MAIN_IMAGE,
  });
  await installCommonLispRuntime({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: MAIN_IMAGE,
  });

  // Base state on `main`: Smalltalk `Invoice` class, Common Lisp `tax-amount` function, and Project `billing-suite`
  const invoiceClass = await ensureClassFromDeclaration({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    name: 'Invoice',
    instanceVariables: ['subtotal', 'discount'],
  });
  await publishSmalltalkClassGlobals({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    names: ['Invoice'],
  });
  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: MAIN_IMAGE,
    classRef: invoiceClass.classRef,
    methods: [
      {selector: 'subtotal:discount:', source: '[ :s :d | subtotal := s. discount := d. ^self ]'},
      {selector: 'netAmount', source: '[ ^subtotal - discount ]'},
    ],
  });

  const clBase = await installCommonLispProgram({
    images: runtime.images,
    compilation: runtime.compilation,
    runtime,
    imageId: MAIN_IMAGE,
    source: '(defun compute-total (inv) (+ (send inv :netAmount) 10))',
  });

  await createProject({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    projectId: PROJECT_ID,
    name: 'Billing Suite',
  });
  await addProjectMember({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    projectId: PROJECT_ID,
    key: 'class:Invoice',
    role: 'class',
    target: invoiceClass.classRef,
  });
  await addProjectMember({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    projectId: PROJECT_ID,
    key: 'fn:compute-total',
    role: 'function',
    target: clBase.functions['COMPUTE-TOTAL'].blockRef,
  });

  const baseMainBranch = await createBranch({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    name: 'main',
    description: 'Base main branch',
  });

  // Fork `FEATURE_IMAGE` (`feature/loyalty-bonus`) from `main` branch
  const forked = await forkImageFromBranch({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    branchName: 'main',
    targetImageId: FEATURE_IMAGE,
    createBranchName: 'feature/loyalty-bonus',
  });
  assert.equal(forked.targetImageId, FEATURE_IMAGE);
  assert.equal(forked.branch.name, 'feature/loyalty-bonus');

  // 1. On `MAIN_IMAGE` (`main`), add a Smalltalk method `withServiceFee:` to `Invoice` and register a new Project member
  await reconcileMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: MAIN_IMAGE,
    classRef: invoiceClass.classRef,
    methods: [
      {selector: 'withServiceFee:', source: '[ :fee | ^(self netAmount) + fee ]'},
    ],
  });
  const feeNote = await runtime.images.putCodeArtifact(MAIN_IMAGE, {
    id: 'notes/service-fee',
    languageId: 'markdown',
    representation: 'text/markdown',
    content: textValue('# Service Fee Policy'),
  });
  await addProjectMember({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    projectId: PROJECT_ID,
    key: 'doc:service-fee',
    role: 'documentation',
    target: objectRef(MAIN_IMAGE, feeNote.id),
  });
  await advanceBranch({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    name: 'main',
  });

  // 2. On `FEATURE_IMAGE` (`feature/loyalty-bonus`), add a Common Lisp helper `apply-loyalty-rebate` and register it in the Project
  const clFeature = await installCommonLispProgram({
    images: runtime.images,
    compilation: runtime.compilation,
    runtime,
    imageId: FEATURE_IMAGE,
    source: '(defun apply-loyalty-rebate (amount rebate) (- amount rebate))',
  });
  await addProjectMember({
    images: runtime.images,
    imageId: FEATURE_IMAGE,
    projectId: PROJECT_ID,
    key: 'fn:apply-loyalty-rebate',
    role: 'function',
    target: clFeature.functions['APPLY-LOYALTY-REBATE'].blockRef,
  });
  await advanceBranch({
    images: runtime.images,
    imageId: FEATURE_IMAGE,
    name: 'feature/loyalty-bonus',
  });

  // Diff branches at both image and Project levels
  const branchDiff = await diffBranches({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    baseBranch: 'main',
    targetBranch: 'feature/loyalty-bonus',
    targetImageId: FEATURE_IMAGE,
  });
  assert.equal(branchDiff.identical, false);

  const projBranchDiff = await diffProjectBranches({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    projectId: PROJECT_ID,
    leftBranch: 'main',
    rightBranch: 'feature/loyalty-bonus',
    rightImageId: FEATURE_IMAGE,
  });
  assert.equal(projBranchDiff.identical, false);
  assert.deepEqual(
    projBranchDiff.memberChanges.map((m) => m.key),
    ['doc:service-fee', 'fn:apply-loyalty-rebate'],
  );

  // Merge Project descriptors across the two branches relative to `baseMainBranch.descriptor.frontier`
  const projMerge = await mergeProjectBranches({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    projectId: PROJECT_ID,
    baseFrontier: baseMainBranch.descriptor.frontier,
    leftBranch: 'main',
    rightBranch: 'feature/loyalty-bonus',
    rightImageId: FEATURE_IMAGE,
  });
  assert.equal(projMerge.clean, true);
  assert.deepEqual(
    projMerge.mergedDescriptor.members.map((m) => m.key),
    ['class:Invoice', 'doc:service-fee', 'fn:apply-loyalty-rebate', 'fn:compute-total'],
  );

  // Perform three-way structural merge of `feature/loyalty-bonus` into `MAIN_IMAGE` (`main`)
  const merged = await mergeBranches({
    images: runtime.images,
    imageId: MAIN_IMAGE,
    baseFrontier: baseMainBranch.descriptor.frontier,
    sourceBranch: 'feature/loyalty-bonus',
    sourceImageId: FEATURE_IMAGE,
    targetBranch: 'main',
  });
  assert.equal(merged.clean, true);
  assert.equal(merged.applied, true);
  assert.ok(merged.targetBranch.frontier.revision > baseMainBranch.descriptor.frontier.revision);

  // Verify the merged `MAIN_IMAGE` executes both Smalltalk `withServiceFee:` (from `main`) and Common Lisp `apply-loyalty-rebate` (from `feature/loyalty-bonus`) together!
  const combinedResult = await evaluateCommonLispSource({
    runtime,
    imageId: MAIN_IMAGE,
    source: `
      (let ((inv (send (send Invoice :new) :subtotal:discount: 200 30)))
        (apply-loyalty-rebate (send inv :withServiceFee: 15) 25))
    `,
  });
  // ((200 - 30) + 15) - 25 = 160
  assert.deepEqual(combinedResult, integerValue(160n));
});

test('authorized branch operations enforce no-existence-oracle authority ordering before any storage read or write', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const IMAGE_ID = 'auth-branch-img';
  await runtime.images.createImage({id: IMAGE_ID, name: 'Authorized Branch Image'});
  await createProject({
    images: runtime.images,
    imageId: IMAGE_ID,
    projectId: 'p1',
    name: 'Project One',
  });

  const existingBranch = await authorizedCreateBranch({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'main',
    description: 'Authorized main',
    require: () => {},
  });
  assert.equal(existingBranch.descriptor.name, 'main');

  // Denied caller on `authorizedReadBranch` gets identical error for existing `'main'` and missing `'ghost'` before storage read
  const checkCalls = [];
  const denyRequire = (op, res) => {
    checkCalls.push({op, res});
    const err = new Error(`Denied ${op} on ${res}`);
    err.name = 'AuthorityDeniedError';
    throw err;
  };

  await assert.rejects(
    () =>
      authorizedReadBranch({
        images: runtime.images,
        imageId: IMAGE_ID,
        name: 'main',
        require: denyRequire,
      }),
    {name: 'AuthorityDeniedError'},
  );
  await assert.rejects(
    () =>
      authorizedReadBranch({
        images: runtime.images,
        imageId: IMAGE_ID,
        name: 'ghost',
        require: denyRequire,
      }),
    {name: 'AuthorityDeniedError'},
  );
  assert.equal(checkCalls.length, 2);
  assert.equal(checkCalls[0].op, OBJECT_READ_OPERATION);
  assert.equal(checkCalls[0].res, objectResource(IMAGE_ID, branchObjectId('main')));
  assert.equal(checkCalls[1].res, objectResource(IMAGE_ID, branchObjectId('ghost')));

  // Verify canonical demand ordering on `authorizedDiffBranches`, `authorizedMergeBranches`, and `authorizedDiffProjectBranches`
  const mergeChecks = [];
  await authorizedCreateBranch({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'alpha',
    require: () => {},
  });
  await authorizedAdvanceBranch({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'alpha',
    expectedVersionToken: (await authorizedReadBranch({
      images: runtime.images,
      imageId: IMAGE_ID,
      name: 'alpha',
      require: () => {},
    })).versionToken,
    require: (op, res) => mergeChecks.push({op, res}),
  });
  assert.deepEqual(mergeChecks, [
    {op: OBJECT_WRITE_OPERATION, res: objectResource(IMAGE_ID, branchObjectId('alpha'))},
  ]);

  const diffChecks = [];
  const diffRes = await authorizedDiffBranches({
    images: runtime.images,
    imageId: IMAGE_ID,
    baseBranch: 'main',
    targetBranch: 'alpha',
    require: (op, res) => diffChecks.push({op, res}),
  });
  assert.equal(diffRes.identical, true);
  assert.equal(diffChecks.length, 2);

  const projChecks = [];
  const projDiffRes = await authorizedDiffProjectBranches({
    images: runtime.images,
    imageId: IMAGE_ID,
    projectId: 'p1',
    leftBranch: 'main',
    rightBranch: 'alpha',
    require: (op, res) => projChecks.push({op, res}),
  });
  assert.equal(projDiffRes.identical, true);
  assert.ok(
    projChecks.some((c) => c.res === objectResource(IMAGE_ID, projectObjectId('p1'))),
  );

  const authMergeChecks = [];
  const authMergeRes = await authorizedMergeBranches({
    images: runtime.images,
    imageId: IMAGE_ID,
    sourceBranch: 'alpha',
    targetBranch: 'main',
    require: (op, res) => authMergeChecks.push({op, res}),
  });
  assert.equal(authMergeRes.clean, true);
  assert.ok(
    authMergeChecks.some(
      (c) => c.op === OBJECT_WRITE_OPERATION && c.res === objectResource(IMAGE_ID, branchObjectId('main')),
    ),
  );
});
