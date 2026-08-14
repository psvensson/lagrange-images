import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  createOpenSmalltalkCuisProvider,
  createRuntime,
  integerValue,
} from '../src/runtime.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';

const OPENSMALLTALK_VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_IMAGE_IDENTITY = 'cuis/6bcee3f38ce037c9714b997ccd3b5b3ff62965c8/Cuis7.9-8090.image/gitblob:523dc5e74b5b550922b56ff2406415c19700ee8e';

test('real OpenSmalltalkVM loads an upstream Cuis package and serves it through ForeignRuntimeService', {skip: !enabled, timeout: 60_000}, async () => {
  const vmPath = process.env.LAGRANGE_OPENSMALLTALK_VM_PATH;
  const imagePath = process.env.LAGRANGE_CUIS_IMAGE_PATH;
  const jsonPackagePath = process.env.LAGRANGE_CUIS_JSON_PACKAGE_PATH;
  assert.ok(vmPath, 'LAGRANGE_OPENSMALLTALK_VM_PATH is required');
  assert.ok(imagePath, 'LAGRANGE_CUIS_IMAGE_PATH is required');
  assert.ok(jsonPackagePath, 'LAGRANGE_CUIS_JSON_PACKAGE_PATH is required');

  const packageBytes = await readFile(jsonPackagePath);
  const packageSha256 = createHash('sha256').update(packageBytes).digest('hex');
  const provider = createOpenSmalltalkCuisProvider({
    vmPath,
    imagePath,
    vmIdentity: OPENSMALLTALK_VM_IDENTITY,
    imageIdentity: CUIS_IMAGE_IDENTITY,
    startupTimeoutMs: 30_000,
    callTimeoutMs: 10_000,
    stopTimeoutMs: 10_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [[OPENSMALLTALK_CUIS_PROVIDER_ID, provider]],
  });
  try {
    const instance = await runtime.foreignRuntimes.start({
      providerId: OPENSMALLTALK_CUIS_PROVIDER_ID,
      spec: {packages: [{name: 'JSON', path: jsonPackagePath}]},
    });
    assert.equal(instance.providerIdentity, provider.identity);
    assert.match(instance.providerIdentity, /^opensmalltalk-cuis-runtime\/v1\/[0-9a-f]{64}$/);
    assert.deepEqual(instance.metadata, {
      runtime: 'OpenSmalltalkVM',
      image: 'Cuis',
      bridgeProtocol: 'lagrange-cuis-stdio/v0',
      vmIdentity: OPENSMALLTALK_VM_IDENTITY,
      imageIdentity: CUIS_IMAGE_IDENTITY,
      packages: [{
        name: 'JSON',
        sha256: packageSha256,
        size: packageBytes.length,
      }],
    });
    assert.equal(JSON.stringify(instance.metadata).includes(jsonPackagePath), false);

    const sum = await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'proof', operation: 'add'},
      arguments: [integerValue(12), integerValue(30)],
    });
    assert.deepEqual(sum, integerValue(42));

    const factorial = await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'proof', operation: 'factorial'},
      arguments: [integerValue(8)],
    });
    assert.deepEqual(factorial, integerValue(40320));

    const jsonRoundTrip = await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'json', operation: 'roundTripSum'},
      arguments: [integerValue(17), integerValue(25)],
    });
    assert.deepEqual(jsonRoundTrip, integerValue(42));

    await runtime.foreignRuntimes.stop(instance.runtimeId);
    assert.deepEqual(runtime.foreignRuntimes.list(), []);
  } finally {
    await runtime.close();
  }
});
