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
  objectRef,
  textValue,
} from '../src/runtime.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';
const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_JSON_IDENTITY = 'cuis-package/JSON/6bcee3f38ce037c9714b997ccd3b5b3ff62965c8/gitblob:47fab65d0d9017d706aa07d39ab0451619488ccd';

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

test('real Cuis toolchain derives an artifact-backed runnable image containing an upstream package', {skip: !enabled, timeout: 120_000}, async () => {
  const vmPath = process.env.LAGRANGE_OPENSMALLTALK_VM_PATH;
  const imagePath = process.env.LAGRANGE_CUIS_IMAGE_PATH;
  const changesPath = process.env.LAGRANGE_CUIS_CHANGES_PATH;
  const sourcesPath = process.env.LAGRANGE_CUIS_SOURCES_PATH;
  const jsonPackagePath = process.env.LAGRANGE_CUIS_JSON_PACKAGE_PATH;
  for (const [name, value] of Object.entries({vmPath, imagePath, changesPath, sourcesPath, jsonPackagePath})) {
    assert.ok(value, `${name} integration path is required`);
  }

  const toolchainProvider = createOpenSmalltalkCuisToolchainProvider({
    vmPath,
    vmIdentity: VM_IDENTITY,
    timeoutMs: 60_000,
  });
  const runtimeProvider = createArtifactBackedOpenSmalltalkCuisProvider({
    vmPath,
    vmIdentity: VM_IDENTITY,
    startupTimeoutMs: 30_000,
    callTimeoutMs: 10_000,
    stopTimeoutMs: 10_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, toolchainProvider]],
    foreignRuntimeProviders: [[OPENSMALLTALK_CUIS_PROVIDER_ID, runtimeProvider]],
  });
  await runtime.images.createImage({id: 'build-image'});
  try {
    const baseImage = await put(runtime, 'cuis-base-image', CUIS_IMAGE_V1, bytesValue(await readFile(imagePath)), {
      metadata: {fileName: 'Cuis7.9-8090.image'},
    });
    const baseChanges = await put(runtime, 'cuis-base-changes', CUIS_CHANGES_V1, bytesValue(await readFile(changesPath)), {
      metadata: {fileName: 'Cuis7.9-8090.changes'},
    });
    const baseSources = await put(runtime, 'cuis-base-sources', CUIS_SOURCES_V1, bytesValue(await readFile(sourcesPath)), {
      metadata: {fileName: 'Cuis7.8.sources'},
    });
    const jsonPackage = await put(runtime, 'cuis-json-package', CUIS_PACKAGE_V1, textValue(await readFile(jsonPackagePath, 'utf8')), {
      metadata: {fileName: 'JSON.pck.st', identity: CUIS_JSON_IDENTITY},
    });
    const build = await put(runtime, 'cuis-json-build', CUIS_BUILD_V1, textValue(CUIS_BUILD_CONTRACT_V0), {
      dependencies: [
        {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
        {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
        {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
        {role: 'package', artifact: objectRef('build-image', jsonPackage.id)},
      ],
    });

    const result = await runtime.toolchains.run({
      providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
      imageId: 'build-image',
      roots: [objectRef('build-image', build.id)],
      target: {representation: CUIS_IMAGE_V1, fileName: 'LagrangeDerived.image'},
      options: {},
      outputIds: {image: 'derived-cuis-image', changes: 'derived-cuis-changes'},
    });
    assert.equal(result.reused, false);
    assert.equal(result.derivationKey, null);
    assert.deepEqual(result.outputs.map(({name}) => name), ['image', 'changes']);

    const derivedImage = await runtime.images.getCodeArtifact('build-image', 'derived-cuis-image');
    const derivedChanges = await runtime.images.getCodeArtifact('build-image', 'derived-cuis-changes');
    assert.equal(derivedImage.representation, CUIS_IMAGE_V1);
    assert.equal(derivedChanges.representation, CUIS_CHANGES_V1);
    assert.deepEqual(derivedImage.metadata.packageArtifactIds, [jsonPackage.id]);
    assert.deepEqual(derivedImage.metadata.packageFileNames, ['JSON.pck.st']);
    assert.equal(derivedImage.metadata.sourcesFileName, 'Cuis7.8.sources');
    assert.deepEqual(derivedImage.dependencies, [{role: 'sources', artifact: objectRef('build-image', baseSources.id)}]);

    const runtimeDefinition = await put(
      runtime,
      'derived-cuis-runtime',
      CUIS_RUNTIME_DEFINITION_V1,
      textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0),
      {
        dependencies: [
          {role: 'image', artifact: objectRef('build-image', derivedImage.id)},
          {role: 'changes', artifact: objectRef('build-image', derivedChanges.id)},
          {role: 'sources', artifact: objectRef('build-image', baseSources.id)},
        ],
      },
    );

    const instance = await runtime.foreignRuntimeDefinitions.start({
      providerId: OPENSMALLTALK_CUIS_PROVIDER_ID,
      definition: objectRef('build-image', runtimeDefinition.id),
    });
    assert.deepEqual(instance.metadata.definition, objectRef('build-image', runtimeDefinition.id));
    assert.deepEqual(instance.metadata.imageArtifact, objectRef('build-image', derivedImage.id));
    assert.deepEqual(instance.metadata.changesArtifact, objectRef('build-image', derivedChanges.id));
    assert.deepEqual(instance.metadata.sourcesArtifact, objectRef('build-image', baseSources.id));
    assert.deepEqual(instance.metadata.packages, []);

    const packageProof = await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'json', operation: 'package-proof'},
      arguments: [],
    });
    assert.deepEqual(packageProof, booleanValue(true));
    await runtime.foreignRuntimes.stop(instance.runtimeId);
  } finally {
    await runtime.close();
  }
});
