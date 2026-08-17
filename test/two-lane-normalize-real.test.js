import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
  bytesValue,
  createArtifactBackedOpenSmalltalkCuisProvider,
  createJcoComponentRuntime,
  createRuntime,
  installCallableInterface,
  installForeignRuntimeBinding,
  installWasmComponentBinding,
  objectRef,
  textValue,
} from '../src/runtime.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';

const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';

const COMPONENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'normalize-component',
  'normalize.component.wasm',
);

function normalizeSpec(text) {
  return text.toLowerCase().replace(/[\t\n\v\f\r ]+/g, ' ').trim();
}

const INPUTS = [
  '  Hello   World  ',
  'ALREADY lower',
  '  Multiple   spaces   between  ',
  '',
  'x',
  '  Tabs\tand\nnewlines  ',
  '  HÄLLO   Wörld  ',
  '  世界  \u{1f600} ',
];

// The fast two-lane proof runs the real Component against a fake Cuis session. This one
// runs both lanes for real: a Rust Component through the canonical ABI, and a live
// OpenSmalltalkVM through the stdio bridge, behind one shared callable interface.
test('a Rust Component and a live Cuis image satisfy one callable interface identically', {skip: !enabled, timeout: 180_000}, async () => {
  const vmPath = process.env.LAGRANGE_OPENSMALLTALK_VM_PATH;
  const imagePath = process.env.LAGRANGE_CUIS_IMAGE_PATH;
  const changesPath = process.env.LAGRANGE_CUIS_CHANGES_PATH;
  const sourcesPath = process.env.LAGRANGE_CUIS_SOURCES_PATH;
  for (const [name, value] of Object.entries({vmPath, imagePath, changesPath, sourcesPath})) {
    assert.ok(value, `${name} integration path is required`);
  }

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
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
  await runtime.images.createImage({id: 'proof'});
  try {
    const put = async (id, representation, content, extra = {}) => await runtime.images.putCodeArtifact('proof', {
      id, representation, content, languageId: 'smalltalk', ...extra,
    });

    const callableInterface = await installCallableInterface({
      images: runtime.images,
      imageId: 'proof',
      interfaceId: 'normalize-interface',
      functionName: 'normalize',
      parameters: ['string'],
      result: 'string',
    });
    const interfaceRef = objectRef('proof', callableInterface.id);

    const component = await runtime.images.putCodeArtifact('proof', {
      id: 'normalize-component',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(await readFile(COMPONENT_PATH)),
      languageId: 'rust',
    });
    const componentLane = await installWasmComponentBinding({
      images: runtime.images,
      callableInterface: interfaceRef,
      component: objectRef('proof', component.id),
      bindingId: 'normalize-component-binding',
      blockId: 'normalize-component-block',
    });

    const baseImage = await put('cuis-image', CUIS_IMAGE_V1, bytesValue(await readFile(imagePath)), {
      metadata: {fileName: 'Cuis7.9-8090.image'},
    });
    const baseChanges = await put('cuis-changes', CUIS_CHANGES_V1, bytesValue(await readFile(changesPath)), {
      metadata: {fileName: 'Cuis7.9-8090.changes'},
    });
    const baseSources = await put('cuis-sources', CUIS_SOURCES_V1, bytesValue(await readFile(sourcesPath)), {
      metadata: {fileName: 'Cuis7.8.sources'},
    });
    const runtimeDefinition = await put('cuis-runtime', CUIS_RUNTIME_DEFINITION_V1, textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0), {
      dependencies: [
        {role: 'image', artifact: objectRef('proof', baseImage.id)},
        {role: 'changes', artifact: objectRef('proof', baseChanges.id)},
        {role: 'sources', artifact: objectRef('proof', baseSources.id)},
      ],
    });
    const cuisLane = await installForeignRuntimeBinding({
      images: runtime.images,
      callableInterface: interfaceRef,
      runtimeDefinition: objectRef('proof', runtimeDefinition.id),
      target: {service: 'text', operation: 'normalize'},
      bindingId: 'normalize-cuis-binding',
      blockId: 'normalize-cuis-block',
    });

    // Both bindings point at the same interface artifact, not at look-alike copies.
    const interfaceOf = (binding) => binding.bindingArtifact.dependencies
      .find((dependency) => dependency.role === 'interface').artifact;
    assert.deepEqual(interfaceOf(componentLane), interfaceOf(cuisLane));

    const blocks = [
      objectRef('proof', componentLane.block.id),
      objectRef('proof', cuisLane.block.id),
    ];
    for (const input of INPUTS) {
      const expected = textValue(normalizeSpec(input));
      const results = [];
      for (const blockRef of blocks) {
        const activation = await runtime.invocations.invokeBlock(blockRef, [textValue(input)]);
        results.push(await runtime.executor.execute(activation));
      }
      assert.deepEqual(results[0], expected, `Rust Component lane disagreed for ${JSON.stringify(input)}`);
      assert.deepEqual(results[1], expected, `live Cuis lane disagreed for ${JSON.stringify(input)}`);
      assert.deepEqual(results[0], results[1], `lanes disagreed for ${JSON.stringify(input)}`);
    }
  } finally {
    await runtime.close();
  }
});
