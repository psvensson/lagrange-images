// The ADR 0085 M5 vertical, step one (Bead lagrange-images-nfv1.2): represent the complete
// upstream closure of the selected M5 application as a durable Project/release, install it
// into a FRESH image of a restartable backend, and recover it there — with the application
// artifacts carried as ordinary Project members, exactly the way the mixed-language Project
// proof carries its members. What this file does NOT do is the native import itself: the M5.2
// acceptance harness (nfv1.3) installs the release, imports the unmodified application, and
// never-shortened asserts against the recorded oracle. This slice only moves the CLOSURE.
//
// THE FROZEN M5 ACCEPTANCE CONTRACT (bead lagrange-images-nfv1.1) — repeated here because the
// release is the contract's first durable representation:
//
//   application : Life (Conway cellular automaton), the package's own model protocol
//   upstream    : Cuis-Smalltalk/Games @ 52aad9c547fb54ad0e3bbc427aff3f601a75d54c
//   source      : Life/Life.pck.st, git blob f9180bba8cf9e7aa47aedc4699ca5043af93c9b5
//   license     : MIT at that commit
//   fixture     : grid 4@5, placement 2@2, pattern #(#(1 1 1))  (upstream blinker data)
//   behavior    : LifeModel>>nextState, twice: horizontal -> vertical -> horizontal
//   oracle      : recorded in real pinned Cuis 7.9 (bead lagrange-images-nfv1.1); states
//                 |00000|01110|00000|00000| -> |00100|00100|00100|00000| -> (first state)
//
// The pinned Cuis-Smalltalk-Dev tree contains infrastructure, tests, tools and guides but no
// convincing independently authored application, so M5 introduces exactly ONE immutable
// external trust anchor: the Games repository commit above (Life is named by the pinned Cuis
// 7.9 AllPackages manifest; the commit, not the manifest, is the provenance anchor).
//
// WHAT THE RELEASE CONTAINS, and what it deliberately does not. The release carries the
// application SOURCE CLOSURE as two artifacts:
//
//   life/package — the pinned `smalltalk/cuis-package/v1` bytes, `logicalPath: 'Life.pck.st'`,
//                  with the upstream identity recorded in `metadata.identity`;
//   life/export  — the derived `smalltalk/cuis-semantic-export-v2` canonical manifest, with ONE
//                  explicit dependency edge (role 'package') naming that package artifact.
//
// The toolchain machinery (pinned base image/changes/sources, build root, raw toolchain outputs)
// never becomes a Project member: it is derivation machinery for the export stage, and the
// export's provenance is the explicit package dependency edge plus the toolchain identity in
// metadata — refs hidden in the 20 MB build inputs would drag a whole Cuis base image into an
// application release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import './ensure-node-crypto.test-helper.js';
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
import {installManagedProjectRelease} from '../src/project/managed-installation.js';
import {readManagedProjectInstallation} from '../src/project/installation-state.js';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';
const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_COMMIT = '6bcee3f38ce037c9714b997ccd3b5b3ff62965c8';
const CUIS_IMAGE_IDENTITY = `cuis/${CUIS_COMMIT}/Cuis7.9-8090.image/gitblob:523dc5e74b5b550922b56ff2406415c19700ee8e`;
const GAMES_COMMIT = '52aad9c547fb54ad0e3bbc427aff3f601a75d54c';
const CUIS_LIFE_BLOB = 'f9180bba8cf9e7aa47aedc4699ca5043af93c9b5';
const CUIS_LIFE_IDENTITY = `cuis-package/Life/${GAMES_COMMIT}/gitblob:${CUIS_LIFE_BLOB}`;

const STUDIO = 'life-studio';
const PROD = 'life-prod';
const PROJECT_ID = 'life-m5';
const MEMBER_KEYS = ['life/export', 'life/package'];

// The real toolchain derivation ran ONCE, and the canonical manifest facts below were measured
// from its output rather than assumed. Life is structurally the cleanest candidate the hard
// gates found: it declares no requirements, defines exactly four classes, no load-time chunks,
// and every superclass identity it leaves the package with is a Cuis base class — three of the
// four (TextModel via ActiveModel, PluggableButtonMorph, SystemWindow) are GUI-adjacent base
// classes that the M5.2 ACCEPTANCE SCOPE does not import (the model path never touches them);
// which of them ever becomes work is decided one RED at a time by that acceptance, never by
// this list.
const FROZEN_MANIFEST_FACTS = Object.freeze({
  format: CUIS_SEMANTIC_EXPORT_V2,
  packages: [{name: 'Life', requires: []}],
  classes: Object.freeze([
    ['cuis-class/Life/GridCell', 'cuis-class/Cuis-Base/PluggableButtonMorph'],
    ['cuis-class/Life/LifeArray', 'cuis-class/Cuis-Base/Array2D'],
    ['cuis-class/Life/LifeModel', 'cuis-class/Cuis-Base/TextModel'],
    ['cuis-class/Life/LifeView', 'cuis-class/Cuis-Base/SystemWindow'],
  ]),
  methods: 88,
});

function gitBlobIdentity(bytes) {
  return `gitblob:${createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}`;
}

// One real build per test-file run. The build runtime is closed before the text is consumed, so
// everything below the derivation already sits on the native side of the toolchain boundary.
let semanticExportText = null;
async function lifeSemanticExport() {
  if (semanticExportText !== null) return semanticExportText;
  const buildRuntime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, createOpenSmalltalkCuisToolchainProvider({
      vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 900_000,
    })]],
  });
  try {
    await buildRuntime.images.createImage({id: 'build-image'});
    const baseImage = await buildRuntime.images.putCodeArtifact('build-image', {
      id: 'life-bi', languageId: 'smalltalk', representation: CUIS_IMAGE_V1,
      content: bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)),
      logicalPath: 'Cuis7.9-8090.image', metadata: {identity: CUIS_IMAGE_IDENTITY}, dependencies: [],
    });
    const baseChanges = await buildRuntime.images.putCodeArtifact('build-image', {
      id: 'life-bc', languageId: 'smalltalk', representation: CUIS_CHANGES_V1,
      content: bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)),
      logicalPath: 'Cuis7.9-8090.changes', dependencies: [],
    });
    const baseSources = await buildRuntime.images.putCodeArtifact('build-image', {
      id: 'life-bs', languageId: 'smalltalk', representation: CUIS_SOURCES_V1,
      content: bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)),
      logicalPath: 'Cuis7.8.sources', dependencies: [],
    });
    const lifePackage = await buildRuntime.images.putCodeArtifact('build-image', {
      id: 'life-pkg', languageId: 'smalltalk', representation: CUIS_PACKAGE_V1,
      content: textValue((await readFile(process.env.LAGRANGE_CUIS_LIFE_PACKAGE_PATH)).toString('utf8')),
      logicalPath: 'Life.pck.st', metadata: {identity: CUIS_LIFE_IDENTITY}, dependencies: [],
    });
    await buildRuntime.images.putCodeArtifact('build-image', {
      id: 'life-buildroot', languageId: 'smalltalk', representation: CUIS_BUILD_V1,
      content: textValue(CUIS_BUILD_CONTRACT_V0), dependencies: [
        {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
        {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
        {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
        {role: 'package', artifact: objectRef('build-image', lifePackage.id)},
      ],
    });
    await buildRuntime.toolchains.run({
      providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
      imageId: 'build-image',
      roots: [objectRef('build-image', 'life-buildroot')],
      target: {representation: CUIS_IMAGE_V1, fileName: 'LifeProjectRelease.image'},
      options: {semanticExport: CUIS_SEMANTIC_EXPORT_V2},
      outputIds: {image: 'life-derived-image', changes: 'life-derived-changes', 'semantic-export': 'life-derived-export'},
    });
    const artifact = await buildRuntime.images.getCodeArtifact('build-image', 'life-derived-export');
    assert.equal(artifact.representation, CUIS_SEMANTIC_EXPORT_V2);
    semanticExportText = artifact.content.value;
    return semanticExportText;
  } finally {
    // The toolchain process has already exited; closing its owning runtime makes the cut explicit.
    await buildRuntime.close();
  }
}

function assertMeasuredManifest(text) {
  const manifest = JSON.parse(text);
  assert.equal(manifest.format, FROZEN_MANIFEST_FACTS.format);
  assert.deepEqual(manifest.packages, FROZEN_MANIFEST_FACTS.packages, 'Life declares nothing beyond the base image');
  assert.deepEqual(
    manifest.classes.map(({identity, superclass}) => [identity, superclass]),
    FROZEN_MANIFEST_FACTS.classes,
    'exactly the four Life classes, with their true base-class superclasses visible (recorded foreign boundaries, never repaired here)',
  );
  assert.equal(manifest.classes.length, 4);
  assert.equal(manifest.methods.length, FROZEN_MANIFEST_FACTS.methods);
  for (const method of manifest.methods) {
    assert.ok(method.class.startsWith('cuis-class/Life/'), 'every method belongs to the application itself');
  }
  return manifest;
}

async function withSqliteBackend(body) {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-life-release-'));
  const filename = join(directory, 'image.sqlite');
  try {
    return await body(filename);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

// Runtime A derives the export AND authors the release, so it carries the real toolchain
// provider. Runtime B is composed WITHOUT any toolchain or foreign-runtime provider at all: the
// install/execute lane of the applied release must have no Cuis participant to even configure.
test('the pinned Life application closure travels as a Project/release into a fresh image and wakes up there intact', {skip: !enabled, timeout: 900_000}, async () => {
  await withSqliteBackend(async (filename) => {
    const packageBytes = await readFile(process.env.LAGRANGE_CUIS_LIFE_PACKAGE_PATH);
    // The pin is re-asserted from the bytes this file actually reads, not trusted from setup.
    assert.equal(`cuis-package/Life/${GAMES_COMMIT}/${gitBlobIdentity(packageBytes)}`, CUIS_LIFE_IDENTITY,
      'the exact pinned Games@52aad9c5 Life bytes, before anything ships');
    const exportText = await lifeSemanticExport();
    assertMeasuredManifest(exportText);

    // --- Author the release as an ordinary Project over ordinary artifacts.
    let release;
    let material;
    let provenance;
    const backend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    const runtimeA = await createRuntime({
      backend: {instance: backend},
      toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, createOpenSmalltalkCuisToolchainProvider({
        vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 900_000,
      })]],
    });
    try {
      const images = runtimeA.images;
      await images.createImage({id: STUDIO});
      const packageArtifact = await images.putCodeArtifact(STUDIO, {
        id: 'life-pkg', languageId: 'smalltalk', representation: CUIS_PACKAGE_V1,
        content: textValue(packageBytes.toString('utf8')),
        logicalPath: 'Life.pck.st', metadata: {identity: CUIS_LIFE_IDENTITY}, dependencies: [],
      });
      // The canonical export of that package, with its one truthful dependency edge. Retrieving
      // the same manifest text the real toolchain produced keeps the release DETERMINISTIC to
      // the measured derivation without re-running a Cuis image to materialize it; nfv1.3 restores the full
      // oracle discipline by re-deriving before the native import when the acceptance runs.
      const exportArtifact = await images.putCodeArtifact(STUDIO, {
        id: 'life-export', languageId: 'smalltalk', representation: CUIS_SEMANTIC_EXPORT_V2,
        content: textValue(exportText),
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
      assert.deepEqual(descriptor.members.map(({key}) => key), [...MEMBER_KEYS].sort());
      const profile = createDeploymentProfile({project: descriptor, profileId: 'full', members: MEMBER_KEYS});
      ({release, material, provenance} = await captureCurrentGraphProjectRelease({
        images, projectImageId: STUDIO, projectId: PROJECT_ID, profile,
      }));
      assert.equal(release.projectId, PROJECT_ID);
      assert.deepEqual(release.members.map(({key}) => key), [...MEMBER_KEYS].sort());
      assert.deepEqual(Object.keys(provenance.sourceFrontiers), [STUDIO]);

      // Install into a FRESH image: the only M5.2 starting point later, already proven here.
      await images.createImage({id: PROD});
      const installed = await installManagedProjectRelease({images, targetImageId: PROD, release, material});
      assert.equal(installed.releaseId, release.releaseId);
    } finally {
      await runtimeA.close();
    }

    // --- Restart. Nothing survives from runtime A except the sqlite file.
    const runtimeB = await createRuntime({backend: {instance: new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)})}});
    try {
      assert.deepEqual(runtimeB.toolchainProviders.list(), [], 'the recovering runtime has no toolchain providers configured');
      const installation = await readManagedProjectInstallation({images: runtimeB.images, targetImageId: PROD, projectId: PROJECT_ID});
      assert.ok(installation, 'the managed installation must be recoverable after restart');
      assert.equal(installation.releaseId, release.releaseId);
      assert.deepEqual(installation.members.map(({key}) => key), [...MEMBER_KEYS].sort());
      for (const member of installation.members) {
        assert.deepEqual(Object.keys(member).sort(), ['contentIdentity', 'key', 'representation', 'role', 'target']);
        assert.equal(member.target.imageId, PROD);
      }

      const byKey = new Map(installation.members.map((member) => [member.key, member]));
      const packageTarget = byKey.get('life/package').target;
      const installedPackage = await runtimeB.images.getCodeArtifact(PROD, packageTarget.objectId);
      assert.equal(installedPackage.representation, CUIS_PACKAGE_V1);
      assert.equal(installedPackage.logicalPath, 'Life.pck.st');
      // metadata is deliberately non-portable (ADR 0074): upstream identity provenance lives in
      // the studio record; what survives a portable release is the content itself, whose blob
      // hash is the durable upstream identity.
      assert.notEqual(installedPackage.metadata?.identity, CUIS_LIFE_IDENTITY,
        'metadata must not be relied on to cross a portable release');

      assert.equal(installedPackage.content.value, packageBytes.toString('utf8'),
        'the application source arrives as the exact pinned upstream bytes');
      assert.equal(gitBlobIdentity(Buffer.from(installedPackage.content.value, 'utf8')), `gitblob:${CUIS_LIFE_BLOB}`);

      const exportTarget = byKey.get('life/export').target;
      const installedExport = await runtimeB.images.getCodeArtifact(PROD, exportTarget.objectId);
      assert.equal(installedExport.representation, CUIS_SEMANTIC_EXPORT_V2);
      assertMeasuredManifest(installedExport.content.value);
      assert.deepEqual(installedExport.dependencies, [{role: 'package', artifact: packageTarget}],
        'the export still names exactly its package, now translated to the target image');

      // Hygiene: the derivation machinery never entered the application release.
      const prodRecords = await runtimeB.images.listRecords(PROD);
      assert.ok(!prodRecords.some(({representation}) => representation === CUIS_IMAGE_V1 || representation === CUIS_BUILD_V1 || representation === CUIS_CHANGES_V1 || representation === CUIS_SOURCES_V1),
        'a Cuis base image or build contract must never ride along in an application release');

      // Same release, replayed: recovery, not duplication (the managed contract's second outcome).
      const replay = await installManagedProjectRelease({images: runtimeB.images, targetImageId: PROD, release, material});
      assert.deepEqual(replay, installation);
    } finally {
      await runtimeB.close();
    }
  });
});
