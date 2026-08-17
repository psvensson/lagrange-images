import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  booleanValue,
  bytesValue,
  createOpenSmalltalkCuisProvider,
  createRuntime,
  float64Value,
  integerValue,
  textValue,
} from '../src/runtime.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';

const OPENSMALLTALK_VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_IMAGE_IDENTITY = 'cuis/6bcee3f38ce037c9714b997ccd3b5b3ff62965c8/Cuis7.9-8090.image/gitblob:523dc5e74b5b550922b56ff2406415c19700ee8e';
const CUIS_JSON_IDENTITY = 'cuis-package/JSON/6bcee3f38ce037c9714b997ccd3b5b3ff62965c8/gitblob:47fab65d0d9017d706aa07d39ab0451619488ccd';

test('real OpenSmalltalkVM loads and executes an existing Cuis package through ForeignRuntimeService', {skip: !enabled, timeout: 60_000}, async () => {
  const vmPath = process.env.LAGRANGE_OPENSMALLTALK_VM_PATH;
  const imagePath = process.env.LAGRANGE_CUIS_IMAGE_PATH;
  const jsonPackagePath = process.env.LAGRANGE_CUIS_JSON_PACKAGE_PATH;
  assert.ok(vmPath, 'LAGRANGE_OPENSMALLTALK_VM_PATH is required');
  assert.ok(imagePath, 'LAGRANGE_CUIS_IMAGE_PATH is required');
  assert.ok(jsonPackagePath, 'LAGRANGE_CUIS_JSON_PACKAGE_PATH is required');

  const provider = createOpenSmalltalkCuisProvider({
    vmPath,
    imagePath,
    vmIdentity: OPENSMALLTALK_VM_IDENTITY,
    imageIdentity: CUIS_IMAGE_IDENTITY,
    startupTimeoutMs: 60_000,
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
      spec: {packages: [{path: jsonPackagePath, identity: CUIS_JSON_IDENTITY}]},
    });
    assert.equal(instance.providerIdentity, provider.identity);
    assert.deepEqual(instance.metadata.packages, [{
      identity: CUIS_JSON_IDENTITY,
      fileName: 'JSON.pck.st',
    }]);

    const sum = await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'proof', operation: 'add'},
      arguments: [integerValue(12), integerValue(30)],
    });
    assert.deepEqual(sum, integerValue(42));

    const packageProof = await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'json', operation: 'package-proof'},
      arguments: [],
    });
    assert.deepEqual(packageProof, booleanValue(true));

    const factorial = await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'proof', operation: 'factorial'},
      arguments: [integerValue(8)],
    });
    assert.deepEqual(factorial, integerValue(40320));

    // proof/echo decodes and re-encodes its argument, so it exercises every
    // lagrange-cuis-stdio/v1 Value branch on the Smalltalk side of the bridge.
    const scalars = [
      booleanValue(true),
      booleanValue(false),
      integerValue(0),
      integerValue(-7),
      integerValue('123456789012345678901234567890'),
      float64Value(1.5),
      float64Value(-0),
      float64Value(1e-300),
      float64Value(3.141592653589793),
      textValue(''),
      textValue('plain'),
      textValue('tab\there'),
      // Beyond Latin-1 on purpose: Cuis String truncates these, UnicodeString does not.
      textValue('hällo 世界 \u{1f600}'),
      bytesValue(new Uint8Array([])),
      bytesValue(new Uint8Array([0, 1, 255])),
      bytesValue(new Uint8Array([72, 105])),
    ];
    for (const scalar of scalars) {
      const echoed = await runtime.foreignRuntimes.call({
        runtimeId: instance.runtimeId,
        interface: {service: 'proof', operation: 'echo'},
        arguments: [scalar],
      });
      assert.deepEqual(echoed, scalar, `echo round-trip failed for ${JSON.stringify(scalar)}`);
    }

    for (const [input, expected] of [
      ['  Hello   World  ', 'hello world'],
      ['ALREADY lower', 'already lower'],
      ['  Tabs\tand\nnewlines  ', 'tabs and newlines'],
      ['', ''],
      ['x', 'x'],
      ['  HÄLLO   Wörld  ', 'hällo wörld'],
      ['  世界  \u{1f600} ', '世界 \u{1f600}'],
    ]) {
      const normalized = await runtime.foreignRuntimes.call({
        runtimeId: instance.runtimeId,
        interface: {service: 'text', operation: 'normalize'},
        arguments: [textValue(input)],
      });
      assert.deepEqual(normalized, textValue(expected),
        `normalize failed for ${JSON.stringify(input)}`);
    }

    await runtime.foreignRuntimes.stop(instance.runtimeId);
    assert.deepEqual(runtime.foreignRuntimes.list(), []);
  } finally {
    await runtime.close();
  }
});
