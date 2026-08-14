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
  WASM_BINARY_V1,
  WASM_RESUMABLE_VALUE_HANDLE_ABI_V1,
  booleanValue,
  bytesValue,
  compileWasmFunctionArtifact,
  createArtifactBackedOpenSmalltalkCuisProvider,
  createOpenSmalltalkCuisToolchainProvider,
  createRuntime,
  installForeignRuntimeCallable,
  installSymmetricSmalltalkBlock,
  installWasmScalarCallable,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';
const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_JSON_IDENTITY = 'cuis-package/JSON/6bcee3f38ce037c9714b997ccd3b5b3ff62965c8/gitblob:47fab65d0d9017d706aa07d39ab0451619488ccd';
const I32_ADD_WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

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

test('real Cuis toolchain participates in a resumable Lagrange-WASM mixed Block program', {skip: !enabled, timeout: 120_000}, async () => {
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
    foreignRuntimeDefinitionBindings: [[CUIS_RUNTIME_DEFINITION_V1, OPENSMALLTALK_CUIS_PROVIDER_ID]],
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

    const {interfaceArtifact: jsonInterface, block: jsonBlock} = await installForeignRuntimeCallable({
      images: runtime.images,
      runtimeDefinition: objectRef('build-image', runtimeDefinition.id),
      interface: {service: 'json', operation: 'package-proof'},
      argumentCount: 0,
      interfaceId: 'cuis-json-package-proof-interface',
      blockId: 'cuis-json-package-proof-block',
    });
    assert.deepEqual(jsonInterface.dependencies, [{
      role: 'runtime-definition',
      artifact: objectRef('build-image', runtimeDefinition.id),
    }]);
    assert.equal(JSON.stringify(jsonInterface).includes(OPENSMALLTALK_CUIS_PROVIDER_ID), false);
    assert.equal(runtime.foreignRuntimes.list().length, 0);

    const jsonActivation = await runtime.invocations.invokeBlock(objectRef('build-image', jsonBlock.id), []);
    assert.deepEqual(await runtime.executor.execute(jsonActivation), booleanValue(true));
    assert.equal(runtime.foreignRuntimes.list().length, 1);
    const [instance] = runtime.foreignRuntimes.list();
    assert.deepEqual(instance.metadata.definition, objectRef('build-image', runtimeDefinition.id));
    assert.deepEqual(instance.metadata.imageArtifact, objectRef('build-image', derivedImage.id));
    assert.deepEqual(instance.metadata.changesArtifact, objectRef('build-image', derivedChanges.id));
    assert.deepEqual(instance.metadata.sourcesArtifact, objectRef('build-image', baseSources.id));
    assert.deepEqual(instance.metadata.packages, []);

    const {block: cuisAddBlock} = await installForeignRuntimeCallable({
      images: runtime.images,
      runtimeDefinition: objectRef('build-image', runtimeDefinition.id),
      interface: {service: 'proof', operation: 'add'},
      argumentCount: 2,
      interfaceId: 'cuis-add-interface',
      blockId: 'cuis-add-block',
    });
    const rustWasm = await runtime.images.putCodeArtifact('build-image', {
      id: 'rust-add-wasm',
      languageId: 'rust',
      representation: WASM_BINARY_V1,
      content: bytesValue(I32_ADD_WASM),
      metadata: {purpose: 'mixed-language-callable-proof'},
    });
    const {block: rustAddBlock} = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef('build-image', rustWasm.id),
      interfaceId: 'rust-add-interface',
      blockId: 'rust-add-block',
      exportName: 'add',
      parameters: ['i32', 'i32'],
      result: 'i32',
    });

    const environment = await runtime.images.putLexicalEnvironment('build-image', {
      id: 'mixed-environment',
      bindings: {
        'mixed:cuis': {name: 'cuis', value: objectRef('build-image', cuisAddBlock.id)},
        'mixed:rust': {name: 'rust', value: objectRef('build-image', rustAddBlock.id)},
      },
    });
    const environmentRef = objectRef('build-image', environment.id);
    const orchestrator = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'build-image',
      id: 'mixed-orchestrator',
      source: '[ :x | cuis value: (rust value: x value: x) value: x ]',
      captures: {cuis: 'mixed:cuis', rust: 'mixed:rust'},
      environment: environmentRef,
    });
    const wasm = await compileWasmFunctionArtifact({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('build-image', orchestrator.semanticArtifact.id),
      moduleId: 'mixed-orchestrator:wasm-module',
      functionId: 'mixed-orchestrator:wasm-function',
    });
    const wasmBlock = await runtime.images.putBlock('build-image', {
      id: 'mixed-orchestrator:wasm-block',
      code: objectRef('build-image', wasm.functionArtifact.id),
      environment: environmentRef,
    });
    assert.equal(wasm.moduleArtifact.metadata.abi, WASM_RESUMABLE_VALUE_HANDLE_ABI_V1);
    assert.match(wasm.moduleArtifact.metadata.effectSites[0].resumeEntry, /\$resume_/);

    const mixedActivation = await runtime.invocations.invokeBlock(
      objectRef('build-image', wasmBlock.id),
      [integerValue(14)],
    );
    assert.deepEqual(await runtime.executor.execute(mixedActivation), integerValue(42));
    assert.equal(runtime.foreignRuntimes.list().length, 1);
    assert.equal(runtime.foreignRuntimes.list()[0].runtimeId, instance.runtimeId);
  } finally {
    await runtime.close();
  }
});
