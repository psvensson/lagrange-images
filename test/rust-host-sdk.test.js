import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  LAGRANGE_HOST_CALLABLE_DISPATCH_SPECIFIER,
  LAGRANGE_HOST_IMAGE_CREATE_SPECIFIER,
  LAGRANGE_HOST_IMAGE_MUTATE_SPECIFIER,
  LAGRANGE_HOST_IMAGE_OBSERVE_SPECIFIER,
  LAGRANGE_HOST_IMAGE_READ_SPECIFIER,
  LAGRANGE_RUST_HOST_IMPORTS,
  LAGRANGE_RUST_SDK_V1,
  OBJECT_CREATE_OPERATION,
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  ObjectMutationConflictError,
  RUST_CARGO_LOCK_V1,
  RUST_CARGO_MANIFEST_V1,
  RUST_SOURCE_V1,
  AuthorityError,
  UndeclaredHostImportError,
  WASM_COMPONENT_V1,
  bytesValue,
  createLagrangeRustHostBindings,
  createRuntime,
  generateLagrangeRustSdkCrate,
  installLagrangeRustComponentWithHostSdk,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  materializeCargoProject,
  materializeLagrangeRustSdkArtifacts,
  objectRef,
  objectResource,
  textValue,
  validateVendorPackages,
} from '../src/runtime.js';

test('generateLagrangeRustSdkCrate and materializeLagrangeRustSdkArtifacts produce valid vendored Cargo SDK artifacts', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const imageId = 'rust-sdk-vendor-image';
  await runtime.images.createImage({id: imageId, name: 'Rust SDK Vendor Image'});

  const sdk = generateLagrangeRustSdkCrate({
    packageName: 'lagrange_sdk',
    version: '0.1.0',
    edition: '2021',
    exports: [
      {
        name: 'stepCounter',
        function: 'step-counter',
        parameters: ['s64'],
        result: 's64',
      },
    ],
  });

  assert.equal(sdk.schema, LAGRANGE_RUST_SDK_V1);
  assert.equal(sdk.packageName, 'lagrange_sdk');
  assert.deepEqual(sdk.hostImports, LAGRANGE_RUST_HOST_IMPORTS);
  assert.ok(sdk.witWorld.includes('package lagrange:sdk@1.0.0;'));
  assert.ok(sdk.witWorld.includes('export step-counter: func(p0: s64) -> s64;'));
  assert.ok(sdk.files['vendor/lagrange_sdk/src/lib.rs'].includes('#![no_std]'));
  assert.ok(sdk.files['vendor/lagrange_sdk/src/lib.rs'].includes('pub trait HostImageRead'));
  assert.ok(sdk.files['vendor/lagrange_sdk/src/lib.rs'].includes('pub trait HostImageMutate'));
  assert.ok(sdk.files['vendor/lagrange_sdk/src/lib.rs'].includes('pub trait HostImageCreate'));
  assert.ok(sdk.files['vendor/lagrange_sdk/src/lib.rs'].includes('pub trait HostImageObserve'));
  assert.ok(sdk.files['vendor/lagrange_sdk/src/lib.rs'].includes('pub trait HostCallableDispatch'));

  const materialized = await materializeLagrangeRustSdkArtifacts({
    images: runtime.images,
    imageId,
    sdk,
  });
  assert.equal(materialized.vendorArtifacts.length, 3);
  assert.ok(materialized.configArtifact);

  const validatedPackages = validateVendorPackages(materialized.vendorArtifacts);
  assert.equal(validatedPackages.length, 1);
  assert.equal(validatedPackages[0].packageDirectory, 'lagrange_sdk');

  // Verify materializeCargoProject accepts a Cargo project consuming the vendored SDK
  const manifestArtifact = await runtime.images.putCodeArtifact(imageId, {
    id: 'app-cargo-toml',
    languageId: 'rust',
    representation: RUST_CARGO_MANIFEST_V1,
    logicalPath: 'Cargo.toml',
    content: textValue('[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nlagrange_sdk = "0.1.0"\n'),
    dependencies: [],
  });
  const lockArtifact = await runtime.images.putCodeArtifact(imageId, {
    id: 'app-cargo-lock',
    languageId: 'rust',
    representation: RUST_CARGO_LOCK_V1,
    logicalPath: 'Cargo.lock',
    content: textValue('version = 3\n\n[[package]]\nname = "lagrange_sdk"\nversion = "0.1.0"\n'),
    dependencies: [],
  });
  const mainRsArtifact = await runtime.images.putCodeArtifact(imageId, {
    id: 'app-main-rs',
    languageId: 'rust',
    representation: RUST_SOURCE_V1,
    logicalPath: 'src/main.rs',
    content: textValue('use lagrange_sdk::SDK_SCHEMA;\nfn main() { let _ = SDK_SCHEMA; }\n'),
    dependencies: [],
  });

  const allInputArtifacts = [
    manifestArtifact,
    lockArtifact,
    mainRsArtifact,
    ...materialized.artifacts,
  ].map((artifact) => ({artifact}));

  const workspace = await mkdtemp(join(tmpdir(), 'lagrange-rust-sdk-test-'));
  try {
    const cargoGraph = await materializeCargoProject(
      {
        roots: [{artifact: manifestArtifact}],
        artifacts: allInputArtifacts,
      },
      workspace,
    );
    assert.equal(cargoGraph.vendoredPackages.length, 1);
    const writtenLibRs = await readFile(join(workspace, 'vendor', 'lagrange_sdk', 'src', 'lib.rs'), 'utf8');
    assert.ok(writtenLibRs.includes('pub const SDK_SCHEMA'));
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
});

test('createLagrangeRustHostBindings and installLagrangeRustComponentWithHostSdk execute capability-checked host calls', async () => {
  let hostImportsRegistry = null;

  // Component runtime double that exercises the wired Lagrange Rust Host SDK imports
  const componentRuntime = {
    async requiredImports() {
      return [...LAGRANGE_RUST_HOST_IMPORTS];
    },
    async invoke(_componentArtifact, functionName, args, imports) {
      assert.equal(functionName, 'process-counter');
      const delta = Number(args[0]);
      const readHost = imports[LAGRANGE_HOST_IMAGE_READ_SPECIFIER];
      const mutateHost = imports[LAGRANGE_HOST_IMAGE_MUTATE_SPECIFIER];
      const createHost = imports[LAGRANGE_HOST_IMAGE_CREATE_SPECIFIER];
      const observeHost = imports[LAGRANGE_HOST_IMAGE_OBSERVE_SPECIFIER];
      const dispatchHost = imports[LAGRANGE_HOST_CALLABLE_DISPATCH_SPECIFIER];

      // 1. Read slot and version token via lagrange:host/image-read@1.0.0
      const currentVal = await readHost.readSlot('counter', 'count');
      const vToken = await readHost.readObjectVersion('counter');

      // 2. Dispatch callable helper via lagrange:host/callable-dispatch@1.0.0
      const computed = await dispatchHost.invokeCallable('doubleDelta', [delta]);

      // 3. Mutate slot with CAS token via lagrange:host/image-mutate@1.0.0
      const nextVal = currentVal + computed;
      const newToken = await mutateHost.writeSlot('counter', 'count', nextVal, vToken);
      assert.notEqual(newToken, vToken);

      // Verify stale token conflicts with ObjectMutationConflictError
      await assert.rejects(
        async () => await mutateHost.writeSlot('counter', 'count', 999, vToken),
        (err) => err instanceof ObjectMutationConflictError,
      );

      // 4. Create an audit record object via lagrange:host/image-create@1.0.0
      const created = await createHost.createInstance('auditShape', {recordedValue: nextVal});
      assert.equal(created.objectId, 'audit-record-1');

      // 5. Observe updated counter via lagrange:host/image-observe@1.0.0
      const observed = await observeHost.observe(['counter']);
      assert.equal(observed.length, 1);
      assert.equal(observed[0].versionToken, newToken);

      return BigInt(nextVal);
    },
  };

  const imageId = 'rust-sdk-exec-image';
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    componentRuntime,
  });

  createLagrangeRustHostBindings({
    images: runtime.images,
    imageId,
    registry: runtime.componentHostImports,
    readableObjects: {counter: 'counter-obj-1'},
    mutableObjects: {counter: 'counter-obj-1'},
    creatableShapes: {
      auditShape: {
        shapeId: 'audit-shape-v1',
        newObjectId: () => 'audit-record-1',
      },
    },
    callableTargets: {
      doubleDelta: {
        blockRef: objectRef(imageId, 'double-delta-block'),
        invoke: async (args) => integerValue(BigInt(args[0].value) * 2n),
      },
    },
  });

  await runtime.images.createImage({id: imageId, name: 'Rust SDK Exec Image'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
  });

  // Put counter shape + object and audit shape
  await runtime.images.putShape(imageId, {
    id: 'counter-shape-v1',
    slots: [{id: 'slot-count', name: 'count'}],
  });
  await runtime.images.putObject(imageId, {
    id: 'counter-obj-1',
    shape: objectRef(imageId, 'counter-shape-v1'),
    slots: {'slot-count': integerValue(10n)},
  });
  await runtime.images.putShape(imageId, {
    id: 'audit-shape-v1',
    slots: [{id: 'slot-recorded', name: 'recordedValue'}],
  });

  // Install helper block referenced by callableTargets
  await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    blockId: 'double-delta-block',
    source: '[:x | x * 2]',
  });

  // Put WASM Component artifact and bind it with installLagrangeRustComponentWithHostSdk
  const componentArtifact = await runtime.images.putCodeArtifact(imageId, {
    id: 'rust-sdk-component-v1',
    languageId: 'rust',
    representation: WASM_COMPONENT_V1,
    content: bytesValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00])),
    dependencies: [],
  });

  const installed = await installLagrangeRustComponentWithHostSdk({
    images: runtime.images,
    imageId,
    component: componentArtifact,
    exports: [
      {
        name: 'processCounter',
        function: 'process-counter',
        parameters: ['s64'],
        result: 's64',
      },
    ],
  });

  const blockRef = installed.exports.processCounter.blockRef;

  // Issue authority grants for counter read/write, auditShape create, and double-delta-block read
  const fullContext = runtime.authority.issue({
    principal: 'rust-sdk-test',
    grants: [
      {operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, 'counter-obj-1')},
      {operation: OBJECT_WRITE_OPERATION, resource: objectResource(imageId, 'counter-obj-1')},
      {operation: OBJECT_CREATE_OPERATION, resource: objectResource(imageId, 'audit-shape-v1')},
      {operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, 'double-delta-block')},
    ],
  });

  const invokeComponentBlock = async (targetBlockRef, args, authority) => {
    const activation = await runtime.invocations.prepareActivation({
      block: targetBlockRef,
      arguments: args,
    });
    return await runtime.executor.execute(activation, {authority});
  };

  const result = await invokeComponentBlock(blockRef, [integerValue(6n)], fullContext);
  // 10 + (6 * 2) = 22
  assert.deepEqual(result, integerValue(22n));

  const updatedCounter = await runtime.images.getObject(imageId, 'counter-obj-1');
  assert.deepEqual(updatedCounter.slots['slot-count'], integerValue(22n));
  const createdAudit = await runtime.images.getObject(imageId, 'audit-record-1');
  assert.deepEqual(createdAudit.slots['slot-recorded'], integerValue(22n));

  // Verify attenuating away OBJECT_WRITE_OPERATION fails closed per call
  const readOnlyContext = runtime.authority.attenuate(fullContext, {
    grants: [
      {operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, 'counter-obj-1')},
      {operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, 'double-delta-block')},
    ],
  });
  await assert.rejects(
    async () => await invokeComponentBlock(blockRef, [integerValue(3n)], readOnlyContext),
    (err) => err instanceof AuthorityError,
  );

  // Verify undeclared host import fails with UndeclaredHostImportError
  const restrictedInstalled = await installLagrangeRustComponentWithHostSdk({
    images: runtime.images,
    imageId,
    idPrefix: 'restricted-rust-component',
    component: componentArtifact,
    hostImports: [LAGRANGE_HOST_IMAGE_READ_SPECIFIER],
    exports: [
      {
        name: 'processCounter',
        function: 'process-counter',
        parameters: ['s64'],
        result: 's64',
      },
    ],
  });
  await assert.rejects(
    async () => await invokeComponentBlock(
      restrictedInstalled.exports.processCounter.blockRef,
      [integerValue(1n)],
      fullContext,
    ),
    (err) => err instanceof UndeclaredHostImportError,
  );
  await runtime.close();
});
