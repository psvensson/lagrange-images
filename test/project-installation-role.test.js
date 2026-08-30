import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeploymentProfile,
  createProjectDescriptor,
  createProjectInstallation,
  createProjectReleaseManifest,
  planProjectUpgrade,
} from '../src/project/index.js';
import {objectRef} from '../src/value/index.js';

function releaseFor(role) {
  const project = createProjectDescriptor({
    projectId: 'project:role-change',
    name: 'Role change',
    members: [{key: 'worker', role, target: objectRef('dev', 'worker')}],
  });
  const profile = createDeploymentProfile({project, profileId: 'runtime', members: ['worker']});
  return createProjectReleaseManifest({
    project,
    profile,
    materializations: {
      worker: {representation: 'wasm-component/v1', contentIdentity: 'sha256:same-bytes'},
    },
  });
}

test('Project installation preserves release role and role change is not silently retained', () => {
  const v1 = releaseFor('test');
  const installation = createProjectInstallation({
    release: v1,
    targetImageId: 'prod',
    targets: {worker: objectRef('prod', 'worker-live')},
  });
  assert.equal(installation.members[0].role, 'test');

  const v2 = releaseFor('runtime-component');
  const plan = planProjectUpgrade({installation, nextRelease: v2});
  assert.deepEqual(plan.actions.map(({key, kind}) => [key, kind]), [['worker', 'replace']]);
  assert.equal(plan.actions[0].installed.role, 'test');
  assert.equal(plan.actions[0].desired.role, 'runtime-component');
});
