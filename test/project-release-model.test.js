import assert from 'node:assert/strict';
import './ensure-node-crypto.test-helper.js';
import test from 'node:test';

import {
  createDeploymentProfile,
  createProjectDescriptor,
  createProjectInstallation,
  createProjectReleaseManifest,
  createProjectReleaseProvenance,
  normalizeProjectReleaseManifest,
  planProjectUpgrade,
  selectProjectMembers,
} from '../src/project/index.js';
import {objectRef} from '../src/value/index.js';

function projectFixture({
  projectId = 'project:demo',
  name = 'Demo',
  imageA = 'dev-a',
  imageB = 'dev-b',
} = {}) {
  return createProjectDescriptor({
    projectId,
    name,
    namespace: objectRef(imageA, 'namespace'),
    members: [
      {key: 'tests/customer', role: 'test', target: objectRef(imageB, 'customer-tests')},
      {key: 'model/customer', role: 'source', target: objectRef(imageA, 'customer')},
      {key: 'service/api', role: 'component', target: objectRef(imageA, 'api-component')},
      {key: 'docs/readme', role: 'note', target: objectRef(imageB, 'readme')},
    ],
  });
}

test('Project identity and member keys are semantic while member refs may span Images', () => {
  const project = projectFixture();
  assert.equal(project.projectId, 'project:demo');
  assert.deepEqual(project.members.map(({key}) => key), [
    'docs/readme',
    'model/customer',
    'service/api',
    'tests/customer',
  ]);
  assert.deepEqual(
    new Set(project.members.map(({target}) => target.imageId)),
    new Set(['dev-a', 'dev-b']),
  );

  assert.throws(
    () => createProjectDescriptor({
      projectId: 'project:duplicate',
      name: 'Duplicate',
      members: [
        {key: 'same', role: 'source', target: objectRef('a', 'one')},
        {key: 'same', role: 'test', target: objectRef('b', 'two')},
      ],
    }),
    /duplicate Project member key/,
  );
});

test('deployment profiles select explicit stable member keys and infer no reachability or role closure', () => {
  const project = projectFixture();
  const profile = createDeploymentProfile({
    project,
    profileId: 'runtime',
    members: ['service/api', 'model/customer'],
  });
  assert.deepEqual(profile.members, ['model/customer', 'service/api']);
  assert.deepEqual(
    selectProjectMembers(project, profile).map(({key}) => key),
    ['model/customer', 'service/api'],
  );
  assert.equal(selectProjectMembers(project, profile).some(({key}) => key === 'tests/customer'), false);

  assert.throws(
    () => createDeploymentProfile({project, profileId: 'bad', members: ['missing']}),
    /unknown Project member/,
  );
});

test('release manifest identity is canonical content, independent of source Image refs and Project display name', () => {
  const projectA = projectFixture({name: 'Working copy A', imageA: 'dev-a', imageB: 'deps-a'});
  const projectB = projectFixture({name: 'Working copy B', imageA: 'dev-b', imageB: 'deps-b'});
  const profileA = createDeploymentProfile({
    project: projectA,
    profileId: 'runtime',
    members: ['service/api', 'model/customer'],
  });
  const profileB = createDeploymentProfile({
    project: projectB,
    profileId: 'runtime',
    members: ['model/customer', 'service/api'],
  });
  const materials = {
    'service/api': {representation: 'wasm-component/v1', contentIdentity: 'sha256:component'},
    'model/customer': {representation: 'project-member/object-schema-v1', contentIdentity: 'sha256:model'},
  };
  const dependenciesA = [
    {projectId: 'project:z', releaseId: 'sha256:z'},
    {projectId: 'project:a', releaseId: 'sha256:a'},
  ];
  const dependenciesB = [...dependenciesA].reverse();

  const releaseA = createProjectReleaseManifest({
    project: projectA,
    profile: profileA,
    materializations: materials,
    dependencies: dependenciesA,
  });
  const releaseB = createProjectReleaseManifest({
    project: projectB,
    profile: profileB,
    materializations: {
      'model/customer': materials['model/customer'],
      'service/api': materials['service/api'],
    },
    dependencies: dependenciesB,
  });

  assert.equal(releaseA.releaseId, releaseB.releaseId);
  assert.match(releaseA.releaseId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(releaseA).includes('dev-a'), false);
  assert.equal(JSON.stringify(releaseA).includes('customer-tests'), false);
  assert.deepEqual(releaseA.members.map(({key}) => key), ['model/customer', 'service/api']);
  assert.deepEqual(releaseA.dependencies.map(({projectId}) => projectId), ['project:a', 'project:z']);

  const changed = createProjectReleaseManifest({
    project: projectA,
    profile: profileA,
    materializations: {
      ...materials,
      'model/customer': {
        representation: 'project-member/object-schema-v1',
        contentIdentity: 'sha256:model-v2',
      },
    },
    dependencies: dependenciesA,
  });
  assert.notEqual(changed.releaseId, releaseA.releaseId);

  const tampered = structuredClone(releaseA);
  tampered.members[0].contentIdentity = 'sha256:tampered';
  assert.throws(() => normalizeProjectReleaseManifest(tampered), /releaseId does not match canonical content/);
});

test('release provenance is separate from release identity and records a cross-Image frontier map', () => {
  const projectA = projectFixture({imageA: 'dev-a', imageB: 'deps-a'});
  const profileA = createDeploymentProfile({
    project: projectA,
    profileId: 'all-runtime',
    members: ['service/api', 'tests/customer'],
  });
  const release = createProjectReleaseManifest({
    project: projectA,
    profile: profileA,
    materializations: {
      'service/api': {representation: 'wasm-component/v1', contentIdentity: 'sha256:api'},
      'tests/customer': {representation: 'smalltalk/tests-v1', contentIdentity: 'sha256:tests'},
    },
  });
  const provenanceA = createProjectReleaseProvenance({
    release,
    project: projectA,
    sourceFrontiers: {'deps-a': 12, 'dev-a': '0007'},
  });
  assert.deepEqual(provenanceA.sourceFrontiers, {'deps-a': '12', 'dev-a': '7'});
  assert.deepEqual(provenanceA.memberSources.map(({source}) => source.imageId), ['dev-a', 'deps-a']);

  const projectB = projectFixture({imageA: 'dev-b', imageB: 'deps-b'});
  const profileB = createDeploymentProfile({
    project: projectB,
    profileId: 'all-runtime',
    members: ['tests/customer', 'service/api'],
  });
  const releaseB = createProjectReleaseManifest({
    project: projectB,
    profile: profileB,
    materializations: {
      'tests/customer': {representation: 'smalltalk/tests-v1', contentIdentity: 'sha256:tests'},
      'service/api': {representation: 'wasm-component/v1', contentIdentity: 'sha256:api'},
    },
  });
  assert.equal(releaseB.releaseId, release.releaseId);
  const provenanceB = createProjectReleaseProvenance({
    release: releaseB,
    project: projectB,
    sourceFrontiers: {'deps-b': 3, 'dev-b': 9},
  });
  assert.notDeepEqual(provenanceB.memberSources, provenanceA.memberSources);
  assert.equal(provenanceB.releaseId, provenanceA.releaseId);

  assert.throws(
    () => createProjectReleaseProvenance({
      release,
      project: projectA,
      sourceFrontiers: {'dev-a': 7},
    }),
    /does not cover member source image: deps-a/,
  );
});

test('installation maps release member keys to target-Image refs without changing release identity', () => {
  const project = projectFixture();
  const profile = createDeploymentProfile({project, profileId: 'runtime', members: ['model/customer', 'service/api']});
  const release = createProjectReleaseManifest({
    project,
    profile,
    materializations: {
      'model/customer': {representation: 'schema/v1', contentIdentity: 'sha256:model'},
      'service/api': {representation: 'wasm-component/v1', contentIdentity: 'sha256:api'},
    },
  });
  const installation = createProjectInstallation({
    release,
    targetImageId: 'production',
    targets: {
      'service/api': objectRef('production', 'api-91'),
      'model/customer': objectRef('production', 'model-32'),
    },
  });
  assert.equal(installation.releaseId, release.releaseId);
  assert.deepEqual(installation.members.map(({key}) => key), ['model/customer', 'service/api']);
  assert.deepEqual(installation.members.map(({target}) => target.imageId), ['production', 'production']);

  assert.throws(
    () => createProjectInstallation({
      release,
      targetImageId: 'production',
      targets: {
        'service/api': objectRef('elsewhere', 'api'),
        'model/customer': objectRef('production', 'model'),
      },
    }),
    /must belong to installation target image production/,
  );
});

test('upgrade planning is three-state reconciliation intent and detach never means delete', () => {
  const project = createProjectDescriptor({
    projectId: 'project:upgrade',
    name: 'Upgrade',
    members: [
      {key: 'alpha', role: 'component', target: objectRef('dev', 'alpha')},
      {key: 'beta', role: 'component', target: objectRef('dev', 'beta')},
      {key: 'gamma', role: 'note', target: objectRef('dev', 'gamma')},
      {key: 'delta', role: 'component', target: objectRef('dev', 'delta')},
    ],
  });
  const v1Profile = createDeploymentProfile({project, profileId: 'runtime', members: ['gamma', 'beta', 'alpha']});
  const v1 = createProjectReleaseManifest({
    project,
    profile: v1Profile,
    materializations: {
      alpha: {representation: 'component/v1', contentIdentity: 'sha256:alpha'},
      beta: {representation: 'component/v1', contentIdentity: 'sha256:beta-v1'},
      gamma: {representation: 'note/v1', contentIdentity: 'sha256:gamma'},
    },
  });
  const installation = createProjectInstallation({
    release: v1,
    targetImageId: 'prod',
    targets: {
      alpha: objectRef('prod', 'alpha-live'),
      beta: objectRef('prod', 'beta-live'),
      gamma: objectRef('prod', 'gamma-live'),
    },
  });

  const v2Profile = createDeploymentProfile({project, profileId: 'runtime', members: ['delta', 'beta', 'alpha']});
  const v2 = createProjectReleaseManifest({
    project,
    profile: v2Profile,
    materializations: {
      delta: {representation: 'component/v1', contentIdentity: 'sha256:delta'},
      beta: {representation: 'component/v1', contentIdentity: 'sha256:beta-v2'},
      alpha: {representation: 'component/v1', contentIdentity: 'sha256:alpha'},
    },
  });

  const plan = planProjectUpgrade({installation, nextRelease: v2});
  assert.equal(plan.fromReleaseId, v1.releaseId);
  assert.equal(plan.toReleaseId, v2.releaseId);
  assert.deepEqual(
    plan.actions.map(({key, kind}) => [key, kind]),
    [
      ['alpha', 'retain'],
      ['beta', 'replace'],
      ['delta', 'install'],
      ['gamma', 'detach'],
    ],
  );
  const detached = plan.actions.find(({kind}) => kind === 'detach');
  assert.deepEqual(detached.target, objectRef('prod', 'gamma-live'));
  assert.equal(Object.hasOwn(detached, 'delete'), false);
  assert.equal(Object.hasOwn(detached, 'destroy'), false);
});
