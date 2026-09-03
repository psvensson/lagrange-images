// The durable mixed-language Project, with a LIVE Cuis VM (Bead lagrange-images-gxa).
//
// test/mixed-language-project.test.js proves the whole path with a real Rust Component and the
// full Cuis materialization, faking only the VM subprocess. This is its real-lane sibling — the
// same durable-Project SHAPE (native Smalltalk entry + Cuis runtime + real Rust Component behind
// one shared interface), but the Cuis lane runs a real OpenSmalltalkVM through the stdio bridge.
// It differs from the faked sibling on purpose: the runtime definition carries a bootable image +
// changes + sources (not a synthetic package member), because a live VM must actually boot. The
// whole Project is captured, managed-installed, recovered after a real backend restart, and
// executed from the declared graph.
//
// It skips unless LAGRANGE_OPENSMALLTALK_INTEGRATION=1; the pinned VM + Cuis assets come from
// scripts/integration-setup.sh via scripts/integration-env.sh, and it runs in the
// opensmalltalk-cuis-integration CI lane through `npm run test:integration`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_RUNTIME_DEFINITION_CONTRACT_V0,
  CUIS_RUNTIME_DEFINITION_V1,
  CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  WASM_COMPONENT_V1,
  addProjectMember,
  bytesValue,
  captureCurrentGraphProjectRelease,
  createArtifactBackedOpenSmalltalkCuisProvider,
  createDeploymentProfile,
  createRuntime,
  createJcoComponentRuntime,
  createProject,
  installCallableInterface,
  installForeignRuntimeBinding,
  installSymmetricSmalltalkBlock,
  installWasmComponentBinding,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {readProjectDescriptor} from '../src/project/working-state.js';
import {invokeText, normalizeSpec} from './support/mixed-language-project.js';
import {installManagedProjectRelease} from '../src/project/managed-installation.js';
import {readManagedProjectInstallation} from '../src/project/installation-state.js';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';
const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const COMPONENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..',
  'fixtures', 'normalize-component', 'normalize.component.wasm',
);

const PROJECT_ID = 'project:mixed-app-real';
const STUDIO = 'studio';
const PROD = 'prod';
const INPUT = '  HÄLLO   Wörld  ';
const EXPECTED = normalizeSpec(INPUT);

// A full runtime over a restartable sqlite backend, wired to a real OpenSmalltalkVM. Everything
// here is composition-root wiring; nothing durable.
async function composeRuntime(filename, {vmPath}) {
  const backend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
  return await createRuntime({
    backend: {instance: backend},
    componentRuntime: createJcoComponentRuntime(),
    foreignRuntimeProviders: [[
      OPENSMALLTALK_CUIS_PROVIDER_ID,
      createArtifactBackedOpenSmalltalkCuisProvider({
        vmPath,
        vmIdentity: VM_IDENTITY,
        startupTimeoutMs: 60_000,
        callTimeoutMs: 20_000,
        stopTimeoutMs: 10_000,
      }),
    ]],
    foreignRuntimeDefinitionBindings: [[CUIS_RUNTIME_DEFINITION_V1, OPENSMALLTALK_CUIS_PROVIDER_ID]],
  });
}

async function authorMixedProject(runtime, {imagePath, changesPath, sourcesPath}) {
  const images = runtime.images;
  await images.createImage({id: STUDIO});
  const put = async (id, representation, content, logicalPath) => await images.putCodeArtifact(STUDIO, {
    id, languageId: 'smalltalk', representation, content, logicalPath,
  });

  const callableInterface = await installCallableInterface({
    images, imageId: STUDIO, interfaceId: 'normalize-interface',
    functionName: 'normalize', parameters: ['string'], result: 'string',
  });
  const interfaceRef = objectRef(STUDIO, callableInterface.id);

  const component = await images.putCodeArtifact(STUDIO, {
    id: 'normalize-component', representation: WASM_COMPONENT_V1,
    content: bytesValue(await readFile(COMPONENT_PATH)), languageId: 'rust',
  });
  const componentLane = await installWasmComponentBinding({
    images, callableInterface: interfaceRef, component: objectRef(STUDIO, component.id),
    bindingId: 'normalize-component-binding', blockId: 'normalize-component-block',
  });

  const image = await put('cuis-image', CUIS_IMAGE_V1, bytesValue(await readFile(imagePath)), 'Cuis7.9-8090.image');
  const changes = await put('cuis-changes', CUIS_CHANGES_V1, bytesValue(await readFile(changesPath)), 'Cuis7.9-8090.changes');
  const sources = await put('cuis-sources', CUIS_SOURCES_V1, bytesValue(await readFile(sourcesPath)), 'Cuis7.8.sources');
  const cuisDefinition = await images.putCodeArtifact(STUDIO, {
    id: 'cuis-runtime', languageId: 'smalltalk', representation: CUIS_RUNTIME_DEFINITION_V1,
    content: textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0),
    dependencies: [
      {role: 'image', artifact: objectRef(STUDIO, image.id)},
      {role: 'changes', artifact: objectRef(STUDIO, changes.id)},
      {role: 'sources', artifact: objectRef(STUDIO, sources.id)},
    ],
  });
  const cuisLane = await installForeignRuntimeBinding({
    images, callableInterface: interfaceRef, runtimeDefinition: objectRef(STUDIO, cuisDefinition.id),
    target: {service: 'text', operation: 'normalize'},
    bindingId: 'normalize-cuis-binding', blockId: 'normalize-cuis-block',
  });

  const environment = await images.putLexicalEnvironment(STUDIO, {
    id: 'mixed-environment',
    bindings: {
      'mixed:cuis': {name: 'cuis', value: objectRef(STUDIO, cuisLane.block.id)},
      'mixed:rust': {name: 'rust', value: objectRef(STUDIO, componentLane.block.id)},
    },
  });
  const entry = await installSymmetricSmalltalkBlock({
    images, compilation: runtime.compilation, imageId: STUDIO, id: 'mixed-entry',
    source: '[ :t | cuis value: (rust value: t) ]',
    captures: {cuis: 'mixed:cuis', rust: 'mixed:rust'},
    environment: objectRef(STUDIO, environment.id),
  });

  await createProject({images, imageId: STUDIO, projectId: PROJECT_ID, name: 'Mixed App (real)'});
  const members = [
    ['app/entry', 'entrypoint', objectRef(STUDIO, entry.block.id)],
    ['app/interface', 'interface', interfaceRef],
    ['rust/normalize', 'callable', objectRef(STUDIO, componentLane.block.id)],
    ['cuis/normalize', 'callable', objectRef(STUDIO, cuisLane.block.id)],
    ['cuis/runtime', 'runtime-definition', objectRef(STUDIO, cuisDefinition.id)],
  ];
  for (const [key, role, target] of members) {
    await addProjectMember({images, imageId: STUDIO, projectId: PROJECT_ID, key, role, target});
  }
  return {memberKeys: members.map(([key]) => key)};
}

test('one durable Project spans native Smalltalk, a live Cuis VM and a real Rust Component through capture, install, restart and fresh-runtime execution', {
  skip: !enabled,
  timeout: 240_000,
}, async () => {
  const vmPath = process.env.LAGRANGE_OPENSMALLTALK_VM_PATH;
  const imagePath = process.env.LAGRANGE_CUIS_IMAGE_PATH;
  const changesPath = process.env.LAGRANGE_CUIS_CHANGES_PATH;
  const sourcesPath = process.env.LAGRANGE_CUIS_SOURCES_PATH;
  for (const [name, value] of Object.entries({vmPath, imagePath, changesPath, sourcesPath})) {
    assert.ok(value, `${name} integration path is required`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-mixed-project-real-'));
  const filename = join(directory, 'image.sqlite');
  let release; let material; let memberKeys;

  try {
    const runtimeA = await composeRuntime(filename, {vmPath});
    try {
      ({memberKeys} = await authorMixedProject(runtimeA, {imagePath, changesPath, sourcesPath}));
      // Works where authored, through a real VM.
      assert.deepEqual(await invokeText(runtimeA, objectRef(STUDIO, 'mixed-entry'), INPUT), textValue(EXPECTED));

      const descriptor = await readProjectDescriptor({images: runtimeA.images, imageId: STUDIO, projectId: PROJECT_ID});
      const profile = createDeploymentProfile({project: descriptor, profileId: 'full', members: memberKeys});
      ({release, material} = await captureCurrentGraphProjectRelease({
        images: runtimeA.images, projectImageId: STUDIO, projectId: PROJECT_ID, profile,
      }));
      await runtimeA.images.createImage({id: PROD});
      const installed = await installManagedProjectRelease({
        images: runtimeA.images, targetImageId: PROD, release, material,
      });
      assert.equal(installed.releaseId, release.releaseId);
    } finally {
      await runtimeA.close();
    }

    // A genuinely fresh runtime + backend over the same durable store.
    const runtimeB = await composeRuntime(filename, {vmPath});
    try {
      const installation = await readManagedProjectInstallation({
        images: runtimeB.images, targetImageId: PROD, projectId: PROJECT_ID,
      });
      assert.ok(installation, 'managed installation must be recoverable after restart');
      assert.deepEqual(installation.members.map(({key}) => key).sort(), [...memberKeys].sort());
      for (const member of installation.members) {
        assert.deepEqual(Object.keys(member).sort(), ['contentIdentity', 'key', 'representation', 'role', 'target']);
        assert.equal(member.target.imageId, PROD);
      }

      // Execute the entry resolved ONLY through the installation descriptor — a live Cuis VM is
      // started from the imported runtime definition, and the imported Cuis image kept its
      // logicalPath (ADR 0079), which is exactly what lets the fresh VM boot.
      const entryTarget = installation.members.find(({key}) => key === 'app/entry').target;
      assert.deepEqual(await invokeText(runtimeB, entryTarget, INPUT), textValue(EXPECTED));
      // A second, different input proves the live lane really ran rather than a cached answer.
      assert.deepEqual(await invokeText(runtimeB, entryTarget, '  Second   INPUT  '), textValue('second input'));
    } finally {
      await runtimeB.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
