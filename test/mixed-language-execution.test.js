import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {
  CARGO_RUSTC_OCI_PROVIDER_ID,
  CUIS_IMAGE_V1,
  CUIS_RUNTIME_DEFINITION_CONTRACT_V0,
  CUIS_RUNTIME_DEFINITION_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  RUST_CARGO_LOCK_V1,
  RUST_CARGO_MANIFEST_V1,
  RUST_SOURCE_V1,
  WASM_BINARY_V1,
  WASM_RESUMABLE_VALUE_HANDLE_ABI_V1,
  bytesValue,
  compileWasmFunctionArtifact,
  createArtifactBackedOpenSmalltalkCuisProvider,
  createCargoRustcOciProvider,
  createRuntime,
  installForeignRuntimeCallable,
  installSymmetricSmalltalkBlock,
  installWasmScalarCallable,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

const PINNED_RUST_IMAGE = `registry.example/rust-wasm@sha256:${'a'.repeat(64)}`;
const I32_ADD_WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

class FakeCuisSession {
  constructor() {
    this.lines = ['READY\tlagrange-cuis-stdio/v1'];
  }

  async writeLine(line) {
    const fields = line.split('\t');
    if (fields[0] === 'QUIT') {
      this.lines.push('BYE');
      return;
    }
    const [, requestId, service, operation, ...args] = fields;
    if (service === 'proof' && operation === 'add') {
      const left = BigInt(args[0].slice(2));
      const right = BigInt(args[1].slice(2));
      this.lines.push(`OK\t${requestId}\ti:${left + right}`);
      return;
    }
    this.lines.push(`ERR\t${requestId}\tunsupported`);
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
  constructor() { this.starts = []; }
  async start(request) {
    this.starts.push(request);
    return new FakeCuisSession();
  }
}

async function putRustCargoProject(runtime) {
  const source = await runtime.images.putCodeArtifact('mixed', {
    id: 'rust-source',
    languageId: 'rust',
    representation: RUST_SOURCE_V1,
    content: textValue('#[no_mangle]\npub extern "C" fn add(left: i32, right: i32) -> i32 { left + right }\nfn main() {}\n'),
    metadata: {path: 'src/main.rs'},
  });
  const lock = await runtime.images.putCodeArtifact('mixed', {
    id: 'rust-lock',
    languageId: 'rust',
    representation: RUST_CARGO_LOCK_V1,
    content: textValue('version = 4\n\n[[package]]\nname = "mixed"\nversion = "0.1.0"\n'),
  });
  const manifest = await runtime.images.putCodeArtifact('mixed', {
    id: 'rust-manifest',
    languageId: 'rust',
    representation: RUST_CARGO_MANIFEST_V1,
    content: textValue('[package]\nname = "mixed"\nversion = "0.1.0"\nedition = "2021"\n\n[[bin]]\nname = "mixed"\npath = "src/main.rs"\n'),
    dependencies: [
      {role: 'source', artifact: objectRef('mixed', source.id)},
      {role: 'lock', artifact: objectRef('mixed', lock.id)},
    ],
  });
  return {source, lock, manifest};
}

async function execute(runtime, block, value) {
  const activation = await runtime.invocations.invokeBlock(block, [integerValue(value)]);
  return await runtime.executor.execute(activation);
}

test('Symmetric Smalltalk composes Cargo-derived WASM and Cuis Blocks identically through neutral and resumable Lagrange-WASM execution', async () => {
  let cargoInvocation = null;
  const cargoRunner = Object.freeze({
    async run(request) {
      cargoInvocation = request;
      const output = join(request.workspace, 'target', 'wasm32-wasip1', 'release', 'mixed.wasm');
      await mkdir(dirname(output), {recursive: true});
      await writeFile(output, I32_ADD_WASM);
      return {exitCode: 0, stdout: 'cargo-fixture-ok\n', stderr: ''};
    },
  });
  const cuisRunner = new FakeCuisRunner();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[
      CARGO_RUSTC_OCI_PROVIDER_ID,
      createCargoRustcOciProvider({image: PINNED_RUST_IMAGE, runner: cargoRunner}),
    ]],
    foreignRuntimeProviders: [[
      OPENSMALLTALK_CUIS_PROVIDER_ID,
      createArtifactBackedOpenSmalltalkCuisProvider({
        vmPath: '/opt/opensmalltalk/squeak',
        vmIdentity: 'opensmalltalk-vm/test/sha256:1234',
        runner: cuisRunner,
      }),
    ]],
    foreignRuntimeDefinitionBindings: [[CUIS_RUNTIME_DEFINITION_V1, OPENSMALLTALK_CUIS_PROVIDER_ID]],
  });
  await runtime.images.createImage({id: 'mixed'});

  try {
    const rustProject = await putRustCargoProject(runtime);
    await runtime.toolchains.run({
      providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
      imageId: 'mixed',
      roots: [objectRef('mixed', rustProject.manifest.id)],
      target: {
        representation: WASM_BINARY_V1,
        triple: 'wasm32-wasip1',
        binary: 'mixed',
        profile: 'release',
      },
      options: {},
      outputIds: {module: 'rust-wasm'},
    });
    const rustWasm = await runtime.images.getCodeArtifact('mixed', 'rust-wasm');
    assert.equal(rustWasm.languageId, 'rust');
    assert.deepEqual(rustWasm.derivedFrom, [
      objectRef('mixed', 'rust-manifest'),
      objectRef('mixed', 'rust-source'),
      objectRef('mixed', 'rust-lock'),
    ]);
    assert.equal(cargoInvocation.network, 'none');

    const {block: rustBlock} = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef('mixed', rustWasm.id),
      interfaceId: 'rust-add-interface',
      blockId: 'rust-add-block',
      exportName: 'add',
      parameters: ['i32', 'i32'],
      result: 'i32',
    });

    const cuisImage = await runtime.images.putCodeArtifact('mixed', {
      id: 'cuis-image',
      languageId: 'smalltalk',
      representation: CUIS_IMAGE_V1,
      content: bytesValue(Buffer.from('fake-cuis-image')),
      metadata: {fileName: 'Mixed.image'},
    });
    const cuisDefinition = await runtime.images.putCodeArtifact('mixed', {
      id: 'cuis-runtime',
      languageId: 'smalltalk',
      representation: CUIS_RUNTIME_DEFINITION_V1,
      content: textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0),
      dependencies: [{role: 'image', artifact: objectRef('mixed', cuisImage.id)}],
    });
    const {block: cuisBlock} = await installForeignRuntimeCallable({
      images: runtime.images,
      runtimeDefinition: objectRef('mixed', cuisDefinition.id),
      interface: {service: 'proof', operation: 'add'},
      argumentCount: 2,
      interfaceId: 'cuis-add-interface',
      blockId: 'cuis-add-block',
    });

    const environment = await runtime.images.putLexicalEnvironment('mixed', {
      id: 'mixed-environment',
      bindings: {
        'mixed:cuis': {name: 'cuis', value: objectRef('mixed', cuisBlock.id)},
        'mixed:rust': {name: 'rust', value: objectRef('mixed', rustBlock.id)},
      },
    });
    const environmentRef = objectRef('mixed', environment.id);
    const orchestrator = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'mixed',
      id: 'mixed-orchestrator',
      source: '[ :x | cuis value: (rust value: x value: x) value: x ]',
      captures: {cuis: 'mixed:cuis', rust: 'mixed:rust'},
      environment: environmentRef,
    });
    const wasm = await compileWasmFunctionArtifact({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('mixed', orchestrator.semanticArtifact.id),
      moduleId: 'mixed-orchestrator:wasm-module',
      functionId: 'mixed-orchestrator:wasm-function',
    });
    const wasmBlock = await runtime.images.putBlock('mixed', {
      id: 'mixed-orchestrator:wasm-block',
      code: objectRef('mixed', wasm.functionArtifact.id),
      environment: environmentRef,
    });

    assert.equal(wasm.moduleArtifact.metadata.abi, WASM_RESUMABLE_VALUE_HANDLE_ABI_V1);
    assert.equal(wasm.functionArtifact.metadata.abi, WASM_RESUMABLE_VALUE_HANDLE_ABI_V1);
    assert.deepEqual(wasm.moduleArtifact.metadata.effectSites.map(({kind}) => kind), ['send', 'send']);
    assert.match(wasm.moduleArtifact.metadata.effectSites[0].resumeEntry, /\$resume_/);
    assert.equal(wasm.moduleArtifact.metadata.effectSites[1].resumeEntry, null);
    assert.equal(runtime.foreignRuntimes.list().length, 0);

    const wasmRef = objectRef('mixed', wasmBlock.id);
    const neutralRef = objectRef('mixed', orchestrator.block.id);
    assert.deepEqual(await execute(runtime, wasmRef, 14), integerValue(42));
    assert.equal(runtime.foreignRuntimes.list().length, 1);
    assert.equal(cuisRunner.starts.length, 1);

    assert.deepEqual(await execute(runtime, neutralRef, 14), integerValue(42));
    assert.deepEqual(await execute(runtime, wasmRef, 10), integerValue(30));
    assert.deepEqual(await execute(runtime, neutralRef, 10), integerValue(30));
    assert.equal(runtime.foreignRuntimes.list().length, 1);
    assert.equal(cuisRunner.starts.length, 1);
  } finally {
    await runtime.close();
  }
});
