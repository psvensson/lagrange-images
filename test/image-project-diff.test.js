import test from 'node:test';
import assert from 'node:assert/strict';
import './ensure-node-crypto.test-helper.js';
import {
  AuthorityError,
  GRAPH_BUNDLE_DIFF_V1,
  IMAGE_RECORD_DIFF_V1,
  OBJECT_READ_OPERATION,
  PROJECT_DESCRIPTOR_DIFF_V1,
  PROJECT_RELEASE_DIFF_V1,
  PlacementPolicy,
  addProjectMember,
  authorizedDiffProjects,
  authorizedRenameProject,
  authorizedReadProject,
  captureCurrentGraphProjectRelease,
  createAuthorityService,
  createDeploymentProfile,
  createProject,
  createRuntime,
  diffGraphBundles,
  diffImageFrontiers,
  diffImageRecords,
  diffProjectAtFrontiers,
  diffProjectDescriptors,
  diffProjectReleases,
  integerValue,
  objectRef,
  objectResource,
  projectObjectId,
  reconstructImageRecordsAtFrontier,
  textValue,
} from '../src/runtime.js';
import {exportGraphBundle} from '../src/graph/index.js';
import {
  authorizedDiffProjects as portableAuthorizedDiffProjects,
  diffGraphBundles as portableDiffGraphBundles,
  diffImageFrontiers as portableDiffImageFrontiers,
  diffImageRecords as portableDiffImageRecords,
  diffProjectAtFrontiers as portableDiffProjectAtFrontiers,
  diffProjectDescriptors as portableDiffProjectDescriptors,
  diffProjectReleases as portableDiffProjectReleases,
  reconstructImageRecordsAtFrontier as portableReconstructImageRecordsAtFrontier,
} from '../src/portable-runtime.js';

test('portable runtime re-exports exact diff owner functions', () => {
  assert.equal(portableDiffImageRecords, diffImageRecords);
  assert.equal(portableDiffImageFrontiers, diffImageFrontiers);
  assert.equal(portableDiffGraphBundles, diffGraphBundles);
  assert.equal(portableReconstructImageRecordsAtFrontier, reconstructImageRecordsAtFrontier);
  assert.equal(portableDiffProjectDescriptors, diffProjectDescriptors);
  assert.equal(portableDiffProjectReleases, diffProjectReleases);
  assert.equal(portableAuthorizedDiffProjects, authorizedDiffProjects);
  assert.equal(portableDiffProjectAtFrontiers, diffProjectAtFrontiers);
});

test('diffImageRecords strips transient storage fields and computes added, removed, and per-slot modified records', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const {images} = runtime;
    await images.createImage({id: 'app'});
    const shape = await images.putShape('app', {
      id: 'point-shape',
      slots: [
        {id: 'x', name: 'x'},
        {id: 'y', name: 'y'},
      ],
    });
    const p1 = await images.putObject('app', {
      id: 'p1',
      shape: objectRef('app', shape.id),
      slots: {x: integerValue(1), y: integerValue(2)},
    });
    const p2 = await images.putObject('app', {
      id: 'p2',
      shape: objectRef('app', shape.id),
      slots: {x: integerValue(10), y: integerValue(20)},
    });

    const snapshotA = await images.listRecords('app');

    // Touch p1 with identical slots so _version and updatedAt advance without structural change.
    await images.putObject(
      'app',
      {
        id: 'p1',
        shape: objectRef('app', shape.id),
        slots: {x: integerValue(1), y: integerValue(2)},
      },
      {expectedVersion: p1._version},
    );
    const snapshotSame = await images.listRecords('app');
    const sameDiff = diffImageRecords({
      fromRecords: snapshotA,
      toRecords: snapshotSame,
      fromImageId: 'app',
      toImageId: 'app',
    });
    assert.equal(sameDiff.format, IMAGE_RECORD_DIFF_V1);
    assert.equal(sameDiff.identical, true);
    assert.equal(sameDiff.unchangedCount, 3);
    assert.deepEqual(sameDiff.added, []);
    assert.deepEqual(sameDiff.removed, []);
    assert.deepEqual(sameDiff.modified, []);

    // Mutate p2.y and add p3.
    await images.putObject(
      'app',
      {
        id: 'p2',
        shape: objectRef('app', shape.id),
        slots: {x: integerValue(10), y: integerValue(99)},
      },
      {expectedVersion: p2._version},
    );
    await images.putObject('app', {
      id: 'p3',
      shape: objectRef('app', shape.id),
      slots: {x: integerValue(7), y: integerValue(8)},
    });
    const snapshotB = await images.listRecords('app');
    const diffAB = diffImageRecords({
      fromRecords: snapshotA,
      toRecords: snapshotB,
      fromImageId: 'app',
      toImageId: 'app',
    });
    assert.equal(diffAB.identical, false);
    assert.equal(diffAB.unchangedCount, 2);
    assert.deepEqual(
      diffAB.added.map(({id, kind}) => ({id, kind})),
      [{id: 'p3', kind: 'object'}],
    );
    assert.equal(diffAB.modified.length, 1);
    assert.equal(diffAB.modified[0].id, 'p2');
    assert.deepEqual(diffAB.modified[0].changedFields, ['slots']);
    assert.deepEqual(diffAB.modified[0].slotChanges, {
      added: [],
      removed: [],
      modified: [
        {
          slotId: 'y',
          before: integerValue(20),
          after: integerValue(99),
        },
      ],
    });
  } finally {
    await runtime.close();
  }
});

test('reconstructImageRecordsAtFrontier and diffImageFrontiers reconstruct historical state and handle relocations', async () => {
  const runtimeB = await createRuntime({backend: {mode: 'mock'}});
  const runtimeA = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtimeB.images.createImage({id: 'app'});
    const f0 = await runtimeB.images.frontier('app');

    const shape = await runtimeB.images.putShape('app', {
      id: 'counter-shape',
      slots: [{id: 'count', name: 'count'}],
    });
    const counter = await runtimeB.images.putObject('app', {
      id: 'c1',
      shape: objectRef('app', shape.id),
      slots: {count: integerValue(1)},
    });
    const f1 = await runtimeB.images.frontier('app');

    await runtimeB.images.putObject(
      'app',
      {
        id: 'c1',
        shape: objectRef('app', shape.id),
        slots: {count: integerValue(5)},
      },
      {expectedVersion: counter._version},
    );
    const f2 = await runtimeB.images.frontier('app');

    const recordsAtF1 = await reconstructImageRecordsAtFrontier({
      images: runtimeB.images,
      imageId: 'app',
      frontier: f1,
    });
    const c1AtF1 = recordsAtF1.find((r) => r.id === 'c1');
    assert.equal(c1AtF1.slots.count.value, '1');

    const diff01 = await diffImageFrontiers({
      images: runtimeB.images,
      imageId: 'app',
      fromFrontier: f0,
      toFrontier: f1,
    });
    assert.equal(diff01.identical, false);
    assert.deepEqual(
      diff01.added.map((e) => e.id),
      ['c1', 'counter-shape'],
    );

    const diff12 = await diffImageFrontiers({
      images: runtimeB.images,
      imageId: 'app',
      fromFrontier: f1,
      toFrontier: f2,
    });
    assert.equal(diff12.identical, false);
    assert.equal(diff12.modified.length, 1);
    assert.equal(diff12.modified[0].id, 'c1');
    assert.deepEqual(diff12.modified[0].slotChanges.modified, [
      {
        slotId: 'count',
        before: integerValue(1),
        after: integerValue(5),
      },
    ]);

    // Relocate c1 from runtimeB to runtimeA and verify f2 -> f3 records c1 as removed on node B's local history.
    const placement = new PlacementPolicy({
      nodes: {'node-b': runtimeB, 'node-a': runtimeA},
    });
    await placement.relocateObject({
      ref: objectRef('app', 'c1'),
      fromNode: 'node-b',
      toNode: 'node-a',
    });
    const f3 = await runtimeB.images.frontier('app');
    const diff23 = await diffImageFrontiers({
      images: runtimeB.images,
      imageId: 'app',
      fromFrontier: f2,
      toFrontier: f3,
    });
    assert.deepEqual(
      diff23.removed.map((e) => e.id),
      ['c1'],
    );

    await assert.rejects(
      () =>
        reconstructImageRecordsAtFrontier({
          images: runtimeB.images,
          imageId: 'app',
          frontier: f3 + 10,
        }),
      RangeError,
    );
  } finally {
    await runtimeA.close();
    await runtimeB.close();
  }
});

test('diffGraphBundles compares portable graph bundles by canonical contentIdentity and localId records', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const {images} = runtime;
    await images.createImage({id: 'app'});
    const shape = await images.putShape('app', {
      id: 'box-shape',
      slots: [{id: 'val', name: 'val'}],
    });
    const box = await images.putObject('app', {
      id: 'box-1',
      shape: objectRef('app', shape.id),
      slots: {val: textValue('v1')},
    });
    const bundle1 = await exportGraphBundle({
      images,
      roots: {main: objectRef('app', 'box-1')},
    });

    await images.putObject(
      'app',
      {
        id: 'box-1',
        shape: objectRef('app', shape.id),
        slots: {val: textValue('v2')},
      },
      {expectedVersion: box._version},
    );
    const bundle2 = await exportGraphBundle({
      images,
      roots: {main: objectRef('app', 'box-1')},
    });

    const sameBundleDiff = diffGraphBundles(bundle1, bundle1);
    assert.equal(sameBundleDiff.format, GRAPH_BUNDLE_DIFF_V1);
    assert.equal(sameBundleDiff.identical, true);
    assert.equal(sameBundleDiff.modifiedRecords.length, 0);

    const bundleDiff = diffGraphBundles(bundle1, bundle2);
    assert.equal(bundleDiff.identical, false);
    assert.equal(bundleDiff.rootsChanged, false);
    assert.equal(bundleDiff.modifiedRecords.length, 1);
    assert.equal(bundleDiff.modifiedRecords[0].kind, 'object');
  } finally {
    await runtime.close();
  }
});

test('diffProjectDescriptors, diffProjectReleases, authorizedDiffProjects, and diffProjectAtFrontiers', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const {images} = runtime;
    await images.createImage({id: 'app'});
    const shape = await images.putShape('app', {
      id: 'item-shape',
      slots: [{id: 'label', name: 'label'}],
    });
    const itemA1 = await images.putObject('app', {
      id: 'item-a1',
      shape: objectRef('app', shape.id),
      slots: {label: textValue('alpha-v1')},
    });
    const itemA2 = await images.putObject('app', {
      id: 'item-a2',
      shape: objectRef('app', shape.id),
      slots: {label: textValue('alpha-v2')},
    });
    const itemB = await images.putObject('app', {
      id: 'item-b',
      shape: objectRef('app', shape.id),
      slots: {label: textValue('beta')},
    });

    await createProject({images, imageId: 'app', projectId: 'demo', name: 'Demo v1'});
    await addProjectMember({
      images,
      imageId: 'app',
      projectId: 'demo',
      key: 'core',
      role: 'entry',
      target: objectRef('app', itemA1.id),
    });
    const frontierV1 = await images.frontier('app');

    // Capture release 1.
    const authority = createAuthorityService();
    const fullCtx = authority.issue({
      principal: 'tester',
      grants: [
        {operation: 'object/read', resource: objectResource('app', projectObjectId('demo'))},
        {operation: 'object/write', resource: objectResource('app', projectObjectId('demo'))},
      ],
    });
    const requireFull = (demand) => authority.require(fullCtx, demand);

    const {descriptor: descV1, versionToken} = await authorizedReadProject({
      images,
      imageId: 'app',
      projectId: 'demo',
      require: requireFull,
    });
    const profile1 = createDeploymentProfile({
      project: descV1,
      profileId: 'default',
      members: ['core'],
    });
    const release1 = await captureCurrentGraphProjectRelease({
      images,
      projectImageId: 'app',
      projectId: 'demo',
      profile: profile1,
    });

    // Rename Project, retarget 'core' to itemA2, and add 'extra' -> itemB.
    await authorizedRenameProject({
      images,
      imageId: 'app',
      projectId: 'demo',
      name: 'Demo v2',
      expectedVersionToken: versionToken,
      require: requireFull,
    });
    await addProjectMember({
      images,
      imageId: 'app',
      projectId: 'demo',
      key: 'core',
      role: 'entry',
      target: objectRef('app', itemA2.id),
    });
    await addProjectMember({
      images,
      imageId: 'app',
      projectId: 'demo',
      key: 'extra',
      role: 'support',
      target: objectRef('app', itemB.id),
    });
    const frontierV2 = await images.frontier('app');

    const {descriptor: descV2} = await authorizedReadProject({
      images,
      imageId: 'app',
      projectId: 'demo',
      require: requireFull,
    });
    const profile2 = createDeploymentProfile({
      project: descV2,
      profileId: 'default',
      members: ['core', 'extra'],
    });
    const release2 = await captureCurrentGraphProjectRelease({
      images,
      projectImageId: 'app',
      projectId: 'demo',
      profile: profile2,
      dependencies: [{projectId: 'base-lib', releaseId: 'sha256:1111'}],
    });

    // 1. Pure descriptor diff
    const descDiff = diffProjectDescriptors(descV1, descV2);
    assert.equal(descDiff.format, PROJECT_DESCRIPTOR_DIFF_V1);
    assert.equal(descDiff.identical, false);
    assert.equal(descDiff.nameChanged, true);
    assert.equal(descDiff.fromName, 'Demo v1');
    assert.equal(descDiff.toName, 'Demo v2');
    assert.deepEqual(
      descDiff.addedMembers.map((m) => m.key),
      ['extra'],
    );
    assert.equal(descDiff.modifiedMembers.length, 1);
    assert.equal(descDiff.modifiedMembers[0].key, 'core');
    assert.equal(descDiff.modifiedMembers[0].targetChanged, true);
    assert.equal(descDiff.modifiedMembers[0].roleChanged, false);

    // 2. Release manifest diff
    const relDiff = diffProjectReleases(release1.release, release2.release);
    assert.equal(relDiff.format, PROJECT_RELEASE_DIFF_V1);
    assert.equal(relDiff.identical, false);
    assert.deepEqual(
      relDiff.addedMembers.map((m) => m.key),
      ['extra'],
    );
    assert.equal(relDiff.modifiedMembers.length, 1);
    assert.equal(relDiff.modifiedMembers[0].key, 'core');
    assert.equal(relDiff.modifiedMembers[0].contentIdentityChanged, true);
    assert.deepEqual(relDiff.addedDependencies, [{projectId: 'base-lib', releaseId: 'sha256:1111'}]);

    // 3. diffProjectAtFrontiers reconstructs Project descriptor at frontierV1 vs frontierV2
    const atFrontiers = await diffProjectAtFrontiers({
      images,
      imageId: 'app',
      projectId: 'demo',
      fromFrontier: frontierV1,
      toFrontier: frontierV2,
    });
    assert.deepEqual(atFrontiers.projectDiff, descDiff);
    assert.equal(atFrontiers.frontierDiff.fromFrontier, frontierV1);
    assert.equal(atFrontiers.frontierDiff.toFrontier, frontierV2);

    // 4. authorizedDiffProjects enforces object/read on both Projects before any existence read
    const emptyCtx = authority.issue({principal: 'denied', grants: []});
    await assert.rejects(
      () =>
        authorizedDiffProjects({
          images,
          fromImageId: 'app',
          fromProjectId: 'nonexistent-project',
          toImageId: 'app',
          toProjectId: 'demo',
          require: (demand) => authority.require(emptyCtx, demand),
        }),
      AuthorityError,
      'denied caller must receive AuthorityError without learning whether nonexistent-project exists',
    );

    const sameAuthDiff = await authorizedDiffProjects({
      images,
      fromImageId: 'app',
      fromProjectId: 'demo',
      toImageId: 'app',
      toProjectId: 'demo',
      require: requireFull,
    });
    assert.equal(sameAuthDiff.identical, true);
    assert.equal(sameAuthDiff.unchangedMembers.length, 2);
  } finally {
    await runtime.close();
  }
});
