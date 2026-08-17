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
  float64Value,
  createJcoComponentRuntime,
  createRuntime,
  installCallableInterface,
  installCallableInterfaceV2,
  installForeignRuntimeBinding,
  installWasmComponentBinding,
  objectRef,
  packCompositeValue,
  textValue,
  unpackCompositeValue,
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
test('a Rust Component and a live Cuis image satisfy the same callable interfaces identically', {skip: !enabled, timeout: 180_000}, async () => {
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

    const component = await runtime.images.putCodeArtifact('proof', {
      id: 'proof-component',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(await readFile(COMPONENT_PATH)),
      languageId: 'rust',
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

    // Each row is one callable interface bound to both lanes. The Cuis target differs from
    // the interface function name on purpose in the last row: how a lane addresses its own
    // implementation is the binding's business, not the interface's.
    const bytesOf = (...values) => bytesValue(new Uint8Array(values));
    const INTERFACES = [
      {
        id: 'normalize', functionName: 'normalize',
        parameters: ['string'], result: 'string',
        cuisTarget: {service: 'text', operation: 'normalize'},
        cases: [
          [[textValue('  Hello   World  ')], textValue('hello world')],
          [[textValue('  Tabs\tand\nnewlines  ')], textValue('tabs and newlines')],
          [[textValue('  HÄLLO   Wörld  ')], textValue('hällo wörld')],
          [[textValue('  世界  \u{1f600} ')], textValue('世界 \u{1f600}')],
          [[textValue('')], textValue('')],
        ],
      },
      {
        id: 'reverse', functionName: 'reverse',
        parameters: ['list<u8>'], result: 'list<u8>',
        cuisTarget: {service: 'bytes', operation: 'reverse'},
        cases: [
          [[bytesOf()], bytesOf()],
          [[bytesOf(1, 2, 3)], bytesOf(3, 2, 1)],
          // Every byte value, and long enough to expose any chunking or line wrapping.
          [
            [bytesValue(new Uint8Array(Array.from({length: 256}, (_, i) => i)))],
            bytesValue(new Uint8Array(Array.from({length: 256}, (_, i) => 255 - i))),
          ],
          [
            [bytesValue(new Uint8Array(Array.from({length: 2000}, (_, i) => i % 256)))],
            bytesValue(new Uint8Array(Array.from({length: 2000}, (_, i) => (1999 - i) % 256))),
          ],
        ],
      },
      {
        id: 'scale', functionName: 'scale',
        parameters: ['f64', 'f64'], result: 'f64',
        cuisTarget: {service: 'float', operation: 'scale'},
        cases: [
          [[float64Value(1.5), float64Value(2.25)], float64Value(3.375)],
          [[float64Value(0.1), float64Value(3)], float64Value(0.1 * 3)],
          [[float64Value(-0), float64Value(1)], float64Value(-0)],
          [[float64Value(1e308), float64Value(10)], float64Value(Infinity)],
        ],
      },
      {
        id: 'echo-f32', functionName: 'echo-f32',
        parameters: ['f32'], result: 'f32',
        // The Cuis image has no f32 notion; it echoes a float64 that the shared interface
        // already rounded. That is the point: f32 semantics belong to the interface.
        cuisTarget: {service: 'proof', operation: 'echo'},
        cases: [
          [[float64Value(0.1)], float64Value(Math.fround(0.1))],
          [[float64Value(1.5)], float64Value(1.5)],
        ],
      },
    ];

    // The first composite through both real lanes. The Component lane unpacks the envelope
    // for the canonical ABI; the Cuis lane forwards the envelope bytes untouched and decodes
    // inside the image, so the stdio framing never learns a nested grammar.
    const LIST_OF_STRING = {kind: 'list', element: 'string'};
    const normalizeSpec = (text) => text.toLowerCase().replace(/[\t\n\v\f\r ]+/g, ' ').trim();
    INTERFACES.push({
      id: 'normalize-all', functionName: 'normalize-all', types: {},
      parameters: [LIST_OF_STRING], result: LIST_OF_STRING,
      cuisTarget: {service: 'text', operation: 'normalize-all'},
      decode: (value) => unpackCompositeValue(value, LIST_OF_STRING),
      cases: [
        [[], []],
        [[''], ['']],
        [['  Hello   World  '], ['hello world']],
        [['a', 'B', '  c  '], ['a', 'b', 'c']],
        [['  HÄLLO   Wörld  ', '  世界  \u{1f600} '], ['hällo wörld', '世界 \u{1f600}']],
        // Content that looks like the bridge's own line protocol must be inert.
        [['d:looks-like-a-token', 'e:%20also', 'OK\tERR', 'a\nb'],
          ['d:looks-like-a-token', 'e:%20also', 'ok err', 'a b']],
        [Array.from({length: 500}, (_, i) => `  Item ${i}  `),
          Array.from({length: 500}, (_, i) => `item ${i}`)],
      ].map(([input, output]) => [
        [packCompositeValue(input, LIST_OF_STRING)],
        packCompositeValue(output, LIST_OF_STRING),
      ]),
    });

    for (const spec of INTERFACES) {
      const install = spec.types === undefined ? installCallableInterface : installCallableInterfaceV2;
      const callableInterface = await install({
        images: runtime.images,
        imageId: 'proof',
        interfaceId: `${spec.id}-interface`,
        functionName: spec.functionName,
        parameters: spec.parameters,
        result: spec.result,
        ...(spec.types === undefined ? {} : {types: spec.types}),
      });
      const interfaceRef = objectRef('proof', callableInterface.id);

      const componentLane = await installWasmComponentBinding({
        images: runtime.images,
        callableInterface: interfaceRef,
        component: objectRef('proof', component.id),
        bindingId: `${spec.id}-component-binding`,
        blockId: `${spec.id}-component-block`,
      });
      const cuisLane = await installForeignRuntimeBinding({
        images: runtime.images,
        callableInterface: interfaceRef,
        runtimeDefinition: objectRef('proof', runtimeDefinition.id),
        target: spec.cuisTarget,
        bindingId: `${spec.id}-cuis-binding`,
        blockId: `${spec.id}-cuis-block`,
      });

      const interfaceOf = (binding) => binding.bindingArtifact.dependencies
        .find((dependency) => dependency.role === 'interface').artifact;
      assert.deepEqual(interfaceOf(componentLane), interfaceOf(cuisLane),
        `${spec.id}: the two lanes must share one interface artifact`);

      const blocks = [
        objectRef('proof', componentLane.block.id),
        objectRef('proof', cuisLane.block.id),
      ];
      for (const [args, expected] of spec.cases) {
        const results = [];
        for (const blockRef of blocks) {
          const activation = await runtime.invocations.invokeBlock(blockRef, args);
          results.push(await runtime.executor.execute(activation));
        }
        const shown = JSON.stringify(args, (_, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 70);
        const seen = spec.decode ? results.map(spec.decode) : results;
        const want = spec.decode ? spec.decode(expected) : expected;
        assert.deepEqual(seen[0], want, `${spec.id}: Rust Component lane disagreed for ${shown}`);
        assert.deepEqual(seen[1], want, `${spec.id}: live Cuis lane disagreed for ${shown}`);
        assert.deepEqual(results[0], results[1], `${spec.id}: lanes disagreed byte for byte for ${shown}`);
      }
    }
  } finally {
    await runtime.close();
  }
});
