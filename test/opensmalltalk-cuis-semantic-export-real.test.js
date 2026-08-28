import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SEMANTIC_EXPORT_V1,
  CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  bytesValue,
  createOpenSmalltalkCuisToolchainProvider,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';
const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_COMMIT = '6bcee3f38ce037c9714b997ccd3b5b3ff62965c8';

// The multi-package cluster (Bead lagrange-images-d57), in dependency-satisfiable order.
const CLUSTER = [
  {fileName: 'ExtendedClipboard.pck.st', env: 'LAGRANGE_CUIS_EXTENDEDCLIPBOARD_PACKAGE_PATH', blob: 'd561a0dcedf37e6bd93c15cb07498c34ce6d3c5f'},
  {fileName: 'FFI.pck.st', env: 'LAGRANGE_CUIS_FFI_PACKAGE_PATH', blob: '76bcc869cb66a602d4658465177913269697118b'},
  {fileName: 'Graphics-Files-Additional.pck.st', env: 'LAGRANGE_CUIS_GRAPHICS_FILES_ADDITIONAL_PACKAGE_PATH', blob: '6cddf265949b90fd58d0fea0498df6a1c3594685'},
  {fileName: 'Alien-Core.pck.st', env: 'LAGRANGE_CUIS_ALIEN_CORE_PACKAGE_PATH', blob: '59a2b4bdaa0f21287e3af3479cc31f6a71957758'},
  {fileName: 'WeakDictionaries.pck.st', env: 'LAGRANGE_CUIS_WEAKDICTIONARIES_PACKAGE_PATH', blob: '773620a6f3c15bb21deca5e9895ecfac881c8b64'},
  {fileName: 'Compression.pck.st', env: 'LAGRANGE_CUIS_COMPRESSION_PACKAGE_PATH', blob: '243d8265b411fc36a72dd101f21a18e7c94b2d87'},
];

async function put(runtime, id, representation, content, {metadata = {}, dependencies = []} = {}) {
  return await runtime.images.putCodeArtifact('build-image', {
    id, languageId: 'smalltalk', representation, content, metadata, dependencies,
  });
}

async function buildCluster(runtime, {stem}) {
  const baseImage = await put(runtime, `bi-${stem}`, CUIS_IMAGE_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)), {metadata: {fileName: 'Cuis7.9-8090.image'}});
  const baseChanges = await put(runtime, `bc-${stem}`, CUIS_CHANGES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)), {metadata: {fileName: 'Cuis7.9-8090.changes'}});
  const baseSources = await put(runtime, `bs-${stem}`, CUIS_SOURCES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)), {metadata: {fileName: 'Cuis7.8.sources'}});
  const deps = [
    {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
    {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
    {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
  ];
  for (const spec of CLUSTER) {
    const pkg = await put(runtime, `p-${stem}-${spec.fileName}`, CUIS_PACKAGE_V1, textValue(await readFile(process.env[spec.env], 'utf8')), {
      metadata: {fileName: spec.fileName, identity: `cuis-package/${spec.fileName.replace(/\.pck\.st$/, '')}/${CUIS_COMMIT}/gitblob:${spec.blob}`},
    });
    deps.push({role: 'package', artifact: objectRef('build-image', pkg.id)});
  }
  const build = await put(runtime, `build-${stem}`, CUIS_BUILD_V1, textValue(CUIS_BUILD_CONTRACT_V0), {});
  await runtime.images.putCodeArtifact('build-image', {
    id: `buildroot-${stem}`, languageId: 'smalltalk', representation: CUIS_BUILD_V1,
    content: textValue(CUIS_BUILD_CONTRACT_V0), metadata: {}, dependencies: deps,
  });
  const result = await runtime.toolchains.run({
    providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
    imageId: 'build-image',
    roots: [objectRef('build-image', `buildroot-${stem}`)],
    target: {representation: CUIS_IMAGE_V1, fileName: `${stem}.image`},
    options: {semanticExport: true},
    outputIds: {image: `${stem}-image`, changes: `${stem}-changes`, 'semantic-export': `${stem}-export`},
  });
  const exportArtifact = await runtime.images.getCodeArtifact('build-image', `${stem}-export`);
  assert.equal(exportArtifact.representation, CUIS_SEMANTIC_EXPORT_V1);
  return {result, exportText: exportArtifact.content.value};
}

test('Cuis semantic export captures package/class/method structure with semantic (not heap) identities', {skip: !enabled, timeout: 600_000}, async () => {
  const toolchainProvider = createOpenSmalltalkCuisToolchainProvider({
    vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 600_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, toolchainProvider]],
  });
  await runtime.images.createImage({id: 'build-image'});
  try {
    const {exportText} = await buildCluster(runtime, {stem: 'ClusterExport'});
    const manifest = JSON.parse(exportText);
    assert.equal(manifest.format, CUIS_SEMANTIC_EXPORT_V1);

    // Structure: every cluster package appears with its requirements.
    const packageByName = new Map(manifest.packages.map((p) => [p.name, p]));
    for (const name of ['ExtendedClipboard', 'FFI', 'Graphics-Files-Additional', 'Alien-Core', 'WeakDictionaries', 'Compression']) {
      assert.ok(packageByName.has(name), `manifest has package ${name}`);
    }
    assert.deepEqual(packageByName.get('FFI').requires, ['Alien-Core', 'WeakDictionaries']);
    assert.deepEqual(packageByName.get('Alien-Core').requires, ['WeakDictionaries']);
    assert.deepEqual(packageByName.get('ExtendedClipboard').requires, ['FFI', 'Graphics-Files-Additional']);
    assert.deepEqual(packageByName.get('Graphics-Files-Additional').requires, ['Compression']);

    // Classes carry semantic identities + superclass refs (base classes -> Cuis-Base).
    for (const cls of manifest.classes) {
      assert.equal(cls.identity, `cuis-class/${cls.package}/${cls.name}`);
    }
    const archive = manifest.classes.find((c) => c.package === 'Compression' && c.name === 'Archive');
    assert.ok(archive, 'Compression defines class Archive');
    assert.equal(archive.superclassName, 'Object');
    assert.equal(archive.superclass, 'cuis-class/Cuis-Base/Object');

    // Extension method: ByteArray>>unzipped is OWNED by Compression but TARGETS base ByteArray.
    // Per ADR 0072 §3 the method carries `class` (a cuis-class identity), not a raw className; the
    // target class name is the identity's last segment.
    const classNameOf = (m) => m.class.slice(m.class.lastIndexOf('/') + 1);
    const unzipped = manifest.methods.find((m) => m.selector === 'unzipped' && classNameOf(m) === 'ByteArray');
    assert.ok(unzipped, 'manifest has ByteArray>>unzipped');
    assert.equal(unzipped.package, 'Compression');
    assert.equal(unzipped.class, 'cuis-class/Cuis-Base/ByteArray');
    assert.equal(unzipped.side, 'instance');
    assert.match(unzipped.source, /GZipReadStream/);

    // Method identity form: cuis-method/<owningPkg>/<targetClassName>/<side>/<selector>, with the
    // target-class name matching the `class` ref's last segment. No HEAP identity leaks: an actual
    // Spur oop is a memory address (`@`+hex, `0x`+hex, or a long bare decimal). Match THOSE — not
    // the substring 'oop', which false-positives on legitimate Alien-Core selectors oopAt:/oopResult:.
    const heapIdentity = /@[0-9a-f]{6,}|\b0x[0-9a-f]+\b|\/\d{7,}\b|\b\d{9,}\b/i;
    for (const m of manifest.methods) {
      assert.equal(m.identity, `cuis-method/${m.package}/${classNameOf(m)}/${m.side}/${m.selector}`);
      assert.ok(!heapIdentity.test(m.identity), `no heap identity in method identity: ${m.identity}`);
    }
    // Sanity: the guard must actually be able to fire (falsification) — feed it a fake oop identity.
    assert.ok(heapIdentity.test('cuis-method/P/C/instance/0x0000abcdef12'), 'guard matches a 0x-address identity');
    assert.ok(heapIdentity.test('cuis-method/P/C/instance/foo@abcdef12'), 'guard matches an @-address identity');
  } finally {
    await runtime.close();
  }
});

test('Cuis semantic export is deterministic: two equivalent builds yield byte-identical exports', {skip: !enabled, timeout: 900_000}, async () => {
  const toolchainProvider = createOpenSmalltalkCuisToolchainProvider({
    vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 900_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, toolchainProvider]],
  });
  await runtime.images.createImage({id: 'build-image'});
  try {
    const first = await buildCluster(runtime, {stem: 'DetA'});
    const second = await buildCluster(runtime, {stem: 'DetB'});
    // NON-VACUITY floor (ADR 0072 falsification): byte-identity is hollow if the export captured
    // nothing, so assert both builds actually exported structure before comparing bytes.
    const manifestA = JSON.parse(first.exportText);
    const manifestB = JSON.parse(second.exportText);
    assert.ok(manifestA.classes.length > 0 && manifestA.methods.length > 0, 'first build exported no classes/methods (determinism would be vacuous)');
    assert.ok(manifestB.classes.length > 0 && manifestB.methods.length > 0, 'second build exported no classes/methods (determinism would be vacuous)');
    assert.equal(second.exportText, first.exportText, 'two equivalent builds must yield byte-identical semantic exports');
  } finally {
    await runtime.close();
  }
});
