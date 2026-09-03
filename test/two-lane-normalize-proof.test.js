import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  CALLABLE_INTERFACE_V1,
  CUIS_IMAGE_V1,
  CUIS_RUNTIME_DEFINITION_CONTRACT_V0,
  CUIS_RUNTIME_DEFINITION_V1,
  CUIS_STDIO_BRIDGE_V1,
  FOREIGN_RUNTIME_BINDING_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  WASM_COMPONENT_BINDING_V1,
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

const COMPONENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'normalize-component',
  'normalize.component.wasm',
);

// The specification both lanes are held to, written once here so neither lane can quietly
// define "normalize" to mean whatever it happens to implement.
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

class FakeCuisSession {
  constructor() {
    this.lines = [`READY\t${CUIS_STDIO_BRIDGE_V1}`];
    this.writes = [];
  }

  async writeLine(line) {
    this.writes.push(line);
    const fields = line.split('\t');
    if (fields[0] === 'QUIT') {
      this.lines.push('BYE');
      return;
    }
    const [, id, service, operation, ...args] = fields;
    if (service !== 'text' || operation !== 'normalize') {
      this.lines.push(`ERR\t${id}\tunsupported`);
      return;
    }
    const decodePercent = (token) => {
      const encoded = token.slice(2);
      const bytes = [];
      for (let i = 0; i < encoded.length; i++) {
        if (encoded[i] === '%') {
          bytes.push(parseInt(encoded.substring(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(encoded.charCodeAt(i));
        }
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    };
    const encodePercent = (str) => Array.from(new TextEncoder().encode(str), (b) =>
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
      || b === 0x2D || b === 0x2E || b === 0x5F || b === 0x7E
        ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    this.lines.push(`OK\t${id}\te:${encodePercent(normalizeSpec(decodePercent(args[0])))}`);
  }

  async nextLine() {
    if (this.lines.length === 0) throw new Error('fake Cuis session has no queued output');
    return this.lines.shift();
  }

  async waitForExit() { return {code: 0, signal: null, stderr: ''}; }
  kill() {}
  stderrText() { return ''; }
}

class FakeCuisRunner {
  constructor() { this.sessions = []; }
  async start() {
    const session = new FakeCuisSession();
    this.sessions.push(session);
    return session;
  }
}

async function setUpTwoLanes(root) {
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    componentRuntime: createJcoComponentRuntime(),
    foreignRuntimeProviders: [[
      OPENSMALLTALK_CUIS_PROVIDER_ID,
      createArtifactBackedOpenSmalltalkCuisProvider({
        vmPath: '/vm',
        imagePath: '/image',
        vmIdentity: 'vm/test',
        imageIdentity: 'image/test',
        runner: new FakeCuisRunner(),
        workspaceRoot: root,
      }),
    ]],
    foreignRuntimeDefinitionBindings: [[CUIS_RUNTIME_DEFINITION_V1, OPENSMALLTALK_CUIS_PROVIDER_ID]],
  });
  await runtime.images.createImage({id: 'demo'});

  // One interface. It names a callable shape and nothing else: no module, no runtime,
  // no provider, no capability.
  const callableInterface = await installCallableInterface({
    images: runtime.images,
    imageId: 'demo',
    interfaceId: 'normalize-interface',
    functionName: 'normalize',
    parameters: ['string'],
    result: 'string',
  });
  const interfaceRef = objectRef('demo', callableInterface.id);

  const component = await runtime.images.putCodeArtifact('demo', {
    id: 'normalize-component',
    representation: WASM_COMPONENT_V1,
    content: bytesValue(await readFile(COMPONENT_PATH)),
    languageId: 'rust',
  });
  const componentLane = await installWasmComponentBinding({
    images: runtime.images,
    callableInterface: interfaceRef,
    component: objectRef('demo', component.id),
    bindingId: 'normalize-component-binding',
    blockId: 'normalize-component-block',
  });

  const cuisImage = await runtime.images.putCodeArtifact('demo', {
    id: 'cuis-image',
    representation: CUIS_IMAGE_V1,
    content: bytesValue(Buffer.from('fake-image')),
    languageId: 'smalltalk',
    logicalPath: 'Proof.image',
  });
  const cuisDefinition = await runtime.images.putCodeArtifact('demo', {
    id: 'cuis-definition',
    representation: CUIS_RUNTIME_DEFINITION_V1,
    content: textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0),
    languageId: 'smalltalk',
    dependencies: [{role: 'image', artifact: objectRef('demo', cuisImage.id)}],
  });
  const cuisLane = await installForeignRuntimeBinding({
    images: runtime.images,
    callableInterface: interfaceRef,
    runtimeDefinition: objectRef('demo', cuisDefinition.id),
    target: {service: 'text', operation: 'normalize'},
    bindingId: 'normalize-cuis-binding',
    blockId: 'normalize-cuis-block',
  });

  return {runtime, callableInterface, interfaceRef, componentLane, cuisLane};
}

test('one callable interface is shared by a WASM Component lane and a Cuis lane', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-two-lane-proof-'));
  const {runtime, callableInterface, componentLane, cuisLane} = await setUpTwoLanes(root);
  try {
    // The architectural claim: not "two interfaces that agree" but one interface, twice bound.
    assert.equal(callableInterface.representation, CALLABLE_INTERFACE_V1);
    assert.equal(componentLane.bindingArtifact.representation, WASM_COMPONENT_BINDING_V1);
    assert.equal(cuisLane.bindingArtifact.representation, FOREIGN_RUNTIME_BINDING_V1);

    const interfaceOf = (binding) => binding.bindingArtifact.dependencies
      .find((dependency) => dependency.role === 'interface').artifact;
    assert.deepEqual(interfaceOf(componentLane), interfaceOf(cuisLane));
    assert.equal(interfaceOf(componentLane).objectId, callableInterface.id);

    // The interface itself depends on nothing, so it cannot name an implementation.
    assert.deepEqual(callableInterface.dependencies, []);
  } finally {
    await runtime.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('both lanes return identical canonical text Values through ordinary Block invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-two-lane-proof-'));
  const {runtime, componentLane, cuisLane} = await setUpTwoLanes(root);
  try {
    // The caller only has two Block refs. Nothing here names a lane, an ABI or a provider.
    const lanes = [
      objectRef('demo', componentLane.block.id),
      objectRef('demo', cuisLane.block.id),
    ];

    for (const input of INPUTS) {
      const expected = textValue(normalizeSpec(input));
      const results = [];
      for (const blockRef of lanes) {
        const activation = await runtime.invocations.invokeBlock(blockRef, [textValue(input)]);
        results.push(await runtime.executor.execute(activation));
      }
      assert.deepEqual(results[0], expected, `Component lane disagreed for ${JSON.stringify(input)}`);
      assert.deepEqual(results[1], expected, `Cuis lane disagreed for ${JSON.stringify(input)}`);
      assert.deepEqual(results[0], results[1], `lanes disagreed for ${JSON.stringify(input)}`);
    }
  } finally {
    await runtime.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('the shared interface types both lanes identically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-two-lane-proof-'));
  const {runtime, componentLane, cuisLane} = await setUpTwoLanes(root);
  try {
    for (const [lane, binding] of [['Component', componentLane], ['Cuis', cuisLane]]) {
      const blockRef = objectRef('demo', binding.block.id);

      const wrongArity = await runtime.invocations.invokeBlock(blockRef, []);
      await assert.rejects(runtime.executor.execute(wrongArity), /expected 1 arguments/,
        `${lane} lane did not enforce arity from the shared interface`);

      const wrongType = await runtime.invocations.invokeBlock(blockRef, [bytesValue(new Uint8Array([1]))]);
      await assert.rejects(runtime.executor.execute(wrongType), /must be a text Value for string/,
        `${lane} lane did not enforce parameter type from the shared interface`);
    }
  } finally {
    await runtime.close();
    await rm(root, {recursive: true, force: true});
  }
});
