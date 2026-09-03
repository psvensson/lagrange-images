// Real digest-pinned Cargo/rustc OCI proof (Bead lagrange-images-1h9, ADR 0077).
//
// Every other Cargo test in this repository injects a fake OCI runner: it proves the provider
// builds the right workspace and command, and nothing more. This file runs the actual compiler,
// in the actual pinned image, with the network off, and then executes what came out.
//
// It skips unless `LAGRANGE_CARGO_OCI_INTEGRATION=1`, so a green `npm test` is not evidence that
// it ran. `scripts/cargo-oci-setup.sh` pulls the pinned image and `scripts/cargo-oci-env.sh`
// exports the environment; `npm run test:cargo-oci` does both halves. CI runs it as the required
// `cargo-rustc-oci-integration` job.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
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
  bytesValue,
  createCargoRustcOciProvider,
  createRuntime,
  installWasmScalarCallable,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {cargoOciProofFixture} from './support/cargo-oci-proof-fixture.js';

const execFileAsync = promisify(execFileCallback);
const enabled = process.env.LAGRANGE_CARGO_OCI_INTEGRATION === '1';
const IMAGE = process.env.LAGRANGE_CARGO_OCI_IMAGE ?? '';
const OCI_CLI = process.env.LAGRANGE_OCI_CLI || 'docker';
const IMAGE_ID = 'cargo-proof';
// One real compile is a couple of seconds on a warm runner, but a cold container start plus a
// first-ever release build of std-linked code is not, and a timeout here reads as a broken
// toolchain rather than a slow one.
const BUILD_TIMEOUT_MS = 300_000;

function requireEnvironment() {
  assert.ok(IMAGE, 'LAGRANGE_CARGO_OCI_IMAGE is required; run scripts/cargo-oci-setup.sh');
  assert.match(IMAGE, /@sha256:[0-9a-f]{64}$/, 'the proof image must be pinned by digest, never a tag');
  return IMAGE.slice(IMAGE.lastIndexOf('@') + 1);
}

// The real OciCliRunner, with the argv it actually executed captured on the way past. Wrapping
// execFile rather than run() keeps the assertions about the real invocation instead of about a
// request object the provider filled in.
function recordingRunner(invocations) {
  return new OciCliRunner({
    command: OCI_CLI,
    async execFile(command, args, options) {
      invocations.push(Object.freeze({command, args: Object.freeze([...args])}));
      return await execFileAsync(command, args, options);
    },
  });
}

async function proofRuntime(invocations) {
  const provider = createCargoRustcOciProvider({image: IMAGE, runner: recordingRunner(invocations)});
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[CARGO_RUSTC_OCI_PROVIDER_ID, provider]],
  });
  await runtime.images.createImage({id: IMAGE_ID});
  return {runtime, provider};
}

// Everything the compiler will see enters here and only here. The manifest is the single root; the
// lock, source, vendor config and each vendored file hang off it as explicit dependency edges, so
// the closure ToolchainService resolves is the whole build input.
async function installProofGraph(runtime, fixture, {vendored = true} = {}) {
  const put = async (id, representation, content, logicalPath) => await runtime.images.putCodeArtifact(IMAGE_ID, {
    id,
    languageId: 'rust',
    representation,
    content,
    ...(logicalPath ? {logicalPath} : {}),
  });

  const source = await put('proof-source', RUST_SOURCE_V1, textValue(fixture.sourceText), fixture.sourcePath);
  const lock = await put('proof-lock', RUST_CARGO_LOCK_V1, textValue(fixture.lockText));
  const dependencies = [
    {role: 'source', artifact: objectRef(IMAGE_ID, source.id)},
    {role: 'lock', artifact: objectRef(IMAGE_ID, lock.id)},
  ];
  if (vendored) {
    const config = await put('proof-config', RUST_CARGO_CONFIG_V1, textValue(fixture.configText));
    dependencies.push({role: 'cargo-config', artifact: objectRef(IMAGE_ID, config.id)});
    for (const [index, file] of fixture.vendorFiles.entries()) {
      const content = file.bytes === undefined ? textValue(file.text) : bytesValue(file.bytes);
      const artifact = await put(`proof-vendor-${index}`, RUST_CARGO_VENDOR_FILE_V1, content, file.path);
      dependencies.push({role: 'vendor', artifact: objectRef(IMAGE_ID, artifact.id)});
    }
  }
  const manifest = await runtime.images.putCodeArtifact(IMAGE_ID, {
    id: 'proof-manifest',
    languageId: 'rust',
    representation: RUST_CARGO_MANIFEST_V1,
    content: textValue(fixture.manifestText),
    dependencies,
  });
  return manifest;
}

async function build(runtime, fixture, manifest, outputId) {
  return await runtime.toolchains.run({
    providerId: CARGO_RUSTC_OCI_PROVIDER_ID,
    imageId: IMAGE_ID,
    roots: [objectRef(IMAGE_ID, manifest.id)],
    target: {
      representation: WASM_BINARY_V1,
      triple: fixture.triple,
      binary: fixture.binary,
      profile: 'release',
    },
    outputIds: {module: outputId},
  });
}

test('real Cargo/rustc in a digest-pinned OCI image compiles a closed vendored graph to executable WASM', {
  skip: !enabled,
  timeout: BUILD_TIMEOUT_MS,
}, async () => {
  const digest = requireEnvironment();
  const fixture = cargoOciProofFixture();
  const invocations = [];
  const {runtime, provider} = await proofRuntime(invocations);
  try {
    const manifest = await installProofGraph(runtime, fixture);
    const result = await build(runtime, fixture, manifest, 'proof-wasm');

    // 1. The build really ran in the pinned image, with nothing but the workspace reachable.
    assert.equal(invocations.length, 1, 'exactly one container invocation compiled the graph');
    const {command, args} = invocations[0];
    assert.equal(command, OCI_CLI);
    assert.equal(args.filter((arg) => arg === '--mount').length, 1, 'the workspace is the only mount');
    assert.equal(args.filter((arg) => arg === '--volume' || arg === '-v').length, 0);
    assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'none']);
    assert.deepEqual(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 2), ['--entrypoint', 'cargo']);
    assert.equal(args.includes(IMAGE), true, 'the container ran the digest-pinned reference verbatim');
    // No ambient host Cargo state or home directory: both point inside the container.
    assert.equal(args.includes('CARGO_HOME=/tmp/lagrange-cargo-home'), true);
    assert.equal(args.includes('HOME=/tmp/lagrange-home'), true);
    assert.deepEqual(args.slice(args.indexOf(IMAGE) + 1), [
      'build', '--frozen', '--target', fixture.triple, '--target-dir', 'target', '--bin', fixture.binary, '--release',
    ]);

    // 2. The output is a real compiler artifact with truthful provenance back to every input.
    assert.equal(provider.identity, `${CARGO_RUSTC_OCI_PROVIDER_V1}/${digest}`);
    const module = await runtime.images.getCodeArtifact(IMAGE_ID, 'proof-wasm');
    assert.equal(module.representation, WASM_BINARY_V1);
    assert.equal(module.content.kind, 'bytes');
    const bytes = Buffer.from(module.content.base64, 'base64');
    assert.ok(bytes.length > 64, 'a real rustc release build is more than a WASM header');
    assert.deepEqual([...bytes.subarray(0, 8)], [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    assert.equal(module.metadata.ociImage, IMAGE);
    assert.equal(module.metadata.ociImageDigest, digest);
    assert.equal(module.metadata.ociNetwork, 'none');
    assert.equal(module.metadata.cargoFrozen, true);
    assert.equal(module.metadata.cargoVendored, true);
    assert.equal(module.metadata.cargoVendoredPackages, 1);
    assert.equal(module.metadata.rustTargetTriple, fixture.triple);
    assert.equal(module.metadata.toolchainIdentity, provider.identity);
    const inputs = result.inputs.map(({objectId}) => objectId).sort();
    assert.deepEqual(inputs, [
      'proof-config', 'proof-lock', 'proof-manifest', 'proof-source',
      'proof-vendor-0', 'proof-vendor-1', 'proof-vendor-2', 'proof-vendor-3',
    ]);
    assert.deepEqual(module.derivedFrom.map(({objectId}) => objectId).sort(), inputs);

    // 3. The bytes are executable through the ordinary callable/activation lane, not a side path.
    //    `wasm-scalar-call/v0` refuses an imported module, so this also proves the closed build
    //    produced a module with no host imports.
    const {block} = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef(IMAGE_ID, module.id),
      interfaceId: 'proof-interface',
      blockId: 'proof-block',
      exportName: fixture.exportName,
      parameters: ['i32', 'i32'],
      result: 'i32',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef(IMAGE_ID, block.id), [
      integerValue(7),
      integerValue(5),
    ]);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(fixture.expected(7, 5)));
  } finally {
    await runtime.close();
  }
});

// The point of a vendored dependency proof is that the dependency is actually linked. A fixture
// whose vendored code never reached the compiler would still produce a valid WASM module and still
// export the function, so the proof reads the vendored constant back out of the executed module.
test('the vendored dependency is compiled into the module, not decoration on the graph', {
  skip: !enabled,
  timeout: BUILD_TIMEOUT_MS,
}, async () => {
  requireEnvironment();
  const fixture = cargoOciProofFixture({scale: 11});
  const invocations = [];
  const {runtime} = await proofRuntime(invocations);
  try {
    const manifest = await installProofGraph(runtime, fixture);
    await build(runtime, fixture, manifest, 'scaled-wasm');
    const module = await runtime.images.getCodeArtifact(IMAGE_ID, 'scaled-wasm');
    const {block} = await installWasmScalarCallable({
      images: runtime.images,
      wasm: objectRef(IMAGE_ID, module.id),
      interfaceId: 'scaled-interface',
      blockId: 'scaled-block',
      exportName: fixture.exportName,
      parameters: ['i32', 'i32'],
      result: 'i32',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef(IMAGE_ID, block.id), [
      integerValue(7),
      integerValue(5),
    ]);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(132));
    assert.equal(fixture.expected(7, 5), 132);
  } finally {
    await runtime.close();
  }
});

// Falsifier: a vendored byte that does not match its declared checksum never reaches the compiler.
test('a changed vendored file fails before the container starts', {skip: !enabled, timeout: BUILD_TIMEOUT_MS}, async () => {
  requireEnvironment();
  const fixture = cargoOciProofFixture({
    corruptVendorLibrary: '#![no_std]\n\npub fn scaled_sum(left: i32, right: i32) -> i32 {\n    left.wrapping_add(right)\n}\n',
  });
  const invocations = [];
  const {runtime} = await proofRuntime(invocations);
  try {
    const manifest = await installProofGraph(runtime, fixture);
    await assert.rejects(build(runtime, fixture, manifest, 'corrupt-wasm'), /checksum mismatch: src\/lib\.rs/);
    assert.equal(invocations.length, 0, 'no container ran for a graph that failed its own integrity check');
    assert.equal(await runtime.images.getCodeArtifact(IMAGE_ID, 'corrupt-wasm'), null);
  } finally {
    await runtime.close();
  }
});

// Falsifier: the same check inside real Cargo. Here the vendored package is internally consistent,
// so this repository's validation passes and only the compiler can catch the disagreement with the
// lock. If Cargo were not verifying source-replacement checksums, this build would succeed.
test('a Cargo.lock checksum that disagrees with the vendored package fails in the real compiler', {
  skip: !enabled,
  timeout: BUILD_TIMEOUT_MS,
}, async () => {
  requireEnvironment();
  const fixture = cargoOciProofFixture({lockChecksum: 'c'.repeat(64)});
  const invocations = [];
  const {runtime} = await proofRuntime(invocations);
  try {
    const manifest = await installProofGraph(runtime, fixture);
    await assert.rejects(
      build(runtime, fixture, manifest, 'lock-mismatch-wasm'),
      (error) => error instanceof CargoRustcOciBuildError && /checksum/i.test(error.stderr),
    );
    assert.equal(invocations.length, 1, 'the failure came from the compiler, not from validation');
    assert.equal(await runtime.images.getCodeArtifact(IMAGE_ID, 'lock-mismatch-wasm'), null);
  } finally {
    await runtime.close();
  }
});

// Falsifier: remove the vendored package from the graph and leave the dependency declared. With a
// network or an ambient Cargo cache this build would quietly succeed by fetching the crate; with
// neither it cannot, which is what makes the closed-input claim testable rather than asserted.
// The assertion is on Cargo's own diagnostic — it reached for crates.io and `--frozen` refused —
// so this cannot pass for some unrelated reason the container also happened to fail on.
test('a declared dependency missing from the graph cannot be fetched or found in a host cache', {
  skip: !enabled,
  timeout: BUILD_TIMEOUT_MS,
}, async () => {
  requireEnvironment();
  const fixture = cargoOciProofFixture();
  const invocations = [];
  const {runtime} = await proofRuntime(invocations);
  try {
    const manifest = await installProofGraph(runtime, fixture, {vendored: false});
    await assert.rejects(
      build(runtime, fixture, manifest, 'unvendored-wasm'),
      (error) => error instanceof CargoRustcOciBuildError
        && error.exitCode !== 0
        && /failed to get `tiny-math`/.test(error.stderr)
        && /--frozen was specified/.test(error.stderr),
    );
    // ...and the container it failed in had no network to fall back on either.
    assert.equal(invocations.length, 1);
    const {args} = invocations[0];
    assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'none']);
    assert.equal(await runtime.images.getCodeArtifact(IMAGE_ID, 'unvendored-wasm'), null);
  } finally {
    await runtime.close();
  }
});

// Falsifier: the lane cannot be re-pointed at a moving tag, which is the only thing that makes the
// digest in the output metadata worth recording.
test('the proof image cannot be named by tag', {skip: !enabled}, async () => {
  const digest = requireEnvironment();
  assert.throws(
    () => createCargoRustcOciProvider({image: IMAGE.slice(0, IMAGE.lastIndexOf('@')) + ':latest'}),
    /pinned by @sha256/,
  );
  assert.equal(IMAGE.endsWith(digest), true);
});
