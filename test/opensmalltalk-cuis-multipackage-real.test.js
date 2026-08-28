import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_RUNTIME_DEFINITION_CONTRACT_V0,
  CUIS_RUNTIME_DEFINITION_V1,
  CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  booleanValue,
  bytesValue,
  createArtifactBackedOpenSmalltalkCuisProvider,
  createOpenSmalltalkCuisToolchainProvider,
  createRuntime,
  installForeignRuntimeCallable,
  objectRef,
  textValue,
} from '../src/runtime.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';
const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_COMMIT = '6bcee3f38ce037c9714b997ccd3b5b3ff62965c8';

// The real upstream multi-package DAG (Bead lagrange-images-d57), pinned by Git blob:
//   ExtendedClipboard -> FFI + Graphics-Files-Additional
//   FFI               -> WeakDictionaries + Alien-Core
//   Alien-Core        -> WeakDictionaries            (diamond on WeakDictionaries)
//   Graphics-Files-Additional -> Compression
//   WeakDictionaries, Compression -> (base)
// The behavior proof exercises Compression (pure-Smalltalk gzip) and WeakDictionaries —
// both headless-safe. FFI / Alien-Core / ExtendedClipboard are installed (exercising the
// full dependency-resolution DAG) but not CALLED (their behavior binds native libraries,
// which a headless VM does not provide).
const CLUSTER = [
  {key: 'EXTENDEDCLIPBOARD', fileName: 'ExtendedClipboard.pck.st', env: 'LAGRANGE_CUIS_EXTENDEDCLIPBOARD_PACKAGE_PATH', blob: 'd561a0dcedf37e6bd93c15cb07498c34ce6d3c5f'},
  {key: 'FFI', fileName: 'FFI.pck.st', env: 'LAGRANGE_CUIS_FFI_PACKAGE_PATH', blob: '76bcc869cb66a602d4658465177913269697118b'},
  {key: 'GRAPHICS', fileName: 'Graphics-Files-Additional.pck.st', env: 'LAGRANGE_CUIS_GRAPHICS_FILES_ADDITIONAL_PACKAGE_PATH', blob: '6cddf265949b90fd58d0fea0498df6a1c3594685'},
  {key: 'ALIEN', fileName: 'Alien-Core.pck.st', env: 'LAGRANGE_CUIS_ALIEN_CORE_PACKAGE_PATH', blob: '59a2b4bdaa0f21287e3af3479cc31f6a71957758'},
  {key: 'WEAK', fileName: 'WeakDictionaries.pck.st', env: 'LAGRANGE_CUIS_WEAKDICTIONARIES_PACKAGE_PATH', blob: '773620a6f3c15bb21deca5e9895ecfac881c8b64'},
  {key: 'COMPRESSION', fileName: 'Compression.pck.st', env: 'LAGRANGE_CUIS_COMPRESSION_PACKAGE_PATH', blob: '243d8265b411fc36a72dd101f21a18e7c94b2d87'},
];

async function put(runtime, id, representation, content, {metadata = {}, dependencies = []} = {}) {
  return await runtime.images.putCodeArtifact('build-image', {
    id,
    languageId: 'smalltalk',
    representation,
    content,
    metadata,
    dependencies,
  });
}

async function makeProviders() {
  const vmPath = process.env.LAGRANGE_OPENSMALLTALK_VM_PATH;
  const toolchainProvider = createOpenSmalltalkCuisToolchainProvider({vmPath, vmIdentity: VM_IDENTITY, timeoutMs: 120_000});
  const runtimeProvider = createArtifactBackedOpenSmalltalkCuisProvider({
    vmPath,
    vmIdentity: VM_IDENTITY,
    startupTimeoutMs: 60_000,
    callTimeoutMs: 20_000,
    stopTimeoutMs: 10_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, toolchainProvider]],
    foreignRuntimeProviders: [[OPENSMALLTALK_CUIS_PROVIDER_ID, runtimeProvider]],
    foreignRuntimeDefinitionBindings: [[CUIS_RUNTIME_DEFINITION_V1, OPENSMALLTALK_CUIS_PROVIDER_ID]],
  });
  await runtime.images.createImage({id: 'build-image'});
  return runtime;
}

async function putBase(runtime) {
  const baseImage = await put(runtime, 'cuis-base-image', CUIS_IMAGE_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)), {
    metadata: {fileName: 'Cuis7.9-8090.image'},
  });
  const baseChanges = await put(runtime, 'cuis-base-changes', CUIS_CHANGES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)), {
    metadata: {fileName: 'Cuis7.9-8090.changes'},
  });
  const baseSources = await put(runtime, 'cuis-base-sources', CUIS_SOURCES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)), {
    metadata: {fileName: 'Cuis7.8.sources'},
  });
  return {baseImage, baseChanges, baseSources};
}

async function putPackage(runtime, spec) {
  const path = process.env[spec.env];
  assert.ok(path, `${spec.env} integration path is required`);
  return await put(runtime, `cuis-package-${spec.fileName}`, CUIS_PACKAGE_V1, textValue(await readFile(path, 'utf8')), {
    metadata: {fileName: spec.fileName, identity: `cuis-package/${spec.fileName.replace(/\.pck\.st$/, '')}/${CUIS_COMMIT}/gitblob:${spec.blob}`},
  });
}

test('multi-package Cuis cluster builds a derived image whose fresh runtime performs cross-package behavior', {skip: !enabled, timeout: 300_000}, async () => {
  const runtime = await makeProviders();
  try {
    const {baseImage, baseChanges, baseSources} = await putBase(runtime);
    // Declare every cluster package. They are declared in ANTI-dependency order (a
    // dependent before its requirements) to prove Cuis — not the caller's listing order —
    // resolves the transitive !requires: closure. The build must still succeed.
    const packages = [];
    for (const spec of CLUSTER) packages.push(await putPackage(runtime, spec));

    const build = await put(runtime, 'cuis-cluster-build', CUIS_BUILD_V1, textValue(CUIS_BUILD_CONTRACT_V0), {
      dependencies: [
        {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
        {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
        {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
        ...packages.map((pkg) => ({role: 'package', artifact: objectRef('build-image', pkg.id)})),
      ],
    });

    const result = await runtime.toolchains.run({
      providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
      imageId: 'build-image',
      roots: [objectRef('build-image', build.id)],
      target: {representation: CUIS_IMAGE_V1, fileName: 'LagrangeClusterDerived.image'},
      options: {},
      outputIds: {image: 'derived-cluster-image', changes: 'derived-cluster-changes'},
    });
    assert.equal(result.reused, false);

    const derivedImage = await runtime.images.getCodeArtifact('build-image', 'derived-cluster-image');
    const derivedChanges = await runtime.images.getCodeArtifact('build-image', 'derived-cluster-changes');
    // The derived image records every declared package (in declared order) for provenance.
    assert.deepEqual(derivedImage.metadata.packageFileNames, CLUSTER.map((spec) => spec.fileName));
    assert.deepEqual(derivedImage.metadata.packageArtifactIds, packages.map((pkg) => pkg.id));

    const runtimeDefinition = await put(runtime, 'derived-cluster-runtime', CUIS_RUNTIME_DEFINITION_V1, textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0), {
      dependencies: [
        {role: 'image', artifact: objectRef('build-image', derivedImage.id)},
        {role: 'changes', artifact: objectRef('build-image', derivedChanges.id)},
        {role: 'sources', artifact: objectRef('build-image', baseSources.id)},
      ],
    });

    const {block: clusterBlock} = await installForeignRuntimeCallable({
      images: runtime.images,
      runtimeDefinition: objectRef('build-image', runtimeDefinition.id),
      interface: {service: 'cluster', operation: 'package-proof'},
      argumentCount: 0,
      interfaceId: 'cuis-cluster-package-proof-interface',
      blockId: 'cuis-cluster-package-proof-block',
    });

    // Launch the derived image FRESH, with NO runtime package injection, and require the
    // cross-package behavior to succeed.
    const activation = await runtime.invocations.invokeBlock(objectRef('build-image', clusterBlock.id), []);
    assert.deepEqual(await runtime.executor.execute(activation), booleanValue(true));
    const [instance] = runtime.foreignRuntimes.list();
    assert.deepEqual(instance.metadata.packages, []);
  } finally {
    await runtime.close();
  }
});

test('multi-package build with a missing dependency FAILS (failure diagnostics, not a false-success build)', {skip: !enabled, timeout: 300_000}, async () => {
  const runtime = await makeProviders();
  try {
    const {baseImage, baseChanges, baseSources} = await putBase(runtime);
    // Falsification (Bead lagrange-images-d57): a build whose dependency cannot be satisfied
    // MUST fail with real diagnostics — never a falsely-successful image. The requirement is a
    // SYNTHETIC package whose !requires: names a feature that is guaranteed ABSENT everywhere
    // (the base image does not provide it and no declared package does). This is deterministic:
    // an earlier version omitted the real WeakDictionaries package, but Cuis's FeatureRequirement
    // can satisfy a named feature from the base image's own package cache / search path on a cold
    // boot, so "omit WeakDictionaries" was not a reliable unsatisfiable (cold-runner flake). A
    // provably-absent feature name removes that guest-side non-determinism at the source.
    const ABSENT_FEATURE = 'Lagrange-Provably-Absent-Feature-9f3a7c';
    const synthetic = await put(runtime, 'cuis-package-lagrange-unsatisfiable', CUIS_PACKAGE_V1, textValue(
      `'From Cuis7.9 [latest update: #8062] on 28 August 2026 at 12:00:00 pm'!\n` +
      `'Description Synthetic package whose requirement can never be satisfied (falsification fixture).'!\n` +
      `!provides: 'Lagrange-Unsatisfiable' 1 0!\n` +
      `!requires: '${ABSENT_FEATURE}' 1 0 nil!\n`,
    ), {
      metadata: {fileName: 'LagrangeUnsatisfiable.pck.st'},
    });

    const build = await put(runtime, 'cuis-cluster-build-missing', CUIS_BUILD_V1, textValue(CUIS_BUILD_CONTRACT_V0), {
      dependencies: [
        {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
        {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
        {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
        {role: 'package', artifact: objectRef('build-image', synthetic.id)},
      ],
    });

    await assert.rejects(
      runtime.toolchains.run({
        providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
        imageId: 'build-image',
        roots: [objectRef('build-image', build.id)],
        target: {representation: CUIS_IMAGE_V1, fileName: 'LagrangeClusterMissing.image'},
        options: {},
        outputIds: {image: 'derived-missing-image', changes: 'derived-missing-changes'},
      }),
      (error) => {
        assert.equal(error.name, 'OpenSmalltalkToolchainRunError');
        // The failure diagnostic must be the real TAB-delimited BUILD...FAILED field naming the
        // unsatisfiable feature — a genuinely failed build, not a silent broken image or a
        // wrong-reason error. Require BOTH the FAILED marker AND the absent feature name.
        const diag = `${error.stdout}\n${error.stderr}\n${error.message}`;
        assert.match(diag, /FAILED/i);
        assert.match(diag, new RegExp(ABSENT_FEATURE.replace(/[-]/g, '\\$&'), 'i'));
        return true;
      },
    );
  } finally {
    await runtime.close();
  }
});
