import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {
  CARGO_RUSTC_OCI_PROVIDER_ID,
  CARGO_RUSTC_OCI_PROVIDER_V1,
  CargoRustcOciBuildError,
  OciCliRunner,
  RUST_CARGO_CONFIG_V1,
  RUST_CARGO_LOCK_V1,
  RUST_CARGO_MANIFEST_V1,
  RUST_CARGO_VENDOR_FILE_V1,
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
const VENDOR_PACKAGE_CHECKSUM = 'b'.repeat(64);
const VENDOR_MANIFEST = '[package]\nname = "tiny_math"\nversion = "1.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n';
const VENDOR_LIB = 'pub fn add(left: i32, right: i32) -> i32 { left + right }\n';
const VENDOR_ASSET = Buffer.from([0x00, 0x01, 0x02, 0xff]);
const VENDOR_CHECKSUM = JSON.stringify({
  package: VENDOR_PACKAGE_CHECKSUM,
  files: {
    'Cargo.toml': '2b981fbd669c7f98389c30b8c9f57e9db52f72b09d49374e13fa83a565e25012',
    'assets/data.bin': '3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56',
    'src/lib.rs': '084abb700c372b9420868b22516aacda02912e4db9d5223004a1c9d3f552ae13',
  },
});
const VENDOR_CONFIG = '[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "vendor"\n';

async function putCargoProject(runtime, {
  sourcePath = 'src/main.rs',
  sourceText = 'fn main() {}\n',
  manifestText = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n\n[[bin]]\nname = "demo"\npath = "src/main.rs"\n',
  lockText = 'version = 4\n\n[[package]]\nname = "demo"\nversion = "0.1.0"\n',
  extraDependencies = [],
} = {}) {
  const source = await runtime.images.putCodeArtifact('demo', {
    id: 'source',
    languageId: 'rust',
    representation: RUST_SOURCE_V1,
    content: textValue(sourceText),
    metadata: {path: sourcePath},
  });
  const lock = await runtime.images.putCodeArtifact('demo', {
    id: 'cargo-lock',
    languageId: 'rust',
    representation: RUST_CARGO_LOCK_V1,
    content: textValue(lockText),
  });
  const manifest = await runtime.images.putCodeArtifact('demo', {
    id: 'cargo-manifest',
    languageId: 'rust',
    representation: RUST_CARGO_MANIFEST_V1,
    content: textValue(manifestText),
    dependencies: [
      {role: 'source', artifact: objectRef('demo', source.id)},
      {role: 'lock', artifact: objectRef('demo', lock.id)},
      ...extraDependencies,
    ],
  });
  return {manifest, source, lock};
}

async function putVendoredDependency(runtime, {badChecksum = false} = {}) {
  const config = await runtime.images.putCodeArtifact('demo', {
    id: 'cargo-config',
    languageId: 'rust',
    representation: RUST_CARGO_CONFIG_V1,
    content: textValue(VENDOR_CONFIG),
  });
  const vendorManifest = await runtime.images.putCodeArtifact('demo', {
    id: 'vendor-manifest',
    languageId: 'rust',
    representation: RUST_CARGO_VENDOR_FILE_V1,
    content: textValue(VENDOR_MANIFEST),
    metadata: {path: 'vendor/tiny_math/Cargo.toml'},
  });
  const vendorLib = await runtime.images.putCodeArtifact('demo', {
    id: 'vendor-lib',
    languageId: 'rust',
    representation: RUST_CARGO_VENDOR_FILE_V1,
    content: textValue(VENDOR_LIB),
    metadata: {path: 'vendor/tiny_math/src/lib.rs'},
  });
  const vendorAsset = await runtime.images.putCodeArtifact('demo', {
    id: 'vendor-asset',
    languageId: 'rust',
    representation: RUST_CARGO_VENDOR_FILE_V1,
    content: bytesValue(VENDOR_ASSET),
    metadata: {path: 'vendor/tiny_math/assets/data.bin'},
  });
  const checksumValue = badChecksum
    ? VENDOR_CHECKSUM.replace('084abb700c372b9420868b22516aacda02912e4db9d5223004a1c9d3f552ae13', '0'.repeat(64))
    : VENDOR_CHECKSUM;
  const vendorChecksum = await runtime.images.putCodeArtifact('demo', {
    id: 'vendor-checksum',
    languageId: 'rust',
    representation: RUST_CARGO_VENDOR_FILE_V1,
    content: textValue(checksumValue),
    metadata: {path: 'vendor/tiny_math/.cargo-checksum.json'},
  });
  return {config, vendorManifest, vendorLib, vendorAsset, vendorChecksum};
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

    assert.equal(provider.identity, `${CARGO_RUSTC_OCI_PROVIDER_V1}/sha256:${'a'.repeat(64)}`);
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
    assert.equal(module.metadata.cargoVendored, false);
    assert.equal(module.metadata.cargoVendoredPackages, 0);
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

test('Cargo/rustc OCI provider materializes a closed project with an explicit vendored third-party crate', async () => {
  let invocation = null;
  const runner = Object.freeze({
    async run(request) {
      invocation = request;
      assert.match(await readFile(join(request.workspace, 'Cargo.toml'), 'utf8'), /tiny_math = "1.0.0"/);
      assert.match(await readFile(join(request.workspace, 'Cargo.lock'), 'utf8'), /name = "tiny_math"/);
      assert.equal(await readFile(join(request.workspace, '.cargo', 'config.toml'), 'utf8'), VENDOR_CONFIG);
      assert.equal(await readFile(join(request.workspace, 'vendor', 'tiny_math', 'Cargo.toml'), 'utf8'), VENDOR_MANIFEST);
      assert.equal(await readFile(join(request.workspace, 'vendor', 'tiny_math', 'src', 'lib.rs'), 'utf8'), VENDOR_LIB);
      assert.deepEqual(await readFile(join(request.workspace, 'vendor', 'tiny_math', 'assets', 'data.bin')), VENDOR_ASSET);
      assert.deepEqual(JSON.parse(await readFile(join(request.workspace, 'vendor', 'tiny_math', '.cargo-checksum.json'), 'utf8')), JSON.parse(VENDOR_CHECKSUM));
      assert.equal(await readFile(join(request.workspace, 'src', 'main.rs'), 'utf8'), 'fn main() { println!("{}", tiny_math::add(2, 3)); }\n');
      const output = join(request.workspace, 'target', 'wasm32-wasip1', 'release', 'demo.wasm');
      await mkdir(dirname(output), {recursive: true});
      await writeFile(output, WASM_BYTES);
      return {exitCode: 0, stdout: 'vendored-build-ok\n', stderr: ''};
    },
  });
  const provider = createCargoRustcOciProvider({image: PINNED_IMAGE, runner});
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const vendor = await putVendoredDependency(runtime);
    const project = await putCargoProject(runtime, {
      sourceText: 'fn main() { println!("{}", tiny_math::add(2, 3)); }\n',
      manifestText: '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\ntiny_math = "1.0.0"\n\n[[bin]]\nname = "demo"\npath = "src/main.rs"\n',
      lockText: `version = 4\n\n[[package]]\nname = "demo"\nversion = "0.1.0"\ndependencies = [\n "tiny_math",\n]\n\n[[package]]\nname = "tiny_math"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${VENDOR_PACKAGE_CHECKSUM}"\n`,
      extraDependencies: [
        {role: 'config', artifact: objectRef('demo', vendor.config.id)},
        {role: 'vendor', artifact: objectRef('demo', vendor.vendorManifest.id)},
        {role: 'vendor', artifact: objectRef('demo', vendor.vendorLib.id)},
        {role: 'vendor', artifact: objectRef('demo', vendor.vendorAsset.id)},
        {role: 'vendor', artifact: objectRef('demo', vendor.vendorChecksum.id)},
      ],
    });

    const result = await runtime.toolchains.run({
      providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
      imageId: 'demo',
      roots: [objectRef('demo', project.manifest.id)],
      target: cargoTarget(),
      outputIds: {module: 'vendored-demo-wasm'},
    });

    assert.equal(invocation.network, 'none');
    assert.deepEqual(invocation.command.slice(0, 3), ['cargo', 'build', '--frozen']);
    await assert.rejects(access(invocation.workspace), (error) => error?.code === 'ENOENT');
    assert.deepEqual(result.inputs.map(({objectId}) => objectId), [
      'cargo-manifest', 'source', 'cargo-lock', 'cargo-config', 'vendor-manifest', 'vendor-lib', 'vendor-asset', 'vendor-checksum',
    ]);
    const module = await runtime.images.getCodeArtifact('demo', 'vendored-demo-wasm');
    assert.equal(module.metadata.cargoVendored, true);
    assert.equal(module.metadata.cargoVendoredPackages, 1);
    assert.deepEqual(module.derivedFrom, result.inputs);
  } finally {
    await runtime.close();
  }
});

test('Cargo/rustc OCI provider validates vendored package integrity before invoking OCI', async () => {
  let runs = 0;
  const provider = createCargoRustcOciProvider({
    image: PINNED_IMAGE,
    runner: {async run() { runs += 1; return {exitCode: 0, stdout: '', stderr: ''}; }},
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const vendor = await putVendoredDependency(runtime, {badChecksum: true});
    const project = await putCargoProject(runtime, {
      extraDependencies: [
        {role: 'config', artifact: objectRef('demo', vendor.config.id)},
        {role: 'vendor', artifact: objectRef('demo', vendor.vendorManifest.id)},
        {role: 'vendor', artifact: objectRef('demo', vendor.vendorLib.id)},
        {role: 'vendor', artifact: objectRef('demo', vendor.vendorAsset.id)},
        {role: 'vendor', artifact: objectRef('demo', vendor.vendorChecksum.id)},
      ],
    });
    await assert.rejects(
      runtime.toolchains.run({
        providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
        imageId: 'demo',
        roots: [objectRef('demo', project.manifest.id)],
        target: cargoTarget(),
      }),
      /Cargo vendor package tiny_math checksum mismatch: src\/lib.rs/,
    );
    assert.equal(runs, 0);
  } finally {
    await runtime.close();
  }
});

test('Cargo/rustc OCI provider rejects tags, unsupported artifacts and unsafe source/vendor paths', async () => {
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

    const thirdRuntime = await createRuntime({
      backend: {mode: 'mock'},
      toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, provider]],
    });
    await thirdRuntime.images.createImage({id: 'demo'});
    try {
      const config = await thirdRuntime.images.putCodeArtifact('demo', {
        id: 'cargo-config', languageId: 'rust', representation: RUST_CARGO_CONFIG_V1, content: textValue(VENDOR_CONFIG),
      });
      const badVendor = await thirdRuntime.images.putCodeArtifact('demo', {
        id: 'bad-vendor', languageId: 'rust', representation: RUST_CARGO_VENDOR_FILE_V1,
        content: textValue('x'), metadata: {path: 'not-vendor/file.rs'},
      });
      project = await putCargoProject(thirdRuntime, {
        extraDependencies: [
          {role: 'config', artifact: objectRef('demo', config.id)},
          {role: 'vendor', artifact: objectRef('demo', badVendor.id)},
        ],
      });
      await assert.rejects(
        thirdRuntime.toolchains.run({providerId: CARGO_RUSTC_OCI_PROVIDER_ID, imageId: 'demo', roots: [objectRef('demo', project.manifest.id)], target: cargoTarget()}),
        /must be under vendor\/\<package-directory\>\/\.\.\.|must be under vendor/,
      );
      assert.equal(runs, 0);
    } finally {
      await thirdRuntime.close();
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
  // The program is an explicit --entrypoint, not the image's declared ENTRYPOINT: a toolchain
  // image that ships an entrypoint of its own must not get to wrap or replace the build command.
  assert.deepEqual(args, [
    'run', '--rm', '--network', 'none',
    '--mount', 'type=bind,src=/tmp/workspace,dst=/workspace',
    '--workdir', '/workspace', '--entrypoint', 'cargo', '--user', '1000:1000',
    '--env', 'CARGO_HOME=/tmp/cargo', '--env', 'HOME=/tmp/home',
    PINNED_IMAGE, 'build', '--frozen',
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
