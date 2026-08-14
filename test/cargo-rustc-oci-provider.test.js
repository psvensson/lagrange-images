import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {
  CARGO_RUSTC_OCI_PROVIDER_ID,
  CargoRustcOciBuildError,
  OciCliRunner,
  RUST_CARGO_LOCK_V1,
  RUST_CARGO_MANIFEST_V1,
  RUST_SOURCE_V1,
  WASM_BINARY_V1,
  buildOciRunArgs,
  bytesValue,
  createCargoRustcOciProvider,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';

const PINNED_IMAGE = `registry.example/rust-wasm@sha256:${'a'.repeat(64)}`;
const WASM_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

async function putCargoProject(runtime, {
  sourcePath = 'src/main.rs',
  extraDependencies = [],
} = {}) {
  const source = await runtime.images.putCodeArtifact('demo', {
    id: 'source',
    languageId: 'rust',
    representation: RUST_SOURCE_V1,
    content: textValue('fn main() {}\n'),
    metadata: {path: sourcePath},
  });
  const lock = await runtime.images.putCodeArtifact('demo', {
    id: 'cargo-lock',
    languageId: 'rust',
    representation: RUST_CARGO_LOCK_V1,
    content: textValue('version = 4\n\n[[package]]\nname = "demo"\nversion = "0.1.0"\n'),
  });
  const manifest = await runtime.images.putCodeArtifact('demo', {
    id: 'cargo-manifest',
    languageId: 'rust',
    representation: RUST_CARGO_MANIFEST_V1,
    content: textValue('[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n\n[[bin]]\nname = "demo"\npath = "src/main.rs"\n'),
    dependencies: [
      {role: 'source', artifact: objectRef('demo', source.id)},
      {role: 'lock', artifact: objectRef('demo', lock.id)},
      ...extraDependencies,
    ],
  });
  return {manifest, source, lock};
}

function cargoTarget(overrides = {}) {
  return {
    representation: WASM_BINARY_V1,
    triple: 'wasm32-wasip1',
    binary: 'demo',
    profile: 'release',
    ...overrides,
  };
}

test('Cargo/rustc OCI provider materializes an explicit project graph and imports WASM output', async () => {
  let invocation = null;
  const runner = Object.freeze({
    async run(request) {
      invocation = request;
      assert.equal(await readFile(join(request.workspace, 'Cargo.toml'), 'utf8'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n\n[[bin]]\nname = "demo"\npath = "src/main.rs"\n');
      assert.match(await readFile(join(request.workspace, 'Cargo.lock'), 'utf8'), /name = "demo"/);
      assert.equal(await readFile(join(request.workspace, 'src', 'main.rs'), 'utf8'), 'fn main() {}\n');
      const output = join(request.workspace, 'target', 'wasm32-wasip1', 'release', 'demo.wasm');
      await mkdir(dirname(output), {recursive: true});
      await writeFile(output, WASM_BYTES);
      return {exitCode: 0, stdout: 'cargo-ok\n', stderr: 'cargo-note\n'};
    },
  });
  const provider = createCargoRustcOciProvider({image: PINNED_IMAGE, runner});
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const {manifest} = await putCargoProject(runtime);
    const result = await runtime.toolchains.run({
      providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
      imageId: 'demo',
      roots: [objectRef('demo', manifest.id)],
      target: cargoTarget(),
      outputIds: {module: 'demo-wasm'},
    });

    assert.equal(invocation.image, PINNED_IMAGE);
    assert.equal(invocation.network, 'none');
    assert.equal(invocation.containerWorkdir, '/workspace');
    assert.deepEqual(invocation.environment, {
      HOME: '/tmp/lagrange-home',
      CARGO_HOME: '/tmp/lagrange-cargo-home',
    });
    assert.deepEqual(invocation.command, [
      'cargo', 'build', '--frozen', '--target', 'wasm32-wasip1', '--target-dir', 'target', '--bin', 'demo', '--release',
    ]);
    await assert.rejects(access(invocation.workspace), (error) => error?.code === 'ENOENT');

    assert.deepEqual(result.inputs.map(({objectId}) => objectId), ['cargo-manifest', 'source', 'cargo-lock']);
    assert.deepEqual(result.diagnostics, [
      {severity: 'note', source: 'cargo', stream: 'stdout', message: 'cargo-ok\n'},
      {severity: 'note', source: 'cargo', stream: 'stderr', message: 'cargo-note\n'},
    ]);
    const module = await runtime.images.getCodeArtifact('demo', 'demo-wasm');
    assert.equal(module.representation, WASM_BINARY_V1);
    assert.deepEqual(module.content, bytesValue(WASM_BYTES));
    assert.deepEqual(module.dependencies, []);
    assert.deepEqual(module.derivedFrom, [
      objectRef('demo', 'cargo-manifest'),
      objectRef('demo', 'source'),
      objectRef('demo', 'cargo-lock'),
    ]);
    assert.equal(module.metadata.cargoFrozen, true);
    assert.equal(module.metadata.cargoBinary, 'demo');
    assert.equal(module.metadata.rustTargetTriple, 'wasm32-wasip1');
    assert.equal(module.metadata.ociImage, PINNED_IMAGE);
    assert.equal(module.metadata.ociImageDigest, `sha256:${'a'.repeat(64)}`);
    assert.equal(module.metadata.ociNetwork, 'none');
    assert.equal(module.metadata.toolchainProviderId, CARGO_RUSTC_OCI_PROVIDER_ID);
    assert.equal(module.metadata.toolchainIdentity, provider.identity);
  } finally {
    await runtime.close();
  }
});

test('Cargo/rustc OCI provider rejects tags, unsupported artifacts and unsafe source paths', async () => {
  assert.throws(() => createCargoRustcOciProvider({image: 'rust:latest'}), /pinned by @sha256/);
  let runs = 0;
  const runner = {async run() { runs += 1; return {exitCode: 0, stdout: '', stderr: ''}; }};
  const provider = createCargoRustcOciProvider({image: PINNED_IMAGE, runner});
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const foreign = await runtime.images.putCodeArtifact('demo', {
      id: 'foreign',
      representation: 'java/jar-v1',
      content: bytesValue(new Uint8Array([1])),
    });
    let project = await putCargoProject(runtime, {
      extraDependencies: [{role: 'library', artifact: objectRef('demo', foreign.id)}],
    });
    await assert.rejects(
      runtime.toolchains.run({
        providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
        imageId: 'demo',
        roots: [objectRef('demo', project.manifest.id)],
        target: cargoTarget(),
      }),
      /does not support input representation: java\/jar-v1/,
    );
    assert.equal(runs, 0);

    const secondRuntime = await createRuntime({
      backend: {mode: 'mock'},
      toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, provider]],
    });
    await secondRuntime.images.createImage({id: 'demo'});
    try {
      project = await putCargoProject(secondRuntime, {sourcePath: '../escape.rs'});
      await assert.rejects(
        secondRuntime.toolchains.run({
          providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
          imageId: 'demo',
          roots: [objectRef('demo', project.manifest.id)],
          target: cargoTarget(),
        }),
        /portable relative POSIX path|must not contain/,
      );
      assert.equal(runs, 0);
    } finally {
      await secondRuntime.close();
    }
  } finally {
    await runtime.close();
  }
});

test('Cargo/rustc OCI provider fails closed on Cargo errors and missing output', async () => {
  const failingProvider = createCargoRustcOciProvider({
    image: PINNED_IMAGE,
    runner: {async run() { return {exitCode: 17, stdout: 'out', stderr: 'bad build'}; }},
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, failingProvider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const {manifest} = await putCargoProject(runtime);
    await assert.rejects(
      runtime.toolchains.run({
        providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
        imageId: 'demo',
        roots: [objectRef('demo', manifest.id)],
        target: cargoTarget(),
        outputIds: {module: 'failed-wasm'},
      }),
      (error) => error instanceof CargoRustcOciBuildError && error.exitCode === 17 && error.stderr === 'bad build',
    );
    assert.equal(await runtime.images.getCodeArtifact('demo', 'failed-wasm'), null);
  } finally {
    await runtime.close();
  }
});

test('OCI CLI runner builds Docker/Podman-style run arguments without a shell', async () => {
  const args = buildOciRunArgs({
    image: PINNED_IMAGE,
    workspace: '/tmp/workspace',
    containerWorkdir: '/workspace',
    network: 'none',
    user: '1000:1000',
    environment: {HOME: '/tmp/home', CARGO_HOME: '/tmp/cargo'},
    command: ['cargo', 'build', '--frozen'],
  });
  assert.deepEqual(args, [
    'run', '--rm', '--network', 'none',
    '--mount', 'type=bind,src=/tmp/workspace,dst=/workspace',
    '--workdir', '/workspace', '--user', '1000:1000',
    '--env', 'CARGO_HOME=/tmp/cargo', '--env', 'HOME=/tmp/home',
    PINNED_IMAGE, 'cargo', 'build', '--frozen',
  ]);

  let observed = null;
  const runner = new OciCliRunner({
    command: 'podman',
    user: '1000:1000',
    execFile: async (command, invocationArgs, options) => {
      observed = {command, invocationArgs, options};
      return {stdout: 'ok', stderr: ''};
    },
  });
  assert.deepEqual(await runner.run({
    image: PINNED_IMAGE,
    workspace: '/tmp/workspace',
    command: ['cargo', '--version'],
  }), {exitCode: 0, stdout: 'ok', stderr: ''});
  assert.equal(observed.command, 'podman');
  assert.equal(observed.invocationArgs.includes(PINNED_IMAGE), true);
  assert.equal(observed.options.encoding, 'utf8');
});
