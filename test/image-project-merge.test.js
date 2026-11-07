import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMAGE_RECORD_MERGE_V1,
  MERGE_CONFLICT_KINDS,
  MergeConflictError,
  OBJECT_READ_OPERATION,
  PROJECT_DESCRIPTOR_MERGE_V1,
  PROJECT_MERGE_CONFLICT_KINDS,
  PROJECT_RELEASE_MERGE_V1,
  SHAPE_INDEXED,
  addProjectMember,
  applyImageMerge,
  authorizedMergeProjects,
  createDeploymentProfile,
  createProject,
  createProjectReleaseManifest,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  evaluateCommonLispSource,
  evaluateSymmetricSmalltalkBlock,
  installCommonLispProgram,
  installCommonLispRuntime,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  mergeImageFrontiers,
  mergeImageRecords,
  mergeProjectAtFrontiers,
  mergeProjectDescriptors,
  mergeProjectReleases,
  objectRef,
  objectResource,
  projectObjectId,
  reconstructImageRecordsAtFrontier,
  textValue,
} from '../src/runtime.js';

test('mergeImageRecords merges disjoint object slots, indexed elements, and lexical bindings cleanly and detects structured conflicts', () => {
  const pointShape = {
    id: 'shape/point',
    imageId: 'app',
    kind: 'shape',
    slots: [
      {id: 'x', name: 'x'},
      {id: 'y', name: 'y'},
      {id: 'label', name: 'label'},
    ],
    indexed: SHAPE_INDEXED.VALUES,
    metadata: {},
  };

  const basePoint = {
    id: 'obj/point-1',
    imageId: 'app',
    kind: 'object',
    shape: objectRef('app', 'shape/point'),
    behavior: null,
    slots: {
      x: integerValue(10n),
      y: integerValue(20n),
      label: textValue('origin'),
    },
    indexed: [integerValue(1n), integerValue(2n)],
    metadata: {tag: 'v0'},
  };

  const baseEnv = {
    id: 'env/shared',
    imageId: 'app',
    kind: 'lexical-environment',
    parent: null,
    bindings: {
      a: {value: integerValue(1n)},
      b: {value: integerValue(2n)},
    },
    metadata: {},
  };

  const baseArtifact = {
    id: 'art/doc',
    imageId: 'app',
    kind: 'code-artifact',
    languageId: 'common-lisp',
    representation: 'common-lisp/source-v0',
    content: textValue('(+ 1 2)'),
    logicalPath: 'doc.lisp',
    dependencies: [],
    derivedFrom: [],
    metadata: {},
  };

  const baseOnly = {
    id: 'obj/obsolete',
    imageId: 'app',
    kind: 'object',
    shape: objectRef('app', 'shape/point'),
    behavior: null,
    slots: {x: integerValue(0n), y: integerValue(0n), label: textValue('old')},
    indexed: [],
    metadata: {},
  };

  // Left modifies slot x, indexed[0], env binding a, deletes obj/obsolete, and adds obj/left-only
  const leftPoint = {
    ...basePoint,
    slots: {
      ...basePoint.slots,
      x: integerValue(100n),
    },
    indexed: [integerValue(10n), integerValue(2n)],
    metadata: {tag: 'v0', leftNote: 'yes'},
  };
  const leftEnv = {
    ...baseEnv,
    bindings: {
      a: {value: integerValue(10n)},
      b: {value: integerValue(2n)},
    },
  };
  const leftAdded = {
    id: 'obj/left-only',
    imageId: 'app',
    kind: 'object',
    shape: objectRef('app', 'shape/point'),
    behavior: null,
    slots: {x: integerValue(1n), y: integerValue(1n), label: textValue('left')},
    indexed: [],
    metadata: {},
  };

  // Right modifies slot y, indexed[1], env binding b, updates art/doc, and adds obj/right-only
  const rightPoint = {
    ...basePoint,
    slots: {
      ...basePoint.slots,
      y: integerValue(200n),
    },
    indexed: [integerValue(1n), integerValue(20n)],
    metadata: {tag: 'v0', rightNote: 'yes'},
  };
  const rightEnv = {
    ...baseEnv,
    bindings: {
      a: {value: integerValue(1n)},
      b: {value: integerValue(20n)},
    },
  };
  const rightArtifact = {
    ...baseArtifact,
    content: textValue('(+ 10 20)'),
  };
  const rightAdded = {
    id: 'obj/right-only',
    imageId: 'app',
    kind: 'object',
    shape: objectRef('app', 'shape/point'),
    behavior: null,
    slots: {x: integerValue(2n), y: integerValue(2n), label: textValue('right')},
    indexed: [],
    metadata: {},
  };

  const cleanPlan = mergeImageRecords({
    baseRecords: [pointShape, basePoint, baseEnv, baseArtifact, baseOnly],
    leftRecords: [pointShape, leftPoint, leftEnv, baseArtifact, leftAdded],
    rightRecords: [pointShape, rightPoint, rightEnv, rightArtifact, baseOnly, rightAdded],
    baseImageId: 'app',
  });

  assert.equal(cleanPlan.format, IMAGE_RECORD_MERGE_V1);
  assert.equal(cleanPlan.clean, true);
  assert.equal(cleanPlan.conflicts.length, 0);
  assert.deepEqual(cleanPlan.removedIds, ['obj/obsolete']);

  const mergedById = new Map(cleanPlan.mergedRecords.map((r) => [r.id, r]));
  const mergedPoint = mergedById.get('obj/point-1');
  assert.deepEqual(mergedPoint.slots, {
    x: integerValue(100n),
    y: integerValue(200n),
    label: textValue('origin'),
  });
  assert.deepEqual(mergedPoint.indexed, [integerValue(10n), integerValue(20n)]);
  assert.deepEqual(mergedPoint.metadata, {tag: 'v0', leftNote: 'yes', rightNote: 'yes'});

  const mergedEnv = mergedById.get('env/shared');
  assert.deepEqual(mergedEnv.bindings, {
    a: {value: integerValue(10n)},
    b: {value: integerValue(20n)},
  });
  assert.deepEqual(mergedById.get('art/doc').content, textValue('(+ 10 20)'));
  assert.ok(mergedById.has('obj/left-only'));
  assert.ok(mergedById.has('obj/right-only'));
  assert.ok(!mergedById.has('obj/obsolete'));

  // Now introduce conflicts:
  // 1. Both modify slot label and indexed[0] on obj/point-1 to different values
  // 2. Left deletes baseOnly while Right modifies baseOnly (delete-modify)
  // 3. Both add obj/colliding with different slots (add-add)
  // 4. Both modify art/doc to different contents (record-conflict)
  const conflictLeftPoint = {
    ...leftPoint,
    slots: {...leftPoint.slots, label: textValue('left-label')},
    indexed: [integerValue(111n), integerValue(2n)],
  };
  const conflictRightPoint = {
    ...rightPoint,
    slots: {...rightPoint.slots, label: textValue('right-label')},
    indexed: [integerValue(222n), integerValue(20n)],
  };
  const modifiedObsolete = {
    ...baseOnly,
    slots: {...baseOnly.slots, label: textValue('still-used-on-right')},
  };
  const leftColliding = {
    ...leftAdded,
    id: 'obj/colliding',
    slots: {x: integerValue(1n), y: integerValue(2n), label: textValue('L')},
  };
  const rightColliding = {
    ...rightAdded,
    id: 'obj/colliding',
    slots: {x: integerValue(9n), y: integerValue(9n), label: textValue('R')},
  };
  const leftArtifactConflict = {
    ...baseArtifact,
    content: textValue('(* 2 3)'),
  };

  const conflictedPlan = mergeImageRecords({
    baseRecords: [pointShape, basePoint, baseArtifact, baseOnly],
    leftRecords: [pointShape, conflictLeftPoint, leftArtifactConflict, leftColliding],
    rightRecords: [pointShape, conflictRightPoint, rightArtifact, modifiedObsolete, rightColliding],
    baseImageId: 'app',
  });

  assert.equal(conflictedPlan.clean, false);
  assert.equal(conflictedPlan.conflicts.length, 4);

  const conflictsById = new Map(conflictedPlan.conflicts.map((c) => [c.id, c]));
  const artConflict = conflictsById.get('art/doc');
  assert.equal(artConflict.conflictKind, MERGE_CONFLICT_KINDS.RECORD_CONFLICT);
  assert.deepEqual(artConflict.conflictingFields, ['content']);

  const addConflict = conflictsById.get('obj/colliding');
  assert.equal(addConflict.conflictKind, MERGE_CONFLICT_KINDS.ADD_ADD);

  const delModConflict = conflictsById.get('obj/obsolete');
  assert.equal(delModConflict.conflictKind, MERGE_CONFLICT_KINDS.DELETE_MODIFY);
  assert.equal(delModConflict.deletedSide, 'left');
  assert.equal(delModConflict.modifiedSide, 'right');

  const objConflict = conflictsById.get('obj/point-1');
  assert.equal(objConflict.conflictKind, MERGE_CONFLICT_KINDS.OBJECT_CONFLICT);
  assert.equal(objConflict.slotConflicts.length, 1);
  assert.equal(objConflict.slotConflicts[0].slotId, 'label');
  assert.deepEqual(objConflict.slotConflicts[0].left, textValue('left-label'));
  assert.deepEqual(objConflict.slotConflicts[0].right, textValue('right-label'));
  assert.equal(objConflict.indexedConflict.elementConflicts.length, 1);
  assert.equal(objConflict.indexedConflict.elementConflicts[0].index, 0);

  // Supplying explicit resolutions resolves all 4 conflicts cleanly
  const resolvedPlan = mergeImageRecords({
    baseRecords: [pointShape, basePoint, baseArtifact, baseOnly],
    leftRecords: [pointShape, conflictLeftPoint, leftArtifactConflict, leftColliding],
    rightRecords: [pointShape, conflictRightPoint, rightArtifact, modifiedObsolete, rightColliding],
    baseImageId: 'app',
    resolutions: {
      'art/doc': 'right',
      'obj/colliding': 'left',
      'obj/obsolete': 'left',
      'obj/point-1': {
        ...conflictLeftPoint,
        slots: {
          x: integerValue(100n),
          y: integerValue(200n),
          label: textValue('merged-label'),
        },
        indexed: [integerValue(333n), integerValue(20n)],
      },
    },
  });
  assert.equal(resolvedPlan.clean, true);
  assert.equal(resolvedPlan.conflicts.length, 0);
  const resolvedById = new Map(resolvedPlan.mergedRecords.map((r) => [r.id, r]));
  assert.deepEqual(resolvedById.get('obj/point-1').slots.label, textValue('merged-label'));
  assert.deepEqual(resolvedById.get('art/doc').content, textValue('(+ 10 20)'));
  assert.deepEqual(resolvedById.get('obj/colliding').slots.label, textValue('L'));
  assert.ok(!resolvedById.has('obj/obsolete'));
});

test('mergeImageFrontiers and applyImageMerge merge divergent Smalltalk and Common Lisp changes and execute in the merged image', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'base', name: 'Base'});
    await installSymmetricSmalltalkStandardImage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'base',
    });
    await installCommonLispRuntime({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'base',
    });

    const kernel = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'base',
      name: 'Account',
      instanceVariables: ['balance', 'limit'],
    });
    const classObj = await runtime.images.getObject('base', kernel.classRef.objectId);
    const shapeRef = classObj.slots['behavior-instance-shape'];
    const shapeRec = await runtime.images.getShape('base', shapeRef.objectId);
    const balanceSlotId = shapeRec.slots.find((s) => s.name === 'balance').id;
    const limitSlotId = shapeRec.slots.find((s) => s.name === 'limit').id;
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'base',
      classRef: kernel.classRef,
      methods: [
        {selector: 'balance', source: '[ ^balance ]'},
        {selector: 'limit', source: '[ ^limit ]'},
      ],
    });
    await runtime.images.putObject('base', {
      id: 'account/shared',
      shape: shapeRef,
      behavior: kernel.classRef,
      slots: {
        [balanceSlotId]: integerValue(100n),
        [limitSlotId]: integerValue(500n),
      },
    });
    const baseFrontier = await runtime.images.frontier('base');
    const baseRecords = await reconstructImageRecordsAtFrontier({
      images: runtime.images,
      imageId: 'base',
      frontier: baseFrontier,
    });

    // Branch 1 (on 'base' up to leftFrontier): updates Account>>balance slot on account/shared and adds Smalltalk method netAvailable
    await runtime.images.putObject('base', {
      id: 'account/shared',
      shape: shapeRef,
      behavior: kernel.classRef,
      slots: {
        [balanceSlotId]: integerValue(250n),
        [limitSlotId]: integerValue(500n),
      },
    });
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'base',
      classRef: kernel.classRef,
      methods: [{selector: 'netAvailable', source: '[ ^balance + limit ]'}],
    });
    const leftFrontier = await runtime.images.frontier('base');

    // Create a second image 'right-branch' from baseRecords, update limit slot on account/shared and install a Common Lisp function
    await runtime.images.createImage({id: 'right-branch', name: 'Right'});
    const baseSelfMerge = mergeImageRecords({
      baseRecords: [],
      leftRecords: baseRecords,
      rightRecords: [],
      baseImageId: 'base',
      leftImageId: 'base',
      targetImageId: 'right-branch',
    });
    await applyImageMerge({
      images: runtime.images,
      targetImageId: 'right-branch',
      mergePlan: baseSelfMerge,
    });
    await runtime.images.putObject('right-branch', {
      id: 'account/shared',
      shape: objectRef('right-branch', shapeRef.objectId),
      behavior: objectRef('right-branch', kernel.classRef.objectId),
      slots: {
        [balanceSlotId]: integerValue(100n),
        [limitSlotId]: integerValue(1000n),
      },
    });
    await installCommonLispProgram({
      images: runtime.images,
      compilation: runtime.compilation,
      runtime,
      imageId: 'right-branch',
      source: '(defun inspect-account (acc) (+ (send acc :netAvailable) 50))',
    });
    const rightFrontier = await runtime.images.frontier('right-branch');

    const leftRecords = await reconstructImageRecordsAtFrontier({
      images: runtime.images,
      imageId: 'base',
      frontier: leftFrontier,
    });
    const rightRecords = await reconstructImageRecordsAtFrontier({
      images: runtime.images,
      imageId: 'right-branch',
      frontier: rightFrontier,
    });

    const mergePlan = mergeImageRecords({
      baseRecords,
      leftRecords,
      rightRecords,
      baseImageId: 'base',
      leftImageId: 'base',
      rightImageId: 'right-branch',
      targetImageId: 'base',
    });
    assert.equal(mergePlan.clean, true);

    await applyImageMerge({
      images: runtime.images,
      targetImageId: 'base',
      mergePlan,
    });

    // Verify both Smalltalk and Common Lisp changes and merged slots work together in 'base'!
    const stResult = await evaluateSymmetricSmalltalkBlock({
      runtime,
      imageId: 'base',
      source: '[ :acc | acc netAvailable ]',
      arguments: [objectRef('base', 'account/shared')],
    });
    assert.deepEqual(stResult, integerValue(1250n));

    const clResult = await evaluateCommonLispSource({
      runtime,
      imageId: 'base',
      source: '(inspect-account acc)',
      parameters: ['acc'],
      arguments: [objectRef('base', 'account/shared')],
    });
    assert.deepEqual(clResult, integerValue(1300n));

    // Also test mergeImageFrontiers on 'base' and verify applyImageMerge refuses unresolved conflicts
    const fMerge = await mergeImageFrontiers({
      images: runtime.images,
      imageId: 'base',
      baseFrontier,
      leftFrontier,
      rightFrontier: leftFrontier,
    });
    assert.equal(fMerge.clean, true);

    const conflictPlan = mergeImageRecords({
      baseRecords,
      leftRecords,
      rightRecords: [
        ...baseRecords.filter((r) => r.id !== 'account/shared'),
        {
          id: 'account/shared',
          imageId: 'base',
          kind: 'object',
          shape: shapeRef,
          behavior: kernel.classRef,
          slots: {[balanceSlotId]: integerValue(999n), [limitSlotId]: integerValue(500n)},
          metadata: {},
        },
      ],
      baseImageId: 'base',
    });
    assert.equal(conflictPlan.clean, false);
    await assert.rejects(
      () =>
        applyImageMerge({
          images: runtime.images,
          targetImageId: 'base',
          mergePlan: conflictPlan,
        }),
      (err) => err instanceof MergeConflictError && err.conflicts.length === 1,
    );
  } finally {
    await runtime.close();
  }
});

test('mergeProjectDescriptors, mergeProjectReleases, mergeProjectAtFrontiers, and authorizedMergeProjects merge non-overlapping changes and enforce authority before existence reads', async () => {
  const baseProj = {
    format: 'lagrange-project/v1',
    projectId: 'proj/demo',
    name: 'Demo',
    namespace: null,
    members: [
      {key: 'core', role: 'source', target: objectRef('app', 'art/core-v1')},
      {key: 'legacy', role: 'doc', target: objectRef('app', 'art/legacy')},
      {key: 'shared', role: 'source', target: objectRef('app', 'art/shared-v1')},
    ],
  };

  // Left renames project, deletes 'legacy', changes role of 'shared' to 'entrypoint', adds 'left-mod'
  const leftProj = {
    format: 'lagrange-project/v1',
    projectId: 'proj/demo',
    name: 'Demo Left',
    namespace: null,
    members: [
      {key: 'core', role: 'source', target: objectRef('app', 'art/core-v1')},
      {key: 'shared', role: 'entrypoint', target: objectRef('app', 'art/shared-v1')},
      {key: 'left-mod', role: 'source', target: objectRef('app', 'art/left')},
    ],
  };

  // Right sets namespace, updates target of 'shared' to 'art/shared-v2', adds 'right-mod'
  const rightProj = {
    format: 'lagrange-project/v1',
    projectId: 'proj/demo',
    name: 'Demo',
    namespace: objectRef('app', 'ns/main'),
    members: [
      {key: 'core', role: 'source', target: objectRef('app', 'art/core-v1')},
      {key: 'legacy', role: 'doc', target: objectRef('app', 'art/legacy')},
      {key: 'shared', role: 'source', target: objectRef('app', 'art/shared-v2')},
      {key: 'right-mod', role: 'test', target: objectRef('app', 'art/right')},
    ],
  };

  const cleanProjMerge = mergeProjectDescriptors(baseProj, leftProj, rightProj);
  assert.equal(cleanProjMerge.format, PROJECT_DESCRIPTOR_MERGE_V1);
  assert.equal(cleanProjMerge.clean, true);
  assert.equal(cleanProjMerge.mergedDescriptor.name, 'Demo Left');
  assert.deepEqual(cleanProjMerge.mergedDescriptor.namespace, objectRef('app', 'ns/main'));
  assert.deepEqual(cleanProjMerge.mergedDescriptor.members, [
    {key: 'core', role: 'source', target: objectRef('app', 'art/core-v1')},
    {key: 'left-mod', role: 'source', target: objectRef('app', 'art/left')},
    {key: 'right-mod', role: 'test', target: objectRef('app', 'art/right')},
    {key: 'shared', role: 'entrypoint', target: objectRef('app', 'art/shared-v2')},
  ]);

  // Project release merge with dependency version conflict
  const relProfile = createDeploymentProfile({
    project: baseProj,
    profileId: 'portable-v1',
    members: ['core'],
  });
  const baseRel = createProjectReleaseManifest({
    project: baseProj,
    profile: relProfile,
    materializations: {
      core: {
        representation: 'common-lisp/source-v0',
        contentIdentity: 'sha256:1111',
      },
    },
    dependencies: [{projectId: 'proj/dep', releaseId: 'dep-1'}],
  });
  const leftRel = createProjectReleaseManifest({
    project: baseProj,
    profile: relProfile,
    materializations: {
      core: {
        representation: 'common-lisp/source-v0',
        contentIdentity: 'sha256:2222',
      },
    },
    dependencies: [{projectId: 'proj/dep', releaseId: 'dep-2'}],
  });
  const rightRel = createProjectReleaseManifest({
    project: baseProj,
    profile: relProfile,
    materializations: {
      core: {
        representation: 'common-lisp/source-v0',
        contentIdentity: 'sha256:1111',
      },
    },
    dependencies: [{projectId: 'proj/dep', releaseId: 'dep-3'}],
  });
  const relMerge = mergeProjectReleases(baseRel, leftRel, rightRel);
  assert.equal(relMerge.format, PROJECT_RELEASE_MERGE_V1);
  assert.equal(relMerge.clean, false);
  assert.equal(relMerge.conflicts.length, 1);
  assert.equal(
    relMerge.conflicts[0].conflictKind,
    PROJECT_MERGE_CONFLICT_KINDS.DEPENDENCY_VERSION_CONFLICT,
  );
  assert.equal(relMerge.mergedMembers[0].contentIdentity, 'sha256:2222');

  // Test mergeProjectAtFrontiers and authorizedMergeProjects
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'img-a', name: 'A'});
    await runtime.images.createImage({id: 'img-b', name: 'B'});

    const shape = await runtime.images.putShape('img-a', {
      id: 'shape/item',
      slots: [{id: 'val', name: 'val'}],
    });
    const item1 = await runtime.images.putObject('img-a', {
      id: 'obj/item-1',
      shape: objectRef('img-a', shape.id),
      slots: {val: integerValue(1n)},
    });
    const item2 = await runtime.images.putObject('img-a', {
      id: 'obj/item-2',
      shape: objectRef('img-a', shape.id),
      slots: {val: integerValue(2n)},
    });

    await createProject({
      images: runtime.images,
      imageId: 'img-a',
      projectId: 'p1',
      name: 'Project 1',
    });
    const fBase = await runtime.images.frontier('img-a');

    await addProjectMember({
      images: runtime.images,
      imageId: 'img-a',
      projectId: 'p1',
      key: 'm1',
      role: 'data',
      target: objectRef('img-a', item1.id),
    });
    const fLeft = await runtime.images.frontier('img-a');

    await addProjectMember({
      images: runtime.images,
      imageId: 'img-a',
      projectId: 'p1',
      key: 'm2',
      role: 'data',
      target: objectRef('img-a', item2.id),
    });
    const fRight = await runtime.images.frontier('img-a');

    const atFrontiers = await mergeProjectAtFrontiers({
      images: runtime.images,
      imageId: 'img-a',
      projectId: 'p1',
      baseFrontier: fBase,
      leftFrontier: fLeft,
      rightFrontier: fRight,
    });
    assert.equal(atFrontiers.projectMerge.clean, true);
    assert.deepEqual(
      atFrontiers.projectMerge.mergedDescriptor.members.map((m) => m.key),
      ['m1', 'm2'],
    );

    // Verify no-existence-oracle authority ordering in authorizedMergeProjects
    const demands = [];
    await assert.rejects(
      () =>
        authorizedMergeProjects({
          images: runtime.images,
          baseImageId: 'img-b',
          baseProjectId: 'missing-proj',
          leftImageId: 'img-a',
          leftProjectId: 'p1',
          rightImageId: 'img-a',
          rightProjectId: 'p1',
          require(demand) {
            demands.push(demand);
            throw new Error('AuthorityDenied');
          },
        }),
      /AuthorityDenied/,
    );
    assert.deepEqual(demands, [
      {
        operation: OBJECT_READ_OPERATION,
        resource: objectResource('img-a', projectObjectId('p1')),
      },
    ]);
  } finally {
    await runtime.close();
  }
});
