import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAGRANGE_PACKAGE_ARCHIVE_V1,
  PACKAGE_ARCHIVE_IMPORT_RECEIPT_V1,
  PRECOMPILED_WASM_REUSE_RECEIPT_V1,
  TOOLCHAIN_DERIVATION_INDEX_V1,
  TOOLCHAIN_PROVIDER_PROTOCOL_V0,
  ToolchainProviderRegistry,
  ToolchainService,
  WASM_BINARY_V1,
  bytesValue,
  createPackageArchiveManifest,
  createRuntime,
  importPackageArchive,
  objectRef,
  parsePackageArchiveArtifact,
  readToolchainDerivationIndexEntry,
  rebuildToolchainDerivationIndex,
  reusePrecompiledWasmArtifact,
  textValue,
} from '../src/index.js';

const MINIMAL_WASM_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

test('ToolchainService persists durable derivation-key index objects and reuses cached outputs in O(1) without listCodeArtifacts', async () => {
  const runtime = await createRuntime();
  try {
    const image = await runtime.images.createImage({id: 'img-derivation-idx', name: 'DerivationIdx'});

    const source = await runtime.images.putCodeArtifact(image.id, {
      id: 'rust-src-1',
      languageId: 'rust',
      representation: 'rust-source/v1',
      logicalPath: 'src/lib.rs',
      content: textValue('pub fn answer() -> i32 { 42 }\n'),
    });

    let providerCalls = 0;
    const providerId = 'test-cacheable-toolchain';
    const toolchainIdentity = 'test-cacheable-toolchain/v1';
    const providers = new ToolchainProviderRegistry();
    providers.register(providerId, {
      identity: toolchainIdentity,
      cacheKey(request) {
        return {
          roots: request.roots.map((r) => r.artifact.content.value),
          target: request.target,
        };
      },
      async run() {
        providerCalls += 1;
        return {
          outputs: [
            {
              name: 'wasm-binary',
              languageId: 'rust',
              representation: WASM_BINARY_V1,
              logicalPath: 'target/out.wasm',
              content: bytesValue(MINIMAL_WASM_BYTES),
            },
            {
              name: 'build-manifest',
              languageId: 'rust',
              representation: 'build-manifest/v1',
              content: textValue(JSON.stringify({ok: true})),
            },
          ],
          diagnostics: [],
        };
      },
    });

    const service1 = new ToolchainService({images: runtime.images, providers});
    const firstRun = await service1.run({
      providerId,
      imageId: image.id,
      roots: [objectRef(image.id, source.id)],
      target: {triple: 'wasm32-unknown-unknown'},
      outputIds: {
        'wasm-binary': 'out-wasm-1',
        'build-manifest': 'out-manifest-1',
      },
    });

    assert.equal(firstRun.reused, false);
    assert.equal(providerCalls, 1);
    assert.equal(typeof firstRun.derivationKey, 'string');

    // Verify durable derivation index entry exists in the image
    const indexEntry = await readToolchainDerivationIndexEntry({
      images: runtime.images,
      imageId: image.id,
      providerId,
      toolchainIdentity,
      derivationKey: firstRun.derivationKey,
    });
    assert.ok(indexEntry);
    assert.equal(indexEntry.format, TOOLCHAIN_DERIVATION_INDEX_V1);
    assert.equal(indexEntry.results.length, 1);
    assert.equal(indexEntry.results[0].outputs.length, 2);

    // Falsification proof: construct a brand-new ToolchainService over an images proxy
    // where listCodeArtifacts throws if invoked, proving O(1) durable index lookup.
    const noScanImages = new Proxy(runtime.images, {
      get(target, prop, receiver) {
        if (prop === 'listCodeArtifacts') {
          return async () => {
            throw new Error('listCodeArtifacts must not be called when durable derivation index hits');
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    const service2 = new ToolchainService({images: noScanImages, providers});
    const secondRun = await service2.run({
      providerId,
      imageId: image.id,
      roots: [objectRef(image.id, source.id)],
      target: {triple: 'wasm32-unknown-unknown'},
      outputIds: {
        'wasm-binary': 'out-wasm-1',
        'build-manifest': 'out-manifest-1',
      },
    });

    assert.equal(secondRun.reused, true);
    assert.equal(providerCalls, 1);
    assert.equal(secondRun.outputs.length, 2);
    assert.equal(secondRun.outputs[0].artifact.id, 'out-wasm-1');
    assert.equal(secondRun.outputs[1].artifact.id, 'out-manifest-1');
  } finally {
    await runtime.close();
  }
});

test('rebuildToolchainDerivationIndex indexes pre-existing unindexed toolchain artifacts for O(1) lookup', async () => {
  const runtime = await createRuntime();
  try {
    const image = await runtime.images.createImage({id: 'img-rebuild-idx', name: 'RebuildIdx'});
    const source = await runtime.images.putCodeArtifact(image.id, {
      id: 'src-unindexed',
      languageId: 'rust',
      representation: 'rust-source/v1',
      content: textValue('fn main() {}'),
    });

    const providerId = 'manual-seeded-provider';
    const toolchainIdentity = 'manual-seeded-provider/v1';
    const providers = new ToolchainProviderRegistry();
    providers.register(providerId, {
      identity: toolchainIdentity,
      cacheKey(req) {
        return {src: req.roots[0].artifact.content.value};
      },
      async run() {
        return {
          outputs: [
            {
              name: 'bin',
              representation: WASM_BINARY_V1,
              content: bytesValue(MINIMAL_WASM_BYTES),
            },
          ],
        };
      },
    });

    // Run once, then delete the index object or seed a second image without index object
    const image2 = await runtime.images.createImage({id: 'img-rebuild-idx-2', name: 'RebuildIdx2'});
    await runtime.images.putCodeArtifact(image2.id, {
      id: source.id,
      languageId: source.languageId,
      representation: source.representation,
      content: source.content,
    });

    const service = new ToolchainService({images: runtime.images, providers});
    const run1 = await service.run({
      providerId,
      imageId: image.id,
      roots: [objectRef(image.id, source.id)],
      outputIds: {bin: 'seeded-bin-1'},
    });

    // Copy only the output CodeArtifact to image2 (without the durable index object)
    const outArt = run1.outputs[0].artifact;
    await runtime.images.putCodeArtifact(image2.id, {
      id: outArt.id,
      languageId: outArt.languageId,
      representation: outArt.representation,
      content: outArt.content,
      derivedFrom: [objectRef(image2.id, source.id)],
      metadata: {
        ...outArt.metadata,
        toolchainProtocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0,
      },
    });

    const beforeRebuild = await readToolchainDerivationIndexEntry({
      images: runtime.images,
      imageId: image2.id,
      providerId,
      toolchainIdentity,
      derivationKey: run1.derivationKey,
    });
    assert.equal(beforeRebuild, null);

    const rebuildReport = await rebuildToolchainDerivationIndex({
      images: runtime.images,
      imageId: image2.id,
    });
    assert.equal(rebuildReport.format, TOOLCHAIN_DERIVATION_INDEX_V1);
    assert.equal(rebuildReport.indexedCount, 1);

    const afterRebuild = await readToolchainDerivationIndexEntry({
      images: runtime.images,
      imageId: image2.id,
      providerId,
      toolchainIdentity,
      derivationKey: run1.derivationKey,
    });
    assert.ok(afterRebuild);
    assert.equal(afterRebuild.results.length, 1);
  } finally {
    await runtime.close();
  }
});

test('Package/archive importer materializes immutable dependency artifacts and reuses precompiled WASM binaries across imports', async () => {
  const runtime = await createRuntime();
  try {
    const image = await runtime.images.createImage({id: 'img-pkg-archive', name: 'PkgArchive'});

    const coreManifest = createPackageArchiveManifest({
      name: 'core-math',
      version: '1.0.0',
      languageId: 'rust',
      files: [
        {
          logicalPath: 'src/lib.rs',
          representation: 'rust-source/v1',
          text: 'pub fn double(x: i32) -> i32 { x * 2 }\n',
        },
        {
          logicalPath: 'Cargo.toml',
          representation: 'rust-cargo-manifest/v1',
          text: '[package]\nname = "core-math"\nversion = "1.0.0"\n',
        },
      ],
      precompiledArtifacts: [
        {
          name: 'shared-runtime-wasm',
          representation: WASM_BINARY_V1,
          logicalPath: 'prebuilt/runtime.wasm',
          bytes: MINIMAL_WASM_BYTES,
        },
      ],
    });

    const coreImport = await importPackageArchive({
      images: runtime.images,
      imageId: image.id,
      archive: coreManifest,
    });

    assert.equal(coreImport.format, PACKAGE_ARCHIVE_IMPORT_RECEIPT_V1);
    assert.equal(coreImport.packageName, 'core-math');
    assert.equal(coreImport.memberArtifacts.length, 2);
    assert.equal(coreImport.precompiledArtifacts.length, 1);
    assert.equal(coreImport.precompiledArtifacts[0].reused, false);
    assert.equal(coreImport.reusedWasmCount, 0);

    const parsedCore = parsePackageArchiveArtifact(coreImport.archiveArtifact);
    assert.equal(parsedCore.format, LAGRANGE_PACKAGE_ARCHIVE_V1);
    assert.equal(parsedCore.archiveDigest, coreManifest.archiveDigest);

    // Import a downstream package that depends on core-math and ships the identical precompiled WASM binary
    const appManifest = createPackageArchiveManifest({
      name: 'app-calc',
      version: '2.1.0',
      languageId: 'rust',
      files: [
        {
          logicalPath: 'src/main.rs',
          representation: 'rust-source/v1',
          text: 'pub fn run() -> i32 { core_math::double(21) }\n',
        },
      ],
      precompiledArtifacts: [
        {
          name: 'shared-runtime-wasm',
          representation: WASM_BINARY_V1,
          logicalPath: 'prebuilt/runtime.wasm',
          bytes: MINIMAL_WASM_BYTES,
        },
      ],
      dependencies: [
        {
          name: 'core-math',
          version: '1.0.0',
        },
      ],
    });

    const appImport = await importPackageArchive({
      images: runtime.images,
      imageId: image.id,
      archive: appManifest,
      dependencyArtifactRefs: {
        'core-math': coreImport.archiveArtifactRef,
      },
    });

    assert.equal(appImport.format, PACKAGE_ARCHIVE_IMPORT_RECEIPT_V1);
    assert.equal(appImport.reusedWasmCount, 1);
    assert.equal(appImport.precompiledArtifacts[0].reused, true);
    assert.equal(
      appImport.precompiledArtifacts[0].artifactId,
      coreImport.precompiledArtifacts[0].artifactId,
    );

    // Verify explicit dependency links on the imported app archive CodeArtifact
    const depRoles = appImport.archiveArtifact.dependencies.map((d) => d.role).sort();
    assert.deepEqual(depRoles, [
      'dependency:core-math',
      'member:src/main.rs',
      'precompiled:shared-runtime-wasm',
    ]);

    // Direct reusePrecompiledWasmArtifact check
    const directReuse = await reusePrecompiledWasmArtifact({
      images: runtime.images,
      imageId: image.id,
      representation: WASM_BINARY_V1,
      content: MINIMAL_WASM_BYTES,
      logicalPath: 'prebuilt/runtime.wasm',
    });
    assert.equal(directReuse.format, PRECOMPILED_WASM_REUSE_RECEIPT_V1);
    assert.equal(directReuse.reused, true);
    assert.equal(directReuse.artifactId, coreImport.precompiledArtifacts[0].artifactId);
  } finally {
    await runtime.close();
  }
});
