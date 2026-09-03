import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {
  CARGO_RUSTC_OCI_CACHE_CONTRACT_V0,
  CARGO_RUSTC_OCI_CACHE_CONTRACT_V1,
  CARGO_RUSTC_OCI_PROVIDER_ID,
  RUST_CARGO_LOCK_V1,
  RUST_CARGO_MANIFEST_V1,
  RUST_SOURCE_V1,
  TOOLCHAIN_PROVIDER_PROTOCOL_V0,
  WASM_BINARY_V1,
  bytesValue,
  createCargoRustcOciProvider,
  ToolchainProviderRegistry,
  ToolchainService,
  createRuntime,
  createToolchainDerivationDescriptor,
  objectRef,
  textValue,
} from '../src/runtime.js';

const PINNED_IMAGE = `registry.example/rust-wasm@sha256:${'c'.repeat(64)}`;
const WASM_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

async function putSource(runtime, id, content = 'source') {
  return await runtime.images.putCodeArtifact('demo', {
    id,
    representation: 'example/source-v1',
    content: textValue(content),
  });
}

test('cacheable toolchain provider reuses a complete multi-output result set', async () => {
  let runs = 0;
  const provider = Object.freeze({
    identity: 'example-cacheable-toolchain/v1',
    cacheKey() { return {contract: 'example-cache/v1'}; },
    async run() {
      runs += 1;
      return {
        outputs: [
          {name: 'module', representation: 'example/module-v1', content: textValue(`module-${runs}`)},
          {name: 'interface', representation: 'example/interface-v1', content: textValue(`interface-${runs}`)},
        ],
        diagnostics: [{severity: 'note', message: `run-${runs}`}],
      };
    },
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [['example/cacheable', provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const source = await putSource(runtime, 'source');
    const request = {
      providerId: 'example/cacheable',
      imageId: 'demo',
      roots: [objectRef('demo', source.id)],
      target: {representation: 'example/module-v1'},
      options: {optimize: true},
      outputIds: {module: 'module-a', interface: 'interface-a'},
    };
    const first = await runtime.toolchains.run(request);
    const second = await runtime.toolchains.run(request);

    assert.equal(runs, 1);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(typeof first.derivationKey, 'string');
    assert.equal(second.derivationKey, first.derivationKey);
    assert.deepEqual(first.diagnostics, [{severity: 'note', message: 'run-1'}]);
    assert.deepEqual(second.diagnostics, []);
    assert.deepEqual(second.outputs.map(({name, artifact}) => [name, artifact.id]), [
      ['module', 'module-a'],
      ['interface', 'interface-a'],
    ]);

    const module = await runtime.images.getCodeArtifact('demo', 'module-a');
    const iface = await runtime.images.getCodeArtifact('demo', 'interface-a');
    assert.equal(module.metadata.toolchainDerivationKey, first.derivationKey);
    assert.equal(iface.metadata.toolchainDerivationKey, first.derivationKey);
    assert.equal(module.metadata.toolchainResultId, iface.metadata.toolchainResultId);
    assert.equal(module.metadata.toolchainOutputName, 'module');
    assert.equal(module.metadata.toolchainOutputIndex, 0);
    assert.equal(module.metadata.toolchainOutputCount, 2);
    assert.equal(iface.metadata.toolchainOutputName, 'interface');
    assert.equal(iface.metadata.toolchainOutputIndex, 1);
    assert.equal(iface.metadata.toolchainOutputCount, 2);

    const forced = await runtime.toolchains.run({
      ...request,
      outputIds: {module: 'module-b', interface: 'interface-b'},
      reuse: false,
    });
    assert.equal(runs, 2);
    assert.equal(forced.reused, false);
    assert.equal(forced.derivationKey, first.derivationKey);

    const reusedForced = await runtime.toolchains.run({
      ...request,
      outputIds: {module: 'module-b', interface: 'interface-b'},
    });
    assert.equal(runs, 2);
    assert.equal(reusedForced.reused, true);
    assert.deepEqual(reusedForced.outputs.map(({artifact}) => artifact.id), ['module-b', 'interface-b']);

    const changedTarget = await runtime.toolchains.run({
      ...request,
      target: {representation: 'example/module-v1', abi: 'v2'},
      outputIds: {module: 'module-c', interface: 'interface-c'},
    });
    assert.equal(runs, 3);
    assert.equal(changedTarget.reused, false);
    assert.notEqual(changedTarget.derivationKey, first.derivationKey);
  } finally {
    await runtime.close();
  }
});

test('toolchain providers without cacheKey remain one-shot', async () => {
  let runs = 0;
  const provider = Object.freeze({
    identity: 'example-one-shot/v1',
    async run() {
      runs += 1;
      return {outputs: [{name: 'module', representation: 'example/module-v1', content: textValue(`run-${runs}`)}]};
    },
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [['example/one-shot', provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const source = await putSource(runtime, 'source');
    const base = {
      providerId: 'example/one-shot',
      imageId: 'demo',
      roots: [objectRef('demo', source.id)],
      target: {representation: 'example/module-v1'},
    };
    const first = await runtime.toolchains.run({...base, outputIds: {module: 'one-shot-a'}});
    const second = await runtime.toolchains.run({...base, outputIds: {module: 'one-shot-b'}});
    assert.equal(runs, 2);
    assert.equal(first.reused, false);
    assert.equal(second.reused, false);
    assert.equal(first.derivationKey, null);
    assert.equal(second.derivationKey, null);
  } finally {
    await runtime.close();
  }
});

test('toolchain derivation key changes with build-relevant artifact bytes and metadata', async () => {
  const provider = Object.freeze({
    identity: 'fingerprint-provider/v1',
    cacheKey() { return {execution: 'stable'}; },
    async run() { throw new Error('not used'); },
  });
  const ref = objectRef('demo', 'vendor-file');
  const artifact = {
    kind: 'code-artifact',
    id: 'vendor-file',
    imageId: 'demo',
    languageId: 'rust',
    representation: 'rust/cargo-vendor-file-v1',
    content: bytesValue(new Uint8Array([1, 2, 3])),
    dependencies: [],
    metadata: {path: 'vendor/pkg/data.bin'},
  };
  const makeRequest = (overrides = {}) => {
    const current = {...artifact, ...overrides};
    const node = Object.freeze({ref, artifact: Object.freeze(current)});
    return Object.freeze({
      protocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0,
      providerId: 'rust/cargo-oci',
      toolchainIdentity: provider.identity,
      roots: Object.freeze([node]),
      artifacts: Object.freeze([node]),
      target: Object.freeze({representation: 'wasm-binary/v1'}),
      options: Object.freeze({}),
    });
  };

  const context = Object.freeze({protocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0});
  const first = await createToolchainDerivationDescriptor(provider, makeRequest(), context);
  const changedBytes = await createToolchainDerivationDescriptor(provider, makeRequest({
    content: bytesValue(new Uint8Array([1, 2, 4])),
  }), context);
  const changedMetadata = await createToolchainDerivationDescriptor(provider, makeRequest({
    metadata: {path: 'vendor/pkg/other.bin'},
  }), context);

  assert.notEqual(first.derivationKey, changedBytes.derivationKey);
  assert.notEqual(first.derivationKey, changedMetadata.derivationKey);
});

test('public Cargo OCI provider opts into generic result reuse', async () => {
  let runs = 0;
  const runner = Object.freeze({
    async run(request) {
      runs += 1;
      const output = join(request.workspace, 'target', 'wasm32-wasip1', 'release', 'demo.wasm');
      await mkdir(dirname(output), {recursive: true});
      await writeFile(output, WASM_BYTES);
      return {exitCode: 0, stdout: `cargo-${runs}\n`, stderr: ''};
    },
  });
  const provider = createCargoRustcOciProvider({image: PINNED_IMAGE, runner});
  assert.equal(typeof provider.cacheKey, 'function');

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const source = await runtime.images.putCodeArtifact('demo', {
      id: 'source',
      languageId: 'rust',
      representation: RUST_SOURCE_V1,
      content: textValue('fn main() {}\n'),
      metadata: {path: 'src/main.rs'},
    });
    const lock = await runtime.images.putCodeArtifact('demo', {
      id: 'lock',
      languageId: 'rust',
      representation: RUST_CARGO_LOCK_V1,
      content: textValue('version = 4\n\n[[package]]\nname = "demo"\nversion = "0.1.0"\n'),
    });
    const manifest = await runtime.images.putCodeArtifact('demo', {
      id: 'manifest',
      languageId: 'rust',
      representation: RUST_CARGO_MANIFEST_V1,
      content: textValue('[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n\n[[bin]]\nname = "demo"\npath = "src/main.rs"\n'),
      dependencies: [
        {role: 'source', artifact: objectRef('demo', source.id)},
        {role: 'lock', artifact: objectRef('demo', lock.id)},
      ],
    });
    const request = {
      providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
      imageId: 'demo',
      roots: [objectRef('demo', manifest.id)],
      target: {
        representation: WASM_BINARY_V1,
        triple: 'wasm32-wasip1',
        binary: 'demo',
        profile: 'release',
      },
      outputIds: {module: 'cargo-wasm'},
    };

    const first = await runtime.toolchains.run(request);
    const second = await runtime.toolchains.run(request);
    assert.equal(runs, 1);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.outputs[0].artifact.id, 'cargo-wasm');
    assert.deepEqual(second.diagnostics, []);
  } finally {
    await runtime.close();
  }
});

// ADR 0078. Before ADR 0077 the image's ENTRYPOINT took part in choosing the container program;
// after it the requested program is authoritative. Those are two different computations, so a
// derivation persisted under the first must not satisfy a lookup for the second — otherwise the
// cache contract identifier names results of two execution semantics at once.
//
// `legacy` is the public provider with exactly one thing reverted: the contract string. It is the
// A in the A/B and it is also the falsifier — if the bump were undone, this is the provider the
// runtime would ship, and step 2 shows that provider reuses the old record.
test('a derivation persisted under the pre-entrypoint cache contract is not reused by the current one', async () => {
  let runs = 0;
  const runner = Object.freeze({
    async run(request) {
      runs += 1;
      const output = join(request.workspace, 'target', 'wasm32-wasip1', 'release', 'demo.wasm');
      await mkdir(dirname(output), {recursive: true});
      await writeFile(output, WASM_BYTES);
      return {exitCode: 0, stdout: '', stderr: ''};
    },
  });
  const current = createCargoRustcOciProvider({image: PINNED_IMAGE, runner});
  assert.deepEqual(current.cacheKey(), {contract: CARGO_RUSTC_OCI_CACHE_CONTRACT_V1, ociImage: PINNED_IMAGE});
  const legacy = Object.freeze({
    ...current,
    cacheKey() { return {contract: CARGO_RUSTC_OCI_CACHE_CONTRACT_V0, ociImage: PINNED_IMAGE}; },
  });
  assert.equal(legacy.identity, current.identity, 'only the cache contract differs');

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, current]],
  });
  // Same image service, same provider id, different cache material: the exact situation of a
  // store written before the bump and read after it.
  const legacyService = new ToolchainService({
    images: runtime.images,
    providers: new ToolchainProviderRegistry([[CARGO_RUSTC_OCI_PROVIDER_ID, legacy]]),
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const source = await runtime.images.putCodeArtifact('demo', {
      id: 'source',
      languageId: 'rust',
      representation: RUST_SOURCE_V1,
      content: textValue('fn main() {}\n'),
      metadata: {path: 'src/main.rs'},
    });
    const lock = await runtime.images.putCodeArtifact('demo', {
      id: 'lock',
      languageId: 'rust',
      representation: RUST_CARGO_LOCK_V1,
      content: textValue('version = 4\n\n[[package]]\nname = "demo"\nversion = "0.1.0"\n'),
    });
    const manifest = await runtime.images.putCodeArtifact('demo', {
      id: 'manifest',
      languageId: 'rust',
      representation: RUST_CARGO_MANIFEST_V1,
      content: textValue('[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n\n[[bin]]\nname = "demo"\npath = "src/main.rs"\n'),
      dependencies: [
        {role: 'source', artifact: objectRef('demo', source.id)},
        {role: 'lock', artifact: objectRef('demo', lock.id)},
      ],
    });
    // Held constant throughout, output id included: ADR 0020 makes a different requested id a
    // different installation, so varying it here would hide the miss behind an unrelated rule.
    const request = {
      providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
      imageId: 'demo',
      roots: [objectRef('demo', manifest.id)],
      target: {representation: WASM_BINARY_V1, triple: 'wasm32-wasip1', binary: 'demo', profile: 'release'},
      outputIds: {module: 'cargo-wasm'},
    };

    // 1. A record persisted under v0.
    const old = await legacyService.run(request);
    assert.equal(runs, 1);
    assert.equal(old.reused, false);
    const stored = await runtime.images.getCodeArtifact('demo', 'cargo-wasm');
    assert.equal(stored.metadata.toolchainDerivationKey, old.derivationKey);

    // 2. Control and falsifier in one: under v0 that record is admissible. A provider differing
    //    from the shipped one only by the reverted contract string reuses it.
    const oldAgain = await legacyService.run(request);
    assert.equal(runs, 1);
    assert.equal(oldAgain.reused, true);
    assert.equal(oldAgain.outputs[0].artifact.id, 'cargo-wasm');

    // 3. Under v1 the identical request does not find it. The provider runs again, and because the
    //    caller asked for the id the v0 record already holds, the service refuses to overwrite —
    //    the old result is neither reused nor silently replaced.
    await assert.rejects(runtime.toolchains.run(request), /toolchain output already exists: module -> demo\/cargo-wasm/);
    assert.equal(runs, 2);

    // 4. The two namespaces really are distinct keys over identical request material.
    const material = Object.freeze({
      protocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0,
      providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
      toolchainIdentity: current.identity,
      roots: Object.freeze([]),
      artifacts: Object.freeze([]),
      target: Object.freeze(request.target),
      options: Object.freeze({}),
    });
    const context = Object.freeze({protocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0});
    const v0 = await createToolchainDerivationDescriptor(legacy, material, context);
    const v1 = await createToolchainDerivationDescriptor(current, material, context);
    assert.equal(v0.toolchainIdentity, v1.toolchainIdentity);
    assert.notEqual(v0.derivationKey, v1.derivationKey);
  } finally {
    await runtime.close();
  }
});
