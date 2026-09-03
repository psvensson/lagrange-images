import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {createRuntime} from '../src/runtime.js';
import {LagrangeBackend} from '../src/backend/index.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {PROJECT_INSTALLATION_V1, normalizeProjectInstallation} from '../src/project/model.js';
import {
  PROJECT_INSTALLATION_HEAD_SHAPE_ID,
  PROJECT_INSTALLATION_MEMBER_SHAPE_ID,
  PROJECT_INSTALLATION_SNAPSHOT_SHAPE_ID,
  ProjectInstallationStateError,
  ensureInstallationShapes,
  installationHeadObjectId,
  materializeInstallationRecords,
  readManagedProjectInstallation,
} from '../src/project/installation-state.js';
import {SHAPE_INDEXED} from '../src/object/model.js';
import {objectRef, textValue} from '../src/value/index.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

const SLOT = Object.freeze({
  projectId: 'installation-project-id',
  snapshot: 'installation-snapshot',
  releaseId: 'installation-release-id',
  memberKey: 'installation-member-key',
  role: 'installation-member-role',
  representation: 'installation-member-representation',
  contentIdentity: 'installation-member-content-identity',
  target: 'installation-member-target',
});

function fixture() {
  return normalizeProjectInstallation({
    format: PROJECT_INSTALLATION_V1,
    projectId: 'project:demo/with/slashes',
    releaseId: 'sha256:release',
    targetImageId: 'dst',
    members: [
      {
        key: 'zeta',
        role: 'test',
        representation: 'smalltalk/tests-v1',
        contentIdentity: 'sha256:zeta',
        target: objectRef('dst', 'zeta-target'),
      },
      {
        key: 'alpha',
        role: 'source',
        representation: 'smalltalk/source-v1',
        contentIdentity: 'sha256:alpha',
        target: objectRef('dst', 'alpha-target'),
      },
    ],
  });
}

function deterministicCrypto(ids = ['member-alpha', 'member-zeta', 'snapshot']) {
  let next = 0;
  return {
    uuid() {
      assert.ok(next < ids.length, 'test supplied enough deterministic ids');
      return ids[next++];
    },
  };
}

function assertDeeplyFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const entry of Object.values(value)) assertDeeplyFrozen(entry);
}

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function persistFixture(images) {
  const installation = fixture();
  await images.createImage({id: installation.targetImageId});
  await ensureInstallationShapes({images, targetImageId: installation.targetImageId});
  const records = materializeInstallationRecords({installation, crypto: deterministicCrypto()});
  await images.createRecords(installation.targetImageId, records);
  return {installation, records};
}

async function rewriteObject(images, imageId, objectId, change) {
  const current = await images.getObject(imageId, objectId);
  assert.ok(current, `fixture object exists: ${objectId}`);
  const changed = change(current);
  const input = {
    id: current.id,
    shape: current.shape,
    behavior: current.behavior,
    slots: current.slots,
    metadata: current.metadata,
    ...changed,
  };
  if (Object.hasOwn(current, 'indexed') && !Object.hasOwn(changed, 'indexed')) input.indexed = current.indexed;
  await images.putObject(imageId, input, {expectedVersion: current._version});
}

function recordsByRole(records) {
  const head = records.at(-1);
  const snapshot = records.at(-2);
  const members = records.slice(0, -2);
  return {head, snapshot, members};
}

test('fixed Shapes bootstrap race-tolerantly and never count as an installation', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'dst'});
    const realGetRecord = runtime.images.getRecord.bind(runtime.images);
    let initialHeadReads = 0;
    const racingImages = {
      getRecord: async (imageId, objectId) => {
        if (objectId === PROJECT_INSTALLATION_HEAD_SHAPE_ID && initialHeadReads < 2) {
          initialHeadReads += 1;
          return null;
        }
        return realGetRecord(imageId, objectId);
      },
      putShape: runtime.images.putShape.bind(runtime.images),
    };
    await Promise.all([
      ensureInstallationShapes({images: racingImages, targetImageId: 'dst'}),
      ensureInstallationShapes({images: racingImages, targetImageId: 'dst'}),
    ]);
    assert.equal(initialHeadReads, 2, 'both contenders observed the head Shape absent before racing');

    const expected = [
      {
        id: PROJECT_INSTALLATION_HEAD_SHAPE_ID,
        slots: [
          {id: SLOT.projectId, name: 'projectId'},
          {id: SLOT.snapshot, name: 'snapshot'},
        ],
        indexed: SHAPE_INDEXED.NONE,
      },
      {
        id: PROJECT_INSTALLATION_SNAPSHOT_SHAPE_ID,
        slots: [
          {id: SLOT.projectId, name: 'projectId'},
          {id: SLOT.releaseId, name: 'releaseId'},
        ],
        indexed: SHAPE_INDEXED.VALUES,
      },
      {
        id: PROJECT_INSTALLATION_MEMBER_SHAPE_ID,
        slots: [
          {id: SLOT.memberKey, name: 'key'},
          {id: SLOT.role, name: 'role'},
          {id: SLOT.representation, name: 'representation'},
          {id: SLOT.contentIdentity, name: 'contentIdentity'},
          {id: SLOT.target, name: 'target'},
        ],
        indexed: SHAPE_INDEXED.NONE,
      },
    ];
    for (const shape of expected) {
      const stored = await runtime.images.getShape('dst', shape.id);
      assert.deepEqual(stored.slots, shape.slots);
      assert.equal(stored.indexed ?? SHAPE_INDEXED.NONE, shape.indexed);
    }
    const historyBeforeReplay = await runtime.images.history('dst');
    await ensureInstallationShapes({images: runtime.images, targetImageId: 'dst'});
    assert.equal((await runtime.images.history('dst')).length, historyBeforeReplay.length, 'exact replay writes nothing');
    assert.equal(await readManagedProjectInstallation({
      images: runtime.images,
      targetImageId: 'dst',
      projectId: 'project:demo/with/slashes',
    }), null, 'Shapes alone are not installation state');
  });
});

test('materialization is canonical, deeply frozen ordinary-object input and round-trips every descriptor field', async () => {
  await withRuntime(async (runtime) => {
    const installation = fixture();
    await runtime.images.createImage({id: 'dst'});
    await ensureInstallationShapes({images: runtime.images, targetImageId: 'dst'});
    const records = materializeInstallationRecords({installation, crypto: deterministicCrypto()});
    assertDeeplyFrozen(records);
    assert.deepEqual(records.map(({kind}) => kind), ['object', 'object', 'object', 'object']);

    const {head, snapshot, members} = recordsByRole(records);
    assert.deepEqual(members.map(({id}) => id), ['member-alpha', 'member-zeta'], 'ids minted in canonical member order');
    assert.deepEqual(members.map(({slots}) => slots[SLOT.memberKey].value), ['alpha', 'zeta']);
    assert.equal(snapshot.id, 'snapshot');
    assert.deepEqual(snapshot.indexed, members.map(({id}) => objectRef('dst', id)));
    assert.equal(head.id, installationHeadObjectId(installation.projectId));
    assert.equal(head.id, 'lagrange-project-installation/project:demo/with/slashes/head');
    assert.deepEqual(head.slots[SLOT.snapshot], objectRef('dst', snapshot.id));

    await runtime.images.createRecords('dst', records);
    const recovered = await readManagedProjectInstallation({
      images: runtime.images,
      targetImageId: 'dst',
      projectId: installation.projectId,
    });
    assert.deepEqual(recovered, installation);
    assertDeeplyFrozen(recovered);

    const projectApi = await import('lagrange-images/project');
    assert.equal(projectApi.readManagedProjectInstallation, readManagedProjectInstallation);
  });
});

test('snapshot/member records without the deterministic head are invisible and never scanned or adopted', async () => {
  await withRuntime(async (runtime) => {
    const installation = fixture();
    await runtime.images.createImage({id: 'dst'});
    await ensureInstallationShapes({images: runtime.images, targetImageId: 'dst'});
    const records = materializeInstallationRecords({installation, crypto: deterministicCrypto()});
    await runtime.images.createRecords('dst', records.slice(0, -1));

    const reads = [];
    const readOnly = {
      getRecord: async (imageId, objectId) => {
        reads.push([imageId, objectId]);
        return runtime.images.getRecord(imageId, objectId);
      },
    };
    assert.equal(await readManagedProjectInstallation({
      images: readOnly,
      targetImageId: 'dst',
      projectId: installation.projectId,
    }), null);
    assert.deepEqual(reads, [['dst', installationHeadObjectId(installation.projectId)]]);
  });
});

const corruptions = [
  {
    name: 'dangling head snapshot ref',
    pattern: /snapshot.*missing/,
    mutate: async (images, {head}) => rewriteObject(images, 'dst', head.id, (record) => ({
      slots: {...record.slots, [SLOT.snapshot]: objectRef('dst', 'missing-snapshot')},
    })),
  },
  {
    name: 'snapshot projectId differs from the stable head key',
    pattern: /snapshot projectId/,
    mutate: async (images, {snapshot}) => rewriteObject(images, 'dst', snapshot.id, (record) => ({
      slots: {...record.slots, [SLOT.projectId]: textValue('project:other')},
    })),
  },
  {
    name: 'malformed snapshot releaseId',
    pattern: /releaseId/,
    mutate: async (images, {snapshot}) => rewriteObject(images, 'dst', snapshot.id, (record) => ({
      slots: {...record.slots, [SLOT.releaseId]: textValue('')},
    })),
  },
  {
    name: 'dangling snapshot member ref',
    pattern: /member.*missing/,
    mutate: async (images, {snapshot}) => rewriteObject(images, 'dst', snapshot.id, () => ({
      indexed: [objectRef('dst', 'missing-member')],
    })),
  },
  {
    name: 'duplicate member key',
    pattern: /duplicate Project installation member key/,
    mutate: async (images, {members}) => rewriteObject(images, 'dst', members[1].id, (record) => ({
      slots: {...record.slots, [SLOT.memberKey]: textValue('alpha')},
    })),
  },
  ...[
    [SLOT.memberKey, 'key'],
    [SLOT.role, 'role'],
    [SLOT.representation, 'representation'],
    [SLOT.contentIdentity, 'contentIdentity'],
  ].map(([slotId, label]) => ({
    name: `malformed member ${label}`,
    pattern: new RegExp(label),
    mutate: async (images, {members}) => rewriteObject(images, 'dst', members[0].id, (record) => ({
      slots: {...record.slots, [slotId]: textValue('')},
    })),
  })),
  {
    name: 'member target outside target Image',
    pattern: /must belong to installation target image dst/,
    mutate: async (images, {members}) => rewriteObject(images, 'dst', members[0].id, (record) => ({
      slots: {...record.slots, [SLOT.target]: objectRef('elsewhere', 'target')},
    })),
  },
];

for (const scenario of corruptions) {
  test(`corruption: ${scenario.name} is surfaced as ProjectInstallationStateError`, async () => {
    await withRuntime(async (runtime) => {
      const {installation, records} = await persistFixture(runtime.images);
      await scenario.mutate(runtime.images, recordsByRole(records));
      await assert.rejects(
        readManagedProjectInstallation({
          images: runtime.images,
          targetImageId: installation.targetImageId,
          projectId: installation.projectId,
        }),
        (error) => error instanceof ProjectInstallationStateError && scenario.pattern.test(error.message),
      );
    });
  });
}

test('schema divergence is corruption; an identical existing schema remains idempotent', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'dst'});
    await runtime.images.putShape('dst', {id: PROJECT_INSTALLATION_HEAD_SHAPE_ID, slots: []});
    await assert.rejects(
      ensureInstallationShapes({images: runtime.images, targetImageId: 'dst'}),
      (error) => error instanceof ProjectInstallationStateError && /Shape.*diverges/.test(error.message),
    );
  });
});

test('real-backend restart recovery needs only deterministic head, snapshot and member reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-installation-state-'));
  const filename = join(directory, 'image.sqlite');
  try {
    const firstBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await firstBackend.start();
    const first = new ImageService({backend: firstBackend});
    const installation = fixture();
    await first.createImage({id: 'dst'});
    await ensureInstallationShapes({images: first, targetImageId: 'dst'});
    await first.createRecords('dst', materializeInstallationRecords({installation, crypto: deterministicCrypto()}));
    await firstBackend.stop();

    const secondBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await secondBackend.start();
    try {
      const second = new ImageService({backend: secondBackend});
      const reads = [];
      const readOnly = {
        getRecord: async (imageId, objectId) => {
          reads.push(objectId);
          return second.getRecord(imageId, objectId);
        },
      };
      assert.deepEqual(await readManagedProjectInstallation({
        images: readOnly,
        targetImageId: 'dst',
        projectId: installation.projectId,
      }), installation);
      assert.deepEqual(reads, [
        installationHeadObjectId(installation.projectId),
        'snapshot',
        'member-alpha',
        'member-zeta',
      ]);
    } finally {
      await secondBackend.stop();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
