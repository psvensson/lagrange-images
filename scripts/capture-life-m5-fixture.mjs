// One-time authoring of the committed M5 Life release fixture (bead lagrange-images-nfv1.3).
//
// This is the ONLY place the M5 acceptance touches the capture boundary. The witness test
// (test/cuis-life-m5-acceptance.test.js) never runs this script and never sees the toolchain:
// it installs the committed fixture into a fresh image of a fresh backend and proceeds natively.
// Run with the integration environment (source scripts/integration-env.sh):
//
//   node scripts/capture-life-m5-fixture.mjs
//
// The fixture is regenerated ONLY when the sealed M5 selection or packages change — never at
// witness time. The authoring run re-asserts the frozen contract pins (bead
// lagrange-images-nfv1.1) before writing anything.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SEMANTIC_EXPORT_V2,
  CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  addProjectMember,
  bytesValue,
  captureCurrentGraphProjectRelease,
  createDeploymentProfile,
  createOpenSmalltalkCuisToolchainProvider,
  createProject,
  createRuntime,
  objectRef,
  readProjectDescriptor,
  textValue,
} from '../src/runtime.js';

const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_COMMIT = '6bcee3f38ce037c9714b997ccd3b5b3ff62965c8';
const CUIS_IMAGE_IDENTITY = `cuis/${CUIS_COMMIT}/Cuis7.9-8090.image/gitblob:523dc5e74b5b550922b56ff2406415c19700ee8e`;
const GAMES_COMMIT = '52aad9c547fb54ad0e3bbc427aff3f601a75d54c';
const CUIS_LIFE_BLOB = 'f9180bba8cf9e7aa47aedc4699ca5043af93c9b5';
const CUIS_LIFE_IDENTITY = `cuis-package/Life/${GAMES_COMMIT}/gitblob:${CUIS_LIFE_BLOB}`;
const STUDIO = 'life-studio';
const PROJECT_ID = 'life-m5';

function gitBlobIdentity(bytes) {
  return `gitblob:${createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}`;
}

const packageBytes = await readFile(process.env.LAGRANGE_CUIS_LIFE_PACKAGE_PATH);
if (`cuis-package/Life/${GAMES_COMMIT}/${gitBlobIdentity(packageBytes)}` !== CUIS_LIFE_IDENTITY) {
  throw new Error('the pinned Life bytes must be the sealed M5 selection before capture');
}

const runtime = await createRuntime({
  backend: {mode: 'mock'},
  toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, createOpenSmalltalkCuisToolchainProvider({
    vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 900_000,
  })]],
});
try {
  const images = runtime.images;
  await images.createImage({id: STUDIO});

  // Toolchain derivation machinery, in the studio image but OUTSIDE the Project (nfv1.2).
  const baseImage = await images.putCodeArtifact(STUDIO, {
    id: 'life-bi', languageId: 'smalltalk', representation: CUIS_IMAGE_V1,
    content: bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)),
    logicalPath: 'Cuis7.9-8090.image', metadata: {identity: CUIS_IMAGE_IDENTITY}, dependencies: [],
  });
  const baseChanges = await images.putCodeArtifact(STUDIO, {
    id: 'life-bc', languageId: 'smalltalk', representation: CUIS_CHANGES_V1,
    content: bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)),
    logicalPath: 'Cuis7.9-8090.changes', dependencies: [],
  });
  const baseSources = await images.putCodeArtifact(STUDIO, {
    id: 'life-bs', languageId: 'smalltalk', representation: CUIS_SOURCES_V1,
    content: bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)),
    logicalPath: 'Cuis7.8.sources', dependencies: [],
  });
  const lifePackage = await images.putCodeArtifact(STUDIO, {
    id: 'life-pkg-src', languageId: 'smalltalk', representation: CUIS_PACKAGE_V1,
    content: textValue(packageBytes.toString('utf8')),
    logicalPath: 'Life.pck.st', metadata: {identity: CUIS_LIFE_IDENTITY}, dependencies: [],
  });
  await images.putCodeArtifact(STUDIO, {
    id: 'life-buildroot', languageId: 'smalltalk', representation: CUIS_BUILD_V1,
    content: textValue(CUIS_BUILD_CONTRACT_V0), dependencies: [
      {role: 'base-image', artifact: objectRef(STUDIO, baseImage.id)},
      {role: 'base-changes', artifact: objectRef(STUDIO, baseChanges.id)},
      {role: 'base-sources', artifact: objectRef(STUDIO, baseSources.id)},
      {role: 'package', artifact: objectRef(STUDIO, lifePackage.id)},
    ],
  });
  await runtime.toolchains.run({
    providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
    imageId: STUDIO,
    roots: [objectRef(STUDIO, 'life-buildroot')],
    target: {representation: CUIS_IMAGE_V1, fileName: 'LifeProjectRelease.image'},
    options: {semanticExport: CUIS_SEMANTIC_EXPORT_V2},
    outputIds: {image: 'life-derived-image', changes: 'life-derived-changes', 'semantic-export': 'life-derived-export'},
  });
  const derivedExport = await images.getCodeArtifact(STUDIO, 'life-derived-export');
  if (derivedExport.representation !== CUIS_SEMANTIC_EXPORT_V2) throw new Error('toolchain export is not a canonical v2 manifest');
  if (JSON.parse(derivedExport.content.value).methods.length !== 88) throw new Error('the measured Life manifest changed');

  // The release members (nfv1.2 shape, re-declared here so this script owns the fixture): the
  // package artifact and the derived export with ONE truthful dependency edge.
  const packageArtifact = await images.putCodeArtifact(STUDIO, {
    id: 'life-pkg', languageId: 'smalltalk', representation: CUIS_PACKAGE_V1,
    content: textValue(packageBytes.toString('utf8')),
    logicalPath: 'Life.pck.st', metadata: {identity: CUIS_LIFE_IDENTITY}, dependencies: [],
  });
  const exportArtifact = await images.putCodeArtifact(STUDIO, {
    id: 'life-export', languageId: 'smalltalk', representation: CUIS_SEMANTIC_EXPORT_V2,
    content: textValue(derivedExport.content.value),
    metadata: {identity: CUIS_LIFE_IDENTITY, derivedBy: `${OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID}@${VM_IDENTITY}`},
    dependencies: [{role: 'package', artifact: objectRef(STUDIO, packageArtifact.id)}],
  });
  await createProject({images, imageId: STUDIO, projectId: PROJECT_ID, name: 'M5 Life'});
  for (const [key, role, target] of [
    ['life/package', 'package', objectRef(STUDIO, packageArtifact.id)],
    ['life/export', 'semantic-export', objectRef(STUDIO, exportArtifact.id)],
  ]) {
    await addProjectMember({images, imageId: STUDIO, projectId: PROJECT_ID, key, role, target});
  }
  const descriptor = await readProjectDescriptor({images, imageId: STUDIO, projectId: PROJECT_ID});
  const profile = createDeploymentProfile({project: descriptor, profileId: 'full', members: ['life/package', 'life/export']});
  const {release, provenance, material} = await captureCurrentGraphProjectRelease({
    images, projectImageId: STUDIO, projectId: PROJECT_ID, profile,
  });
  const fixture = {
    recorded: {
      upstream: `Cuis-Smalltalk/Games@${GAMES_COMMIT}`,
      packageBlob: CUIS_LIFE_BLOB,
      license: 'MIT at the pinned commit',
      derivedBy: `${OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID}@${VM_IDENTITY}`,
      distribution: `Cuis-Smalltalk/Cuis-Smalltalk-Dev@${CUIS_COMMIT}`,
    },
    release, provenance, material,
  };
  await mkdir(new URL('../test/fixtures/', import.meta.url), {recursive: true});
  await writeFile(new URL('../test/fixtures/life-m5-release.json', import.meta.url), JSON.stringify(fixture, null, 2));
  console.log('WROTE test/fixtures/life-m5-release.json', material.contentIdentity);
} finally {
  await runtime.close();
}
