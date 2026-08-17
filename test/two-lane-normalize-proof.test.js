import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  CUIS_IMAGE_V1,
  CUIS_RUNTIME_DEFINITION_CONTRACT_V0,
  CUIS_RUNTIME_DEFINITION_V1,
  CUIS_STDIO_BRIDGE_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  WASM_COMPONENT_V1,
  WASM_WIT_CALLABLE_INTERFACE_V1,
  bytesValue,
  createArtifactBackedOpenSmalltalkCuisProvider,
  createRuntime,
  installForeignRuntimeCallable,
  installWasmWitCallable,
  objectRef,
  textValue,
} from '../src/runtime.js';

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
    if (service === 'text' && operation === 'normalize') {
      const decode = (token) => {
        if (token.startsWith('e:')) {
          const enc = token.slice(2);
          const bytes = [];
          for (let i = 0; i < enc.length; i++) {
            if (enc[i] === '%' && i + 2 < enc.length) {
              bytes.push(parseInt(enc.substring(i + 1, i + 3), 16));
              i += 2;
            } else {
              bytes.push(enc.charCodeAt(i));
            }
          }
          return new TextDecoder().decode(new Uint8Array(bytes));
        }
        throw new Error(`unexpected token: ${token}`);
      };
      const encode = (str) => {
        return Array.from(new TextEncoder().encode(str), (b) =>
          (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
          || b === 0x2D || b === 0x2E || b === 0x5F || b === 0x7E
            ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
        ).join('');
      };
      const input = decode(args[0]);
      const normalized = input.toLowerCase().replace(/\s+/g, ' ').trim();
      this.lines.push(`OK\t${id}\te:${encode(normalized)}`);
      return;
    }
    this.lines.push(`ERR\t${id}\tunsupported`);
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
  constructor() { this.starts = []; this.sessions = []; }
  async start(request) {
    this.starts.push(request);
    const session = new FakeCuisSession();
    this.sessions.push(session);
    return session;
  }
}

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

test('same text/normalize interface through Component and Cuis lanes produces identical results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-two-lane-proof-'));
  const runner = new FakeCuisRunner();
  const cuisProvider = createArtifactBackedOpenSmalltalkCuisProvider({
    vmPath: '/vm',
    imagePath: '/image',
    vmIdentity: 'vm/test',
    imageIdentity: 'image/test',
    runner,
    workspaceRoot: root,
  });

  const componentRuntime = {
    async invoke(_component, functionName, args) {
      if (functionName === 'normalize') return normalizeText(args[0]);
      throw new Error(`unknown: ${functionName}`);
    },
  };

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    componentRuntime,
    foreignRuntimeProviders: [[OPENSMALLTALK_CUIS_PROVIDER_ID, cuisProvider]],
    foreignRuntimeDefinitionBindings: [
      [CUIS_RUNTIME_DEFINITION_V1, OPENSMALLTALK_CUIS_PROVIDER_ID],
    ],
  });

  try {
    await runtime.images.createImage({id: 'demo'});

    const component = await runtime.images.putCodeArtifact('demo', {
      id: 'normalize-wasm-component',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d])),
      languageId: 'rust',
    });
    const componentCallable = await installWasmWitCallable({
      images: runtime.images,
      component: objectRef('demo', component.id),
      interfaceId: 'normalize-wit-interface',
      blockId: 'normalize-wit-block',
      functionName: 'normalize',
      parameters: ['string'],
      result: 'string',
    });

    const cuisImageArtifact = await runtime.images.putCodeArtifact('demo', {
      id: 'cuis-image',
      representation: CUIS_IMAGE_V1,
      content: bytesValue(Buffer.from('fake-image')),
      languageId: 'smalltalk',
      metadata: {fileName: 'Proof.image'},
    });
    const definitionContent = await runtime.images.putCodeArtifact('demo', {
      id: 'cuis-def',
      representation: CUIS_RUNTIME_DEFINITION_V1,
      content: textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0),
      languageId: 'smalltalk',
      dependencies: [{
        role: 'image',
        artifact: objectRef('demo', cuisImageArtifact.id),
      }],
    });
    const cuisCallable = await installForeignRuntimeCallable({
      images: runtime.images,
      runtimeDefinition: objectRef('demo', definitionContent.id),
      blockId: 'normalize-cuis-block',
      interface: {service: 'text', operation: 'normalize'},
      argumentCount: 1,
    });

    assert.equal(componentCallable.interfaceArtifact.representation, WASM_WIT_CALLABLE_INTERFACE_V1);
    assert.equal(cuisCallable.interfaceArtifact.representation, 'foreign-runtime-callable-interface/v1');

    const inputs = [
      '  Hello   World  ',
      'ALREADY lower',
      '  Multiple   spaces   between  ',
      '',
      'x',
    ];

    for (const input of inputs) {
      const expected = normalizeText(input);

      const componentActivation = await runtime.invocations.invokeBlock(
        objectRef('demo', componentCallable.block.id),
        [textValue(input)],
      );
      const componentResult = await runtime.executor.execute(componentActivation);
      assert.deepEqual(componentResult, textValue(expected),
        `Component lane failed for: ${JSON.stringify(input)}`);

      const cuisActivation = await runtime.invocations.invokeBlock(
        objectRef('demo', cuisCallable.block.id),
        [textValue(input)],
      );
      const cuisResult = await runtime.executor.execute(cuisActivation);
      assert.deepEqual(cuisResult, textValue(expected),
        `Cuis lane failed for: ${JSON.stringify(input)}`);
    }
  } finally {
    await runtime.close();
    await rm(root, {recursive: true, force: true});
  }
});
